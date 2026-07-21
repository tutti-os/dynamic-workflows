import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowDetail } from "@/lib/db/workflows/workflow-repository";
import { listWorkflowGenerations } from "@/lib/db/workflows/generations";
import { listWorkflowEditJobs } from "@/lib/db/workflows/edit-jobs";
import type { AuthoringSemanticReview } from "@/lib/db/workflows/types";
import {
  AuthoringSubmitError,
  submitAuthoringScript,
  validateAuthoringScript,
} from "@/lib/workflow/authoring/submit";
import {
  AUTHORING_CURRENT_SCRIPT_FILE,
  AUTHORING_DRAFT_FILE,
} from "@/lib/workflow/authoring/workspace";

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
  semanticReview: AuthoringSemanticReview | null;
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
        semanticReview: generation.semanticReview,
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
        semanticReview: edit.semanticReview,
      }),
    ),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return NextResponse.json({ sessions });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    jobId?: unknown;
    action?: unknown;
    reason?: unknown;
  };
  const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
  const action = typeof body.action === "string" ? body.action : "";
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const generation = listWorkflowGenerations({ workflowId: id }).find(
    (item) => item.id === jobId,
  );
  const edit = generation
    ? undefined
    : listWorkflowEditJobs({ workflowId: id }).find((item) => item.id === jobId);
  if (!generation && !edit) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }
  const file = generation ? AUTHORING_DRAFT_FILE : AUTHORING_CURRENT_SCRIPT_FILE;

  try {
    if (action === "check" || action === "review") {
      return NextResponse.json({
        result: await validateAuthoringScript({
          jobId,
          file,
          reviewMode: action === "review" ? "agent" : "none",
        }),
      });
    }
    if (action === "submit" || action === "skip") {
      return NextResponse.json({
        result: await submitAuthoringScript({
          jobId,
          file,
          skipSemanticReview: action === "skip",
          reason,
        }),
      });
    }
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "Unknown authoring action." } },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof AuthoringSubmitError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    throw error;
  }
}
