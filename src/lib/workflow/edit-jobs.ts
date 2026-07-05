import {
  cancelWorkflowEditJob,
  completeWorkflowEditJob,
  failWorkflowEditJob,
  getWorkflowEditJob,
  markWorkflowEditJobRunning,
  markWorkflowEditJobStale,
  updateWorkflowEditJobAgentSession,
} from "@/lib/db/workflows/edit-jobs";
import {
  getWorkflowVersion,
} from "@/lib/db/workflows/versions";
import type {
  WorkflowEditJobRecord,
} from "@/lib/db/workflows/types";
import { workflowVersionNotFoundError } from "@/lib/api/app-error";
import { cancelAgentRun } from "@/lib/agents/runtime";
import type { ApiErrorCode } from "@/lib/api/errors";
import { WorkflowCwdError } from "@/lib/workflow/cwd";
import { editWorkflowScriptWithRepair } from "@/lib/workflow/generator";
import { WorkflowScriptSyntaxError } from "@/lib/workflow/parser";

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
    edit.status === "canceled"
  ) {
    return edit;
  }

  if (edit.status === "running") {
    return activeEditJobs.has(edit.id) ? edit : markWorkflowEditJobStale(edit.id);
  }

  startEditJob(edit.id);
  return getWorkflowEditJob(edit.id) ?? edit;
}

function startEditJob(editId: string) {
  if (activeEditJobs.has(editId)) {
    return;
  }

  const promise = runEditJob(editId).finally(() => {
    activeEditJobs.delete(editId);
  });
  activeEditJobs.set(editId, promise);
}

async function runEditJob(editId: string) {
  const edit = markWorkflowEditJobRunning(editId);
  if (!edit) {
    return;
  }

  try {
    const baseVersion = getWorkflowVersion(edit.baseVersionId);
    if (!baseVersion || baseVersion.workflowId !== edit.workflowId) {
      throw workflowVersionNotFoundError();
    }

    const edited = await editWorkflowScriptWithRepair({
      currentScript: baseVersion.script,
      instruction: edit.instruction,
      agent: edit.agent ?? undefined,
      model: edit.model ?? undefined,
      cwd: edit.cwd ?? undefined,
      onEvent: (event) => {
        if (event.type === "session_ref" && event.session.agentSessionId) {
          updateWorkflowEditJobAgentSession({
            editId,
            agentSessionId: event.session.agentSessionId,
          });
        }
      },
    });

    completeWorkflowEditJob({
      editId,
      script: edited.script,
      result: {
        repaired: edited.repaired,
        repairAttempts: edited.repairAttempts,
      },
    });
  } catch (error) {
    failWorkflowEditJob({
      editId,
      error: serializeEditError(error),
    });
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

  await cancelAgentRun(editId);
  return cancelWorkflowEditJob({ editId });
}

function serializeEditError(error: unknown) {
  const code = getEditErrorCode(error);
  return {
    code,
    message:
      error instanceof Error ? error.message : "Workflow edit failed",
    diagnostics:
      error instanceof WorkflowScriptSyntaxError ? error.diagnostics : undefined,
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
