import {
  completeWorkflowGeneration,
  failWorkflowGeneration,
  getLatestWorkflowGeneration,
  getWorkflowGeneration,
  markWorkflowGenerationRunning,
  resetWorkflowGenerationForRetry,
} from "@/lib/db/workflows/generations";
import type {
  WorkflowGenerationRecord,
} from "@/lib/db/workflows/types";
import type { ApiErrorCode } from "@/lib/api/errors";
import { WorkflowCwdError } from "@/lib/workflow/cwd";
import { generateWorkflowScriptWithRepair } from "@/lib/workflow/generator";
import { WorkflowScriptSyntaxError } from "@/lib/workflow/parser";

const activeGenerationJobs = new Map<string, Promise<void>>();

export function ensureWorkflowGenerationStarted(
  workflowId: string,
): WorkflowGenerationRecord | null {
  const generation = getLatestWorkflowGeneration(workflowId);
  if (
    !generation ||
    generation.status === "completed" ||
    generation.status === "failed"
  ) {
    return generation;
  }

  startGenerationJob(generation.id);
  return getWorkflowGeneration(generation.id) ?? generation;
}

export function retryWorkflowGeneration(
  workflowId: string,
): WorkflowGenerationRecord | null {
  const generation = resetWorkflowGenerationForRetry(workflowId);
  if (!generation || generation.status === "completed") {
    return generation;
  }

  startGenerationJob(generation.id);
  return getWorkflowGeneration(generation.id) ?? generation;
}

function startGenerationJob(generationId: string) {
  if (activeGenerationJobs.has(generationId)) {
    return;
  }

  const promise = runGenerationJob(generationId).finally(() => {
    activeGenerationJobs.delete(generationId);
  });
  activeGenerationJobs.set(generationId, promise);
}

async function runGenerationJob(generationId: string) {
  const generation = markWorkflowGenerationRunning(generationId);
  if (!generation) {
    return;
  }

  try {
    const generated = await generateWorkflowScriptWithRepair({
      description: generation.prompt,
      agent: generation.agent ?? undefined,
      model: generation.model ?? undefined,
      cwd: generation.cwd ?? undefined,
    });

    completeWorkflowGeneration({
      generationId,
      script: generated.script,
      generation: {
        repaired: generated.repaired,
        repairAttempts: generated.repairAttempts,
      },
    });
  } catch (error) {
    failWorkflowGeneration({
      generationId,
      error: serializeGenerationError(error),
    });
  }
}

function serializeGenerationError(error: unknown) {
  const code = getGenerationErrorCode(error);
  return {
    code,
    message:
      error instanceof Error ? error.message : "Workflow generation failed",
    diagnostics:
      error instanceof WorkflowScriptSyntaxError ? error.diagnostics : undefined,
  };
}

function getGenerationErrorCode(error: unknown): ApiErrorCode {
  if (error instanceof WorkflowScriptSyntaxError) {
    return "WORKFLOW_SCRIPT_INVALID";
  }
  if (error instanceof WorkflowCwdError) {
    return "WORKFLOW_CWD_INVALID";
  }
  return "WORKFLOW_GENERATION_FAILED";
}
