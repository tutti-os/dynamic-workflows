import { randomUUID } from "node:crypto";
import {
  FLOW_V1_LIFECYCLES,
  type FlowV1JsonObject,
  type FlowV1Lifecycle,
  type FlowV1ParamsRecord,
  type FlowV1RuntimeSummary,
  type FlowV1ScheduleRecord,
  type FlowV1ScheduleStatus,
} from "@/lib/flow-v1/types";
import { validateFlowV1Cron } from "@/lib/flow-v1/cron";
import { getDb } from "../client";
import {
  parseJsonObjectColumn,
  stringifyJsonObjectColumn,
} from "./json-schemas";
import {
  FlowV1PersistenceError,
  getActiveFlowV1Cycle,
  getFlowV1Run,
} from "./flow-runtime";

type ParamsRow = {
  flow_id: string;
  revision: number;
  values_json: string;
  created_at: string;
};

type ScheduleRow = {
  id: string;
  flow_id: string;
  status: string;
  cron_expression: string;
  timezone: string;
  catch_up: string;
  overlap_policy: string;
  input_json: string;
  revision: number;
  next_fire_at: string | null;
  last_scheduled_at: string | null;
  coalesced_scheduled_at: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
};

export function setFlowV1Lifecycle(input: {
  flowId: string;
  lifecycle: FlowV1Lifecycle;
}): FlowV1Lifecycle {
  if (!FLOW_V1_LIFECYCLES.includes(input.lifecycle)) {
    throw new FlowV1PersistenceError(
      "flow_lifecycle_invalid",
      `Invalid Flow lifecycle: ${input.lifecycle}.`,
    );
  }
  const changes = getDb()
    .prepare(
      `
      UPDATE workflows
      SET lifecycle = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(input.lifecycle, new Date().toISOString(), input.flowId).changes;
  if (changes !== 1) {
    throw flowNotFound(input.flowId);
  }
  return input.lifecycle;
}

export function setFlowV1Params(input: {
  flowId: string;
  values: FlowV1JsonObject;
  expectedRevision?: number;
}): FlowV1ParamsRecord {
  const database = getDb();
  return database.transaction(() => {
    const flow = database
      .prepare(
        `
        SELECT params_revision
        FROM workflows
        WHERE id = ?
      `,
      )
      .get(input.flowId) as { params_revision: number } | undefined;
    if (!flow) {
      throw flowNotFound(input.flowId);
    }
    if (
      input.expectedRevision !== undefined &&
      flow.params_revision !== input.expectedRevision
    ) {
      throw new FlowV1PersistenceError(
        "flow_params_revision_conflict",
        `Flow params revision is ${flow.params_revision}, not ${input.expectedRevision}.`,
      );
    }
    const revision = flow.params_revision + 1;
    const now = new Date().toISOString();
    const updated = database
      .prepare(
        `
        UPDATE workflows
        SET params_revision = ?, updated_at = ?
        WHERE id = ? AND params_revision = ?
      `,
      )
      .run(revision, now, input.flowId, flow.params_revision).changes;
    if (updated !== 1) {
      throw new FlowV1PersistenceError(
        "flow_params_revision_conflict",
        "Flow params changed while the new revision was being saved.",
      );
    }
    database
      .prepare(
        `
        INSERT INTO workflow_params (
          flow_id, revision, values_json, created_at
        ) VALUES (?, ?, ?, ?)
      `,
      )
      .run(
        input.flowId,
        revision,
        stringifyJsonObjectColumn(input.values, {
          table: "workflow_params",
          column: "values_json",
          id: `${input.flowId}:${revision}`,
        }),
        now,
      );
    return requireFlowV1Params(input.flowId, revision);
  })();
}

export function getCurrentFlowV1Params(
  flowId: string,
): FlowV1ParamsRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT params.*
      FROM workflow_params params
      JOIN workflows flows
        ON flows.id = params.flow_id
        AND flows.params_revision = params.revision
      WHERE params.flow_id = ?
    `,
    )
    .get(flowId) as ParamsRow | undefined;
  return row ? mapParams(row) : null;
}

