import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import {
  ensureWorkflowGenerationStarted,
  retryWorkflowGeneration,
} from "@/lib/workflow/generation-jobs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const body = await readRequestBody(request);
  const generation = body.retry
    ? retryWorkflowGeneration(id)
    : ensureWorkflowGenerationStarted(id);
  const detail = getWorkflowDetail(id);
  const status =
    generation?.status === "pending" || generation?.status === "running"
      ? 202
      : 200;

  return NextResponse.json({ generation, detail }, { status });
}

async function readRequestBody(request: Request): Promise<{ retry?: boolean }> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as { retry?: unknown };
    return { retry: parsed.retry === true };
  } catch {
    return {};
  }
}
