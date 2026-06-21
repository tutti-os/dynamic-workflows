import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  createWorkflowVersion,
  getWorkflowDetail,
} from "@/lib/db/workflows";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const body = (await request.json()) as { script?: string };
  if (!body.script?.trim()) {
    return NextResponse.json(
      apiError("SCRIPT_REQUIRED"),
      { status: 400 },
    );
  }

  try {
    const version = createWorkflowVersion({
      workflowId: id,
      script: body.script,
    });
    return NextResponse.json({ version, detail: getWorkflowDetail(id) });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_SAVE_FAILED");
  }
}
