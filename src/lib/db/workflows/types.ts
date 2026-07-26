import type {
  WorkflowHumanTask,
  WorkflowDiagnostic,
  WorkflowMeta,
} from "@/lib/workflow/types";
import type {
  FlowV1DetailProjection,
  FlowV1RuntimeSummary,
} from "@/lib/flow-v1/types";

export type WorkflowHumanTaskRecord = WorkflowHumanTask;

export type WorkflowRecord = {
  id: string;
  name: string;
  description: string;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuthoringSemanticReviewStatus =
  | "running"
  | "passed"
  | "failed"
  | "stale"
  | "unavailable"
  | "invalid_output"
  | "canceled"
  | "waived";

export type AuthoringSemanticReviewFinding = {
  reason: string;
  nodePath: string[];
  suggestion: string;
};

export type AuthoringSemanticReview = {
  reviewId: string;
  status: AuthoringSemanticReviewStatus;
  intentHash: string;
  scriptHash: string;
  reviewerAgent: string | null;
  reviewerModel: string | null;
  reviewerSessionId: string | null;
  summary: string;
  findings: AuthoringSemanticReviewFinding[];
  waiverReason?: string;
  error?: string;
  startedAt: string;
  completedAt: string | null;
};

export type WorkflowVersionRecord = {
  id: string;
  workflowId: string;
  version: number;
  meta: WorkflowMeta;
  semanticReview: AuthoringSemanticReview | null;
  createdAt: string;
};

export type WorkflowGenerationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type WorkflowGenerationError = {
  code?: string;
  message: string;
  diagnostics?: WorkflowDiagnostic[];
};

export type WorkflowGenerationRecord = {
  id: string;
  workflowId: string;
  prompt: string;
  agent: string | null;
  model: string | null;
  cwd: string | null;
  agentSessionId: string | null;
  semanticReview: AuthoringSemanticReview | null;
  status: WorkflowGenerationStatus;
  generation: unknown;
  error: WorkflowGenerationError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkflowListItem = {
  workflow: WorkflowRecord;
  currentVersion: WorkflowVersionRecord | null;
  generation: WorkflowGenerationRecord | null;
  flowV1Runtime: FlowV1RuntimeSummary | null;
};

export type WorkflowDetail = {
  workflow: WorkflowRecord;
  currentVersion: WorkflowVersionRecord | null;
  versions: WorkflowVersionRecord[];
  generation: WorkflowGenerationRecord | null;
  flowV1?: FlowV1DetailProjection | null;
};
