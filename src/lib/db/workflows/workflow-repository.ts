import { workflowNotFoundError } from "@/lib/api/app-error";
import { getDb } from "../client";
import { getLatestWorkflowGeneration } from "./generations";
import { getFlowV1RuntimeSummary } from "./flow-settings";
import { getWorkflowVersion, listWorkflowVersions } from "./versions";
import {
  mapGeneration,
  mapVersion,
  mapWorkflow,
  type GenerationRow,
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

  return rows.map((row) => {
    const workflow = mapWorkflow(row);
    return {
      workflow,
      currentVersion: workflow.currentVersionId
        ? versionsById.get(workflow.currentVersionId) ?? null
        : null,
      generation: generationsByWorkflowId.get(workflow.id) ?? null,
      flowV1Runtime: workflow.currentVersionId
        ? getFlowV1RuntimeSummary(workflow.id)
        : null,
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
    generation: getLatestWorkflowGeneration(workflowId),
  };
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

export function deleteWorkflow(workflowId: string): boolean {
  return (
    getDb()
      .prepare("DELETE FROM workflows WHERE id = ?")
      .run(workflowId).changes > 0
  );
}

export function getWorkflow(workflowId: string): WorkflowRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflows WHERE id = ?")
    .get(workflowId) as WorkflowRow | undefined;
  return row ? mapWorkflow(row) : null;
}
