import { randomUUID } from "node:crypto";
import {
  FLOW_V1_EFFECT_STATUSES,
  FLOW_V1_NODE_STATUSES,
  type FlowV1EffectRecord,
  type FlowV1EffectStatus,
  type FlowV1JsonObject,
  type FlowV1JsonValue,
  type FlowV1NodeAttemptRecord,
  type FlowV1NodeStatus,
} from "@/lib/flow-v1/types";
import { getDb } from "../client";
import {
  parseJsonObjectColumn,
  parseJsonValueColumn,
  stringifyJsonObjectColumn,
  stringifyJsonValueColumn,
} from "./json-schemas";
import { FlowV1PersistenceError } from "./flow-runtime";

type AttemptRow = {
  id: string;
  cycle_id: string;
  run_id: string;
  node_id: string;
  sequence: number;
  status: string;
  input_json: string;
  output_json: string | null;
  error_json: string | null;
  control_outcome: string | null;
  agent_session_key: string | null;
  agent_session_id: string | null;
  started_at: string;
  finished_at: string | null;
};

type EffectRow = {
  id: string;
  cycle_id: string;
  run_id: string;
  node_id: string;
  attempt_id: string | null;
  idempotency_key: string;
  status: string;
  external_ref: string | null;
  result_json: string | null;
  error_json: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
};

export function startFlowV1NodeAttempt(input: {
  cycleId: string;
  runId: string;
  ownerToken: string;
  nodeId: string;
  nodeInput: FlowV1JsonObject;
  agentSessionKey?: string;
  agentSessionId?: string;
}): FlowV1NodeAttemptRecord {
  assertTickOwnership(input.runId, input.cycleId, input.ownerToken);
  if (!input.nodeId.trim()) {
    throw new FlowV1PersistenceError(
      "flow_node_id_invalid",
      "nodeId must be non-empty.",
    );
  }
  const database = getDb();
  return database.transaction(() => {
    const id = randomUUID();
    const agentSessionKey = input.agentSessionKey?.trim() || null;
    const inheritedSessionId =
      input.agentSessionId?.trim() ||
      (agentSessionKey
        ? (
            database
              .prepare(
                `
                SELECT agent_session_id
                FROM workflow_node_attempts
                WHERE cycle_id = ? AND agent_session_key = ?
                  AND agent_session_id IS NOT NULL
                ORDER BY started_at DESC, rowid DESC
                LIMIT 1
              `,
              )
              .get(input.cycleId, agentSessionKey) as
              | { agent_session_id: string }
              | undefined
          )?.agent_session_id
        : undefined);
    const sequence = (
      database
        .prepare(
          `
          SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
          FROM workflow_node_attempts
          WHERE cycle_id = ? AND node_id = ?
        `,
        )
        .get(input.cycleId, input.nodeId) as { sequence: number }
    ).sequence;
    database
      .prepare(
        `
        INSERT INTO workflow_node_attempts (
          id, cycle_id, run_id, node_id, sequence, status, input_json,
          output_json, error_json, control_outcome, agent_session_key,
          agent_session_id,
          started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, ?, ?, ?, NULL)
      `,
      )
      .run(
        id,
        input.cycleId,
        input.runId,
        input.nodeId,
        sequence,
        stringifyJsonObjectColumn(input.nodeInput, {
          table: "workflow_node_attempts",
          column: "input_json",
          id,
        }),
        agentSessionKey,
        inheritedSessionId ?? null,
        new Date().toISOString(),
      );
    return requireAttempt(id);
  })();
}

export function finishFlowV1NodeAttempt(input: {
  attemptId: string;
  ownerToken: string;
  status: Extract<
    FlowV1NodeStatus,
    "completed" | "failed" | "waiting" | "canceled" | "uncertain" | "not_selected"
  >;
  output?: FlowV1JsonValue;
  error?: FlowV1JsonObject;
  controlOutcome?: string;
}): { transitioned: boolean; attempt: FlowV1NodeAttemptRecord | null } {
  const existing = getFlowV1NodeAttempt(input.attemptId);
  if (!existing) {
    return { transitioned: false, attempt: null };
  }
  assertTickOwnership(
    existing.runId,
    existing.cycleId,
    input.ownerToken,
  );
  const transitioned = getDb()
    .prepare(
      `
      UPDATE workflow_node_attempts
      SET status = ?, output_json = ?, error_json = ?, control_outcome = ?,
        finished_at = ?
      WHERE id = ? AND status = 'running'
    `,
    )
    .run(
      input.status,
      input.output === undefined
        ? null
        : stringifyJsonValueColumn(input.output, {
            table: "workflow_node_attempts",
            column: "output_json",
            id: input.attemptId,
          }),
      input.error === undefined
        ? null
        : stringifyJsonObjectColumn(input.error, {
            table: "workflow_node_attempts",
            column: "error_json",
            id: input.attemptId,
          }),
      input.controlOutcome ?? null,
      new Date().toISOString(),
      input.attemptId,
    ).changes;
  return {
    transitioned: transitioned === 1,
    attempt: getFlowV1NodeAttempt(input.attemptId),
  };
}

