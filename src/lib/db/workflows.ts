import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  assertWorkflowScriptValid,
  parseWorkflowScript,
} from "@/lib/workflow/parser";
import type {
  ParsedWorkflow,
  WorkflowDiagnostic,
  WorkflowMeta,
} from "@/lib/workflow/types";
import { getDb, getRunLogPath } from "./client";

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
  createdAt: string;
};

export type WorkflowRunStatus = "running" | "completed" | "failed" | "canceled";

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
  provider: string | null;
  model: string | null;
  cwd: string | null;
  status: WorkflowGenerationStatus;
  generation: unknown;
  error: WorkflowGenerationError | null;
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
  provider: string | null;
  model: string | null;
  cwd: string | null;
  input: unknown;
  result: unknown;
  logPath: string | null;
  startedAt: string;
  finishedAt: string | null;
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

type WorkflowRow = {
  id: string;
  name: string;
  description: string;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  id: string;
  workflow_id: string;
  version: number;
  script: string;
  meta_json: string;
  created_at: string;
};

type RunRow = {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  executor_kind: string;
  external_run_id: string | null;
  status: WorkflowRunStatus;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  input_json: string;
  result_json: string | null;
  log_path: string | null;
  started_at: string;
  finished_at: string | null;
};

type GenerationRow = {
  id: string;
  workflow_id: string;
  prompt: string;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  status: WorkflowGenerationStatus;
  generation_json: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export function listWorkflows(): WorkflowListItem[] {
  const database = getDb();
  const rows = database
    .prepare(
      `
      SELECT * FROM workflows
      ORDER BY updated_at DESC
    `,
    )
    .all() as WorkflowRow[];

  return rows.map((row) => {
    const workflow = mapWorkflow(row);
    return {
      workflow,
      currentVersion: workflow.currentVersionId
        ? getWorkflowVersion(workflow.currentVersionId)
        : null,
      generation: getLatestWorkflowGeneration(workflow.id),
      runCount: countWorkflowRuns(workflow.id),
      latestRun: getLatestWorkflowRun(workflow.id),
    };
  });
}

export function getWorkflowDetail(workflowId: string): WorkflowDetail | null {
  const workflow = getWorkflow(workflowId);
  if (!workflow) {
    return null;
  }

  const currentVersion = workflow.currentVersionId
    ? getWorkflowVersion(workflow.currentVersionId)
    : null;
  if (workflow.currentVersionId && !currentVersion) {
    return null;
  }

  return {
    workflow,
    currentVersion,
    versions: listWorkflowVersions(workflowId),
    runs: listWorkflowRuns(workflowId),
    generation: getLatestWorkflowGeneration(workflowId),
  };
}

export function createWorkflowFromScript(script: string): WorkflowDetail {
  const parsed = assertWorkflowScriptValid(script);
  const now = new Date().toISOString();
  const workflowId = randomUUID();
  const versionId = randomUUID();
  const database = getDb();

  database
    .transaction(() => {
      database
        .prepare(
          `
          INSERT INTO workflows (
            id, name, description, current_version_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          workflowId,
          parsed.meta.name,
          parsed.meta.description,
          versionId,
          now,
          now,
        );

      database
        .prepare(
          `
          INSERT INTO workflow_versions (
            id, workflow_id, version, script, meta_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(versionId, workflowId, 1, script, JSON.stringify(parsed.meta), now);
    })();

  const detail = getWorkflowDetail(workflowId);
  if (!detail) {
    throw new Error("Failed to create workflow");
  }
  return detail;
}

export function createPendingWorkflowGeneration(input: {
  prompt: string;
  provider?: string;
  model?: string;
  cwd?: string;
}): WorkflowDetail {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const now = new Date().toISOString();
  const workflowId = randomUUID();
  const generationId = randomUUID();
  const database = getDb();

  database
    .transaction(() => {
      database
        .prepare(
          `
          INSERT INTO workflows (
            id, name, description, current_version_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          workflowId,
          derivePendingWorkflowName(prompt),
          derivePendingWorkflowDescription(prompt),
          null,
          now,
          now,
        );

      database
        .prepare(
          `
          INSERT INTO workflow_generations (
            id, workflow_id, prompt, provider, model, cwd, status,
            generation_json, error_json, created_at, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          generationId,
          workflowId,
          prompt,
          input.provider ?? null,
          input.model ?? null,
          input.cwd ?? null,
          "pending",
          null,
          null,
          now,
          null,
          null,
        );
    })();

  const detail = getWorkflowDetail(workflowId);
  if (!detail) {
    throw new Error("Failed to create workflow");
  }
  return detail;
}

export function getWorkflowGeneration(
  generationId: string,
): WorkflowGenerationRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_generations WHERE id = ?")
    .get(generationId) as GenerationRow | undefined;
  return row ? mapGeneration(row) : null;
}

export function getLatestWorkflowGeneration(
  workflowId: string,
): WorkflowGenerationRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT * FROM workflow_generations
      WHERE workflow_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(workflowId) as GenerationRow | undefined;
  return row ? mapGeneration(row) : null;
}

export function markWorkflowGenerationRunning(
  generationId: string,
): WorkflowGenerationRecord | null {
  const generation = getWorkflowGeneration(generationId);
  if (!generation || generation.status === "completed") {
    return null;
  }

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE workflow_generations
      SET status = 'running',
        started_at = COALESCE(started_at, ?),
        finished_at = NULL,
        error_json = NULL
      WHERE id = ?
        AND status != 'completed'
    `,
    )
    .run(now, generationId);

  return getWorkflowGeneration(generationId);
}

export function resetWorkflowGenerationForRetry(
  workflowId: string,
): WorkflowGenerationRecord | null {
  const generation = getLatestWorkflowGeneration(workflowId);
  if (!generation || generation.status === "completed") {
    return generation;
  }

  getDb()
    .prepare(
      `
      UPDATE workflow_generations
      SET status = 'pending',
        generation_json = NULL,
        error_json = NULL,
        started_at = NULL,
        finished_at = NULL
      WHERE id = ?
    `,
    )
    .run(generation.id);

  return getWorkflowGeneration(generation.id);
}

export function completeWorkflowGeneration(input: {
  generationId: string;
  script: string;
  generation: unknown;
}): WorkflowDetail {
  const generation = getWorkflowGeneration(input.generationId);
  if (!generation) {
    throw new Error("Workflow generation not found");
  }

  const parsed = assertWorkflowScriptValid(input.script);
  const database = getDb();
  const now = new Date().toISOString();
  const versionId = randomUUID();
  const version = database
    .prepare(
      `
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM workflow_versions
      WHERE workflow_id = ?
    `,
    )
    .get(generation.workflowId) as { next_version: number };

  database
    .transaction(() => {
      database
        .prepare(
          `
          INSERT INTO workflow_versions (
            id, workflow_id, version, script, meta_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          versionId,
          generation.workflowId,
          version.next_version,
          input.script,
          JSON.stringify(parsed.meta),
          now,
        );

      database
        .prepare(
          `
          UPDATE workflows
          SET name = ?, description = ?, current_version_id = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(
          parsed.meta.name,
          parsed.meta.description,
          versionId,
          now,
          generation.workflowId,
        );

      database
        .prepare(
          `
          UPDATE workflow_generations
          SET status = 'completed',
            generation_json = ?,
            error_json = NULL,
            finished_at = ?
          WHERE id = ?
        `,
        )
        .run(
          JSON.stringify(input.generation),
          now,
          input.generationId,
        );
    })();

  const detail = getWorkflowDetail(generation.workflowId);
  if (!detail) {
    throw new Error("Workflow not found");
  }
  return detail;
}

export function failWorkflowGeneration(input: {
  generationId: string;
  error: WorkflowGenerationError;
}): WorkflowGenerationRecord | null {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE workflow_generations
      SET status = 'failed',
        error_json = ?,
        finished_at = ?
      WHERE id = ?
        AND status != 'completed'
    `,
    )
    .run(JSON.stringify(input.error), now, input.generationId);

  return getWorkflowGeneration(input.generationId);
}

export function createWorkflowVersion(input: {
  workflowId: string;
  script: string;
}): WorkflowVersionRecord {
  const database = getDb();
  const parsed = assertWorkflowScriptValid(input.script);
  const now = new Date().toISOString();
  const versionId = randomUUID();

  const version = database
    .prepare(
      `
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM workflow_versions
      WHERE workflow_id = ?
    `,
    )
    .get(input.workflowId) as { next_version: number };

  database
    .transaction(() => {
      database
        .prepare(
          `
          INSERT INTO workflow_versions (
            id, workflow_id, version, script, meta_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          versionId,
          input.workflowId,
          version.next_version,
          input.script,
          JSON.stringify(parsed.meta),
          now,
        );

      database
        .prepare(
          `
          UPDATE workflows
          SET current_version_id = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(
          versionId,
          now,
          input.workflowId,
        );
    })();

  const created = getWorkflowVersion(versionId);
  if (!created) {
    throw new Error("Failed to create workflow version");
  }
  return created;
}

export function updateWorkflowMetadata(input: {
  workflowId: string;
  name: string;
  description: string;
}): WorkflowDetail {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `
      UPDATE workflows
      SET name = ?, description = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(input.name, input.description, now, input.workflowId);

  if (result.changes === 0) {
    throw new Error("Workflow not found");
  }

  const detail = getWorkflowDetail(input.workflowId);
  if (!detail) {
    throw new Error("Workflow not found");
  }
  return detail;
}

export function duplicateWorkflow(input: {
  workflowId: string;
  versionId?: string;
  name?: string;
}): WorkflowDetail {
  const sourceWorkflow = getWorkflow(input.workflowId);
  if (!sourceWorkflow?.currentVersionId) {
    throw new Error("Workflow not found");
  }

  const sourceVersion = input.versionId
    ? getWorkflowVersion(input.versionId)
    : getWorkflowVersion(sourceWorkflow.currentVersionId);
  if (!sourceVersion || sourceVersion.workflowId !== input.workflowId) {
    throw new Error("Workflow version not found");
  }

  const now = new Date().toISOString();
  const workflowId = randomUUID();
  const versionId = randomUUID();
  const name = input.name?.trim() || `${sourceWorkflow.name}_copy`;
  const database = getDb();

  database
    .transaction(() => {
      database
        .prepare(
          `
          INSERT INTO workflows (
            id, name, description, current_version_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          workflowId,
          name,
          sourceWorkflow.description,
          versionId,
          now,
          now,
        );

      database
        .prepare(
          `
          INSERT INTO workflow_versions (
            id, workflow_id, version, script, meta_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          versionId,
          workflowId,
          1,
          sourceVersion.script,
          JSON.stringify(sourceVersion.meta),
          now,
        );
    })();

  const detail = getWorkflowDetail(workflowId);
  if (!detail) {
    throw new Error("Failed to duplicate workflow");
  }
  return detail;
}

export function deleteWorkflow(workflowId: string): boolean {
  const database = getDb();
  const rows = database
    .prepare("SELECT log_path FROM workflow_runs WHERE workflow_id = ?")
    .all(workflowId) as Array<{ log_path: string | null }>;

  const result = database
    .prepare("DELETE FROM workflows WHERE id = ?")
    .run(workflowId);

  if (result.changes === 0) {
    return false;
  }

  for (const row of rows) {
    if (!row.log_path) {
      continue;
    }
    try {
      fs.unlinkSync(row.log_path);
    } catch {
      // Log cleanup should not make workflow deletion fail.
    }
  }

  return true;
}

export function createWorkflowRun(input: {
  workflowId: string;
  workflowVersionId: string;
  executorKind: string;
  provider?: string;
  model?: string;
  cwd?: string;
  request: unknown;
}): WorkflowRunRecord {
  const now = new Date().toISOString();
  const runId = randomUUID();
  const logPath = getRunLogPath(runId);

  getDb()
    .prepare(
      `
      INSERT INTO workflow_runs (
        id, workflow_id, workflow_version_id, executor_kind, external_run_id,
        status, provider, model, cwd, input_json, result_json, log_path,
        started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      runId,
      input.workflowId,
      input.workflowVersionId,
      input.executorKind,
      null,
      "running",
      input.provider ?? null,
      input.model ?? null,
      input.cwd ?? null,
      JSON.stringify(input.request),
      null,
      logPath,
      now,
      null,
    );

  const run = getWorkflowRun(runId);
  if (!run) {
    throw new Error("Failed to create workflow run");
  }
  return run;
}

export function updateWorkflowRun(input: {
  runId: string;
  status: WorkflowRunStatus;
  result?: unknown;
  finishedAt?: string;
}) {
  getDb()
    .prepare(
      `
      UPDATE workflow_runs
      SET status = ?, result_json = ?, finished_at = ?
      WHERE id = ?
    `,
    )
    .run(
      input.status,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.finishedAt ?? new Date().toISOString(),
      input.runId,
    );
}

export function getWorkflowRun(runId: string): WorkflowRunRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_runs WHERE id = ?")
    .get(runId) as RunRow | undefined;
  return row ? mapRun(row) : null;
}

export function getWorkflowVersion(
  versionId: string,
): WorkflowVersionRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_versions WHERE id = ?")
    .get(versionId) as VersionRow | undefined;
  return row ? mapVersion(row) : null;
}

export function parseWorkflow(script: string): ParsedWorkflow {
  return parseWorkflowScript(script);
}

function getWorkflow(workflowId: string): WorkflowRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflows WHERE id = ?")
    .get(workflowId) as WorkflowRow | undefined;
  return row ? mapWorkflow(row) : null;
}

function listWorkflowVersions(workflowId: string): WorkflowVersionRecord[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM workflow_versions
      WHERE workflow_id = ?
      ORDER BY version DESC
    `,
    )
    .all(workflowId) as VersionRow[];
  return rows.map(mapVersion);
}

function listWorkflowRuns(workflowId: string): WorkflowRunRecord[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM workflow_runs
      WHERE workflow_id = ?
      ORDER BY started_at DESC
      LIMIT 50
    `,
    )
    .all(workflowId) as RunRow[];
  return rows.map(mapRun);
}

