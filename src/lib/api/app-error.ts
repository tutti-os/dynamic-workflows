import type { ApiErrorCode } from "@/lib/api/errors";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: unknown;
  readonly diagnostics?: WorkflowDiagnostic[];

  constructor(
    code: ApiErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      details?: unknown;
      diagnostics?: WorkflowDiagnostic[];
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "AppError";
    this.code = code;
    this.details = options?.details;
    this.diagnostics = options?.diagnostics;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function workflowNotFoundError(): AppError {
  return new AppError("WORKFLOW_NOT_FOUND", "Workflow not found");
}

export function workflowRetryRequestInvalidError(message: string): AppError {
  return new AppError("WORKFLOW_RETRY_REQUEST_INVALID", message);
}
