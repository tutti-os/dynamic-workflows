import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowDetail } from "@/lib/db/workflows/workflow-repository";
import { getWorkflowRun } from "@/lib/db/workflows/runs";
import { RunNoteError, recordRunNote } from "@/lib/workflow/run-notes";
import type { WorkflowRunNoteTarget } from "@/lib/workflow/types";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }
  const currentRun = getWorkflowRun(runId);
  if (!currentRun || currentRun.workflowId !== id) {
    return NextResponse.json(apiError("RUN_NOT_FOUND"), { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(apiError("RUN_NOTE_INVALID"), { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(apiError("RUN_NOTE_INVALID"), { status: 400 });
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.message !== "string" || !raw.message.trim()) {
    return NextResponse.json(apiError("RUN_NOTE_INVALID"), { status: 400 });
  }
  const target: WorkflowRunNoteTarget =
    raw.target === "current" ? "current" : "next-step";
  const nodeId =
    typeof raw.nodeId === "string" && raw.nodeId.trim()
      ? raw.nodeId.trim()
      : undefined;

  try {
    const result = await recordRunNote({
      runId,
      message: raw.message,
      target,
      nodeId,
    });
    const run = getWorkflowRun(runId) ?? currentRun;
    return NextResponse.json({
      note: result.note,
      ...(result.delivery ? { delivery: result.delivery } : {}),
      run,
    });
  } catch (error) {
    if (error instanceof RunNoteError) {
      return NextResponse.json(
        apiError(error.code, { message: error.message }),
        { status: error.status },
      );
    }
    return NextResponse.json(
      apiError("WORKFLOW_RUN_FAILED", {
        message:
          error instanceof Error ? error.message : "Operator note failed.",
      }),
      { status: 500 },
    );
  }
}
