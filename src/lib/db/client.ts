import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateDb } from "@/lib/db/migrations";

const DATA_DIR =
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR ??
  process.env.TUTTI_APP_DATA_DIR ??
  path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "dynamic-workflows.sqlite");

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrateDb(db);
  }

  return db;
}

export function getRunLogPath(runId: string): string {
  return path.join(DATA_DIR, "runs", `${runId}.jsonl`);
}

export function getDataDir(): string {
  return DATA_DIR;
}