export function getFlowV1NodeAttempt(
  attemptId: string,
): FlowV1NodeAttemptRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_node_attempts WHERE id = ?")
    .get(attemptId) as AttemptRow | undefined;
  return row ? mapAttempt(row) : null;
}

export function setFlowV1NodeAttemptAgentSession(input: {
  attemptId: string;
  ownerToken: string;
  agentSessionId: string;
}): { updated: boolean; attempt: FlowV1NodeAttemptRecord | null } {
  const existing = getFlowV1NodeAttempt(input.attemptId);
  if (!existing) {
    return { updated: false, attempt: null };
  }
  assertTickOwnership(existing.runId, existing.cycleId, input.ownerToken);
  if (!input.agentSessionId.trim()) {
    throw new FlowV1PersistenceError(
      "flow_agent_session_id_invalid",
      "agentSessionId must be non-empty.",
    );
  }
  const updated = getDb()
    .prepare(
      `
      UPDATE workflow_node_attempts
      SET agent_session_id = ?
      WHERE id = ? AND status = 'running'
    `,
    )
    .run(input.agentSessionId.trim(), input.attemptId).changes;
  return {
    updated: updated === 1,
    attempt: getFlowV1NodeAttempt(input.attemptId),
  };
}

export function listFlowV1NodeAttempts(
  cycleId: string,
): FlowV1NodeAttemptRecord[] {
  return (
    getDb()
      .prepare(
        `
        SELECT * FROM workflow_node_attempts
        WHERE cycle_id = ?
        ORDER BY started_at ASC, rowid ASC
      `,
      )
      .all(cycleId) as AttemptRow[]
  ).map(mapAttempt);
}

