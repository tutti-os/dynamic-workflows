import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import { getFlowV1Run } from "@/lib/db/workflows/flow-runtime";
import { dispatchFlowV1 } from "@/lib/flow-v1/flow-service";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  try {
    const flowRun = getFlowV1Run(runId);
    if (!flowRun || flowRun.flowId !== id) {
      throw new Error("Tick does not belong to this Flow.");
    }
    const result = await dispatchFlowV1({ flowId: id });
    return Response.json({
      run: result.tick.run,
      cycle: result.tick.cycle,
    });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_RUN_FAILED");
  }
}
