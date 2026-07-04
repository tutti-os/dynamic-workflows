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
          "workflow_runs",
          "workflow_run_checkpoints",
          "workflow_generations",
          "workflow_edit_jobs",
        ]),
      );
      expect(readColumnNames(database, "workflow_versions")).toEqual(
        expect.arrayContaining(["source", "base_version_id", "note"]),
      );
      expect(readColumnNames(database, "workflow_edit_jobs")).toContain(
        "agent_session_id",
      );
      expect(readColumnNames(database, "workflow_run_checkpoints")).toEqual(
        expect.arrayContaining([
          "run_id",
          "node_id",
          "checkpoint_json",
          "updated_at",
        ]),
      );
      for (const table of [
        "workflow_runs",
        "workflow_generations",
        "workflow_edit_jobs",
      ]) {
        const columns = readColumnNames(database, table);
        expect(columns).toContain("agent");
        expect(columns).not.toContain("provider");
      }
      expect(readCurrentVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  it("stamps an existing v1 database without dropping data", () => {
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
          'workflow-1', 'Existing', 'Existing workflow', NULL,
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
      ).toEqual({ name: "Existing" });
      expect(readTableNames(database)).toContain("schema_migrations");
      expect(readTableNames(database)).toContain("workflow_generations");
      expect(readTableNames(database)).toContain("workflow_edit_jobs");
      expect(readTableNames(database)).toContain("workflow_run_checkpoints");
      expect(readColumnNames(database, "workflow_versions")).toEqual(
        expect.arrayContaining(["source", "base_version_id", "note"]),
      );
      expect(readColumnNames(database, "workflow_edit_jobs")).toContain(
        "agent_session_id",
      );
      const runColumns = readColumnNames(database, "workflow_runs");
      expect(runColumns).toContain("agent");
      expect(runColumns).not.toContain("provider");
      expect(
        database
          .prepare("SELECT id, agent FROM workflow_runs ORDER BY id")
          .all(),
      ).toEqual([
        { id: "run-1", agent: "local:codex" },
        { id: "run-2", agent: "local:claude-code" },
        { id: "run-3", agent: "mock" },
      ]);
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
