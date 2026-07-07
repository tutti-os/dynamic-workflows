import type { WorkflowDiagnostic } from "@/lib/workflow/types";

export type ApiErrorCode =
  | "PROMPT_REQUIRED"
  | "SCRIPT_REQUIRED"
  | "WORKFLOW_NAME_REQUIRED"
  | "WORKFLOW_NAME_TOO_LONG"
  | "WORKFLOW_DESCRIPTION_TOO_LONG"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_VERSION_NOT_FOUND"
  | "WORKFLOW_BLUEPRINT_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "WORKFLOW_SCRIPT_INVALID"
  | "WORKFLOW_INPUTS_INVALID"
  | "WORKFLOW_CWD_INVALID"
  | "WORKFLOW_GENERATION_FAILED"
  | "WORKFLOW_EDIT_FAILED"
  | "WORKFLOW_REPAIR_FAILED"
  | "WORKFLOW_IMPORT_FAILED"
  | "WORKFLOW_SAVE_FAILED"
  | "WORKFLOW_UPDATE_FAILED"
  | "WORKFLOW_DUPLICATE_FAILED"
  | "WORKFLOW_DELETE_FAILED"
  | "WORKFLOW_RUN_FAILED"
  | "AGENT_TARGET_DETECTION_FAILED"
  | "LEGACY_RUN_ENDPOINT"
  | "UNKNOWN_ERROR";

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
  diagnostics?: WorkflowDiagnostic[];
};

export type ApiErrorResponse = {
  error: ApiError;
};

const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  PROMPT_REQUIRED: "Enter a prompt before creating a workflow.",
  SCRIPT_REQUIRED: "Paste a workflow script before importing or saving.",
  WORKFLOW_NAME_REQUIRED: "Enter a workflow name.",
  WORKFLOW_NAME_TOO_LONG: "Workflow name must be 120 characters or less.",
  WORKFLOW_DESCRIPTION_TOO_LONG:
    "Workflow description must be 500 characters or less.",
  WORKFLOW_NOT_FOUND: "Workflow not found.",
  WORKFLOW_VERSION_NOT_FOUND: "Workflow version not found.",
  WORKFLOW_BLUEPRINT_NOT_FOUND: "Workflow blueprint not found.",
  RUN_NOT_FOUND: "Run not found.",
  WORKFLOW_SCRIPT_INVALID:
    "The workflow script has syntax or workflow rule errors.",
  WORKFLOW_INPUTS_INVALID: "Workflow inputs are invalid.",
  WORKFLOW_CWD_INVALID:
    "The working directory is invalid or outside the allowed workspace.",
  WORKFLOW_GENERATION_FAILED: "Workflow generation failed.",
  WORKFLOW_EDIT_FAILED: "Workflow edit failed.",
  WORKFLOW_REPAIR_FAILED: "The agent could not repair this workflow script.",
  WORKFLOW_IMPORT_FAILED: "Workflow import failed.",
  WORKFLOW_SAVE_FAILED: "Workflow save failed.",
  WORKFLOW_UPDATE_FAILED: "Workflow update failed.",
  WORKFLOW_DUPLICATE_FAILED: "Workflow duplication failed.",
  WORKFLOW_DELETE_FAILED: "Workflow deletion failed.",
  WORKFLOW_RUN_FAILED: "Workflow run failed.",
  AGENT_TARGET_DETECTION_FAILED: "Agent target detection failed.",
  LEGACY_RUN_ENDPOINT:
    "Use the workflow detail page to run a versioned, logged workflow.",
  UNKNOWN_ERROR: "Something went wrong.",
};

export function apiError(
  code: ApiErrorCode,
  options?: {
    message?: string;
    details?: unknown;
    diagnostics?: WorkflowDiagnostic[];
  },
): ApiErrorResponse {
  return {
    error: {
      code,
      message: options?.message ?? ERROR_MESSAGES[code],
      ...(options?.details === undefined ? {} : { details: options.details }),
      ...(options?.diagnostics === undefined
        ? {}
        : { diagnostics: options.diagnostics }),
    },
  };
}

export function getApiErrorMessage(
  value: unknown,
  fallbackCode: ApiErrorCode = "UNKNOWN_ERROR",
): string {
  const parsed = readApiError(value, fallbackCode);
  return parsed.message;
}

export function readApiError(
  value: unknown,
  fallbackCode: ApiErrorCode = "UNKNOWN_ERROR",
): ApiError {
  if (isApiErrorResponse(value)) {
    return value.error;
  }

  if (typeof value === "string" && value.trim()) {
    return {
      code: fallbackCode,
      message: value,
    };
  }

  return {
    code: fallbackCode,
    message: ERROR_MESSAGES[fallbackCode],
  };
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (!value || typeof value !== "object" || !("error" in value)) {
    return false;
  }

  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  );
}
