import { randomUUID } from "node:crypto";
import { assertWorkflowScriptValid, parseWorkflowScript } from "@/lib/workflow/parser";
import type { ParsedWorkflow } from "@/lib/workflow/types";
import { getDb } from "../client";
import { getWorkflow, getWorkflowDetail } from "./workflow-repository";
import { mapVersion, type VersionRow } from "./mappers";
import type { WorkflowDetail, WorkflowVersionRecord } from "./types";

export function createWorkflowVersion(input: {
  workflowId: string;
  script: string;
  publish?: boolean;
  source?: string;
  baseVersionId?: string;
  note?: string;
}): WorkflowVersionRecord {
  const database = getDb();
  const parsed = assertWorkflowScriptValid(input.script);
  const now = new Date().toISOString();
  const versionId = randomUUID();
  const publish = input.publish ?? true;

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
            id, workflow_id, version, script, meta_json, source,
            base_version_id, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          versionId,
          input.workflowId,
          version.next_version,
          input.script,
          JSON.stringify(parsed.meta),
          input.source ?? null,
          input.baseVersionId ?? null,
          input.note ?? null,
          now,
        );

      if (publish) {
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
            input.workflowId,
          );
      } else {
        database
          .prepare(
            `
            UPDATE workflows
            SET updated_at = ?
            WHERE id = ?
          `,
          )
          .run(now, input.workflowId);
      }
    })();

  const created = getWorkflowVersion(versionId);
  if (!created) {
    throw new Error("Failed to create workflow version");
  }
  return created;
}

export function publishWorkflowVersion(input: {
  workflowId: string;
  versionId: string;
}): WorkflowDetail {
  const version = getWorkflowVersion(input.versionId);
  if (!version || version.workflowId !== input.workflowId) {
    throw new Error("Workflow version not found");
  }

  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `
      UPDATE workflows
      SET name = ?, description = ?, current_version_id = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      version.meta.name,
      version.meta.description,
      input.versionId,
      now,
      input.workflowId,
    );

  if (result.changes === 0) {
    throw new Error("Workflow not found");
  }

  const detail = getWorkflowDetail(input.workflowId);
  if (!detail) {
    throw new Error("Workflow not found");
  }
  return detail;
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

export function listWorkflowVersions(workflowId: string): WorkflowVersionRecord[] {
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
