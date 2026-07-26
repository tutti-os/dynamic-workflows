import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowDetail } from "@/lib/db/workflows/workflow-repository";
import { getFlowV1Run } from "@/lib/db/workflows/flow-runtime";
import {
  FlowV1ServiceError,
  respondToFlowV1HumanTask,
} from "@/lib/flow-v1/flow-service";
import type { WorkflowValue } from "@/lib/workflow/types";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string; taskId: string }> },
) {
  const { id, runId, taskId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }
  const currentRun = getFlowV1Run(runId);
  if (!currentRun || currentRun.flowId !== id) {
    return NextResponse.json(apiError("RUN_NOT_FOUND"), { status: 404 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(apiError("HUMAN_TASK_INVALID"), { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(apiError("HUMAN_TASK_INVALID"), { status: 400 });
  }
  const raw = body as Record<string, unknown>;
  if (
    typeof raw.action !== "string" ||
    !Number.isInteger(raw.revision) ||
    !raw.values ||
    typeof raw.values !== "object" ||
    Array.isArray(raw.values)
  ) {
    return NextResponse.json(apiError("HUMAN_TASK_INVALID"), { status: 400 });
  }

  try {
    const result = await respondToFlowV1HumanTask({
      flowId: id,
      runId,
      taskId,
      action: raw.action,
      values: raw.values as Record<string, WorkflowValue>,
      revision: raw.revision as number,
    });
    return NextResponse.json({
      task: result.task,
      run: result.tick.run,
      execution: result.execution,
    });
  } catch (error) {
    if (error instanceof FlowV1ServiceError) {
      const notFound = error.code === "flow_human_task_not_found";
      return NextResponse.json(
        apiError(
          notFound ? "HUMAN_TASK_NOT_FOUND" : "HUMAN_TASK_CONFLICT",
          { message: error.message },
        ),
        { status: notFound ? 404 : 409 },
      );
    }
    return NextResponse.json(apiError("WORKFLOW_RUN_FAILED", {
      message: error instanceof Error ? error.message : "Workflow resume failed.",
    }), { status: 500 });
  }
}
