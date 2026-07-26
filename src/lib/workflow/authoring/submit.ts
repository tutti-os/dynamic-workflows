import type { AuthoringSemanticReview } from "@/lib/db/workflows/types";
import { setAuthoringSemanticReview } from "@/lib/db/workflows/semantic-reviews";
import {
  createWaivedSemanticReview,
  getCurrentAuthoringSemanticReview,
  getCurrentIntentHash,
  hashAuthoringScript,
  markReviewStale,
} from "./semantic-review";

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

export async function requireSemanticReview(input: {
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
      "No semantic review exists for this Bundle. Run authoring validate with --review-mode agent, then wait for its result.",
    );
  }
  if (review.intentHash !== intentHash || review.scriptHash !== scriptHash) {
    markReviewStale(input.jobId, review);
    throw reviewBlocked(
      "The semantic review is stale because the user intent or Bundle changed. Review the current Bundle again, or explicitly waive review with a reason.",
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
      return "Semantic review failed the design. Revise the Bundle and review again, or waive review with a reason.";
    case "stale":
      return "Semantic review is stale. Review the current Bundle again, or waive it with a reason.";
    case "unavailable":
    case "invalid_output":
    case "canceled":
      return `Semantic review is ${review.status}. Retry review, or waive it with a reason.`;
    case "waived":
      return "The stored waiver does not match this Bundle. Waive the current Bundle again with a reason.";
    case "passed":
      return "Semantic review must pass before submission.";
  }
}
