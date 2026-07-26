import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrateDb } from "./migrations";

describe("migrateDb", () => {
  it("creates the current schema in an empty database", () => {
    const database = new Database(":memory:");
    try {
      migrateDb(database);

      const tables = readTableNames(database);
      expect(tables).toEqual(
        expect.arrayContaining([
          "schema_migrations",
          "workflows",
          "workflow_versions",
          "workflow_version_bundles",
          "workflow_version_files",
          "workflow_runs",
          "workflow_run_human_tasks",
          "workflow_generations",
          "workflow_params",
          "workflow_secret_bindings",
          "workflow_schedules",
          "workflow_cycles",
          "workflow_cycle_checkpoints",
          "workflow_invocations",
          "workflow_node_attempts",
          "workflow_effects",
          "workflow_memory_updates",
        ]),
      );
      expect(tables).not.toEqual(
        expect.arrayContaining([
          "workflow_edit_jobs",
          "workflow_run_checkpoints",
          "workflow_run_notes",
        ]),
      );
      expect(readColumnNames(database, "workflow_versions")).toEqual(
        expect.arrayContaining([
          "schema_version",
          "version_status",
          "bundle_hash",
          "published_at",
        ]),
      );
      expect(readColumnNames(database, "workflows")).toEqual(
        expect.arrayContaining(["lifecycle", "params_revision"]),
      );
      expect(readColumnNames(database, "workflow_cycles")).toContain(
        "outcome",
      );
      const runColumns = readColumnNames(database, "workflow_runs");
      expect(runColumns).toEqual(
        expect.arrayContaining([
          "cycle_id",
          "invocation_id",
          "tick_sequence",
          "stop_reason",
          "owner_token",
          "owner_claimed_at",
        ]),
      );
      expect(runColumns).not.toEqual(
        expect.arrayContaining([
          "executor_kind",
          "external_run_id",
          "resume_token",
          "log_path",
        ]),
      );
      expect(readColumnNames(database, "workflow_version_bundles")).toEqual([
        "version_id",
        "schema_version",
        "bundle_hash",
        "created_at",
      ]);
      expect(readColumnNames(database, "workflow_version_files")).toEqual([
        "version_id",
        "path",
        "content",
        "sha256",
        "size_bytes",
        "media_kind",
        "file_role",
        "created_at",
      ]);
      expect(readColumnNames(database, "workflow_run_human_tasks")).toEqual(
        expect.arrayContaining([
          "run_id",
          "cycle_id",
          "node_id",
          "execution_key",
          "status",
          "spec_json",
          "context_json",
          "response_json",
          "revision",
        ]),
      );
      expect(readColumnNames(database, "workflow_generations")).toContain(
        "agent",
      );
      expect(readCurrentVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  it("purges pre-Flow workflows and drops legacy-only tables", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          current_version_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE workflow_versions (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          script TEXT NOT NULL,
          meta_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
          UNIQUE (workflow_id, version)
        );

        CREATE TABLE workflow_runs (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          workflow_version_id TEXT NOT NULL,
          executor_kind TEXT NOT NULL,
          external_run_id TEXT,
          status TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          cwd TEXT,
          input_json TEXT NOT NULL,
          result_json TEXT,
          log_path TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
          FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions(id)
        );

        INSERT INTO workflows (
          id, name, description, current_version_id, created_at, updated_at
        ) VALUES (
          'workflow-1', 'Existing', 'Existing workflow', 'version-1',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );

        INSERT INTO workflow_versions (
          id, workflow_id, version, script, meta_json, created_at
        ) VALUES (
          'version-1', 'workflow-1', 1, 'export const meta = {}', '{}',
          '2026-01-01T00:00:00.000Z'
        );

        INSERT INTO workflow_runs (
          id, workflow_id, workflow_version_id, executor_kind, status,
          provider, input_json, started_at
        ) VALUES
          ('run-1', 'workflow-1', 'version-1', 'local-agent', 'completed',
           'codex', '{}', '2026-01-02T00:00:00.000Z'),
          ('run-2', 'workflow-1', 'version-1', 'local-agent', 'completed',
           'claude-code', '{}', '2026-01-03T00:00:00.000Z'),
          ('run-3', 'workflow-1', 'version-1', 'mock', 'completed',
           'mock', '{}', '2026-01-04T00:00:00.000Z');
      `);

      migrateDb(database);

      expect(readCurrentVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        database
          .prepare("SELECT name FROM workflows WHERE id = ?")
          .get("workflow-1"),
      ).toBeUndefined();
      expect(readTableNames(database)).toContain("schema_migrations");
      expect(readTableNames(database)).toContain("workflow_generations");
      expect(readTableNames(database)).toContain("workflow_run_human_tasks");
      expect(readTableNames(database)).not.toContain("workflow_edit_jobs");
      expect(readTableNames(database)).not.toContain(
        "workflow_run_checkpoints",
      );
      expect(readTableNames(database)).not.toContain("workflow_run_notes");
      expect(readTableNames(database)).toContain("workflow_version_bundles");
      expect(readTableNames(database)).toContain("workflow_version_files");
      expect(readTableNames(database)).toContain("workflow_cycles");
      expect(readTableNames(database)).toContain(
        "workflow_cycle_checkpoints",
      );
      expect(readTableNames(database)).toContain("workflow_invocations");
      expect(readTableNames(database)).toContain("workflow_node_attempts");
      expect(readTableNames(database)).toContain("workflow_effects");
      const runColumns = readColumnNames(database, "workflow_runs");
      expect(runColumns).toEqual(
        expect.arrayContaining(["cycle_id", "invocation_id", "tick_sequence"]),
      );
      expect(runColumns).not.toEqual(
        expect.arrayContaining([
          "provider",
          "agent",
          "resume_token",
          "resume_claimed_at",
          "executor_kind",
        ]),
      );
    } finally {
      database.close();
    }
  });
});

function readTableNames(database: Database.Database): string[] {
  const rows = database
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function readCurrentVersion(database: Database.Database): number {
  const row = database
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number };
  return row.version;
}

function readColumnNames(
  database: Database.Database,
  tableName: string,
): string[] {
  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}
