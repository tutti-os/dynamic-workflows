import fs from "node:fs";
import {
  completeWorkflowGeneration,
  getWorkflowGeneration,
} from "@/lib/db/workflows/generations";
import {
  completeWorkflowEditJob,
  getWorkflowEditJob,
} from "@/lib/db/workflows/edit-jobs";
import type {
  WorkflowDiagnostic,
  WorkflowDiagnosticSummary,
} from "@/lib/workflow/types";
import { parseWorkflowScript } from "@/lib/workflow/parser";
import {
  hasWorkflowDiagnosticErrors,
  summarizeWorkflowDiagnostics,
} from "@/lib/workflow/validation";
import {
  AuthoringWorkspaceError,
  resolveAuthoringScriptFile,
} from "./workspace";

const MAX_SCRIPT_BYTES = 512 * 1024;

export type AuthoringSubmitInput = {
  jobId: string;
  file?: string;
  script?: string;
};

export type AuthoringSubmitResult =
  | {
      accepted: true;
      jobType: "generation" | "edit";
      workflowId: string;
      versionId: string | null;
      version: number | null;
      workflowName: string | null;
    }
  | {
      accepted: false;
      jobType: "generation" | "edit";
      diagnosticSummary: WorkflowDiagnosticSummary;
      diagnostics: WorkflowDiagnostic[];
    };

export class AuthoringSubmitError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthoringSubmitError";
    this.code = code;
    this.status = status;
  }
}

export function submitAuthoringScript(
  input: AuthoringSubmitInput,
): AuthoringSubmitResult {
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new AuthoringSubmitError("invalid_input", "job-id is required.", 400);
  }

  const job = locateAuthoringJob(jobId);
  const script = readSubmittedScript(input, jobId);

  const parsed = parseWorkflowScript(script);
  if (hasWorkflowDiagnosticErrors(parsed.diagnostics)) {
    return {
      accepted: false,
      jobType: job.type,
      diagnosticSummary: summarizeWorkflowDiagnostics(parsed.diagnostics),
      diagnostics: parsed.diagnostics,
    };
  }

  if (job.type === "generation") {
    const detail = completeWorkflowGeneration({
      generationId: jobId,
      script,
      generation: { submittedVia: "authoring_submit" },
    });
    return {
      accepted: true,
      jobType: "generation",
      workflowId: detail.workflow.id,
      versionId: detail.currentVersion?.id ?? null,
      version: detail.currentVersion?.version ?? null,
      workflowName: detail.workflow.name,
    };
  }

  const completed = completeWorkflowEditJob({
    editId: jobId,
    script,
    result: { submittedVia: "authoring_submit" },
  });
  if (completed.status !== "completed") {
    throw new AuthoringSubmitError(
      "authoring_job_not_submittable",
      `Edit job is ${completed.status}; the script was not applied.`,
      409,
    );
  }
  return {
    accepted: true,
    jobType: "edit",
    workflowId: completed.workflowId,
    versionId: completed.createdVersionId,
    version: null,
    workflowName: null,
  };
}

// Authoring sessions are decoupled from job completion: a session may keep
// conversing and submit any number of times. Each accepted submit lands a new
// version ("completed" only means "has produced at least one version"). Only
// jobs whose session never launched (failed) or was canceled reject submits.
function locateAuthoringJob(
  jobId: string,
): { type: "generation" | "edit" } {
  const generation = getWorkflowGeneration(jobId);
  if (generation) {
    if (generation.status === "failed") {
      throw new AuthoringSubmitError(
        "authoring_job_not_submittable",
        "This authoring job failed to launch; ask the user to retry it.",
        409,
      );
    }
    return { type: "generation" };
  }

  const edit = getWorkflowEditJob(jobId);
  if (edit) {
    if (edit.status === "failed" || edit.status === "canceled") {
      throw new AuthoringSubmitError(
        "authoring_job_not_submittable",
        `Edit job is ${edit.status}; submits are no longer accepted.`,
        409,
      );
    }
    return { type: "edit" };
  }

  throw new AuthoringSubmitError(
    "authoring_job_not_found",
    "No authoring job found for this job-id.",
    404,
  );
}

function readSubmittedScript(
  input: AuthoringSubmitInput,
  jobId: string,
): string {
  if (input.script?.trim()) {
    return input.script;
  }
  if (!input.file?.trim()) {
    throw new AuthoringSubmitError(
      "invalid_input",
      "Provide the script through --file or --script.",
      400,
    );
  }

  let filePath: string;
  try {
    filePath = resolveAuthoringScriptFile({ jobId, file: input.file.trim() });
  } catch (error) {
    if (error instanceof AuthoringWorkspaceError) {
      throw new AuthoringSubmitError("invalid_input", error.message, 400);
    }
    throw error;
  }
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_SCRIPT_BYTES) {
    throw new AuthoringSubmitError(
      "invalid_input",
      `Script file exceeds ${MAX_SCRIPT_BYTES} bytes.`,
      400,
    );
  }
  const script = fs.readFileSync(filePath, "utf8");
  if (!script.trim()) {
    throw new AuthoringSubmitError(
      "invalid_input",
      "Script file is empty.",
      400,
    );
  }
  return script;
}
