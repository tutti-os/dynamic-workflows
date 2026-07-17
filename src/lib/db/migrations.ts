import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 10;

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
      if (currentVersion < 1) {
        applySchemaV1(database);
        recordSchemaMigration(database, 1);
      }
      if (currentVersion < 2) {
        applySchemaV2(database);
        recordSchemaMigration(database, 2);
      }
      if (currentVersion < 3) {
        applySchemaV3(database);
        recordSchemaMigration(database, 3);
      }
      if (currentVersion < 4) {
        applySchemaV4(database);
        recordSchemaMigration(database, 4);
      }
      if (currentVersion < 5) {
        applySchemaV5(database);
        recordSchemaMigration(database, 5);
      }
      if (currentVersion < 6) {
        applySchemaV6(database);
        recordSchemaMigration(database, 6);
      }
      if (currentVersion < 7) {
        applySchemaV7(database);
        recordSchemaMigration(database, 7);
      }
      if (currentVersion < 8) {
        applySchemaV8(database);
        recordSchemaMigration(database, 8);
      }
      if (currentVersion < 9) {
        applySchemaV9(database);
        recordSchemaMigration(database, 9);
      }
      if (currentVersion < 10) {
        applySchemaV10(database);
        recordSchemaMigration(database, 10);
      }
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

function applySchemaV2(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_generations (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      cwd TEXT,
      status TEXT NOT NULL,
      generation_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_generations_workflow_id
      ON workflow_generations(workflow_id, created_at DESC);
  `);
}

function applySchemaV3(database: Database.Database): void {
  database.exec(`
    ALTER TABLE workflow_versions ADD COLUMN source TEXT;
    ALTER TABLE workflow_versions ADD COLUMN base_version_id TEXT;
    ALTER TABLE workflow_versions ADD COLUMN note TEXT;

    CREATE TABLE IF NOT EXISTS workflow_edit_jobs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      base_version_id TEXT NOT NULL,
      created_version_id TEXT,
      instruction TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      cwd TEXT,
      status TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
      FOREIGN KEY (base_version_id) REFERENCES workflow_versions(id),
      FOREIGN KEY (created_version_id) REFERENCES workflow_versions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_edit_jobs_workflow_id
      ON workflow_edit_jobs(workflow_id, created_at DESC);
  `);
}

function applySchemaV4(database: Database.Database): void {
  database.exec(`
    ALTER TABLE workflow_edit_jobs ADD COLUMN agent_session_id TEXT;
  `);
}

function applySchemaV5(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_run_checkpoints (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_run_checkpoints_run_id
      ON workflow_run_checkpoints(run_id);
  `);
}

function applySchemaV6(database: Database.Database): void {
  database.exec(`
    ALTER TABLE workflow_runs RENAME COLUMN provider TO agent;
    ALTER TABLE workflow_generations RENAME COLUMN provider TO agent;
    ALTER TABLE workflow_edit_jobs RENAME COLUMN provider TO agent;
  `);

  // Stored values move from provider ids to agent target ids so retry and
  // resume paths keep resolving after the rename.
  for (const table of [
    "workflow_runs",
    "workflow_generations",
    "workflow_edit_jobs",
  ]) {
    database.exec(`
      UPDATE ${table} SET agent = 'local:codex' WHERE agent = 'codex';
      UPDATE ${table} SET agent = 'local:claude-code'
        WHERE agent IN ('claude-code', 'claude');
    `);
  }
}

function applySchemaV7(database: Database.Database): void {
  database.exec(`
    ALTER TABLE workflow_runs ADD COLUMN resume_token TEXT;
    ALTER TABLE workflow_runs ADD COLUMN resume_claimed_at TEXT;

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_resume_token
      ON workflow_runs(resume_token)
      WHERE resume_token IS NOT NULL;
  `);
}

function applySchemaV8(database: Database.Database): void {
  database.exec(`
    ALTER TABLE workflow_generations ADD COLUMN agent_session_id TEXT;
  `);
}

function applySchemaV9(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_run_human_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      parent_node_id TEXT,
      iteration INTEGER,
      execution_key TEXT NOT NULL,
      status TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      context_json TEXT NOT NULL,
      response_json TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
      UNIQUE (run_id, execution_key)
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_run_human_tasks_run_status
      ON workflow_run_human_tasks(run_id, status, created_at);
  `);
}

function applySchemaV10(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_run_notes (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      message TEXT NOT NULL,
      target TEXT NOT NULL,
      node_id TEXT,
      status TEXT NOT NULL,
      consumed_execution_key TEXT,
      delivery_json TEXT,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_run_notes_run_status
      ON workflow_run_notes(run_id, status, created_at);
  `);
}
