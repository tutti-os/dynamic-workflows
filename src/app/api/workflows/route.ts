import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  createPendingWorkflowGeneration,
} from "@/lib/db/workflows/generations";
import {
  listWorkflows,
} from "@/lib/db/workflows/workflow-repository";
import { ensureWorkflowGenerationStarted } from "@/lib/workflow/generation-jobs";
import { reconcileStaleRunningRuns } from "@/lib/workflow/run-jobs";

export async function GET() {
  // Reconcile any zombie "running" run surfaced as a workflow's latestRun so
  // the home list stops showing it as running forever.
  const workflows = await Promise.all(
    listWorkflows().map(async (summary) => {
      if (summary.latestRun?.status !== "running") {
        return summary;
      }
      const [latestRun] = await reconcileStaleRunningRuns([summary.latestRun]);
      return { ...summary, latestRun };
    }),
  );
  return NextResponse.json({ workflows });
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
