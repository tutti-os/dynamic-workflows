import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowDetail } from "@/lib/db/workflows/workflow-repository";
import { listWorkflowGenerations } from "@/lib/db/workflows/generations";
import { listWorkflowEditJobs } from "@/lib/db/workflows/edit-jobs";

export type WorkflowAuthoringSessionItem = {
  id: string;
  kind: "create" | "edit";
  status: string;
  agentSessionId: string | null;
  agent: string | null;
  model: string | null;
  request: string;
  createdVersionId: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const sessions: WorkflowAuthoringSessionItem[] = [
    ...listWorkflowGenerations({ workflowId: id }).map(
      (generation): WorkflowAuthoringSessionItem => ({
        id: generation.id,
        kind: "create",
        status: generation.status,
        agentSessionId: generation.agentSessionId,
        agent: generation.agent,
        model: generation.model,
        request: generation.prompt,
        createdVersionId: null,
        errorMessage: generation.error?.message ?? null,
        createdAt: generation.createdAt,
      }),
    ),
    ...listWorkflowEditJobs({ workflowId: id }).map(
      (edit): WorkflowAuthoringSessionItem => ({
        id: edit.id,
        kind: "edit",
        status: edit.status,
        agentSessionId: edit.agentSessionId,
        agent: edit.agent,
        model: edit.model,
        request: edit.instruction,
        createdVersionId: edit.createdVersionId,
        errorMessage: edit.error?.message ?? null,
        createdAt: edit.createdAt,
      }),
    ),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return NextResponse.json({ sessions });
}
