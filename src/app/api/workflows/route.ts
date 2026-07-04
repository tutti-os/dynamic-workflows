import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  createPendingWorkflowGeneration,
  listWorkflows,
} from "@/lib/db/workflows";
import { ensureWorkflowGenerationStarted } from "@/lib/workflow/generation-jobs";

export async function GET() {
  return NextResponse.json({ workflows: listWorkflows() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    prompt?: string;
    agent?: string;
    model?: string;
    cwd?: string;
  };

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json(
      apiError("PROMPT_REQUIRED"),
      { status: 400 },
    );
  }

  try {
    const detail = createPendingWorkflowGeneration({
      prompt,
      agent: body.agent,
      model: body.model,
      cwd: body.cwd,
    });
    ensureWorkflowGenerationStarted(detail.workflow.id);
    return NextResponse.json(detail, { status: 202 });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_GENERATION_FAILED");
  }
}
