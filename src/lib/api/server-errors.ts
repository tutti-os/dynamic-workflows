import { NextResponse } from "next/server";
import {
  apiError,
  type ApiErrorCode,
  type ApiErrorResponse,
} from "@/lib/api/errors";
import { WorkflowCwdError } from "@/lib/workflow/cwd";
import { WorkflowScriptSyntaxError } from "@/lib/workflow/parser";

const ERROR_STATUS: Partial<Record<ApiErrorCode, number>> = {
  PROMPT_REQUIRED: 400,
  SCRIPT_REQUIRED: 400,
  WORKFLOW_NAME_REQUIRED: 400,
  WORKFLOW_NAME_TOO_LONG: 400,
  WORKFLOW_DESCRIPTION_TOO_LONG: 400,
  WORKFLOW_NOT_FOUND: 404,
  WORKFLOW_VERSION_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  WORKFLOW_SCRIPT_INVALID: 400,
  WORKFLOW_CWD_INVALID: 400,
  LEGACY_RUN_ENDPOINT: 410,
};

export function getWorkflowApiErrorCode(
  error: unknown,
  fallbackCode: ApiErrorCode,
): ApiErrorCode {
  if (error instanceof WorkflowScriptSyntaxError) {
    return "WORKFLOW_SCRIPT_INVALID";
  }
  if (error instanceof WorkflowCwdError) {
    return "WORKFLOW_CWD_INVALID";
  }
  if (error instanceof Error) {
    if (error.message === "Workflow not found") {
      return "WORKFLOW_NOT_FOUND";
    }
    if (error.message === "Run not found") {
      return "RUN_NOT_FOUND";
    }
    if (error.message === "Workflow version not found") {
      return "WORKFLOW_VERSION_NOT_FOUND";
    }
  }
  return fallbackCode;
}

export function toWorkflowApiErrorResponse(
  error: unknown,
  fallbackCode: ApiErrorCode,
  options?: {
    status?: number;
  },
): NextResponse<ApiErrorResponse> {
  const code = getWorkflowApiErrorCode(error, fallbackCode);
  return NextResponse.json(
    apiError(code, {
      message: error instanceof Error ? error.message : undefined,
      diagnostics:
        error instanceof WorkflowScriptSyntaxError
          ? error.diagnostics
          : undefined,
    }),
    { status: options?.status ?? ERROR_STATUS[code] ?? 500 },
  );
}