export function startFlowV1Effect(input: {
  cycleId: string;
  runId: string;
  ownerToken: string;
  nodeId: string;
  attemptId?: string;
  idempotencyKey: string;
}): { created: boolean; effect: FlowV1EffectRecord } {
  assertTickOwnership(input.runId, input.cycleId, input.ownerToken);
  if (!input.idempotencyKey.trim()) {
    throw new FlowV1PersistenceError(
      "flow_effect_idempotency_key_invalid",
      "Effect idempotencyKey must be non-empty.",
    );
  }
  const database = getDb();
  return database.transaction(() => {
    const existing = database
      .prepare(
        `
        SELECT * FROM workflow_effects
        WHERE cycle_id = ? AND node_id = ? AND idempotency_key = ?
      `,
      )
      .get(
        input.cycleId,
        input.nodeId,
        input.idempotencyKey,
      ) as EffectRow | undefined;
    if (existing) {
      return { created: false, effect: mapEffect(existing) };
    }
    if (input.attemptId) {
      const attempt = getFlowV1NodeAttempt(input.attemptId);
      if (
        !attempt ||
        attempt.cycleId !== input.cycleId ||
        attempt.runId !== input.runId ||
        attempt.nodeId !== input.nodeId
      ) {
        throw new FlowV1PersistenceError(
          "flow_effect_attempt_invalid",
          `Attempt ${input.attemptId} does not belong to this Effect execution.`,
        );
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    database
      .prepare(
        `
        INSERT INTO workflow_effects (
          id, cycle_id, run_id, node_id, attempt_id, idempotency_key,
          status, external_ref, result_json, error_json, started_at,
          updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'starting', NULL, NULL, NULL, ?, ?, NULL)
      `,
      )
      .run(
        id,
        input.cycleId,
        input.runId,
        input.nodeId,
        input.attemptId ?? null,
        input.idempotencyKey,
        now,
        now,
      );
    return { created: true, effect: requireEffect(id) };
  })();
}

export function transitionFlowV1Effect(input: {
  effectId: string;
  runId: string;
  ownerToken: string;
  status: Extract<
    FlowV1EffectStatus,
    "completed" | "not_applied" | "uncertain" | "failed"
  >;
  externalRef?: string;
  result?: FlowV1JsonValue;
  error?: FlowV1JsonObject;
}): { transitioned: boolean; effect: FlowV1EffectRecord | null } {
  const existing = getFlowV1Effect(input.effectId);
  if (!existing) {
    return { transitioned: false, effect: null };
  }
  assertTickOwnership(
    input.runId,
    existing.cycleId,
    input.ownerToken,
  );
  const terminal =
    input.status === "completed" || input.status === "not_applied";
  const now = new Date().toISOString();
  const transitioned = getDb()
    .prepare(
      `
      UPDATE workflow_effects
      SET status = ?, external_ref = COALESCE(?, external_ref),
        result_json = ?, error_json = ?, updated_at = ?,
        completed_at = CASE WHEN ? THEN ? ELSE NULL END
      WHERE id = ? AND status IN ('starting', 'uncertain')
    `,
    )
    .run(
      input.status,
      input.externalRef ?? null,
      input.result === undefined
        ? null
        : stringifyJsonValueColumn(input.result, {
            table: "workflow_effects",
            column: "result_json",
            id: input.effectId,
          }),
      input.error === undefined
        ? null
        : stringifyJsonObjectColumn(input.error, {
            table: "workflow_effects",
            column: "error_json",
            id: input.effectId,
          }),
      now,
      terminal ? 1 : 0,
      terminal ? now : null,
      input.effectId,
    ).changes;
  return {
    transitioned: transitioned === 1,
    effect: getFlowV1Effect(input.effectId),
  };
}

export function getFlowV1Effect(
  effectId: string,
): FlowV1EffectRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_effects WHERE id = ?")
    .get(effectId) as EffectRow | undefined;
  return row ? mapEffect(row) : null;
}

export function listFlowV1Effects(cycleId: string): FlowV1EffectRecord[] {
  return (
    getDb()
      .prepare(
        `
        SELECT * FROM workflow_effects
        WHERE cycle_id = ?
        ORDER BY started_at ASC, rowid ASC
      `,
      )
      .all(cycleId) as EffectRow[]
  ).map(mapEffect);
}

function assertTickOwnership(
  runId: string,
  cycleId: string,
  ownerToken: string,
): void {
  const row = getDb()
    .prepare(
      `
      SELECT id FROM workflow_runs
      WHERE id = ? AND cycle_id = ? AND status = 'running'
        AND owner_token = ?
    `,
    )
    .get(runId, cycleId, ownerToken) as { id: string } | undefined;
  if (!row) {
    throw new FlowV1PersistenceError(
      "flow_tick_not_owned",
      `Tick ${runId} is not owned by the supplied execution token.`,
    );
  }
}

function requireAttempt(attemptId: string): FlowV1NodeAttemptRecord {
  const attempt = getFlowV1NodeAttempt(attemptId);
  if (!attempt) {
    throw new Error(`Node Attempt ${attemptId} was not persisted.`);
  }
  return attempt;
}

function requireEffect(effectId: string): FlowV1EffectRecord {
  const effect = getFlowV1Effect(effectId);
  if (!effect) {
    throw new Error(`Effect ${effectId} was not persisted.`);
  }
  return effect;
}

function mapAttempt(row: AttemptRow): FlowV1NodeAttemptRecord {
  if (!FLOW_V1_NODE_STATUSES.includes(row.status as FlowV1NodeStatus)) {
    throw corruptStatus("Node Attempt", row.id, row.status);
  }
  return {
    id: row.id,
    cycleId: row.cycle_id,
    runId: row.run_id,
    nodeId: row.node_id,
    sequence: row.sequence,
    status: row.status as FlowV1NodeStatus,
    input: parseJsonObjectColumn(row.input_json, {
      table: "workflow_node_attempts",
      column: "input_json",
      id: row.id,
    }),
    output: row.output_json
      ? parseJsonValueColumn(row.output_json, {
          table: "workflow_node_attempts",
          column: "output_json",
          id: row.id,
        })
      : null,
    error: row.error_json
      ? parseJsonObjectColumn(row.error_json, {
          table: "workflow_node_attempts",
          column: "error_json",
          id: row.id,
        })
      : null,
    controlOutcome: row.control_outcome,
    agentSessionKey: row.agent_session_key,
    agentSessionId: row.agent_session_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapEffect(row: EffectRow): FlowV1EffectRecord {
  if (!FLOW_V1_EFFECT_STATUSES.includes(row.status as FlowV1EffectStatus)) {
    throw corruptStatus("Effect", row.id, row.status);
  }
  return {
    id: row.id,
    cycleId: row.cycle_id,
    runId: row.run_id,
    nodeId: row.node_id,
    attemptId: row.attempt_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as FlowV1EffectStatus,
    externalRef: row.external_ref,
    result: row.result_json
      ? parseJsonValueColumn(row.result_json, {
          table: "workflow_effects",
          column: "result_json",
          id: row.id,
        })
      : null,
    error: row.error_json
      ? parseJsonObjectColumn(row.error_json, {
          table: "workflow_effects",
          column: "error_json",
          id: row.id,
        })
      : null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function corruptStatus(
  kind: string,
  id: string,
  status: string,
): FlowV1PersistenceError {
  return new FlowV1PersistenceError(
    "flow_persistence_corrupt",
    `${kind} ${id} has invalid status "${status}".`,
  );
}
