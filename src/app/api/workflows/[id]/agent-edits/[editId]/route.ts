import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import {
  getWorkflowDetail,
  getWorkflowEditJob,
  getWorkflowVersion,
} from "@/lib/db/workflows";
import { ensureWorkflowEditStarted } from "@/lib/workflow/edit-jobs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; editId: string }> },
) {
  const { id, editId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const edit = ensureWorkflowEditStarted(editId) ?? getWorkflowEditJob(editId);
  if (!edit || edit.workflowId !== id) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const version = edit.createdVersionId
    ? getWorkflowVersion(edit.createdVersionId)
    : null;
  const status =
    edit.status === "pending" || edit.status === "running" ? 202 : 200;

  return NextResponse.json({ edit, version }, { status });
}
