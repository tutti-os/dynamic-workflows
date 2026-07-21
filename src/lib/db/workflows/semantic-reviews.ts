import { getDb } from "../client";
import { stringifyAuthoringSemanticReviewColumn } from "./json-schemas";
import { getWorkflowEditJob } from "./edit-jobs";
import { getWorkflowGeneration } from "./generations";
import type { AuthoringSemanticReview } from "./types";
import type { AuthoringSemanticReviewStatus } from "./types";

type AuthoringJobTable = "workflow_generations" | "workflow_edit_jobs";

export function getAuthoringSemanticReview(
  jobId: string,
): AuthoringSemanticReview | null {
  return (
    getWorkflowGeneration(jobId)?.semanticReview ??
    getWorkflowEditJob(jobId)?.semanticReview ??
    null
  );
}

export function setAuthoringSemanticReview(
  jobId: string,
  review: AuthoringSemanticReview,
): void {
  const table = locateTable(jobId);
  getDb()
    .prepare(`UPDATE ${table} SET semantic_review_json = ? WHERE id = ?`)
    .run(stringifyReview(table, jobId, review), jobId);
}

export function compareAndSetAuthoringSemanticReview(input: {
  jobId: string;
  reviewId: string;
  expectedStatus?: AuthoringSemanticReviewStatus;
  review: AuthoringSemanticReview;
}): boolean {
  const table = locateTable(input.jobId);
  const database = getDb();
  return database.transaction(() => {
    const current = getAuthoringSemanticReview(input.jobId);
    if (
      current?.reviewId !== input.reviewId ||
      (input.expectedStatus !== undefined &&
        current.status !== input.expectedStatus)
    ) {
      return false;
    }
    database
      .prepare(`UPDATE ${table} SET semantic_review_json = ? WHERE id = ?`)
      .run(stringifyReview(table, input.jobId, input.review), input.jobId);
    return true;
  })();
}

function locateTable(jobId: string): AuthoringJobTable {
  if (getWorkflowGeneration(jobId)) {
    return "workflow_generations";
  }
  if (getWorkflowEditJob(jobId)) {
    return "workflow_edit_jobs";
  }
  throw new Error("Authoring job not found");
}

function stringifyReview(
  table: AuthoringJobTable,
  jobId: string,
  review: AuthoringSemanticReview,
): string {
  return stringifyAuthoringSemanticReviewColumn(review, {
    table,
    column: "semantic_review_json",
    id: jobId,
  });
}
