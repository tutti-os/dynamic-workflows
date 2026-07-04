import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowDetail, getWorkflowRun } from "@/lib/db/workflows";
import {
  EMPTY_LOG_PREVIEW,
  readRunLogPreview,
} from "@/lib/workflow/run-log";
import { markWorkflowRunInterruptedIfStale } from "@/lib/workflow/run-jobs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const existingRun = getWorkflowRun(runId);
  if (!existingRun || existingRun.workflowId !== id) {
    return NextResponse.json(apiError("RUN_NOT_FOUND"), { status: 404 });
  }
  const run = await markWorkflowRunInterruptedIfStale(existingRun);

  const logPreview = run.logPath
    ? await readRunLogPreview(run.logPath)
    : EMPTY_LOG_PREVIEW;

  return NextResponse.json({ run, ...logPreview });
}
