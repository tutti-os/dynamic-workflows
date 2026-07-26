import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import { getFlowV1Run } from "@/lib/db/workflows/flow-runtime";
import { resolveFlowV1MemoryConflict } from "@/lib/flow-v1/flow-service";
import { runFlowV1Tick } from "@/lib/flow-v1/tick-supervisor";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  try {
    const run = getFlowV1Run(runId);
    if (!run || run.flowId !== id) {
      throw new Error("Tick does not belong to this Flow.");
    }
    const body = (await request.json()) as {
      nodeId?: unknown;
      resolution?: unknown;
    };
    if (
      typeof body.nodeId !== "string" ||
      (body.resolution !== "keep_current" &&
        body.resolution !== "apply_candidate")
    ) {
      throw new Error("Memory resolution request is invalid.");
    }
    const result = await resolveFlowV1MemoryConflict({
      flowId: id,
      cycleId: run.cycleId,
      nodeId: body.nodeId,
      resolution: body.resolution,
      executeTick: false,
    });
    if (result.tick.run.status === "pending") {
      setImmediate(() => {
        void runFlowV1Tick({ runId: result.tick.run.id }).catch((error) => {
          console.error("[flow-v1 memory resolve]", error);
        });
      });
    }
    return Response.json({
      resolution: result.resolution,
      resultHash: result.resultHash,
      run: result.tick.run,
    });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_RUN_FAILED");
  }
}
