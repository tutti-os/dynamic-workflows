import type {
  WorkflowHumanTask,
  WorkflowDiagnostic,
  WorkflowMeta,
} from "@/lib/workflow/types";
import type {
  FlowV1BundleFile,
  FlowV1DetailProjection,
  FlowV1Edge,
  FlowV1JsonObject,
  FlowV1Node,
  FlowV1RuntimeSummary,
  FlowV1SchemaEntry,
  FlowV1VersionStatus,
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
  status: FlowV1VersionStatus;
  bundleHash: string;
  publishedAt: string | null;
  createdAt: string;
};

export type WorkflowVersionDiffLine = {
  kind: "context" | "added" | "removed";
  content: string;
  beforeLine: number | null;
  afterLine: number | null;
};

export type WorkflowVersionReview = {
  version: WorkflowVersionRecord;
  bundle: {
    hash: string;
    files: FlowV1BundleFile[];
  };
  graph: {
    nodes: FlowV1Node[];
    edges: FlowV1Edge[];
  };
  configuration: {
    paramsSchema: Record<string, FlowV1SchemaEntry>;
    inputsSchema: Record<string, FlowV1SchemaEntry>;
    secretsSchema: Record<string, FlowV1SchemaEntry>;
    suggestedParams: FlowV1JsonObject;
    projectCwd: string | null;
    defaultAgent: string | null;
    defaultModel: string | null;
    defaultPermissionMode: string | null;
    defaultReasoningEffort: string | null;
  };
  diagnostics: WorkflowDiagnostic[];
  comparison: {
    baseVersion: WorkflowVersionRecord;
    files: Array<{
      path: string;
      status: "added" | "removed" | "modified" | "unchanged";
      lines: WorkflowVersionDiffLine[];
    }>;
    graph: {
      addedNodeIds: string[];
      removedNodeIds: string[];
      changedNodeIds: string[];
      addedEdgeIds: string[];
      removedEdgeIds: string[];
      changedEdgeIds: string[];
    };
  } | null;
};

export type WorkflowDraftReview = WorkflowVersionReview;

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
  latestVersion: WorkflowVersionRecord | null;
  generation: WorkflowGenerationRecord | null;
  flowV1Runtime: FlowV1RuntimeSummary | null;
};

export type WorkflowDetail = {
  workflow: WorkflowRecord;
  currentVersion: WorkflowVersionRecord | null;
  versions: WorkflowVersionRecord[];
  generation: WorkflowGenerationRecord | null;
  flowV1?: FlowV1DetailProjection | null;
  draftReview?: WorkflowDraftReview | null;
  versionReview?: WorkflowVersionReview | null;
};
