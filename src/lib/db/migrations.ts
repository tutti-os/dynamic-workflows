import type Database from "better-sqlite3";
import { looksLikeSecretValue } from "@/lib/flow-v1/secret-bindings";

/**
 * Version 17 is the Flow v1 cutover. It intentionally rebuilt workflow
 * storage instead of migrating the removed script workflow runtime.
 *
 * Version 19 is the first incremental Flow v1 migration. From this version
 * forward, existing Flow data must be preserved.
 *
 * Version 20 restores explicit Agent session keys for durable session reuse.
 *
 * Version 21 removes legacy environment bindings that contain GitHub token
 * values. Those values were accepted as syntactically valid environment names
 * and could be returned through configuration projections.
 *
 * Version 22 adds the optional default reasoning effort to Flow runtime
 * configuration.
 */
export const CURRENT_SCHEMA_VERSION = 22;

export function migrateDb(database: Database.Database): void {
  database.pragma("secure_delete = ON");
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
  const scrubLegacyCredentialPages =
    currentVersion >= 18 && currentVersion <= 20;

  database.pragma("foreign_keys = OFF");
  let migrated = false;
  try {
    database.transaction(() => {
      if (currentVersion === 18) {
        migrateFlowV1Schema18To19(database);
        migrateFlowV1Schema19To20(database);
        migrateFlowV1Schema20To21(database);
        migrateFlowV1Schema21To22(database);
        recordSchemaVersion(database, CURRENT_SCHEMA_VERSION);
      } else if (currentVersion === 19) {
        migrateFlowV1Schema19To20(database);
        migrateFlowV1Schema20To21(database);
        migrateFlowV1Schema21To22(database);
        recordSchemaVersion(database, CURRENT_SCHEMA_VERSION);
      } else if (currentVersion === 20) {
        migrateFlowV1Schema20To21(database);
        migrateFlowV1Schema21To22(database);
        recordSchemaVersion(database, CURRENT_SCHEMA_VERSION);
      } else if (currentVersion === 21) {
        migrateFlowV1Schema21To22(database);
        recordSchemaVersion(database, CURRENT_SCHEMA_VERSION);
      } else {
        dropWorkflowSchema(database);
        createFlowV1Schema(database);
        database.prepare("DELETE FROM schema_migrations").run();
        recordSchemaVersion(database, CURRENT_SCHEMA_VERSION);
      }
    })();
    migrated = true;
  } finally {
    database.pragma("foreign_keys = ON");
  }
  if (migrated && scrubLegacyCredentialPages) {
    database.pragma("wal_checkpoint(TRUNCATE)");
  }
}

