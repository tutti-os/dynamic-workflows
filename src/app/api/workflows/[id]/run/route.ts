import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import { getWorkflowDetail } from "@/lib/db/workflows/workflow-repository";
import { getFlowV1BundleForVersion } from "@/lib/db/workflows/flow-bundles";
import { dispatchFlowV1 } from "@/lib/flow-v1/flow-service";
import type { FlowV1JsonObject } from "@/lib/flow-v1/types";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const detail = getWorkflowDetail(id);
    if (
      !detail?.currentVersion ||
      !getFlowV1BundleForVersion(detail.currentVersion.id)
    ) {
      throw new Error("Flow v1 Bundle not found.");
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const inputs =
      body.inputs &&
      typeof body.inputs === "object" &&
      !Array.isArray(body.inputs)
        ? (body.inputs as FlowV1JsonObject)
        : undefined;
    const result = await dispatchFlowV1({
      flowId: id,
      invocationInput: inputs,
      projectCwd:
        typeof body.cwd === "string" && body.cwd.trim()
          ? body.cwd
          : undefined,
      defaultAgent:
        typeof body.agent === "string" ? body.agent : undefined,
      defaultModel:
        typeof body.model === "string" ? body.model : undefined,
      defaultPermissionMode:
        typeof body.permissionMode === "string"
          ? body.permissionMode
          : undefined,
      defaultReasoningEffort:
        typeof body.reasoningEffort === "string"
          ? body.reasoningEffort
          : undefined,
    });
    return Response.json({
      run: result.tick.run,
      cycle: result.tick.cycle,
      execution: result.execution,
    });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_RUN_FAILED");
  }
}
