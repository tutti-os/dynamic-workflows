import {
  completeWorkflowFlowGeneration,
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
  createWaivedSemanticReview,
  hashAuthoringScript,
} from "@/lib/workflow/authoring/semantic-review";
import { createSampleFlowV1Bundle } from "@/lib/workflow/sample";
import {
  configureFlowV1,
  createFlowV1Version,
} from "@/lib/flow-v1/flow-service";

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
      const bundle = createSampleFlowV1Bundle(generation.prompt);
      const semanticReview = createWaivedSemanticReview({
          intentHash: hashAuthoringScript(generation.prompt),
          scriptHash: hashAuthoringScript(
            bundle.files
              .map((file) => `${file.path}\n${file.content}`)
              .join("\n\n"),
          ),
          reason: "Built-in mock authoring path.",
        });
      createFlowV1Version({
        flowId: generation.workflowId,
        bundle,
        publish: true,
        semanticReview,
      });
      configureFlowV1({
        flowId: generation.workflowId,
        params: {},
        projectCwd: generation.cwd ?? undefined,
      });
      completeWorkflowFlowGeneration({
        generationId,
        generation: {
          source: "sample_flow_bundle",
          bundleHash: bundle.hash,
        },
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

function serializeGenerationError(error: unknown) {
  return {
    code: getGenerationErrorCode(error),
    message:
      error instanceof Error ? error.message : "Workflow generation failed",
  };
}

function getGenerationErrorCode(error: unknown): ApiErrorCode {
  if (error instanceof WorkflowCwdError) {
    return "WORKFLOW_CWD_INVALID";
  }
  return "WORKFLOW_GENERATION_FAILED";
}
