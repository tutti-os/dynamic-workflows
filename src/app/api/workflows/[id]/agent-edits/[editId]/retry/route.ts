import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  createWorkflowEditRetry,
  getWorkflowEditJob,
} from "@/lib/db/workflows/edit-jobs";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import { ensureWorkflowEditStarted } from "@/lib/workflow/edit-jobs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; editId: string }> },
) {
  const { id, editId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const existing = getWorkflowEditJob(editId);
  if (!existing || existing.workflowId !== id) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  try {
    const edit = createWorkflowEditRetry(editId);
    ensureWorkflowEditStarted(edit.id);
    return NextResponse.json({ edit }, { status: 202 });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_EDIT_FAILED");
  }
}
