import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  createWorkflowEditJob,
  listWorkflowEditJobs,
} from "@/lib/db/workflows/edit-jobs";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import { ensureWorkflowEditStarted } from "@/lib/workflow/edit-jobs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const edits = listWorkflowEditJobs({ workflowId: id, limit: 10 });
  for (const edit of edits) {
    if (edit.status === "pending" || edit.status === "running") {
      ensureWorkflowEditStarted(edit.id);
    }
  }

  return NextResponse.json({
    edits: listWorkflowEditJobs({ workflowId: id, limit: 10 }),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const body = (await request.json()) as {
    instruction?: string;
    baseVersionId?: string;
    agent?: string;
    model?: string;
    cwd?: string;
  };
  const instruction = body.instruction?.trim();
  if (!instruction) {
    return NextResponse.json(apiError("PROMPT_REQUIRED"), { status: 400 });
  }

  try {
    const edit = createWorkflowEditJob({
      workflowId: id,
      instruction,
      baseVersionId: body.baseVersionId,
      agent: body.agent,
      model: body.model,
      cwd: body.cwd,
    });
    ensureWorkflowEditStarted(edit.id);
    return NextResponse.json({ edit }, { status: 202 });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_EDIT_FAILED");
  }
}
