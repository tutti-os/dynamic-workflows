import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import {
  publishWorkflowVersion,
} from "@/lib/db/workflows/versions";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  try {
    const detail = publishWorkflowVersion({ workflowId: id, versionId });
    return NextResponse.json({ detail });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_SAVE_FAILED");
  }
}
