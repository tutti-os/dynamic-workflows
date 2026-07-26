import { workflowRetryRequestInvalidError } from "@/lib/api/app-error";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  getFlowV1Cycle,
  getFlowV1Run,
} from "@/lib/db/workflows/flow-runtime";
import { retryFlowV1Node } from "@/lib/flow-v1/flow-service";
import { runFlowV1Tick } from "@/lib/flow-v1/tick-supervisor";

type RetryRequestBody = {
  mapNodeId?: unknown;
  fromNodeId?: unknown;
};

function readNodeId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  try {
    const body = (await request
      .json()
      .catch(() => ({}))) as RetryRequestBody;
    const mapNodeId = readNodeId(body?.mapNodeId);
    const fromNodeId = readNodeId(body?.fromNodeId);
    const flowRun = getFlowV1Run(runId);
    if (!flowRun || flowRun.flowId !== id) {
      throw workflowRetryRequestInvalidError(
        "Tick does not belong to this Flow.",
      );
    }
    const cycle = getFlowV1Cycle(flowRun.cycleId);
    const nodeId = fromNodeId ?? mapNodeId ?? cycle?.currentNodeId;
    if (!nodeId) {
      throw workflowRetryRequestInvalidError(
        "The paused Cycle has no retryable current node.",
      );
    }
    const result = await retryFlowV1Node({
      flowId: id,
      cycleId: flowRun.cycleId,
      nodeId,
      executeTick: false,
    });
    if (result.tick.run.status === "pending") {
      setImmediate(() => {
        void runFlowV1Tick({ runId: result.tick.run.id }).catch(
          (error) => {
            console.error("[flow-v1 retry]", error);
          },
        );
      });
    }
    return Response.json({
      run: result.tick.run,
      cycle: result.tick.cycle,
      invalidatedNodeIds: result.invalidatedNodeIds,
    });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_RUN_FAILED");
  }
}