function countWorkflowRuns(workflowId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE workflow_id = ?")
    .get(workflowId) as { count: number };
  return row.count;
}

function getLatestWorkflowRun(workflowId: string): WorkflowRunRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT * FROM workflow_runs
      WHERE workflow_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `,
    )
    .get(workflowId) as RunRow | undefined;
  return row ? mapRun(row) : null;
}

function mapWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    currentVersionId: row.current_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: VersionRow): WorkflowVersionRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    script: row.script,
    meta: parseJson(row.meta_json, { name: "workflow", description: "" }),
    createdAt: row.created_at,
  };
}

function mapRun(row: RunRow): WorkflowRunRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    executorKind: row.executor_kind,
    externalRunId: row.external_run_id,
    status: row.status,
    provider: row.provider,
    model: row.model,
    cwd: row.cwd,
    input: parseJson(row.input_json, {}),
    result: row.result_json ? parseJson(row.result_json, null) : null,
    logPath: row.log_path,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapGeneration(row: GenerationRow): WorkflowGenerationRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    prompt: row.prompt,
    provider: row.provider,
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

function derivePendingWorkflowName(prompt: string): string {
  const preview = truncate(normalizeWhitespace(prompt), 72);
  return preview ? `Generating: ${preview}` : "Generating workflow";
}

function derivePendingWorkflowDescription(prompt: string): string {
  const preview = truncate(normalizeWhitespace(prompt), 220);
  return preview || "Generating workflow from prompt.";
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
