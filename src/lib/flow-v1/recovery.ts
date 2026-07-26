import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import {
  parseJsonObjectColumn,
  stringifyJsonObjectColumn,
} from "@/lib/db/workflows/json-schemas";
import type {
  FlowV1GraphCheckpoint,
  FlowV1JsonObject,
} from "./types";

export type FlowV1RecoveryResult = {
  interruptedRunIds: string[];
  uncertainEffectIds: string[];
  pendingRunIds: string[];
};

type StaleRunRow = {
  id: string;
  cycle_id: string;
};

type RunningAttemptRow = {
  id: string;
  node_id: string;
};

/**
 * Reconciles process-owned state that cannot survive an application restart.
 * This only changes Flow v1 rows and is safe to call more than once.
 */
export function reconcileFlowV1RuntimeOnStartup(input?: {
  now?: string;
  staleAfterMs?: number;
}): FlowV1RecoveryResult {
  const database = getDb();
  const now = input?.now ?? new Date().toISOString();
  const staleAfterMs = input?.staleAfterMs ?? 60_000;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error("staleAfterMs must be a non-negative number.");
  }
  const cutoff = new Date(
    new Date(now).getTime() - staleAfterMs,
  ).toISOString();
  return database.transaction(() => {
    const staleRuns = database
      .prepare(
        `
        SELECT id, cycle_id, owner_token, owner_claimed_at
        FROM workflow_runs
        WHERE cycle_id IS NOT NULL
          AND status = 'running'
          AND (owner_claimed_at IS NULL OR owner_claimed_at < ?)
        ORDER BY started_at ASC
      `,
      )
      .all(cutoff) as Array<
      StaleRunRow & {
        owner_token: string | null;
        owner_claimed_at: string | null;
      }
    >;
    const interruptedRunIds: string[] = [];
    const uncertainEffectIds: string[] = [];

    for (const run of staleRuns) {
      const recoveryToken = `recovery:${randomUUID()}`;
      const claimed = database
        .prepare(
          `
          UPDATE workflow_runs
          SET owner_token = ?, owner_claimed_at = ?
          WHERE id = ? AND status = 'running'
            AND owner_token IS ? AND owner_claimed_at IS ?
        `,
        )
        .run(
          recoveryToken,
          now,
          run.id,
          run.owner_token,
          run.owner_claimed_at,
        ).changes;
      if (claimed !== 1) {
        continue;
      }
      const attempts = database
        .prepare(
          `
          SELECT id, node_id
          FROM workflow_node_attempts
          WHERE run_id = ? AND status = 'running'
          ORDER BY started_at ASC, rowid ASC
        `,
        )
        .all(run.id) as RunningAttemptRow[];
      const uncertainEffects = database
        .prepare(
          `
          SELECT id, attempt_id, node_id
          FROM workflow_effects
          WHERE run_id = ? AND status IN ('starting', 'uncertain')
        `,
        )
        .all(run.id) as Array<{
        id: string;
        attempt_id: string | null;
        node_id: string;
      }>;
      const uncertainAttemptIds = new Set(
        uncertainEffects.flatMap((effect) =>
          effect.attempt_id ? [effect.attempt_id] : [],
        ),
      );
      const error = {
        code: "flow_attempt_interrupted",
        message:
          "The application restarted before this node committed a result.",
        retryable: true,
      };
      const errorJson = stringifyJsonObjectColumn(error, {
        table: "workflow_node_attempts",
        column: "error_json",
        id: run.id,
      });

      for (const effect of uncertainEffects) {
        database
          .prepare(
            `
            UPDATE workflow_effects
            SET status = 'uncertain', error_json = ?, updated_at = ?,
              completed_at = NULL
            WHERE id = ? AND status IN ('starting', 'uncertain')
          `,
          )
          .run(errorJson, now, effect.id);
        uncertainEffectIds.push(effect.id);
      }
      for (const attempt of attempts) {
        database
          .prepare(
            `
            UPDATE workflow_node_attempts
            SET status = ?, error_json = ?, finished_at = ?
            WHERE id = ? AND status = 'running'
          `,
          )
          .run(
            uncertainAttemptIds.has(attempt.id) ? "uncertain" : "failed",
            errorJson,
            now,
            attempt.id,
          );
      }

      const checkpointRow = database
        .prepare(
          `
          SELECT revision, state_json
          FROM workflow_cycle_checkpoints
          WHERE cycle_id = ?
        `,
        )
        .get(run.cycle_id) as
        | { revision: number; state_json: string }
        | undefined;
      const checkpoint = checkpointRow
        ? readCheckpoint(checkpointRow.state_json, run.cycle_id)
        : null;
      const uncertainParentIds = new Set(
        uncertainEffects.map((effect) => effect.node_id),
      );
      const affectedNodeIds = new Set<string>();
      if (checkpoint) {
        for (const [nodeId, state] of Object.entries(checkpoint.nodes)) {
          if (state.status === "running") {
            affectedNodeIds.add(nodeId);
          }
        }
      }
      for (const attempt of attempts) {
        const parentId = checkpoint
          ? resolveCheckpointNodeId(checkpoint, attempt.node_id)
          : attempt.node_id;
        affectedNodeIds.add(parentId);
        if (uncertainAttemptIds.has(attempt.id)) {
          uncertainParentIds.add(parentId);
        }
      }
      for (const effect of uncertainEffects) {
        affectedNodeIds.add(effect.node_id);
      }
      const pausedUncertain = uncertainParentIds.size > 0;
      const currentNodeId = [...affectedNodeIds][0] ?? null;

      if (checkpoint && checkpointRow) {
        for (const [nodeId, state] of Object.entries(checkpoint.nodes)) {
          if (state.status === "queued") {
            state.status = "idle";
          }
          if (!affectedNodeIds.has(nodeId)) {
            continue;
          }
          state.status = uncertainParentIds.has(nodeId)
            ? "uncertain"
            : "failed";
          state.error = error;
          delete state.waitingReason;
        }
        const checkpointUpdated = database
          .prepare(
            `
            UPDATE workflow_cycle_checkpoints
            SET revision = revision + 1, state_json = ?, updated_at = ?
            WHERE cycle_id = ? AND revision = ?
          `,
          )
          .run(
            stringifyJsonObjectColumn(
              checkpoint as unknown as FlowV1JsonObject,
              {
                table: "workflow_cycle_checkpoints",
                column: "state_json",
                id: run.cycle_id,
              },
            ),
            now,
            run.cycle_id,
            checkpointRow.revision,
          ).changes;
        if (checkpointUpdated !== 1) {
          throw new Error(
            `Cycle ${run.cycle_id} checkpoint changed during startup recovery.`,
          );
        }
      }
      database
        .prepare(
          `
          UPDATE workflow_cycles
          SET status = ?, current_node_id = COALESCE(?, current_node_id)
          WHERE id = ? AND status NOT IN ('completed', 'canceled')
        `,
        )
        .run(
          pausedUncertain ? "paused_uncertain" : "paused_failed",
          currentNodeId,
          run.cycle_id,
        );
      database
        .prepare(
          `
          UPDATE workflow_runs
          SET status = 'interrupted', stop_reason = ?, result_json = ?,
            finished_at = ?, owner_token = NULL, owner_claimed_at = NULL
          WHERE id = ? AND status = 'running'
            AND owner_token = ?
        `,
        )
        .run(
          pausedUncertain ? "paused_uncertain" : "paused_failed",
          stringifyJsonObjectColumn(error, {
            table: "workflow_runs",
            column: "result_json",
            id: run.id,
          }),
          now,
          run.id,
          recoveryToken,
        );
      interruptedRunIds.push(run.id);
    }

    const pendingRunIds = (
      database
        .prepare(
          `
          SELECT id
          FROM workflow_runs
          WHERE cycle_id IS NOT NULL
            AND status = 'pending'
          ORDER BY started_at ASC
        `,
        )
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
    return {
      interruptedRunIds,
      uncertainEffectIds,
      pendingRunIds,
    };
  })();
}

function readCheckpoint(
  stateJson: string,
  cycleId: string,
): FlowV1GraphCheckpoint | null {
  const value = parseJsonObjectColumn(stateJson, {
    table: "workflow_cycle_checkpoints",
    column: "state_json",
    id: cycleId,
  });
  if (
    !value.nodes ||
    Array.isArray(value.nodes) ||
    typeof value.nodes !== "object"
  ) {
    return null;
  }
  return value as unknown as FlowV1GraphCheckpoint;
}

function resolveCheckpointNodeId(
  checkpoint: FlowV1GraphCheckpoint,
  attemptNodeId: string,
): string {
  if (checkpoint.nodes[attemptNodeId]) {
    return attemptNodeId;
  }
  const segments = attemptNodeId.split(".");
  while (segments.length > 1) {
    segments.pop();
    const candidate = segments.join(".");
    if (checkpoint.nodes[candidate]) {
      return candidate;
    }
  }
  return attemptNodeId;
}
