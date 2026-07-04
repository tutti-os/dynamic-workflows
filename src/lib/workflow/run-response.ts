import type { ApiErrorCode } from "@/lib/api/errors";
import { getWorkflowApiErrorCode } from "@/lib/api/server-errors";
import { WorkflowCwdError } from "@/lib/workflow/cwd";
import { WorkflowScriptSyntaxError } from "@/lib/workflow/parser";

export function formatRunError(error: unknown): string {
  if (
    error instanceof WorkflowScriptSyntaxError ||
    error instanceof WorkflowCwdError
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : "Workflow run failed";
}

export function getRunErrorCode(error: unknown): ApiErrorCode {
  return getWorkflowApiErrorCode(error, "WORKFLOW_RUN_FAILED");
}
