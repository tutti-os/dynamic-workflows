import { randomUUID } from "node:crypto";
import { getDb } from "../client";
import {
  parseJsonObjectColumn,
  parseJsonValueColumn,
  stringifyJsonObjectColumn,
  stringifyJsonValueColumn,
} from "./json-schemas";
import type {
  RenderedWorkflowHumanContextItem,
  RenderedWorkflowHumanSpec,
  WorkflowHumanAction,
  WorkflowHumanTask,
  WorkflowHumanTaskRequest,
  WorkflowHumanTaskResponse,
  WorkflowHumanTaskStatus,
  WorkflowValue,
} from "@/lib/workflow/types";

type HumanTaskRow = {
  id: string;
  run_id: string;
  node_id: string;
  parent_node_id: string | null;
  iteration: number | null;
  execution_key: string;
  status: WorkflowHumanTaskStatus;
  spec_json: string;
  context_json: string;
  response_json: string | null;
  revision: number;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
};

export class HumanTaskValidationError extends Error {}
export class HumanTaskConflictError extends Error {}

export function createOrGetWorkflowHumanTask(
  request: WorkflowHumanTaskRequest,
): WorkflowHumanTask {
  const database = getDb();
  return database.transaction(() => {
    const existing = getWorkflowHumanTaskByExecutionKey(
      request.runId,
      request.executionKey,
    );
    if (existing) {
      return existing;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const spec = {
      ...(request.spec.description !== undefined
        ? { description: request.spec.description }
        : {}),
      actions: request.spec.actions,
    };
    database.prepare(`
      INSERT OR IGNORE INTO workflow_run_human_tasks (
        id, run_id, node_id, parent_node_id, iteration, execution_key,
        status, spec_json, context_json, response_json, revision,
        created_at, resolved_at, resolved_by
      )
      SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, 1, ?, NULL, NULL
      WHERE EXISTS (
        SELECT 1 FROM workflow_runs runs
        WHERE runs.id = ?
          AND runs.status IN ('running', 'waiting_for_human', 'interrupted')
      )
    `).run(
      id,
      request.runId,
      request.nodeId,
      request.parentNodeId ?? null,
      request.iteration ?? null,
      request.executionKey,
      stringifyJsonObjectColumn(spec, context(id, "spec_json")),
      stringifyJsonValueColumn(request.spec.context, context(id, "context_json")),
      now,
      request.runId,
    );
    const task = getWorkflowHumanTaskByExecutionKey(
      request.runId,
      request.executionKey,
    );
    if (!task) {
      throw new HumanTaskConflictError(
        "Workflow run no longer accepts human tasks.",
      );
    }
    return task;
  })();
}

export function getWorkflowHumanTask(taskId: string): WorkflowHumanTask | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_run_human_tasks WHERE id = ?")
    .get(taskId) as HumanTaskRow | undefined;
  return row ? mapHumanTask(row) : null;
}

export function getWorkflowHumanTaskByExecutionKey(
  runId: string,
  executionKey: string,
): WorkflowHumanTask | null {
  const row = getDb()
    .prepare(`
      SELECT * FROM workflow_run_human_tasks
      WHERE run_id = ? AND execution_key = ?
    `)
    .get(runId, executionKey) as HumanTaskRow | undefined;
  return row ? mapHumanTask(row) : null;
}

export function listWorkflowHumanTasks(
  runId: string,
  status?: WorkflowHumanTaskStatus,
): WorkflowHumanTask[] {
  const rows = status
    ? getDb().prepare(`
        SELECT * FROM workflow_run_human_tasks
        WHERE run_id = ? AND status = ?
        ORDER BY created_at ASC, rowid ASC
      `).all(runId, status)
    : getDb().prepare(`
        SELECT * FROM workflow_run_human_tasks
        WHERE run_id = ?
        ORDER BY created_at ASC, rowid ASC
      `).all(runId);
  return (rows as HumanTaskRow[]).map(mapHumanTask);
}

