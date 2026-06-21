import { NextResponse } from "next/server";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import { duplicateWorkflow } from "@/lib/db/workflows";

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
    const detail = duplicateWorkflow({
      workflowId: id,
      versionId: body.versionId,
      name: body.name,
    });
    return NextResponse.json(detail, { status: 201 });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_DUPLICATE_FAILED");
  }
}
