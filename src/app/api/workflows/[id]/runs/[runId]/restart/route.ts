import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getFlowV1Run } from "@/lib/db/workflows/flow-runtime";
import {
  FlowV1ServiceError,
  restartFlowV1Cycle,
} from "@/lib/flow-v1/flow-service";
import { runFlowV1Tick } from "@/lib/flow-v1/tick-supervisor";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  const flowRun = getFlowV1Run(runId);
  if (!flowRun || flowRun.flowId !== id) {
    return NextResponse.json(apiError("RUN_NOT_FOUND"), { status: 404 });
  }

  try {
    const result = await restartFlowV1Cycle({
      flowId: id,
      cycleId: flowRun.cycleId,
      executeTick: false,
    });
    if (result.tick.run.status === "pending") {
      setImmediate(() => {
        void runFlowV1Tick({ runId: result.tick.run.id }).catch((error) => {
          console.error("[flow-v1 restart]", error);
        });
      });
    }
    return NextResponse.json({
      run: result.tick.run,
      cycle: result.tick.cycle,
      previousCycleId: result.previousCycleId,
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
