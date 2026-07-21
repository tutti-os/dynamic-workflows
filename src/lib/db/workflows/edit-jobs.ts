import { randomUUID } from "node:crypto";
import { workflowVersionNotFoundError } from "@/lib/api/app-error";
import { getDb } from "../client";
import {
  stringifyJsonValueColumn,
  stringifyWorkflowEditJobErrorColumn,
} from "./json-schemas";
import { createWorkflowVersion, getWorkflowVersion } from "./versions";
import { getWorkflowDetail } from "./workflow-repository";
import { mapEditJob, type EditJobRow } from "./mappers";
import type {
  AuthoringSemanticReview,
  WorkflowEditJobError,
  WorkflowEditJobRecord,
} from "./types";

export function createWorkflowEditJob(input: {
  workflowId: string;
  baseVersionId?: string;
  instruction: string;
  agent?: string;
  model?: string;
  cwd?: string;
}): WorkflowEditJobRecord {
  const detail = getWorkflowDetail(input.workflowId);
  if (!detail?.currentVersion) {
    throw workflowVersionNotFoundError();
  }

  const baseVersionId = input.baseVersionId ?? detail.currentVersion.id;
  const baseVersion = getWorkflowVersion(baseVersionId);
  if (!baseVersion || baseVersion.workflowId !== input.workflowId) {
    throw workflowVersionNotFoundError();
  }

  const instruction = input.instruction.trim();
  if (!instruction) {
    throw new Error("Instruction is required");
  }

  const now = new Date().toISOString();
  const editId = randomUUID();
  getDb()
    .prepare(
      `
      INSERT INTO workflow_edit_jobs (
        id, workflow_id, base_version_id, created_version_id, instruction,
        agent, model, cwd, agent_session_id, status, result_json, error_json,
        created_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      editId,
      input.workflowId,
      baseVersionId,
      null,
      instruction,
      input.agent ?? null,
      input.model ?? null,
      input.cwd ?? null,
      null,
      "pending",
      null,
      null,
      now,
      null,
      null,
    );

  const edit = getWorkflowEditJob(editId);
  if (!edit) {
    throw new Error("Failed to create workflow edit");
  }
  return edit;
}

export function getWorkflowEditJob(editId: string): WorkflowEditJobRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_edit_jobs WHERE id = ?")
    .get(editId) as EditJobRow | undefined;
  return row ? mapEditJob(row) : null;
}

export function listWorkflowEditJobs(input: {
  workflowId: string;
  limit?: number;
}): WorkflowEditJobRecord[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM workflow_edit_jobs
      WHERE workflow_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `,
    )
    .all(input.workflowId, input.limit ?? 20) as EditJobRow[];
  return rows.map(mapEditJob);
}

export function markWorkflowEditJobRunning(
  editId: string,
): WorkflowEditJobRecord | null {
  const now = new Date().toISOString();
  const database = getDb();
  return database.transaction(() => {
    const edit = getWorkflowEditJob(editId);
    if (!edit || edit.status === "completed") {
      return null;
    }

    database
      .prepare(
        `
        UPDATE workflow_edit_jobs
        SET status = 'running',
          started_at = COALESCE(started_at, ?),
          finished_at = NULL,
          error_json = NULL
        WHERE id = ?
          AND status != 'completed'
      `,
      )
      .run(now, editId);

    return getWorkflowEditJob(editId);
  })();
}

export function updateWorkflowEditJobAgentSession(input: {
  editId: string;
  agentSessionId: string;
}): WorkflowEditJobRecord | null {
  const database = getDb();
  return database.transaction(() => {
    database
      .prepare(
        `
        UPDATE workflow_edit_jobs
        SET agent_session_id = ?
        WHERE id = ?
      `,
      )
      .run(input.agentSessionId, input.editId);

    return getWorkflowEditJob(input.editId);
  })();
}

export function completeWorkflowEditJob(input: {
  editId: string;
  script: string;
  result: unknown;
  semanticReview: AuthoringSemanticReview;
}): WorkflowEditJobRecord {
  const edit = getWorkflowEditJob(input.editId);
  if (!edit) {
    throw new Error("Workflow edit not found");
  }
  if (edit.status === "canceled") {
    return edit;
  }

  const version = createWorkflowVersion({
    workflowId: edit.workflowId,
    script: input.script,
    publish: false,
    source: "agent_edit",
    baseVersionId: edit.baseVersionId,
    note: edit.instruction,
    semanticReview: input.semanticReview,
  });

  const now = new Date().toISOString();
  const database = getDb();
  const completed = database.transaction(() => {
    database
      .prepare(
        `
        UPDATE workflow_edit_jobs
        SET status = 'completed',
          created_version_id = ?,
          result_json = ?,
          error_json = NULL,
          finished_at = ?
        WHERE id = ?
          AND status != 'canceled'
      `,
      )
      .run(
        version.id,
        stringifyJsonValueColumn(input.result, {
          table: "workflow_edit_jobs",
          column: "result_json",
          id: input.editId,
        }),
        now,
        input.editId,
      );

    return getWorkflowEditJob(input.editId);
  })();
  if (!completed) {
    throw new Error("Workflow edit not found");
  }
  if (completed.status === "canceled") {
    return completed;
  }
  return completed;
}

export function failWorkflowEditJob(input: {
  editId: string;
  error: WorkflowEditJobError;
}): WorkflowEditJobRecord | null {
  const now = new Date().toISOString();
  const database = getDb();
  return database.transaction(() => {
    database
      .prepare(
        `
        UPDATE workflow_edit_jobs
        SET status = 'failed',
          error_json = ?,
          finished_at = ?
        WHERE id = ?
          AND status NOT IN ('completed', 'canceled')
      `,
      )
      .run(
        stringifyWorkflowEditJobErrorColumn(input.error, {
          table: "workflow_edit_jobs",
          column: "error_json",
          id: input.editId,
        }),
        now,
        input.editId,
      );

    return getWorkflowEditJob(input.editId);
  })();
}

export function cancelWorkflowEditJob(input: {
  editId: string;
  error?: WorkflowEditJobError;
}): WorkflowEditJobRecord | null {
  const now = new Date().toISOString();
  const database = getDb();
  return database.transaction(() => {
    database
      .prepare(
        `
        UPDATE workflow_edit_jobs
        SET status = 'canceled',
          error_json = ?,
          finished_at = ?
        WHERE id = ?
          AND status IN ('pending', 'running')
      `,
      )
      .run(
        input.error
          ? stringifyWorkflowEditJobErrorColumn(input.error, {
              table: "workflow_edit_jobs",
              column: "error_json",
              id: input.editId,
            })
          : stringifyWorkflowEditJobErrorColumn(
              { message: "Workflow edit canceled." },
              {
                table: "workflow_edit_jobs",
                column: "error_json",
                id: input.editId,
              },
            ),
        now,
        input.editId,
      );

    return getWorkflowEditJob(input.editId);
  })();
}

export function createWorkflowEditRetry(
  editId: string,
): WorkflowEditJobRecord {
  const edit = getWorkflowEditJob(editId);
  if (!edit) {
    throw new Error("Workflow edit not found");
  }

  return createWorkflowEditJob({
    workflowId: edit.workflowId,
    baseVersionId: edit.baseVersionId,
    instruction: edit.instruction,
    agent: edit.agent ?? undefined,
    model: edit.model ?? undefined,
    cwd: edit.cwd ?? undefined,
  });
}
