import fs from "node:fs";
import {
  completeWorkflowGeneration,
  getWorkflowGeneration,
} from "@/lib/db/workflows/generations";
import {
  completeWorkflowEditJob,
  getWorkflowEditJob,
} from "@/lib/db/workflows/edit-jobs";
import type { AuthoringSemanticReview } from "@/lib/db/workflows/types";
import type {
  WorkflowDiagnostic,
  WorkflowDiagnosticSummary,
} from "@/lib/workflow/types";
import { setAuthoringSemanticReview } from "@/lib/db/workflows/semantic-reviews";
import { parseWorkflowScript } from "@/lib/workflow/parser";
import {
  hasWorkflowDiagnosticErrors,
  summarizeWorkflowDiagnostics,
} from "@/lib/workflow/validation";
import {
  AuthoringWorkspaceError,
  resolveAuthoringScriptFile,
} from "./workspace";
import {
  createWaivedSemanticReview,
  getCurrentAuthoringSemanticReview,
  getCurrentIntentHash,
  hashAuthoringScript,
  markReviewStale,
  startAuthoringSemanticReview,
} from "./semantic-review";

const MAX_SCRIPT_BYTES = 512 * 1024;

export type AuthoringSubmitInput = {
  jobId: string;
  file?: string;
  script?: string;
  skipSemanticReview?: boolean;
  reason?: string;
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

export type AuthoringValidateResult = {
  valid: boolean;
  jobType: "generation" | "edit";
  diagnosticSummary: WorkflowDiagnosticSummary;
  diagnostics: WorkflowDiagnostic[];
  review: AuthoringSemanticReview | null;
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

export async function submitAuthoringScript(
  input: AuthoringSubmitInput,
): Promise<AuthoringSubmitResult> {
  const { jobId, job, script, parsed } = inspectAuthoringScript(input);
  if (hasWorkflowDiagnosticErrors(parsed.diagnostics)) {
    return {
      accepted: false,
      jobType: job.type,
      diagnosticSummary: summarizeWorkflowDiagnostics(parsed.diagnostics),
      diagnostics: parsed.diagnostics,
    };
  }

  const semanticReview = await requireSemanticReview({
    jobId,
    script,
    skip: input.skipSemanticReview ?? false,
    reason: input.reason,
    fallbackIntent: job.intent,
  });

  if (job.type === "generation") {
    const detail = completeWorkflowGeneration({
      generationId: jobId,
      script,
      generation: { submittedVia: "authoring_submit" },
      semanticReview,
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
    semanticReview,
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

export async function validateAuthoringScript(
  input: AuthoringSubmitInput & {
    reviewMode?: "none" | "agent";
    reviewerAgent?: string;
    reviewerModel?: string;
  },
): Promise<AuthoringValidateResult> {
  const { jobId, job, script, parsed } = inspectAuthoringScript(input);
  const valid = !hasWorkflowDiagnosticErrors(parsed.diagnostics);
  let review = getCurrentAuthoringSemanticReview(jobId);
  if (valid && input.reviewMode === "agent") {
    review = await startAuthoringSemanticReview({
      jobId,
      script,
      reviewerAgent: input.reviewerAgent,
      reviewerModel: input.reviewerModel,
    });
  } else if (review && review.scriptHash !== hashAuthoringScript(script)) {
    review = markReviewStale(jobId, review);
  }
  return {
    valid,
    jobType: job.type,
    diagnosticSummary: summarizeWorkflowDiagnostics(parsed.diagnostics),
    diagnostics: parsed.diagnostics,
    review,
  };
}

function inspectAuthoringScript(input: AuthoringSubmitInput) {
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new AuthoringSubmitError("invalid_input", "job-id is required.", 400);
  }

  const job = locateAuthoringJob(jobId);
  const script = readSubmittedScript(input, jobId);
  const parsed = parseWorkflowScript(script);
  return { jobId, job, script, parsed };
}

// Authoring sessions are decoupled from job completion: a session may keep
// conversing and submit any number of times. Each accepted submit lands a new
// version ("completed" only means "has produced at least one version"). Only
// jobs whose session never launched (failed) or was canceled reject submits.
function locateAuthoringJob(
  jobId: string,
): { type: "generation" | "edit"; intent: string } {
  const generation = getWorkflowGeneration(jobId);
  if (generation) {
    if (generation.status === "failed") {
      throw new AuthoringSubmitError(
        "authoring_job_not_submittable",
        "This authoring job failed to launch; ask the user to retry it.",
        409,
      );
    }
    return { type: "generation", intent: generation.prompt };
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
    return { type: "edit", intent: edit.instruction };
  }

  throw new AuthoringSubmitError(
    "authoring_job_not_found",
    "No authoring job found for this job-id.",
    404,
  );
}

async function requireSemanticReview(input: {
  jobId: string;
  script: string;
  skip: boolean;
  reason?: string;
  fallbackIntent: string;
}): Promise<AuthoringSemanticReview> {
  const scriptHash = hashAuthoringScript(input.script);
  let intentHash: string;
  try {
    intentHash = await getCurrentIntentHash(input.jobId);
  } catch {
    // The explicit waiver remains usable when the reviewer/session service is
    // unavailable. Normal PASS submission still blocks below.
    intentHash = hashAuthoringScript(input.fallbackIntent);
  }

  if (input.skip) {
    const reason = input.reason?.trim();
    if (!reason) {
      throw new AuthoringSubmitError(
        "semantic_review_waiver_reason_required",
        "--skip-semantic-review requires a non-empty --reason.",
        400,
      );
    }
    const waived = createWaivedSemanticReview({ intentHash, scriptHash, reason });
    setAuthoringSemanticReview(input.jobId, waived);
    return waived;
  }

  const review = getCurrentAuthoringSemanticReview(input.jobId);
  if (!review) {
    throw reviewBlocked(
      "No semantic review exists for this candidate. Run authoring validate with --review-mode agent, then wait for its result.",
    );
  }
  if (review.intentHash !== intentHash || review.scriptHash !== scriptHash) {
    markReviewStale(input.jobId, review);
    throw reviewBlocked(
      "The semantic review is stale because the user intent or script changed. Review the current candidate again, or explicitly waive review with a reason.",
    );
  }
  if (review.status !== "passed") {
    throw reviewBlocked(reviewNextAction(review));
  }
  return review;
}

function reviewBlocked(message: string): AuthoringSubmitError {
  return new AuthoringSubmitError("semantic_review_required", message, 409);
}

function reviewNextAction(review: AuthoringSemanticReview): string {
  switch (review.status) {
    case "running":
      return "Semantic review is still running. Wait for it before submitting.";
    case "failed":
      return "Semantic review failed the design. Use its findings to revise or ask the user, then review again; alternatively waive review with a reason.";
    case "stale":
      return "Semantic review is stale. Review the current candidate again, or waive review with a reason.";
    case "unavailable":
    case "invalid_output":
    case "canceled":
      return `Semantic review is ${review.status}. Retry review, or waive it with a reason.`;
    case "waived":
      return "The stored waiver does not match this submission. Waive the current candidate again with a reason.";
    case "passed":
      return "Semantic review must pass before submission.";
  }
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
