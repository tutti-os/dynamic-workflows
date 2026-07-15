import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowDetail } from "@/lib/db/workflows/workflow-repository";
import { getWorkflowRun } from "@/lib/db/workflows/runs";
import { listWorkflowHumanTasks } from "@/lib/db/workflows/human-tasks";
import type { WorkflowHumanTaskStatus } from "@/lib/workflow/types";

export async function GET(
  request: Request,
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
  const rawStatus = new URL(request.url).searchParams.get("status");
  const status = isTaskStatus(rawStatus) ? rawStatus : undefined;
  return NextResponse.json({ tasks: listWorkflowHumanTasks(runId, status) });
}

function isTaskStatus(value: string | null): value is WorkflowHumanTaskStatus {
  return value === "pending" || value === "resolved" || value === "canceled";
}
