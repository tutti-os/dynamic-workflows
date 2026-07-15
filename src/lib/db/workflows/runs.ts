import { randomUUID } from "node:crypto";
import { getDb, getRunLogPath } from "../client";
import type { WorkflowLoopRecoveryState } from "@/lib/workflow/types";
import {
  stringifyJsonObjectColumn,
  stringifyWorkflowLoopRecoveryStateColumn,
} from "./json-schemas";
import {
  mapRun,
  mapRunCheckpoint,
  type RunCheckpointRow,
  type RunRow,
} from "./mappers";
import type {
  WorkflowRunCheckpointRecord,
  WorkflowRunRecord,
  WorkflowRunResumeClaim,
  WorkflowRunStatus,
} from "./types";

export function createWorkflowRun(input: {
  workflowId: string;
  workflowVersionId: string;
  executorKind: string;
  agent?: string;
  model?: string;
  cwd?: string;
  request: unknown;
  executionToken?: string;
}): WorkflowRunRecord {
  const now = new Date().toISOString();
  const runId = randomUUID();
  const logPath = getRunLogPath(runId);
  const database = getDb();

  return database.transaction(() => {
    database
      .prepare(
        `
        INSERT INTO workflow_runs (
          id, workflow_id, workflow_version_id, executor_kind, external_run_id,
          status, agent, model, cwd, input_json, result_json, log_path,
          started_at, finished_at, resume_token, resume_claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        runId,
        input.workflowId,
        input.workflowVersionId,
        input.executorKind,
        null,
        "running",
        input.agent ?? null,
        input.model ?? null,
        input.cwd ?? null,
        stringifyJsonObjectColumn(input.request, {
          table: "workflow_runs",
          column: "input_json",
          id: runId,
        }),
        null,
        logPath,
        now,
        null,
        input.executionToken ?? null,
        input.executionToken ? now : null,
      );

    const run = getWorkflowRun(runId);
    if (!run) {
      throw new Error("Failed to create workflow run");
    }
    return run;
  })();
}

export function isWorkflowRunExecutionClaimed(runId: string): boolean {
  const freshAfter = new Date(Date.now() - 60_000).toISOString();
  const row = getDb().prepare(`
    SELECT 1 AS claimed
    FROM workflow_runs
    WHERE id = ? AND status = 'running' AND resume_token IS NOT NULL
      AND resume_claimed_at >= ?
  `).get(runId, freshAfter) as { claimed: number } | undefined;
  return Boolean(row?.claimed);
}

export function touchWorkflowRunExecutionClaim(input: {
  runId: string;
  executionToken: string;
}): boolean {
  const result = getDb().prepare(`
    UPDATE workflow_runs
    SET resume_claimed_at = ?
    WHERE id = ? AND resume_token = ? AND status = 'running'
  `).run(new Date().toISOString(), input.runId, input.executionToken);
  return result.changes === 1;
}

export function isWorkflowRunExecutionOwned(input: {
  runId: string;
  executionToken: string;
}): boolean {
  const row = getDb().prepare(`
    SELECT 1 AS owned
    FROM workflow_runs
    WHERE id = ? AND resume_token = ? AND status = 'running'
  `).get(input.runId, input.executionToken) as { owned: number } | undefined;
  return Boolean(row?.owned);
}

export function markWorkflowRunWaitingOwned(input: {
  runId: string;
  executionToken: string;
  result: unknown;
  pendingTaskIds: string[];
}): { run: WorkflowRunRecord | null; transitioned: boolean } {
  if (input.pendingTaskIds.length === 0) {
    return { run: getWorkflowRun(input.runId), transitioned: false };
  }
  const database = getDb();
  return database.transaction(() => {
    const placeholders = input.pendingTaskIds.map(() => "?").join(", ");
    const result = database.prepare(`
      UPDATE workflow_runs
      SET status = 'waiting_for_human',
        result_json = ?,
        finished_at = NULL,
        resume_token = NULL,
        resume_claimed_at = NULL
      WHERE id = ?
        AND status = 'running'
        AND resume_token = ?
        AND NOT EXISTS (
          SELECT 1 FROM workflow_run_human_tasks tasks
          WHERE tasks.run_id = workflow_runs.id
            AND tasks.id IN (${placeholders})
            AND tasks.status <> 'pending'
        )
        AND (
          SELECT COUNT(*) FROM workflow_run_human_tasks tasks
          WHERE tasks.run_id = workflow_runs.id
            AND tasks.id IN (${placeholders})
        ) = ?
    `).run(
      stringifyJsonObjectColumn(input.result, {
        table: "workflow_runs",
        column: "result_json",
        id: input.runId,
      }),
      input.runId,
      input.executionToken,
      ...input.pendingTaskIds,
      ...input.pendingTaskIds,
      input.pendingTaskIds.length,
    );
    return {
      run: getWorkflowRun(input.runId),
      transitioned: result.changes === 1,
    };
  })();
}

export function finalizeWorkflowRunExecution(input: {
  runId: string;
  executionToken: string;
  status: Extract<WorkflowRunStatus, "completed" | "failed" | "canceled">;
  result: unknown;
}): { run: WorkflowRunRecord | null; transitioned: boolean } {
  const database = getDb();
  return database.transaction(() => {
    const result = database.prepare(`
      UPDATE workflow_runs
      SET status = ?, result_json = ?, finished_at = ?,
        resume_token = NULL, resume_claimed_at = NULL
      WHERE id = ?
        AND resume_token = ?
        AND (
          status = 'running'
          OR (status = 'canceled' AND ? = 'canceled')
        )
    `).run(
      input.status,
      stringifyJsonObjectColumn(input.result, {
        table: "workflow_runs",
        column: "result_json",
        id: input.runId,
      }),
      new Date().toISOString(),
      input.runId,
      input.executionToken,
      input.status,
    );
    if (result.changes === 1) {
      cancelPendingHumanTasks(database, input.runId);
    }
    return {
      run: getWorkflowRun(input.runId),
      transitioned: result.changes === 1,
    };
  })();
}

export function cancelWorkflowRunAndHumanTasks(input: {
  runId: string;
  result: unknown;
}): { run: WorkflowRunRecord | null; transitioned: boolean } {
  const database = getDb();
  return database.transaction(() => {
    const result = database.prepare(`
      UPDATE workflow_runs
      SET status = 'canceled', result_json = ?, finished_at = ?
      WHERE id = ?
        AND status NOT IN ('completed', 'failed', 'canceled')
    `).run(
      stringifyJsonObjectColumn(input.result, {
        table: "workflow_runs",
        column: "result_json",
        id: input.runId,
      }),
      new Date().toISOString(),
      input.runId,
    );
    if (result.changes === 1) {
      cancelPendingHumanTasks(database, input.runId);
    }
    return {
      run: getWorkflowRun(input.runId),
      transitioned: result.changes === 1,
    };
  })();
}

function cancelPendingHumanTasks(
  database: ReturnType<typeof getDb>,
  runId: string,
): void {
  database.prepare(`
    UPDATE workflow_run_human_tasks
    SET status = 'canceled', revision = revision + 1,
      resolved_at = COALESCE(resolved_at, ?)
    WHERE run_id = ? AND status = 'pending'
  `).run(new Date().toISOString(), runId);
}

export function updateWorkflowRun(input: {
  runId: string;
  status: WorkflowRunStatus;
  result?: unknown;
  finishedAt?: string;
}): WorkflowRunRecord | null {
  const database = getDb();
  return database.transaction(() => {
    database
      .prepare(
        `
        UPDATE workflow_runs
        SET status = ?,
          result_json = ?,
          finished_at = ?,
          resume_token = NULL,
          resume_claimed_at = NULL
        WHERE id = ?
      `,
      )
      .run(
        input.status,
        input.result === undefined
          ? null
          : stringifyJsonObjectColumn(input.result, {
              table: "workflow_runs",
              column: "result_json",
              id: input.runId,
            }),
        input.finishedAt ?? new Date().toISOString(),
        input.runId,
      );

    return getWorkflowRun(input.runId);
  })();
}

export function markWorkflowRunRunning(input: {
  runId: string;
  result?: unknown;
}): WorkflowRunRecord | null {
  const database = getDb();
  return database.transaction(() => {
    database
      .prepare(
        `
        UPDATE workflow_runs
        SET status = 'running',
          result_json = COALESCE(?, result_json),
          finished_at = NULL,
          resume_token = NULL,
          resume_claimed_at = NULL
        WHERE id = ?
      `,
      )
      .run(
        input.result === undefined
          ? null
          : stringifyJsonObjectColumn(input.result, {
              table: "workflow_runs",
              column: "result_json",
              id: input.runId,
            }),
        input.runId,
      );

    return getWorkflowRun(input.runId);
  })();
}

export function markWorkflowRunWaiting(input: {
  runId: string;
  result?: unknown;
}): WorkflowRunRecord | null {
  const database = getDb();
  return database.transaction(() => {
    database.prepare(`
      UPDATE workflow_runs
      SET status = 'waiting_for_human',
        result_json = COALESCE(?, result_json),
        finished_at = NULL,
        resume_token = NULL,
        resume_claimed_at = NULL
      WHERE id = ?
    `).run(
      input.result === undefined
        ? null
        : stringifyJsonObjectColumn(input.result, {
            table: "workflow_runs",
            column: "result_json",
            id: input.runId,
          }),
      input.runId,
    );
    return getWorkflowRun(input.runId);
  })();
}

export function markWorkflowRunInterrupted(input: {
  runId: string;
  result?: unknown;
}): WorkflowRunRecord | null {
  const now = new Date().toISOString();
  const database = getDb();
  return database.transaction(() => {
    database
      .prepare(
        `
        UPDATE workflow_runs
        SET status = 'interrupted',
          result_json = COALESCE(?, result_json),
          finished_at = ?,
          resume_token = NULL,
          resume_claimed_at = NULL
        WHERE id = ?
          AND status = 'running'
      `,
      )
      .run(
        input.result === undefined
          ? null
          : stringifyJsonObjectColumn(input.result, {
              table: "workflow_runs",
              column: "result_json",
              id: input.runId,
            }),
        now,
        input.runId,
      );

    return getWorkflowRun(input.runId);
  })();
}

export function claimWorkflowRunForResume(input: {
  workflowId: string;
  runId: string;
  result?: unknown;
}): WorkflowRunResumeClaim | null {
  const database = getDb();
  const token = randomUUID();
  const now = new Date().toISOString();

  return database.transaction(() => {
    const result = database
      .prepare(
        `
        UPDATE workflow_runs
        SET status = 'running',
          result_json = COALESCE(?, result_json),
          finished_at = NULL,
          resume_token = ?,
          resume_claimed_at = ?
        WHERE id = ?
          AND workflow_id = ?
          AND status IN ('running', 'interrupted', 'waiting_for_human')
          AND resume_token IS NULL
      `,
      )
      .run(
        input.result === undefined
          ? null
          : stringifyJsonObjectColumn(input.result, {
              table: "workflow_runs",
              column: "result_json",
              id: input.runId,
            }),
        token,
        now,
        input.runId,
        input.workflowId,
      );

    if (result.changes === 0) {
      return null;
    }

    const run = getWorkflowRun(input.runId);
    if (!run) {
      throw new Error("Workflow run not found after resume claim");
    }
    return { run, token };
  })();
}

export function releaseWorkflowRunResumeClaim(input: {
  runId: string;
  token: string;
}): WorkflowRunRecord | null {
  const database = getDb();
  return database.transaction(() => {
    database
      .prepare(
        `
        UPDATE workflow_runs
        SET resume_token = NULL,
          resume_claimed_at = NULL
        WHERE id = ?
          AND resume_token = ?
      `,
      )
      .run(input.runId, input.token);

    return getWorkflowRun(input.runId);
  })();
}

export function getWorkflowRun(runId: string): WorkflowRunRecord | null {
  const row = getDb()
    .prepare(`
      SELECT workflow_runs.*,
        (SELECT COUNT(*) FROM workflow_run_human_tasks tasks
          WHERE tasks.run_id = workflow_runs.id AND tasks.status = 'pending')
          AS pending_human_task_count
      FROM workflow_runs WHERE id = ?
    `)
    .get(runId) as RunRow | undefined;
  return row ? mapRun(row) : null;
}

export function upsertWorkflowRunCheckpoint(input: {
  runId: string;
  nodeId: string;
  checkpoint: WorkflowLoopRecoveryState;
}): WorkflowRunCheckpointRecord {
  const now = new Date().toISOString();
  const database = getDb();
  return database.transaction(() => {
    database
      .prepare(
        `
        INSERT INTO workflow_run_checkpoints (
          run_id, node_id, checkpoint_json, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, node_id) DO UPDATE SET
          checkpoint_json = excluded.checkpoint_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        input.runId,
        input.nodeId,
        stringifyWorkflowLoopRecoveryStateColumn(input.checkpoint, {
          table: "workflow_run_checkpoints",
          column: "checkpoint_json",
          id: `${input.runId}:${input.nodeId}`,
        }),
        now,
      );

    const checkpoint = getWorkflowRunCheckpoint(input.runId, input.nodeId);
    if (!checkpoint) {
      throw new Error("Failed to save workflow run checkpoint");
    }
    return checkpoint;
  })();
}

