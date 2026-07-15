import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowDetail } from "@/lib/db/workflows/workflow-repository";
import { getWorkflowRun } from "@/lib/db/workflows/runs";
import { getWorkflowHumanTask } from "@/lib/db/workflows/human-tasks";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string; taskId: string }> },
) {
  const { id, runId, taskId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }
  const run = getWorkflowRun(runId);
  if (!run || run.workflowId !== id) {
    return NextResponse.json(apiError("RUN_NOT_FOUND"), { status: 404 });
  }
  const task = getWorkflowHumanTask(taskId);
  if (!task || task.runId !== runId) {
    return NextResponse.json(apiError("HUMAN_TASK_NOT_FOUND"), { status: 404 });
  }
  return NextResponse.json({ task });
}
