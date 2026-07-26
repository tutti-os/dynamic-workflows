import { NextResponse } from "next/server";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  getWorkflowDetail,
  updateWorkflowMetadata,
} from "@/lib/db/workflows/workflow-repository";
import { getWorkflowVersion } from "@/lib/db/workflows/versions";
import { getFlowV1BundleForVersion } from "@/lib/db/workflows/flow-bundles";
import { getCurrentFlowV1Params } from "@/lib/db/workflows/flow-settings";
import { getFlowV1RuntimeConfig } from "@/lib/flow-v1/runtime-config";
import { createFlowV1 } from "@/lib/flow-v1/flow-service";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    versionId?: string;
  };

  try {
    const source = getWorkflowDetail(id);
    const version = body.versionId
      ? getWorkflowVersion(body.versionId)
      : source?.currentVersion;
    const bundle =
      version?.workflowId === id
        ? getFlowV1BundleForVersion(version.id)
        : null;
    if (!source || !version || !bundle) {
      throw new Error("Flow v1 Bundle not found.");
    }
    const params = getCurrentFlowV1Params(id);
    const config = getFlowV1RuntimeConfig(id);
    const created = createFlowV1({
      bundle,
      params: params?.values,
      ...(config.projectCwd
        ? { projectCwd: config.projectCwd }
        : {}),
      secretBindings: config.secretBindings,
      publish: true,
      activate: false,
    });
    return NextResponse.json(
      updateWorkflowMetadata({
        workflowId: created.flowId,
        name: body.name?.trim() || `${source.workflow.name}_copy`,
        description: source.workflow.description,
      }),
      { status: 201 },
    );
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_DUPLICATE_FAILED");
  }
}
