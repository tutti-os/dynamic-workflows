export type WorkflowRow = {
  id: string;
  name: string;
  description: string;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
};

export type VersionRow = {
  id: string;
  workflow_id: string;
  version: number;
  meta_json: string;
  semantic_review_json: string | null;
  version_status: "draft" | "published" | "superseded";
  bundle_hash: string;
  published_at: string | null;
  created_at: string;
};

export type GenerationRow = {
  id: string;
  workflow_id: string;
  prompt: string;
  agent: string | null;
  model: string | null;
  cwd: string | null;
  agent_session_id: string | null;
  semantic_review_json: string | null;
  status: WorkflowGenerationStatus;
  generation_json: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

import {
  parseAuthoringSemanticReviewColumn,
  parseJsonValueColumn,
  parseWorkflowGenerationErrorColumn,
  parseWorkflowMetaColumn,
} from "./json-schemas";
import type {
  WorkflowGenerationRecord,
  WorkflowGenerationStatus,
  WorkflowVersionRecord,
  WorkflowRecord,
} from "./types";

export function mapWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    currentVersionId: row.current_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapVersion(row: VersionRow): WorkflowVersionRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    meta: parseWorkflowMetaColumn(row.meta_json, {
      table: "workflow_versions",
      column: "meta_json",
      id: row.id,
    }),
    semanticReview: row.semantic_review_json
      ? parseAuthoringSemanticReviewColumn(row.semantic_review_json, {
          table: "workflow_versions",
          column: "semantic_review_json",
          id: row.id,
        })
      : null,
    status: row.version_status,
    bundleHash: row.bundle_hash,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}

export function mapGeneration(row: GenerationRow): WorkflowGenerationRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    prompt: row.prompt,
    agent: row.agent,
    model: row.model,
    cwd: row.cwd,
    agentSessionId: row.agent_session_id,
    semanticReview: row.semantic_review_json
      ? parseAuthoringSemanticReviewColumn(row.semantic_review_json, {
          table: "workflow_generations",
          column: "semantic_review_json",
          id: row.id,
        })
      : null,
    status: row.status,
    generation: row.generation_json
      ? parseJsonValueColumn(row.generation_json, {
          table: "workflow_generations",
          column: "generation_json",
          id: row.id,
        })
      : null,
    error: row.error_json
      ? parseWorkflowGenerationErrorColumn(row.error_json, {
          table: "workflow_generations",
          column: "error_json",
          id: row.id,
        })
      : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
