import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowDetail, getWorkflowRun } from "@/lib/db/workflows";
import {
  EMPTY_LOG_PREVIEW,
  readRunLogPreview,
} from "@/lib/workflow/run-log";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const run = getWorkflowRun(runId);
  if (!run || run.workflowId !== id) {
    return NextResponse.json(apiError("RUN_NOT_FOUND"), { status: 404 });
  }

  const logPreview = run.logPath
    ? await readRunLogPreview(run.logPath)
    : EMPTY_LOG_PREVIEW;

  return NextResponse.json({ run, ...logPreview });
}
