import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowDetail } from "@/lib/db/workflows/workflow-repository";
import { getWorkflowRun } from "@/lib/db/workflows/runs";
import {
  HumanTaskConflictError,
  HumanTaskValidationError,
  resolveWorkflowHumanTask,
} from "@/lib/db/workflows/human-tasks";
import { resumeWorkflowRunAfterHumanTask } from "@/lib/workflow/run-jobs";
import type { WorkflowValue } from "@/lib/workflow/types";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string; taskId: string }> },
) {
  const { id, runId, taskId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }
  const currentRun = getWorkflowRun(runId);
  if (!currentRun || currentRun.workflowId !== id) {
    return NextResponse.json(apiError("RUN_NOT_FOUND"), { status: 404 });
  }
  if (
    currentRun.status === "completed" ||
    currentRun.status === "failed" ||
    currentRun.status === "canceled"
  ) {
    return NextResponse.json(apiError("HUMAN_TASK_CONFLICT", {
      message: "This run has already finished.",
    }), { status: 409 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(apiError("HUMAN_TASK_INVALID"), { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(apiError("HUMAN_TASK_INVALID"), { status: 400 });
  }
  const raw = body as Record<string, unknown>;
  if (
    typeof raw.action !== "string" ||
    !Number.isInteger(raw.revision) ||
    !raw.values ||
    typeof raw.values !== "object" ||
    Array.isArray(raw.values)
  ) {
    return NextResponse.json(apiError("HUMAN_TASK_INVALID"), { status: 400 });
  }

  try {
    const task = resolveWorkflowHumanTask({
      runId,
      taskId,
      action: raw.action,
      values: raw.values as Record<string, WorkflowValue>,
      revision: raw.revision as number,
    });
    const run = await resumeWorkflowRunAfterHumanTask({ workflowId: id, runId });
    return NextResponse.json({ task, run });
  } catch (error) {
    if (error instanceof HumanTaskConflictError) {
      return NextResponse.json(apiError("HUMAN_TASK_CONFLICT", {
        message: error.message,
      }), { status: 409 });
    }
    if (error instanceof HumanTaskValidationError) {
      const status = error.message === "Human task not found." ? 404 : 400;
      return NextResponse.json(
        apiError(
          status === 404 ? "HUMAN_TASK_NOT_FOUND" : "HUMAN_TASK_INVALID",
          { message: error.message },
        ),
        { status },
      );
    }
    return NextResponse.json(apiError("WORKFLOW_RUN_FAILED", {
      message: error instanceof Error ? error.message : "Workflow resume failed.",
    }), { status: 500 });
  }
}
