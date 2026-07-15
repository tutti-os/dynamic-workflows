import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  workflowNotFoundError,
  workflowVersionNotFoundError,
} from "@/lib/api/app-error";
import { assertWorkflowScriptValid } from "@/lib/workflow/parser";
import { getDb } from "../client";
import { stringifyWorkflowMetaColumn } from "./json-schemas";
import { getLatestWorkflowGeneration } from "./generations";
import { listWorkflowRuns } from "./runs";
import { getWorkflowVersion, listWorkflowVersions } from "./versions";
import {
  mapGeneration,
  mapRun,
  mapVersion,
  mapWorkflow,
  type GenerationRow,
  type RunRow,
  type VersionRow,
  type WorkflowRow,
} from "./mappers";
import type {
  WorkflowDetail,
  WorkflowListItem,
  WorkflowRecord,
  WorkflowVersionRecord,
} from "./types";

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

  if (rows.length === 0) {
    return [];
  }

  const workflowIds = rows.map((row) => row.id);
  const workflowPlaceholders = workflowIds.map(() => "?").join(", ");
  const currentVersionIds = rows
    .map((row) => row.current_version_id)
    .filter((id): id is string => Boolean(id));
  const versionsById = new Map<string, WorkflowVersionRecord>();
  if (currentVersionIds.length > 0) {
    const versionPlaceholders = currentVersionIds.map(() => "?").join(", ");
    const versionRows = database
      .prepare(
        `
        SELECT * FROM workflow_versions
        WHERE id IN (${versionPlaceholders})
      `,
      )
      .all(...currentVersionIds) as VersionRow[];
    for (const versionRow of versionRows) {
      const version = mapVersion(versionRow);
      versionsById.set(version.id, version);
    }
  }

  const generationRows = database
    .prepare(
      `
      SELECT *
      FROM (
        SELECT workflow_generations.*,
          ROW_NUMBER() OVER (
            PARTITION BY workflow_id
            ORDER BY created_at DESC, workflow_generations.rowid DESC
          ) AS row_number
        FROM workflow_generations
        WHERE workflow_id IN (${workflowPlaceholders})
      )
      WHERE row_number = 1
    `,
    )
    .all(...workflowIds) as GenerationRow[];
  const generationsByWorkflowId = new Map(
    generationRows.map((row) => [row.workflow_id, mapGeneration(row)]),
  );

  const runCountRows = database
    .prepare(
      `
      SELECT workflow_id, COUNT(*) AS count
      FROM workflow_runs
      WHERE workflow_id IN (${workflowPlaceholders})
      GROUP BY workflow_id
    `,
    )
    .all(...workflowIds) as Array<{ workflow_id: string; count: number }>;
  const runCountsByWorkflowId = new Map(
    runCountRows.map((row) => [row.workflow_id, row.count]),
  );

  const runRows = database
    .prepare(
      `
      SELECT *
      FROM (
        SELECT workflow_runs.*,
          (SELECT COUNT(*) FROM workflow_run_human_tasks tasks
            WHERE tasks.run_id = workflow_runs.id AND tasks.status = 'pending')
            AS pending_human_task_count,
          ROW_NUMBER() OVER (
            PARTITION BY workflow_id
            ORDER BY started_at DESC, workflow_runs.rowid DESC
          ) AS row_number
        FROM workflow_runs
        WHERE workflow_id IN (${workflowPlaceholders})
      )
      WHERE row_number = 1
    `,
    )
    .all(...workflowIds) as RunRow[];
  const latestRunsByWorkflowId = new Map(
    runRows.map((row) => [row.workflow_id, mapRun(row)]),
  );

  return rows.map((row) => {
    const workflow = mapWorkflow(row);
    return {
      workflow,
      currentVersion: workflow.currentVersionId
        ? versionsById.get(workflow.currentVersionId) ?? null
        : null,
      generation: generationsByWorkflowId.get(workflow.id) ?? null,
      runCount: runCountsByWorkflowId.get(workflow.id) ?? 0,
      latestRun: latestRunsByWorkflowId.get(workflow.id) ?? null,
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

export function createWorkflowFromScript(
  script: string,
  options: {
    source?: string;
    note?: string;
  } = {},
): WorkflowDetail {
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
            id, workflow_id, version, script, meta_json, source,
            base_version_id, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          versionId,
          workflowId,
          1,
          script,
          stringifyWorkflowMetaColumn(parsed.meta, {
            table: "workflow_versions",
            column: "meta_json",
            id: versionId,
          }),
          options.source ?? "import",
          null,
          options.note ?? null,
          now,
        );
    })();

  const detail = getWorkflowDetail(workflowId);
  if (!detail) {
    throw new Error("Failed to create workflow");
  }
  return detail;
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
    throw workflowNotFoundError();
  }

  const detail = getWorkflowDetail(input.workflowId);
  if (!detail) {
    throw workflowNotFoundError();
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
    throw workflowNotFoundError();
  }

  const sourceVersion = input.versionId
    ? getWorkflowVersion(input.versionId)
    : getWorkflowVersion(sourceWorkflow.currentVersionId);
  if (!sourceVersion || sourceVersion.workflowId !== input.workflowId) {
    throw workflowVersionNotFoundError();
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
            id, workflow_id, version, script, meta_json, source,
            base_version_id, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          versionId,
          workflowId,
          1,
          sourceVersion.script,
          stringifyWorkflowMetaColumn(sourceVersion.meta, {
            table: "workflow_versions",
            column: "meta_json",
            id: versionId,
          }),
          "duplicate",
          sourceVersion.id,
          null,
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
  const deleted = database.transaction(() => {
    const rows = database
      .prepare("SELECT log_path FROM workflow_runs WHERE workflow_id = ?")
      .all(workflowId) as Array<{ log_path: string | null }>;

    const result = database
      .prepare("DELETE FROM workflows WHERE id = ?")
      .run(workflowId);

    return { rows, deleted: result.changes > 0 };
  })();

  if (!deleted.deleted) {
    return false;
  }

  for (const row of deleted.rows) {
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

export function getWorkflow(workflowId: string): WorkflowRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflows WHERE id = ?")
    .get(workflowId) as WorkflowRow | undefined;
  return row ? mapWorkflow(row) : null;
}
