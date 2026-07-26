import {
  FlowV1BundleError,
  readFlowV1BundleDirectory,
} from "@/lib/flow-v1/bundle";
import { parseFlowV1Bundle } from "@/lib/flow-v1/parser";
import type { FlowV1Bundle, ParsedFlowV1 } from "@/lib/flow-v1/types";
import type { AuthoringSemanticReview } from "@/lib/db/workflows/types";
import type {
  WorkflowDiagnostic,
  WorkflowDiagnosticSummary,
} from "@/lib/workflow/types";
import {
  hasWorkflowDiagnosticErrors,
  summarizeWorkflowDiagnostics,
} from "@/lib/workflow/validation";
import { resolveAuthoringBundleDirectory } from "./workspace";
import {
  completeWorkflowFlowGeneration,
  getWorkflowGeneration,
} from "@/lib/db/workflows/generations";
import {
  createFlowV1Version,
} from "@/lib/flow-v1/flow-service";
import { setFlowV1RuntimeConfig } from "@/lib/flow-v1/runtime-config";
import {
  AuthoringSubmitError,
  requireSemanticReview,
} from "./submit";
import {
  getCurrentAuthoringSemanticReview,
  hashAuthoringScript,
  markReviewStale,
  startAuthoringSemanticReview,
} from "./semantic-review";

export type AuthoringFlowBundleValidation = {
  valid: boolean;
  bundle: FlowV1Bundle | null;
  parsed: ParsedFlowV1 | null;
  diagnosticSummary: WorkflowDiagnosticSummary;
  diagnostics: WorkflowDiagnostic[];
};

export type AuthoringFlowBundleReviewValidation =
  AuthoringFlowBundleValidation & {
    review: AuthoringSemanticReview | null;
  };

/**
 * Reads and statically validates a Flow Bundle from an authoring workspace.
 * This boundary deliberately never imports or executes flow.js or code nodes.
 */
export function validateAuthoringFlowBundle(input: {
  jobId: string;
  directory?: string;
}): AuthoringFlowBundleValidation {
  const directory = resolveAuthoringBundleDirectory(input);
  let bundle: FlowV1Bundle;
  try {
    bundle = readFlowV1BundleDirectory(directory);
  } catch (error) {
    if (!(error instanceof FlowV1BundleError)) {
      throw error;
    }
    return invalidBundle(error.diagnostics);
  }

  const parsed = parseFlowV1Bundle(bundle);
  return {
    valid: !hasWorkflowDiagnosticErrors(parsed.diagnostics),
    bundle,
    parsed,
    diagnosticSummary: summarizeWorkflowDiagnostics(parsed.diagnostics),
    diagnostics: parsed.diagnostics,
  };
}

export async function validateAuthoringFlowBundleWithReview(input: {
  jobId: string;
  directory?: string;
  reviewMode?: "none" | "agent";
  reviewerAgent?: string;
  reviewerModel?: string;
}): Promise<AuthoringFlowBundleReviewValidation> {
  const validation = validateAuthoringFlowBundle(input);
  let review = getCurrentAuthoringSemanticReview(input.jobId);
  if (validation.valid && validation.bundle) {
    const candidate = serializeFlowV1BundleForReview(validation.bundle);
    if (input.reviewMode === "agent") {
      review = await startAuthoringSemanticReview({
        jobId: input.jobId,
        script: candidate,
        reviewerAgent: input.reviewerAgent,
        reviewerModel: input.reviewerModel,
      });
    } else if (
      review &&
      review.scriptHash !== hashAuthoringScript(candidate)
    ) {
      review = markReviewStale(input.jobId, review);
    }
  }
  return { ...validation, review };
}

export async function submitAuthoringFlowBundle(input: {
  jobId: string;
  directory?: string;
  skipSemanticReview?: boolean;
  reason?: string;
}): Promise<{
  accepted: boolean;
  jobType: "generation";
  workflowId?: string;
  versionId?: string;
  version?: number;
  versionStatus?: "draft";
  bundleHash?: string;
  diagnosticSummary?: WorkflowDiagnosticSummary;
  diagnostics?: WorkflowDiagnostic[];
}> {
  const generation = getWorkflowGeneration(input.jobId);
  if (!generation) {
    throw new AuthoringSubmitError(
      "authoring_job_not_found",
      "Flow Bundle submission currently requires a generation job.",
      404,
    );
  }
  const validation = validateAuthoringFlowBundle(input);
  if (!validation.valid || !validation.bundle || !validation.parsed) {
    return {
      accepted: false,
      jobType: "generation",
      diagnosticSummary: validation.diagnosticSummary,
      diagnostics: validation.diagnostics,
    };
  }
  const semanticReview = await requireSemanticReview({
    jobId: input.jobId,
    script: serializeFlowV1BundleForReview(validation.bundle),
    skip: input.skipSemanticReview ?? false,
    reason: input.reason,
    fallbackIntent: generation.prompt,
  });
  const created = createFlowV1Version({
    flowId: generation.workflowId,
    bundle: validation.bundle,
    publish: false,
    semanticReview,
  });
  setFlowV1RuntimeConfig({
    flowId: generation.workflowId,
    projectCwd: generation.cwd ?? undefined,
    defaultAgent: generation.agent ?? "mock",
    defaultModel: generation.model,
  });
  completeWorkflowFlowGeneration({
    generationId: input.jobId,
    generation: {
      submittedVia: "authoring_flow_bundle",
      bundleHash: validation.bundle.hash,
      versionStatus: "draft",
      semanticReview: {
        status: semanticReview.status,
        reviewId: semanticReview.reviewId,
      },
    },
  });
  return {
    accepted: true,
    jobType: "generation",
    workflowId: generation.workflowId,
    versionId: created.versionId,
    version: created.version,
    versionStatus: "draft",
    bundleHash: created.bundleHash,
  };
}

function invalidBundle(
  diagnostics: WorkflowDiagnostic[],
): AuthoringFlowBundleValidation {
  return {
    valid: false,
    bundle: null,
    parsed: null,
    diagnosticSummary: summarizeWorkflowDiagnostics(diagnostics),
    diagnostics,
  };
}

export function serializeFlowV1BundleForReview(
  bundle: FlowV1Bundle,
): string {
  return bundle.files
    .map(
      (file) =>
        `===== ${file.path} =====\n${file.content.replace(/\r\n/g, "\n")}`,
    )
    .join("\n\n");
}
