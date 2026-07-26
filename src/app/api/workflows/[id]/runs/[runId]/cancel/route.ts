import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import {
  getFlowV1Run,
} from "@/lib/db/workflows/flow-runtime";
import {
  cancelFlowV1Cycle,
  FlowV1ServiceError,
} from "@/lib/flow-v1/flow-service";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const flowRun = getFlowV1Run(runId);
  if (!flowRun || flowRun.flowId !== id) {
    return NextResponse.json(apiError("RUN_NOT_FOUND"), { status: 404 });
  }
  try {
    const cancellation = cancelFlowV1Cycle({
      flowId: id,
      cycleId: flowRun.cycleId,
    });
    return NextResponse.json({
      ok: true,
      cancellation,
    });
  } catch (error) {
    if (error instanceof FlowV1ServiceError) {
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: 409 },
      );
    }
    throw error;
  }
}
