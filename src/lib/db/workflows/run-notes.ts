import { randomUUID } from "node:crypto";
import { getDb } from "../client";
import {
  parseJsonObjectColumn,
  stringifyJsonObjectColumn,
} from "./json-schemas";
import type {
  WorkflowRunNote,
  WorkflowRunNoteRequest,
  WorkflowRunNoteStatus,
  WorkflowRunNoteTarget,
} from "@/lib/workflow/types";

type RunNoteRow = {
  id: string;
  run_id: string;
  message: string;
  target: WorkflowRunNoteTarget;
  node_id: string | null;
  status: WorkflowRunNoteStatus;
  consumed_execution_key: string | null;
  delivery_json: string | null;
  created_at: string;
  consumed_at: string | null;
};

export class RunNoteConflictError extends Error {}

/**
 * Record an operator note against an active run. Guarded by the run being in a
 * steerable state (running/waiting_for_human/interrupted) so a finished run
 * never accepts a note. Returns the recorded note in `pending` status; delivery
 * (consumption for next-step, live send for current) is handled by callers.
 */
export function createWorkflowRunNote(
  request: WorkflowRunNoteRequest,
): WorkflowRunNote {
  const database = getDb();
  return database.transaction(() => {
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = database
      .prepare(`
        INSERT INTO workflow_run_notes (
          id, run_id, message, target, node_id, status,
          consumed_execution_key, delivery_json, created_at, consumed_at
        )
        SELECT ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL
        WHERE EXISTS (
          SELECT 1 FROM workflow_runs runs
          WHERE runs.id = ?
            AND runs.status IN ('running', 'waiting_for_human', 'interrupted')
        )
      `)
      .run(
        id,
        request.runId,
        request.message,
        request.target,
        request.nodeId ?? null,
        now,
        request.runId,
      );
    if (result.changes !== 1) {
      throw new RunNoteConflictError(
        "This run is not accepting operator notes.",
      );
    }
    const note = getWorkflowRunNote(id);
    if (!note) {
      throw new Error("Recorded operator note could not be loaded.");
    }
    return note;
  })();
}

export function getWorkflowRunNote(noteId: string): WorkflowRunNote | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_run_notes WHERE id = ?")
    .get(noteId) as RunNoteRow | undefined;
  return row ? mapRunNote(row) : null;
}

export function listWorkflowRunNotes(
  runId: string,
  status?: WorkflowRunNoteStatus,
): WorkflowRunNote[] {
  const rows = status
    ? getDb()
        .prepare(`
          SELECT * FROM workflow_run_notes
          WHERE run_id = ? AND status = ?
          ORDER BY created_at ASC, rowid ASC
        `)
        .all(runId, status)
    : getDb()
        .prepare(`
          SELECT * FROM workflow_run_notes
          WHERE run_id = ?
          ORDER BY created_at ASC, rowid ASC
        `)
        .all(runId);
  return (rows as RunNoteRow[]).map(mapRunNote);
}

/**
 * Atomically claim the pending next-step notes an execution should consume.
 *
 * Matches notes with no nodeId (any execution) or a nodeId equal to the given
 * top-level `nodeId`, in arrival order. Each note is claimed with a status
 * guard (`status = 'pending'`), so under the single-writer SQLite transaction
 * two concurrent map-item executions can never double-consume one note — the
 * first caller's transaction claims it, the second sees `consumed` and skips
 * it. One note = one delivery, first consumer wins.
 */
export function consumeMatchingRunNotes(input: {
  runId: string;
  nodeId: string;
  executionKey: string;
}): WorkflowRunNote[] {
  const database = getDb();
  return database.transaction(() => {
    const candidates = database
      .prepare(`
        SELECT * FROM workflow_run_notes
        WHERE run_id = ?
          AND target = 'next-step'
          AND status = 'pending'
          AND (node_id IS NULL OR node_id = ?)
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(input.runId, input.nodeId) as RunNoteRow[];

    const now = new Date().toISOString();
    const claimed: WorkflowRunNote[] = [];
    for (const candidate of candidates) {
      const result = database
        .prepare(`
          UPDATE workflow_run_notes
          SET status = 'consumed', consumed_execution_key = ?, consumed_at = ?
          WHERE id = ? AND status = 'pending'
        `)
        .run(input.executionKey, now, candidate.id);
      if (result.changes === 1) {
        const note = getWorkflowRunNote(candidate.id);
        if (note) {
          claimed.push(note);
        }
      }
    }
    return claimed;
  })();
}

/** Record the outcome of a current-target live delivery. */
export function markWorkflowRunNoteDelivered(input: {
  noteId: string;
  ok: boolean;
  agentSessionId?: string;
  detail?: string;
}): WorkflowRunNote {
  const database = getDb();
  return database.transaction(() => {
    const now = new Date().toISOString();
    const delivery = {
      ok: input.ok,
      ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    };
    database
      .prepare(`
        UPDATE workflow_run_notes
        SET status = ?, delivery_json = ?, consumed_at = ?
        WHERE id = ?
      `)
      .run(
        input.ok ? "delivered" : "failed",
        stringifyJsonObjectColumn(delivery, context(input.noteId, "delivery_json")),
        now,
        input.noteId,
      );
    const note = getWorkflowRunNote(input.noteId);
    if (!note) {
      throw new Error("Delivered operator note could not be loaded.");
    }
    return note;
  })();
}

function mapRunNote(row: RunNoteRow): WorkflowRunNote {
  const delivery = row.delivery_json
    ? readDelivery(
        parseJsonObjectColumn(row.delivery_json, context(row.id, "delivery_json")),
      )
    : undefined;
  return {
    id: row.id,
    runId: row.run_id,
    message: row.message,
    target: row.target,
    ...(row.node_id ? { nodeId: row.node_id } : {}),
    status: row.status,
    ...(row.consumed_execution_key
      ? { consumedExecutionKey: row.consumed_execution_key }
      : {}),
    ...(delivery ? { delivery } : {}),
    createdAt: row.created_at,
    ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
  };
}

function readDelivery(
  value: Record<string, unknown>,
): WorkflowRunNote["delivery"] {
  return {
    ok: value.ok === true,
    ...(typeof value.agentSessionId === "string"
      ? { agentSessionId: value.agentSessionId }
      : {}),
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
  };
}

function context(id: string, column: string) {
  return { table: "workflow_run_notes", column, id };
}
