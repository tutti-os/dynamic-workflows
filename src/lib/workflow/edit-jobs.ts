import {
  cancelWorkflowEditJob,
  completeWorkflowEditJob,
  failWorkflowEditJob,
  getWorkflowEditJob,
  markWorkflowEditJobRunning,
  updateWorkflowEditJobAgentSession,
} from "@/lib/db/workflows/edit-jobs";
import {
  getWorkflowVersion,
} from "@/lib/db/workflows/versions";
import type {
  WorkflowEditJobRecord,
} from "@/lib/db/workflows/types";
import { workflowVersionNotFoundError } from "@/lib/api/app-error";
import { cancelAgentSession, startAgentSession } from "@/lib/agents/runtime";
import type { ApiErrorCode } from "@/lib/api/errors";
import { WorkflowCwdError } from "@/lib/workflow/cwd";
import { buildEditAuthoringPrompt } from "@/lib/workflow/authoring/prompts";
import { prepareAuthoringWorkspace } from "@/lib/workflow/authoring/workspace";
import { WorkflowScriptSyntaxError } from "@/lib/workflow/parser";
import {
  createWaivedSemanticReview,
  hashAuthoringScript,
} from "@/lib/workflow/authoring/semantic-review";

const activeEditJobs = new Map<string, Promise<void>>();

export function isWorkflowEditActive(editId: string): boolean {
  return activeEditJobs.has(editId);
}

export function ensureWorkflowEditStarted(
  editId: string,
): WorkflowEditJobRecord | null {
  const edit = getWorkflowEditJob(editId);
  if (
    !edit ||
    edit.status === "completed" ||
    edit.status === "failed" ||
    edit.status === "canceled" ||
    // A running edit with a session is decoupled: the conversation lives in
    // AgentGUI and versions land whenever the agent submits.
    (edit.status === "running" && edit.agentSessionId)
  ) {
    return edit;
  }

  startEditJob(edit.id);
  return getWorkflowEditJob(edit.id) ?? edit;
}

function startEditJob(editId: string) {
  if (activeEditJobs.has(editId)) {
    return;
  }

  const promise = launchEditSession(editId).finally(() => {
    activeEditJobs.delete(editId);
  });
  activeEditJobs.set(editId, promise);
}

export async function waitForWorkflowEditLaunch(
  editId: string,
): Promise<WorkflowEditJobRecord | null> {
  const active = activeEditJobs.get(editId);
  if (active) {
    await active;
  }
  return getWorkflowEditJob(editId);
}

// Launch-only: start the authoring session with the current script
// materialized in the workspace. Draft versions land whenever the agent
// calls `authoring submit` (possibly multiple times).
async function launchEditSession(editId: string) {
  const edit = markWorkflowEditJobRunning(editId);
  if (!edit) {
    return;
  }

  try {
    const baseVersion = getWorkflowVersion(edit.baseVersionId);
    if (!baseVersion || baseVersion.workflowId !== edit.workflowId) {
      throw workflowVersionNotFoundError();
    }

    if (!edit.agent || edit.agent === "mock") {
      completeWorkflowEditJob({
        editId,
        script: baseVersion.script,
        result: { source: "unchanged-mock" },
        semanticReview: createWaivedSemanticReview({
          intentHash: hashAuthoringScript(edit.instruction),
          scriptHash: hashAuthoringScript(baseVersion.script),
          reason: "Built-in mock authoring path.",
        }),
      });
      return;
    }

    const workspace = prepareAuthoringWorkspace({
      jobId: editId,
      currentScript: baseVersion.script,
    });
    const session = await startAgentSession({
      agent: edit.agent,
      model: edit.model ?? undefined,
      cwd: workspace.dir,
      prompt: buildEditAuthoringPrompt({
        jobId: editId,
        instruction: edit.instruction,
        userCwd: edit.cwd ?? undefined,
      }),
    });
    updateWorkflowEditJobAgentSession({
      editId,
      agentSessionId: session.agentSessionId,
    });
  } catch (error) {
    try {
      failWorkflowEditJob({
        editId,
        error: serializeEditError(error),
      });
    } catch {
      // Never leave the job stuck in "running" because the error itself
      // failed to persist.
      failWorkflowEditJob({
        editId,
        error: {
          code: "WORKFLOW_EDIT_FAILED",
          message: error instanceof Error ? error.message : "Workflow edit failed",
        },
      });
    }
  }
}

export async function cancelWorkflowEdit(editId: string): Promise<WorkflowEditJobRecord | null> {
  const edit = getWorkflowEditJob(editId);
  if (!edit) {
    return null;
  }
  if (edit.status !== "pending" && edit.status !== "running") {
    return edit;
  }

  if (edit.agentSessionId) {
    await cancelAgentSession(edit.agentSessionId);
  }
  return cancelWorkflowEditJob({ editId });
}

function serializeEditError(error: unknown) {
  const diagnostics =
    error instanceof WorkflowScriptSyntaxError ? error.diagnostics : undefined;
  return {
    code: getEditErrorCode(error),
    message:
      error instanceof Error ? error.message : "Workflow edit failed",
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function getEditErrorCode(error: unknown): ApiErrorCode {
  if (error instanceof WorkflowScriptSyntaxError) {
    return "WORKFLOW_SCRIPT_INVALID";
  }
  if (error instanceof WorkflowCwdError) {
    return "WORKFLOW_CWD_INVALID";
  }
  return "WORKFLOW_EDIT_FAILED";
}
