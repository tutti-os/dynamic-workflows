import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import { getFlowV1BundleForVersion } from "@/lib/db/workflows/flow-bundles";
import { publishFlowV1Version } from "@/lib/flow-v1/flow-service";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  try {
    if (!getFlowV1BundleForVersion(versionId)) {
      return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), {
        status: 404,
      });
    }
    const published = publishFlowV1Version({
      flowId: id,
      versionId,
    });
    return NextResponse.json({
      published,
      detail: getWorkflowDetail(id),
    });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_SAVE_FAILED");
  }
}
