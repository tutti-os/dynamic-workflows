import {
  completeWorkflowGeneration,
  failWorkflowGeneration,
  getLatestWorkflowGeneration,
  getWorkflowGeneration,
  markWorkflowGenerationRunning,
  resetWorkflowGenerationForRetry,
  updateWorkflowGenerationAgentSession,
} from "@/lib/db/workflows/generations";
import type {
  WorkflowGenerationRecord,
} from "@/lib/db/workflows/types";
import type { ApiErrorCode } from "@/lib/api/errors";
import { startAgentSession } from "@/lib/agents/runtime";
import { WorkflowCwdError } from "@/lib/workflow/cwd";
import { buildCreateAuthoringPrompt } from "@/lib/workflow/authoring/prompts";
import { prepareAuthoringWorkspace } from "@/lib/workflow/authoring/workspace";
import {
  assertWorkflowScriptValid,
  WorkflowScriptSyntaxError,
} from "@/lib/workflow/parser";
import { SAMPLE_WORKFLOW } from "@/lib/workflow/sample";

const activeGenerationJobs = new Map<string, Promise<void>>();

export function ensureWorkflowGenerationStarted(
  workflowId: string,
): WorkflowGenerationRecord | null {
  const generation = getLatestWorkflowGeneration(workflowId);
  if (
    !generation ||
    generation.status === "completed" ||
    generation.status === "failed" ||
    // A running generation with a session is already decoupled: the session
    // lives in AgentGUI and the workflow fills in whenever the agent submits.
    (generation.status === "running" && generation.agentSessionId)
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

export async function waitForWorkflowGenerationLaunch(
  workflowId: string,
): Promise<WorkflowGenerationRecord | null> {
  const generation = getLatestWorkflowGeneration(workflowId);
  if (!generation) {
    return null;
  }

  const active = activeGenerationJobs.get(generation.id);
  if (active) {
    await active;
  }
  return getWorkflowGeneration(generation.id);
}

function startGenerationJob(generationId: string) {
  if (activeGenerationJobs.has(generationId)) {
    return;
  }

  const promise = launchGenerationSession(generationId).finally(() => {
    activeGenerationJobs.delete(generationId);
  });
  activeGenerationJobs.set(generationId, promise);
}

// Launch-only: start the authoring session and record it. The session runs
// its own multi-turn conversation in AgentGUI; the workflow fills in whenever
// the agent calls `authoring submit` (possibly multiple times).
async function launchGenerationSession(generationId: string) {
  const generation = markWorkflowGenerationRunning(generationId);
  if (!generation) {
    return;
  }

  try {
    if (!generation.agent || generation.agent === "mock") {
      const script = personalizeSample(generation.prompt);
      assertWorkflowScriptValid(script);
      completeWorkflowGeneration({
        generationId,
        script,
        generation: { source: "sample" },
      });
      return;
    }

    const workspace = prepareAuthoringWorkspace({ jobId: generationId });
    const session = await startAgentSession({
      agent: generation.agent,
      model: generation.model ?? undefined,
      cwd: workspace.dir,
      prompt: buildCreateAuthoringPrompt({
        jobId: generationId,
        description: generation.prompt,
        userCwd: generation.cwd ?? undefined,
      }),
    });
    updateWorkflowGenerationAgentSession({
      generationId,
      agentSessionId: session.agentSessionId,
    });
  } catch (error) {
    try {
      failWorkflowGeneration({
        generationId,
        error: serializeGenerationError(error),
      });
    } catch {
      // Never leave the job stuck in "running" because the error itself
      // failed to persist.
      failWorkflowGeneration({
        generationId,
        error: {
          code: "WORKFLOW_GENERATION_FAILED",
          message: error instanceof Error ? error.message : "Workflow generation failed",
        },
      });
    }
  }
}

function personalizeSample(description: string): string {
  if (!description.trim()) {
    return SAMPLE_WORKFLOW;
  }
  return SAMPLE_WORKFLOW.replace(
    'description: "Inspect a codebase with focused local agents and synthesize the results"',
    `description: ${JSON.stringify(description.trim())}`,
  );
}

function serializeGenerationError(error: unknown) {
  const diagnostics =
    error instanceof WorkflowScriptSyntaxError ? error.diagnostics : undefined;
  return {
    code: getGenerationErrorCode(error),
    message:
      error instanceof Error ? error.message : "Workflow generation failed",
    ...(diagnostics ? { diagnostics } : {}),
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
