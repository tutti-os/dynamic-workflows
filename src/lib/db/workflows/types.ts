import type {
  WorkflowHumanTask,
  WorkflowRunCheckpointState,
  WorkflowDiagnostic,
  WorkflowMeta,
} from "@/lib/workflow/types";

export type WorkflowHumanTaskRecord = WorkflowHumanTask;

export type WorkflowRecord = {
  id: string;
  name: string;
  description: string;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowVersionRecord = {
  id: string;
  workflowId: string;
  version: number;
  script: string;
  meta: WorkflowMeta;
  source: string | null;
  baseVersionId: string | null;
  note: string | null;
  createdAt: string;
};

export type WorkflowRunStatus =
  | "running"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

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
  status: WorkflowGenerationStatus;
  generation: unknown;
  error: WorkflowGenerationError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkflowEditJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type WorkflowEditJobError = {
  code?: string;
  message: string;
  diagnostics?: WorkflowDiagnostic[];
};

export type WorkflowEditJobRecord = {
  id: string;
  workflowId: string;
  baseVersionId: string;
  createdVersionId: string | null;
  instruction: string;
  agent: string | null;
  model: string | null;
  cwd: string | null;
  agentSessionId: string | null;
  status: WorkflowEditJobStatus;
  result: unknown;
  error: WorkflowEditJobError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkflowRunRecord = {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  executorKind: string;
  externalRunId: string | null;
  status: WorkflowRunStatus;
  agent: string | null;
  model: string | null;
  cwd: string | null;
  input: unknown;
  result: unknown;
  logPath: string | null;
  startedAt: string;
  finishedAt: string | null;
  pendingHumanTaskCount?: number;
};

export type WorkflowRunCheckpointRecord = {
  runId: string;
  nodeId: string;
  checkpoint: WorkflowRunCheckpointState;
  updatedAt: string;
};

export type WorkflowRunResumeClaim = {
  run: WorkflowRunRecord;
  token: string;
};

export type WorkflowListItem = {
  workflow: WorkflowRecord;
  currentVersion: WorkflowVersionRecord | null;
  generation: WorkflowGenerationRecord | null;
  runCount: number;
  latestRun: WorkflowRunRecord | null;
};

export type WorkflowDetail = {
  workflow: WorkflowRecord;
  currentVersion: WorkflowVersionRecord | null;
  versions: WorkflowVersionRecord[];
  runs: WorkflowRunRecord[];
  generation: WorkflowGenerationRecord | null;
};
