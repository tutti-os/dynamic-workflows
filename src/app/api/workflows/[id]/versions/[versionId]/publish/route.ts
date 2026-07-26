import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import { getFlowV1BundleForVersion } from "@/lib/db/workflows/flow-bundles";
import { publishFlowV1Version } from "@/lib/flow-v1/flow-service";
import { getFlowV1DetailProjection } from "@/lib/flow-v1/projection";
import { getLatestFlowV1DraftReview } from "@/lib/flow-v1/draft-projection";
import type { FlowV1JsonObject } from "@/lib/flow-v1/types";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      params?: FlowV1JsonObject;
      expectedParamsRevision?: number;
    };
    if (!getFlowV1BundleForVersion(versionId)) {
      return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), {
        status: 404,
      });
    }
    const published = publishFlowV1Version({
      flowId: id,
      versionId,
      params: body.params,
      expectedParamsRevision: body.expectedParamsRevision,
    });
    return NextResponse.json({
      published,
      detail: {
        ...getWorkflowDetail(id),
        flowV1: getFlowV1DetailProjection(id),
        draftReview: getLatestFlowV1DraftReview(id),
      },
    });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_SAVE_FAILED");
  }
}
