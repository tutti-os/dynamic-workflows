import type { ApiErrorCode } from "@/lib/api/errors";
import type { WorkflowRunRecord } from "@/lib/db/workflows/types";
import { getWorkflowRun } from "@/lib/db/workflows/runs";
import {
  RunNoteConflictError,
  createWorkflowRunNote,
  listWorkflowRunNotes,
  markWorkflowRunNoteDelivered,
} from "@/lib/db/workflows/run-notes";
import { sendAgentMessage } from "@/lib/agents/runtime";
import { readRunLog } from "@/lib/workflow/run-log";
import {
  applyWorkflowRunEvent,
  createInitialRunSummary,
  parseRunLogEvents,
} from "@/lib/workflow/run-state";
import { recordOutOfBandRunEvent } from "@/lib/workflow/run-jobs";
import type {
  WorkflowNodeSessionRef,
  WorkflowRunNote,
  WorkflowRunNoteTarget,
} from "@/lib/workflow/types";

export { listWorkflowRunNotes };

/**
 * A typed error carrying the ApiErrorCode + HTTP status the CLI and API route
 * should surface. Mirrors the human-task error shapes.
 */
export class RunNoteError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status: number) {
    super(message);
    this.name = "RunNoteError";
    this.code = code;
    this.status = status;
  }
}

export type RecordRunNoteResult = {
  note: WorkflowRunNote;
  delivery?: { ok: boolean; agentSessionId?: string; detail?: string };
};

/**
 * Record an operator note against a run and, for `current` target, deliver it
 * to the live agent session. Provenance first: the note is written to the notes
 * table AND appended as a run_note event to the run log BEFORE any delivery is
 * attempted, so an unrecorded steer can never happen.
 */
export async function recordRunNote(input: {
  runId: string;
  message: string;
  target: WorkflowRunNoteTarget;
  nodeId?: string;
}): Promise<RecordRunNoteResult> {
  const message = input.message?.trim();
  if (!message) {
    throw new RunNoteError(
      "RUN_NOTE_INVALID",
      "A non-empty note message is required.",
      400,
    );
  }
  if (input.target !== "current" && input.target !== "next-step") {
    throw new RunNoteError(
      "RUN_NOTE_INVALID",
      'target must be "current" or "next-step".',
      400,
    );
  }
  const nodeId = input.nodeId?.trim() || undefined;

  const run = getWorkflowRun(input.runId);
  if (!run) {
    throw new RunNoteError("RUN_NOT_FOUND", "Run not found.", 404);
  }

  if (input.target === "next-step") {
    return { note: recordNote(run, { message, target: "next-step", nodeId }) };
  }

  return deliverCurrentNote(run, { message, nodeId });
}

async function deliverCurrentNote(
  run: WorkflowRunRecord,
  input: { message: string; nodeId?: string },
): Promise<RecordRunNoteResult> {
  if (run.status !== "running") {
    throw new RunNoteError(
      "RUN_NOTE_NO_LIVE_SESSION",
      "This run has no live turn to steer right now; use a next-step note instead.",
      409,
    );
  }

  const resolution = await resolveLiveSession(run, input.nodeId);
  if (!resolution.session) {
    throw new RunNoteError("RUN_NOTE_NO_LIVE_SESSION", resolution.reason, 409);
  }
  const agentSessionId = resolution.session.agentSessionId;

  // Record BEFORE delivery — a delivered steer must always be in the run log.
  const note = recordNote(run, {
    message: input.message,
    target: "current",
    nodeId: input.nodeId,
  });

  try {
    await sendAgentMessage({ agentSessionId, message: input.message });
    const delivered = markWorkflowRunNoteDelivered({
      noteId: note.id,
      ok: true,
      agentSessionId,
    });
    recordOutOfBandRunEvent(run, {
      type: "run_note",
      runId: run.id,
      note: delivered,
    });
    return { note: delivered, delivery: { ok: true, agentSessionId } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "delivery failed";
    const failed = markWorkflowRunNoteDelivered({
      noteId: note.id,
      ok: false,
      agentSessionId,
      detail,
    });
    recordOutOfBandRunEvent(run, {
      type: "run_note",
      runId: run.id,
      note: failed,
    });
    // The note is recorded; report the failed delivery without discarding it.
    return { note: failed, delivery: { ok: false, agentSessionId, detail } };
  }
}

function recordNote(
  run: WorkflowRunRecord,
  input: { message: string; target: WorkflowRunNoteTarget; nodeId?: string },
): WorkflowRunNote {
  let note: WorkflowRunNote;
  try {
    note = createWorkflowRunNote({
      runId: run.id,
      message: input.message,
      target: input.target,
      nodeId: input.nodeId,
    });
  } catch (error) {
    if (error instanceof RunNoteConflictError) {
      throw new RunNoteError("RUN_NOTE_RUN_NOT_ACTIVE", error.message, 409);
    }
    throw error;
  }
  recordOutOfBandRunEvent(run, { type: "run_note", runId: run.id, note });
  return note;
}

/**
 * Resolve the live agent session to steer for a running run by reducing its run
 * log (the freshest record: a session_ref lands on every turn). Returns the
 * running node session; if a nodeId is given it must match, otherwise there
 * must be exactly one running session to avoid steering the wrong one.
 */
async function resolveLiveSession(
  run: WorkflowRunRecord,
  nodeId?: string,
): Promise<{ session?: WorkflowNodeSessionRef; reason: string }> {
  const log = await readRunLog(run.logPath);
  let summary = createInitialRunSummary(undefined, {
    queueExecutableNodes: false,
  });
  for (const event of parseRunLogEvents(log)) {
    summary = applyWorkflowRunEvent(summary, event);
  }
  const running = Object.values(summary.nodeSessions).filter(
    (session) => session.status === "running" && Boolean(session.agentSessionId),
  );

  if (nodeId) {
    const session = running.find((candidate) => candidate.nodeId === nodeId);
    return session
      ? { session, reason: "" }
      : {
          reason: `Node "${nodeId}" has no live agent session; use a next-step note instead.`,
        };
  }
  if (running.length === 1) {
    return { session: running[0], reason: "" };
  }
  if (running.length === 0) {
    return {
      reason:
        "No live agent session is running right now; use a next-step note instead.",
    };
  }
  return {
    reason:
      "Multiple live agent sessions are running; pass a node id to pick which one to steer.",
  };
}
