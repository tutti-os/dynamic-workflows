import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import {
  getWorkflowEditJob,
} from "@/lib/db/workflows/edit-jobs";
import { cancelWorkflowEdit } from "@/lib/workflow/edit-jobs";

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

  const edit = await cancelWorkflowEdit(editId);
  return NextResponse.json({ edit });
}