export function getWorkflowRunCheckpoint(
  runId: string,
  nodeId: string,
): WorkflowRunCheckpointRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT * FROM workflow_run_checkpoints
      WHERE run_id = ? AND node_id = ?
    `,
    )
    .get(runId, nodeId) as RunCheckpointRow | undefined;
  return row ? mapRunCheckpoint(row) : null;
}

export function listWorkflowRunCheckpoints(
  runId: string,
): WorkflowRunCheckpointRecord[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM workflow_run_checkpoints
      WHERE run_id = ?
      ORDER BY updated_at ASC
    `,
    )
    .all(runId) as RunCheckpointRow[];
  return rows.map(mapRunCheckpoint);
}

export function listWorkflowRuns(workflowId: string): WorkflowRunRecord[] {
  const rows = getDb()
    .prepare(
      `
      SELECT workflow_runs.*,
        (SELECT COUNT(*) FROM workflow_run_human_tasks tasks
          WHERE tasks.run_id = workflow_runs.id AND tasks.status = 'pending')
          AS pending_human_task_count
      FROM workflow_runs
      WHERE workflow_id = ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT 50
    `,
    )
    .all(workflowId) as RunRow[];
  return rows.map(mapRun);
}

export function countWorkflowRuns(workflowId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE workflow_id = ?")
    .get(workflowId) as { count: number };
  return row.count;
}

export function getLatestWorkflowRun(workflowId: string): WorkflowRunRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT workflow_runs.*,
        (SELECT COUNT(*) FROM workflow_run_human_tasks tasks
          WHERE tasks.run_id = workflow_runs.id AND tasks.status = 'pending')
          AS pending_human_task_count
      FROM workflow_runs
      WHERE workflow_id = ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `,
    )
    .get(workflowId) as RunRow | undefined;
  return row ? mapRun(row) : null;
}