export function getFlowV1ParamsRevision(
  flowId: string,
  revision: number,
): FlowV1ParamsRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT * FROM workflow_params
      WHERE flow_id = ? AND revision = ?
    `,
    )
    .get(flowId, revision) as ParamsRow | undefined;
  return row ? mapParams(row) : null;
}

export function upsertFlowV1Schedule(input: {
  flowId: string;
  status: FlowV1ScheduleStatus;
  cronExpression: string;
  timezone: string;
  overlapPolicy: "coalesce-latest" | "skip";
  scheduleInput: FlowV1JsonObject;
  nextFireAt?: string | null;
}): FlowV1ScheduleRecord {
  validateSchedule(input);
  const database = getDb();
  return database.transaction(() => {
    const flow = database
      .prepare("SELECT id FROM workflows WHERE id = ?")
      .get(input.flowId) as { id: string } | undefined;
    if (!flow) {
      throw flowNotFound(input.flowId);
    }
    const existing = database
      .prepare("SELECT id, created_at FROM workflow_schedules WHERE flow_id = ?")
      .get(input.flowId) as
      | { id: string; created_at: string }
      | undefined;
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    database
      .prepare(
        `
        INSERT INTO workflow_schedules (
          id, flow_id, status, cron_expression, timezone, catch_up,
          overlap_policy, input_json, revision, next_fire_at, last_scheduled_at,
          coalesced_scheduled_at, failure_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'latest', ?, ?, 0, ?, NULL, NULL, 0, ?, ?)
        ON CONFLICT(flow_id) DO UPDATE SET
          status = excluded.status,
          cron_expression = excluded.cron_expression,
          timezone = excluded.timezone,
          catch_up = excluded.catch_up,
          overlap_policy = excluded.overlap_policy,
          input_json = excluded.input_json,
          revision = workflow_schedules.revision + 1,
          next_fire_at = excluded.next_fire_at,
          failure_count = 0,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        id,
        input.flowId,
        input.status,
        input.cronExpression,
        input.timezone,
        input.overlapPolicy,
        stringifyJsonObjectColumn(input.scheduleInput, {
          table: "workflow_schedules",
          column: "input_json",
          id,
        }),
        input.nextFireAt ?? null,
        existing?.created_at ?? now,
        now,
      );
    return requireFlowV1Schedule(input.flowId);
  })();
}

export function getFlowV1Schedule(
  flowId: string,
): FlowV1ScheduleRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_schedules WHERE flow_id = ?")
    .get(flowId) as ScheduleRow | undefined;
  return row ? mapSchedule(row) : null;
}

export function deleteFlowV1Schedule(flowId: string): boolean {
  return (
    getDb()
      .prepare("DELETE FROM workflow_schedules WHERE flow_id = ?")
      .run(flowId).changes > 0
  );
}

export function listFlowV1SchedulesReady(
  now: string,
): FlowV1ScheduleRecord[] {
  validateOptionalTimestamp(now, "now");
  return (
    getDb()
      .prepare(
        `
        SELECT schedules.*
        FROM workflow_schedules schedules
        JOIN workflows flows ON flows.id = schedules.flow_id
        WHERE schedules.status = 'active'
          AND flows.lifecycle = 'active'
          AND (
            schedules.coalesced_scheduled_at IS NOT NULL
            OR (
              schedules.next_fire_at IS NOT NULL
              AND schedules.next_fire_at <= ?
            )
          )
        ORDER BY COALESCE(
          schedules.coalesced_scheduled_at,
          schedules.next_fire_at
        ) ASC
      `,
      )
      .all(now) as ScheduleRow[]
  ).map(mapSchedule);
}

export function recordFlowV1ScheduleState(input: {
  scheduleId: string;
  expectedRevision: number;
  nextFireAt: string | null;
  lastScheduledAt?: string | null;
  coalescedScheduledAt?: string | null;
  failureCount?: number;
}): { updated: boolean; schedule: FlowV1ScheduleRecord | null } {
  validateOptionalTimestamp(input.nextFireAt, "nextFireAt");
  validateOptionalTimestamp(
    input.lastScheduledAt,
    "lastScheduledAt",
  );
  validateOptionalTimestamp(
    input.coalescedScheduledAt,
    "coalescedScheduledAt",
  );
  const now = new Date().toISOString();
  const updated = getDb()
    .prepare(
      `
      UPDATE workflow_schedules
      SET revision = revision + 1,
        next_fire_at = ?,
        last_scheduled_at = CASE WHEN ? THEN ? ELSE last_scheduled_at END,
        coalesced_scheduled_at = CASE
          WHEN ? THEN ? ELSE coalesced_scheduled_at END,
        failure_count = COALESCE(?, failure_count),
        updated_at = ?
      WHERE id = ? AND revision = ?
    `,
    )
    .run(
      input.nextFireAt,
      input.lastScheduledAt !== undefined ? 1 : 0,
      input.lastScheduledAt ?? null,
      input.coalescedScheduledAt !== undefined ? 1 : 0,
      input.coalescedScheduledAt ?? null,
      input.failureCount ?? null,
      now,
      input.scheduleId,
      input.expectedRevision,
    ).changes;
  const row = getDb()
    .prepare("SELECT * FROM workflow_schedules WHERE id = ?")
    .get(input.scheduleId) as ScheduleRow | undefined;
  return { updated: updated === 1, schedule: row ? mapSchedule(row) : null };
}