export function countPendingWorkflowHumanTasks(runId: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_run_human_tasks
    WHERE run_id = ? AND status = 'pending'
  `).get(runId) as { count: number };
  return row.count;
}

export function resolveWorkflowHumanTask(input: {
  runId: string;
  taskId: string;
  action: string;
  values: Record<string, WorkflowValue>;
  revision: number;
  resolvedBy?: string;
}): WorkflowHumanTask {
  const database = getDb();
  return database.transaction(() => {
    const task = getWorkflowHumanTask(input.taskId);
    if (!task || task.runId !== input.runId) {
      throw new HumanTaskValidationError("Human task not found.");
    }
    if (task.status !== "pending" || task.revision !== input.revision) {
      throw new HumanTaskConflictError("Human task was already handled.");
    }
    const response = validateResponse(task.spec.actions, input.action, input.values);
    const now = new Date().toISOString();
    const result = database.prepare(`
      UPDATE workflow_run_human_tasks
      SET status = 'resolved', response_json = ?, revision = revision + 1,
        resolved_at = ?, resolved_by = ?
      WHERE id = ? AND run_id = ? AND status = 'pending' AND revision = ?
        AND EXISTS (
          SELECT 1 FROM workflow_runs runs
          WHERE runs.id = workflow_run_human_tasks.run_id
            AND runs.status IN ('running', 'waiting_for_human', 'interrupted')
        )
    `).run(
      stringifyJsonObjectColumn(response, context(task.id, "response_json")),
      now,
      input.resolvedBy ?? null,
      task.id,
      task.runId,
      input.revision,
    );
    if (result.changes !== 1) {
      throw new HumanTaskConflictError(
        "Human task was already handled or its workflow run has finished.",
      );
    }
    const resolved = getWorkflowHumanTask(task.id);
    if (!resolved) {
      throw new Error("Resolved human task could not be loaded.");
    }
    return resolved;
  })();
}

export function cancelPendingWorkflowHumanTasks(runId: string): number {
  const result = getDb().prepare(`
    UPDATE workflow_run_human_tasks
    SET status = 'canceled', revision = revision + 1,
      resolved_at = COALESCE(resolved_at, ?)
    WHERE run_id = ? AND status = 'pending'
  `).run(new Date().toISOString(), runId);
  return result.changes;
}

function validateResponse(
  actions: WorkflowHumanAction[],
  actionId: string,
  values: Record<string, WorkflowValue>,
): WorkflowHumanTaskResponse {
  const action = actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new HumanTaskValidationError(`Unknown human task action "${actionId}".`);
  }
  const fields = new Map(action.fields.map((field) => [field.id, field]));
  for (const key of Object.keys(values)) {
    if (!fields.has(key)) {
      throw new HumanTaskValidationError(`Unknown human task field "${key}".`);
    }
  }
  const normalized: Record<string, WorkflowValue> = {};
  for (const field of action.fields) {
    const raw = values[field.id];
    if (raw !== undefined && typeof raw !== "string") {
      throw new HumanTaskValidationError(`${field.label} must be a string.`);
    }
    const value = typeof raw === "string" ? raw : undefined;
    if (field.required && !value?.trim()) {
      throw new HumanTaskValidationError(`${field.label} is required.`);
    }
    if (value === undefined) {
      continue;
    }
    if (
      field.type === "select" &&
      !field.options?.some((option) => option.value === value)
    ) {
      throw new HumanTaskValidationError(`${field.label} has an invalid option.`);
    }
    normalized[field.id] = value;
  }
  return { action: action.id, values: normalized };
}

function mapHumanTask(row: HumanTaskRow): WorkflowHumanTask {
  const rawSpec = parseJsonObjectColumn(row.spec_json, context(row.id, "spec_json"));
  const rawContext = parseJsonValueColumn(
    row.context_json,
    context(row.id, "context_json"),
  );
  const actions = readActions(rawSpec.actions);
  const renderedContext = readContext(rawContext);
  const response = row.response_json
    ? readResponse(
        parseJsonObjectColumn(
          row.response_json,
          context(row.id, "response_json"),
        ),
      )
    : undefined;
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    ...(row.parent_node_id ? { parentNodeId: row.parent_node_id } : {}),
    ...(row.iteration !== null ? { iteration: row.iteration } : {}),
    executionKey: row.execution_key,
    status: row.status,
    spec: {
      ...(typeof rawSpec.description === "string"
        ? { description: rawSpec.description }
        : {}),
      context: renderedContext,
      actions,
    },
    ...(response ? { response } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
  };
}

function readActions(value: unknown): WorkflowHumanAction[] {
  if (!Array.isArray(value)) {
    throw new Error("Stored human task actions have invalid shape.");
  }
  return value as WorkflowHumanAction[];
}

function readContext(value: unknown): RenderedWorkflowHumanContextItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Stored human task context has invalid shape.");
  }
  return value as RenderedWorkflowHumanContextItem[];
}

function readResponse(value: Record<string, unknown>): WorkflowHumanTaskResponse {
  if (typeof value.action !== "string" || !value.values || typeof value.values !== "object") {
    throw new Error("Stored human task response has invalid shape.");
  }
  return value as WorkflowHumanTaskResponse;
}

function context(id: string, column: string) {
  return { table: "workflow_run_human_tasks", column, id };
}
