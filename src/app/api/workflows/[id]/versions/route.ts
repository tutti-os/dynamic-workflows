import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";
import { createFlowV1Version } from "@/lib/flow-v1/flow-service";
import type { FlowV1BundleSourceFile } from "@/lib/flow-v1/types";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const body = (await request.json()) as {
    bundle?: { files?: FlowV1BundleSourceFile[] };
    publish?: boolean;
  };
  if (!body.bundle) {
    return NextResponse.json(
      { error: { code: "FLOW_BUNDLE_REQUIRED" } },
      { status: 400 },
    );
  }

  try {
    const created = createFlowV1Version({
      flowId: id,
      bundle: createFlowV1Bundle(body.bundle.files ?? []),
      publish: body.publish,
    });
    return NextResponse.json({ version: created });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_SAVE_FAILED");
  }
}