function recordSchemaVersion(
  database: Database.Database,
  version: number,
): void {
  database
    .prepare(
      `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
    )
    .run(version, new Date().toISOString());
}

function migrateFlowV1Schema18To19(database: Database.Database): void {
  database.exec(`
    ALTER TABLE workflows ADD COLUMN default_agent TEXT;
    ALTER TABLE workflows ADD COLUMN default_model TEXT;
    ALTER TABLE workflows ADD COLUMN default_permission_mode TEXT;
  `);
}

function migrateFlowV1Schema19To20(database: Database.Database): void {
  database.exec(`
    ALTER TABLE workflow_node_attempts ADD COLUMN agent_session_key TEXT;
    CREATE INDEX idx_workflow_node_attempts_cycle_session
      ON workflow_node_attempts(cycle_id, agent_session_key, started_at);
  `);
}

function migrateFlowV1Schema20To21(database: Database.Database): void {
  const bindingTable = database
    .prepare(
      `
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'workflow_secret_bindings'
    `,
    )
    .get() as { present: number } | undefined;
  if (!bindingTable) {
    return;
  }
  const rows = database
    .prepare(
      `
      SELECT flow_id, secret_name, binding_json
      FROM workflow_secret_bindings
    `,
    )
    .all() as Array<{
    flow_id: string;
    secret_name: string;
    binding_json: string;
  }>;
  const removeBinding = database.prepare(
    `
    DELETE FROM workflow_secret_bindings
    WHERE flow_id = ? AND secret_name = ?
  `,
  );
  for (const row of rows) {
    try {
      const binding = JSON.parse(row.binding_json) as {
        kind?: unknown;
        env?: unknown;
      };
      if (
        binding.kind === "environment" &&
        typeof binding.env === "string" &&
        looksLikeSecretValue(binding.env)
      ) {
        removeBinding.run(row.flow_id, row.secret_name);
      }
    } catch {
      // Corrupt bindings remain visible to the existing corruption diagnostics.
    }
  }
}

function migrateFlowV1Schema21To22(database: Database.Database): void {
  const workflowsTable = database
    .prepare(
      `
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'workflows'
    `,
    )
    .get() as { present: number } | undefined;
  if (!workflowsTable) {
    return;
  }
  database.exec(
    "ALTER TABLE workflows ADD COLUMN default_reasoning_effort TEXT;",
  );
}

function getCurrentSchemaVersion(database: Database.Database): number {
  const row = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  return row.version;
}

function dropWorkflowSchema(database: Database.Database): void {
  database.exec(`
    DROP TABLE IF EXISTS workflow_run_notes;
    DROP TABLE IF EXISTS workflow_run_checkpoints;
    DROP TABLE IF EXISTS workflow_edit_jobs;
    DROP TABLE IF EXISTS workflow_run_human_tasks;
    DROP TABLE IF EXISTS workflow_effects;
    DROP TABLE IF EXISTS workflow_node_attempts;
    DROP TABLE IF EXISTS workflow_memory_updates;
    DROP TABLE IF EXISTS workflow_cycle_checkpoints;
    DROP TABLE IF EXISTS workflow_runs;
    DROP TABLE IF EXISTS workflow_invocations;
    DROP TABLE IF EXISTS workflow_cycles;
    DROP TABLE IF EXISTS workflow_schedules;
    DROP TABLE IF EXISTS workflow_secret_bindings;
    DROP TABLE IF EXISTS workflow_params;
    DROP TABLE IF EXISTS workflow_generations;
    DROP TABLE IF EXISTS workflow_version_files;
    DROP TABLE IF EXISTS workflow_version_bundles;
    DROP TABLE IF EXISTS workflow_versions;
    DROP TABLE IF EXISTS workflows;
  `);
}

function createFlowV1Schema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      current_version_id TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'draft',
      params_revision INTEGER NOT NULL DEFAULT 0,
      project_cwd TEXT,
      default_agent TEXT,
      default_model TEXT,
      default_permission_mode TEXT,
      default_reasoning_effort TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      meta_json TEXT NOT NULL,
      semantic_review_json TEXT,
      schema_version TEXT NOT NULL,
      version_status TEXT NOT NULL,
      bundle_hash TEXT NOT NULL,
      published_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
      UNIQUE (workflow_id, version)
    );

    CREATE INDEX idx_workflow_versions_workflow_id
      ON workflow_versions(workflow_id, version DESC);

    CREATE TABLE workflow_version_bundles (
      version_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      bundle_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (version_id) REFERENCES workflow_versions(id)
        ON DELETE CASCADE
    );

    CREATE TABLE workflow_version_files (
      version_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      media_kind TEXT NOT NULL,
      file_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (version_id, path),
      FOREIGN KEY (version_id) REFERENCES workflow_versions(id)
        ON DELETE CASCADE
    );

    CREATE TABLE workflow_generations (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      agent TEXT,
      model TEXT,
      cwd TEXT,
      agent_session_id TEXT,
      status TEXT NOT NULL,
      generation_json TEXT,
      error_json TEXT,
      semantic_review_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_workflow_generations_workflow_id
      ON workflow_generations(workflow_id, created_at DESC);

    CREATE TABLE workflow_params (
      flow_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      values_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (flow_id, revision),
      FOREIGN KEY (flow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    CREATE TABLE workflow_secret_bindings (
      flow_id TEXT NOT NULL,
      secret_name TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (flow_id, secret_name),
      FOREIGN KEY (flow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    CREATE TABLE workflow_schedules (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL,
      catch_up TEXT NOT NULL,
      overlap_policy TEXT NOT NULL,
      input_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      next_fire_at TEXT,
      last_scheduled_at TEXT,
      coalesced_scheduled_at TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (flow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    CREATE TABLE workflow_cycles (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      flow_version_id TEXT NOT NULL,
      status TEXT NOT NULL,
      outcome TEXT,
      current_node_id TEXT,
      input_snapshot_json TEXT NOT NULL,
      params_revision INTEGER NOT NULL,
      params_snapshot_json TEXT NOT NULL,
      memory_hash_at_start TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (flow_id) REFERENCES workflows(id) ON DELETE CASCADE,
      FOREIGN KEY (flow_version_id) REFERENCES workflow_versions(id),
      UNIQUE (flow_id, sequence)
    );

    CREATE UNIQUE INDEX idx_workflow_cycles_one_unfinished
      ON workflow_cycles(flow_id)
      WHERE status NOT IN ('completed', 'canceled');

    CREATE TABLE workflow_cycle_checkpoints (
      cycle_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (cycle_id) REFERENCES workflow_cycles(id) ON DELETE CASCADE
    );

    CREATE TABLE workflow_invocations (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      cycle_id TEXT,
      run_id TEXT,
      origin_kind TEXT NOT NULL,
      origin_json TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      input_json TEXT NOT NULL,
      error_json TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (flow_id) REFERENCES workflows(id) ON DELETE CASCADE,
      FOREIGN KEY (cycle_id) REFERENCES workflow_cycles(id) ON DELETE SET NULL,
      UNIQUE (flow_id, idempotency_key)
    );

    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_version_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      cycle_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      tick_sequence INTEGER NOT NULL,
      stop_reason TEXT,
      owner_token TEXT,
      owner_claimed_at TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
      FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions(id),
      FOREIGN KEY (cycle_id) REFERENCES workflow_cycles(id) ON DELETE CASCADE,
      FOREIGN KEY (invocation_id) REFERENCES workflow_invocations(id)
        ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX idx_workflow_runs_one_active_tick
      ON workflow_runs(workflow_id)
      WHERE status IN ('pending', 'running');
    CREATE INDEX idx_workflow_runs_workflow_id
      ON workflow_runs(workflow_id, started_at DESC);
    CREATE INDEX idx_workflow_runs_cycle
      ON workflow_runs(cycle_id, tick_sequence);

    CREATE TABLE workflow_run_human_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      cycle_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
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
      FOREIGN KEY (cycle_id) REFERENCES workflow_cycles(id) ON DELETE CASCADE,
      UNIQUE (cycle_id, execution_key)
    );

    CREATE INDEX idx_workflow_human_tasks_cycle_status
      ON workflow_run_human_tasks(cycle_id, status, created_at);

    CREATE TABLE workflow_node_attempts (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      error_json TEXT,
      control_outcome TEXT,
      agent_session_key TEXT,
      agent_session_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY (cycle_id) REFERENCES workflow_cycles(id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
      UNIQUE (cycle_id, node_id, sequence)
    );

    CREATE INDEX idx_workflow_node_attempts_run
      ON workflow_node_attempts(run_id, started_at);

    CREATE INDEX idx_workflow_node_attempts_cycle_session
      ON workflow_node_attempts(cycle_id, agent_session_key, started_at);

    CREATE TABLE workflow_effects (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_id TEXT,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      external_ref TEXT,
      result_json TEXT,
      error_json TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (cycle_id) REFERENCES workflow_cycles(id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES workflow_node_attempts(id)
        ON DELETE SET NULL,
      UNIQUE (cycle_id, node_id, idempotency_key)
    );

    CREATE TABLE workflow_memory_updates (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      cycle_id TEXT,
      run_id TEXT,
      node_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      result_hash TEXT,
      status TEXT NOT NULL,
      markdown TEXT NOT NULL,
      candidate_markdown TEXT,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      FOREIGN KEY (flow_id) REFERENCES workflows(id) ON DELETE CASCADE,
      FOREIGN KEY (cycle_id) REFERENCES workflow_cycles(id) ON DELETE SET NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL,
      UNIQUE (flow_id, idempotency_key)
    );
  `);
}
