import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 1;

export function migrateDb(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const currentVersion = getCurrentSchemaVersion(database);
  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return;
  }

  database
    .transaction(() => {
      applySchemaV1(database);
      recordSchemaMigration(database, 1);
    })();
}

function getCurrentSchemaVersion(database: Database.Database): number {
  const row = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  return row.version;
}

function recordSchemaMigration(
  database: Database.Database,
  version: number,
): void {
  database
    .prepare(
      `
      INSERT OR IGNORE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `,
    )
    .run(version, new Date().toISOString());
}

function applySchemaV1(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      script TEXT NOT NULL,
      meta_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
      UNIQUE (workflow_id, version)
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
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

    CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow_id
      ON workflow_versions(workflow_id, version DESC);

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id
      ON workflow_runs(workflow_id, started_at DESC);
  `);
}
