import { getDb } from "../client";
import { mapVersion, type VersionRow } from "./mappers";
import type {
  WorkflowVersionRecord,
} from "./types";

export function getWorkflowVersion(
  versionId: string,
): WorkflowVersionRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_versions WHERE id = ?")
    .get(versionId) as VersionRow | undefined;
  return row ? mapVersion(row) : null;
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
