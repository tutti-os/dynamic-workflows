import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "dynamic-workflows.sqlite");

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema(db);
  }

  return db;
}

export function getRunLogPath(runId: string): string {
  return path.join(DATA_DIR, "runs", `${runId}.jsonl`);
}

function initSchema(database: Database.Database) {
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
