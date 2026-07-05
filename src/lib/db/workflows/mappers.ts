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
  script: string;
  meta_json: string;
  source: string | null;
  base_version_id: string | null;
  note: string | null;
  created_at: string;
};

export type RunRow = {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  executor_kind: string;
  external_run_id: string | null;
  status: WorkflowRunStatus;
  agent: string | null;
  model: string | null;
  cwd: string | null;
  input_json: string;
  result_json: string | null;
  log_path: string | null;
  started_at: string;
  finished_at: string | null;
  resume_token?: string | null;
  resume_claimed_at?: string | null;
};

export type GenerationRow = {
  id: string;
  workflow_id: string;
  prompt: string;
  agent: string | null;
  model: string | null;
  cwd: string | null;
  status: WorkflowGenerationStatus;
  generation_json: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type EditJobRow = {
  id: string;
  workflow_id: string;
  base_version_id: string;
  created_version_id: string | null;
  instruction: string;
  agent: string | null;
  model: string | null;
  cwd: string | null;
  agent_session_id: string | null;
  status: WorkflowEditJobStatus;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type RunCheckpointRow = {
  run_id: string;
  node_id: string;
  checkpoint_json: string;
  updated_at: string;
};

import type { WorkflowLoopRecoveryState } from "@/lib/workflow/types";
import type {
  WorkflowEditJobError,
  WorkflowEditJobRecord,
  WorkflowEditJobStatus,
  WorkflowGenerationError,
  WorkflowGenerationRecord,
  WorkflowGenerationStatus,
  WorkflowRunCheckpointRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
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
    script: row.script,
    meta: parseJson(row.meta_json, { name: "workflow", description: "" }),
    source: row.source,
    baseVersionId: row.base_version_id,
    note: row.note,
    createdAt: row.created_at,
  };
}

export function mapRun(row: RunRow): WorkflowRunRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    executorKind: row.executor_kind,
    externalRunId: row.external_run_id,
    status: row.status,
    agent: row.agent,
    model: row.model,
    cwd: row.cwd,
    input: parseJson(row.input_json, {}),
    result: row.result_json ? parseJson(row.result_json, null) : null,
    logPath: row.log_path,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
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
    status: row.status,
    generation: row.generation_json
      ? parseJson<unknown>(row.generation_json, null)
      : null,
    error: row.error_json
      ? parseJson<WorkflowGenerationError | null>(row.error_json, null)
      : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function mapRunCheckpoint(row: RunCheckpointRow): WorkflowRunCheckpointRecord {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    checkpoint: parseJson<WorkflowLoopRecoveryState>(row.checkpoint_json, {
      nextIteration: 1,
      previousStepOutputs: {},
      iterations: [],
    }),
    updatedAt: row.updated_at,
  };
}

export function mapEditJob(row: EditJobRow): WorkflowEditJobRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    baseVersionId: row.base_version_id,
    createdVersionId: row.created_version_id,
    instruction: row.instruction,
    agent: row.agent,
    model: row.model,
    cwd: row.cwd,
    agentSessionId: row.agent_session_id,
    status: row.status,
    result: row.result_json ? parseJson<unknown>(row.result_json, null) : null,
    error: row.error_json
      ? parseJson<WorkflowEditJobError | null>(row.error_json, null)
      : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