export function getFlowV1RuntimeSummary(
  flowId: string,
): FlowV1RuntimeSummary | null {
  const database = getDb();
  const flow = database
    .prepare(
      `
      SELECT id, lifecycle, params_revision
      FROM workflows
      WHERE id = ?
    `,
    )
    .get(flowId) as
    | { id: string; lifecycle: string; params_revision: number }
    | undefined;
  if (!flow) {
    return null;
  }
  if (!FLOW_V1_LIFECYCLES.includes(flow.lifecycle as FlowV1Lifecycle)) {
    throw new FlowV1PersistenceError(
      "flow_persistence_corrupt",
      `Flow ${flowId} has invalid lifecycle "${flow.lifecycle}".`,
    );
  }
  const counts = database
    .prepare(
      `
      SELECT
        COUNT(*) AS cycle_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)
          AS completed_cycle_count,
        SUM(CASE WHEN status IN (
          'paused_failed', 'paused_uncertain', 'paused_conflict',
          'paused_budget', 'waiting_human'
        ) THEN 1 ELSE 0 END) AS attention_cycle_count
      FROM workflow_cycles
      WHERE flow_id = ?
    `,
    )
    .get(flowId) as {
    cycle_count: number;
    completed_cycle_count: number | null;
    attention_cycle_count: number | null;
  };
  const runCount = (
    database
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM workflow_runs
        WHERE workflow_id = ? AND cycle_id IS NOT NULL
      `,
      )
      .get(flowId) as { count: number }
  ).count;
  const latestRunRow = database
    .prepare(
      `
      SELECT run.id
      FROM workflow_runs AS run
      JOIN workflow_cycles AS cycle ON cycle.id = run.cycle_id
      WHERE run.workflow_id = ? AND run.cycle_id IS NOT NULL
      ORDER BY cycle.sequence DESC, run.tick_sequence DESC, run.started_at DESC
      LIMIT 1
    `,
    )
    .get(flowId) as { id: string } | undefined;
  return {
    flowId,
    lifecycle: flow.lifecycle as FlowV1Lifecycle,
    paramsRevision: flow.params_revision,
    activeCycle: getActiveFlowV1Cycle(flowId),
    latestRun: latestRunRow ? getFlowV1Run(latestRunRow.id) : null,
    schedule: getFlowV1Schedule(flowId),
    cycleCount: counts.cycle_count,
    runCount,
    completedCycleCount: counts.completed_cycle_count ?? 0,
    attentionCycleCount: counts.attention_cycle_count ?? 0,
  };
}

function requireFlowV1Params(
  flowId: string,
  revision: number,
): FlowV1ParamsRecord {
  const params = getFlowV1ParamsRevision(flowId, revision);
  if (!params) {
    throw new Error(`Flow params ${flowId}:${revision} were not persisted.`);
  }
  return params;
}

function requireFlowV1Schedule(flowId: string): FlowV1ScheduleRecord {
  const schedule = getFlowV1Schedule(flowId);
  if (!schedule) {
    throw new Error(`Flow Schedule for ${flowId} was not persisted.`);
  }
  return schedule;
}

function mapParams(row: ParamsRow): FlowV1ParamsRecord {
  return {
    flowId: row.flow_id,
    revision: row.revision,
    values: parseJsonObjectColumn(row.values_json, {
      table: "workflow_params",
      column: "values_json",
      id: `${row.flow_id}:${row.revision}`,
    }),
    createdAt: row.created_at,
  };
}

function mapSchedule(row: ScheduleRow): FlowV1ScheduleRecord {
  if (
    (row.status !== "active" && row.status !== "paused") ||
    row.catch_up !== "latest" ||
    (row.overlap_policy !== "coalesce-latest" &&
      row.overlap_policy !== "skip")
  ) {
    throw new FlowV1PersistenceError(
      "flow_persistence_corrupt",
      `Schedule ${row.id} contains an unsupported policy or status.`,
    );
  }
  return {
    id: row.id,
    flowId: row.flow_id,
    status: row.status,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    catchUp: "latest",
    overlapPolicy: row.overlap_policy,
    input: parseJsonObjectColumn(row.input_json, {
      table: "workflow_schedules",
      column: "input_json",
      id: row.id,
    }),
    revision: row.revision,
    nextFireAt: row.next_fire_at,
    lastScheduledAt: row.last_scheduled_at,
    coalescedScheduledAt: row.coalesced_scheduled_at,
    failureCount: row.failure_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateSchedule(input: {
  status: FlowV1ScheduleStatus;
  cronExpression: string;
  timezone: string;
  nextFireAt?: string | null;
}): void {
  if (input.status !== "active" && input.status !== "paused") {
    throw new FlowV1PersistenceError(
      "flow_schedule_status_invalid",
      `Invalid Schedule status: ${input.status}.`,
    );
  }
  try {
    validateFlowV1Cron(input.cronExpression);
  } catch (error) {
    throw new FlowV1PersistenceError(
      "flow_schedule_cron_invalid",
      error instanceof Error ? error.message : "Invalid cron expression.",
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: input.timezone,
    }).format();
  } catch {
    throw new FlowV1PersistenceError(
      "flow_schedule_timezone_invalid",
      `Invalid IANA timezone: ${input.timezone}.`,
    );
  }
  validateOptionalTimestamp(input.nextFireAt, "nextFireAt");
}

function validateOptionalTimestamp(
  value: string | null | undefined,
  name: string,
): void {
  if (value !== undefined && value !== null && !Number.isFinite(Date.parse(value))) {
    throw new FlowV1PersistenceError(
      "flow_schedule_timestamp_invalid",
      `${name} must be an ISO timestamp or null.`,
    );
  }
}

function flowNotFound(flowId: string): FlowV1PersistenceError {
  return new FlowV1PersistenceError(
    "flow_not_found",
    `Flow ${flowId} was not found.`,
  );
}
