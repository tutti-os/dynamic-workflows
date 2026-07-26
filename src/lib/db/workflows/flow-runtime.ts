import { randomUUID } from "node:crypto";
import {
  FLOW_V1_CYCLE_STATUSES,
  FLOW_V1_INVOCATION_STATUSES,
  FLOW_V1_RUN_STATUSES,
  FLOW_V1_RUN_STOP_REASONS,
  type FlowV1CycleCheckpointRecord,
  type FlowV1CycleRecord,
  type FlowV1CycleStatus,
  type FlowV1InvocationOrigin,
  type FlowV1InvocationRecord,
  type FlowV1JsonObject,
  type FlowV1RunRecord,
  type FlowV1RunStatus,
  type FlowV1RunStopReason,
  type FlowV1TickBundle,
} from "@/lib/flow-v1/types";
import { getDb } from "../client";
import {
  parseJsonObjectColumn,
  stringifyJsonObjectColumn,
} from "./json-schemas";

type CycleRow = {
  id: string;
  flow_id: string;
  sequence: number;
  flow_version_id: string;
  status: string;
  outcome: string | null;
  current_node_id: string | null;
  input_snapshot_json: string;
  params_revision: number;
  params_snapshot_json: string;
  memory_hash_at_start: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type InvocationRow = {
  id: string;
  flow_id: string;
  cycle_id: string | null;
  run_id: string | null;
  origin_kind: string;
  origin_json: string;
  status: string;
  idempotency_key: string;
  input_json: string;
  error_json: string | null;
  requested_at: string;
  updated_at: string;
};

type FlowRunRow = {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  cycle_id: string | null;
  invocation_id: string | null;
  tick_sequence: number | null;
  status: string;
  stop_reason: string | null;
  input_json: string;
  result_json: string | null;
  owner_token: string | null;
  owner_claimed_at: string | null;
  started_at: string;
  finished_at: string | null;
};

type CheckpointRow = {
  cycle_id: string;
  revision: number;
  state_json: string;
  updated_at: string;
};

export class FlowV1PersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowV1PersistenceError";
    this.code = code;
  }
}

export function startFlowV1Cycle(input: {
  flowId: string;
  flowVersionId: string;
  origin: FlowV1InvocationOrigin;
  idempotencyKey: string;
  inputSnapshot: FlowV1JsonObject;
  paramsRevision: number;
  paramsSnapshot: FlowV1JsonObject;
  memoryHashAtStart?: string;
  initialCheckpoint?: FlowV1JsonObject;
}): FlowV1TickBundle {
  assertStartInput(input);
  const database = getDb();
  return database.transaction(() => {
    const idempotent = getIdempotentTick(
      input.flowId,
      input.idempotencyKey,
    );
    if (idempotent) {
      return idempotent;
    }
    assertPublishedBundleVersion(input.flowId, input.flowVersionId);
    const activeCycle = database
      .prepare(
        `
        SELECT id FROM workflow_cycles
        WHERE flow_id = ? AND status NOT IN ('completed', 'canceled')
        LIMIT 1
      `,
      )
      .get(input.flowId) as { id: string } | undefined;
    if (activeCycle) {
      throw new FlowV1PersistenceError(
        "flow_cycle_active",
        `Flow ${input.flowId} already has unfinished Cycle ${activeCycle.id}.`,
      );
    }

    const now = new Date().toISOString();
    const cycleId = randomUUID();
    const invocationId = randomUUID();
    const runId = randomUUID();
    const sequence = (
      database
        .prepare(
          `
          SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
          FROM workflow_cycles
          WHERE flow_id = ?
        `,
        )
        .get(input.flowId) as { sequence: number }
    ).sequence;

    database
      .prepare(
        `
        INSERT INTO workflow_cycles (
          id, flow_id, sequence, flow_version_id, status, outcome, current_node_id,
          input_snapshot_json, params_revision, params_snapshot_json,
          memory_hash_at_start, created_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, ?, ?, ?, ?, ?, NULL)
      `,
      )
      .run(
        cycleId,
        input.flowId,
        sequence,
        input.flowVersionId,
        jsonObject(input.inputSnapshot, "workflow_cycles", "input_snapshot_json", cycleId),
        input.paramsRevision,
        jsonObject(input.paramsSnapshot, "workflow_cycles", "params_snapshot_json", cycleId),
        input.memoryHashAtStart ?? null,
        now,
        now,
      );
    database
      .prepare(
        `
        INSERT INTO workflow_cycle_checkpoints (
          cycle_id, revision, state_json, updated_at
        ) VALUES (?, 0, ?, ?)
      `,
      )
      .run(
        cycleId,
        jsonObject(
          input.initialCheckpoint ?? {},
          "workflow_cycle_checkpoints",
          "state_json",
          cycleId,
        ),
        now,
      );
    insertInvocation({
      id: invocationId,
      flowId: input.flowId,
      cycleId,
      origin: input.origin,
      idempotencyKey: input.idempotencyKey,
      input: input.inputSnapshot,
      now,
    });
    insertTick({
      id: runId,
      flowId: input.flowId,
      flowVersionId: input.flowVersionId,
      cycleId,
      invocationId,
      tickSequence: 1,
      input: input.inputSnapshot,
      now,
    });
    linkInvocationToRun(invocationId, runId, now);
    return requireTickBundle(invocationId, true);
  })();
}

export function startFlowV1Tick(input: {
  cycleId: string;
  origin: FlowV1InvocationOrigin;
  idempotencyKey: string;
  input?: FlowV1JsonObject;
}): FlowV1TickBundle {
  requireNonEmpty(input.cycleId, "cycleId");
  requireNonEmpty(input.idempotencyKey, "idempotencyKey");
  const database = getDb();
  return database.transaction(() => {
    const cycle = getFlowV1Cycle(input.cycleId);
    if (!cycle) {
      throw new FlowV1PersistenceError(
        "flow_cycle_not_found",
        `Cycle ${input.cycleId} was not found.`,
      );
    }
    const idempotent = getIdempotentTick(
      cycle.flowId,
      input.idempotencyKey,
    );
    if (idempotent) {
      return idempotent;
    }
    if (cycle.status === "completed" || cycle.status === "canceled") {
      throw new FlowV1PersistenceError(
        "flow_cycle_terminal",
        `Cycle ${cycle.id} is already ${cycle.status}.`,
      );
    }
    const activeRun = database
      .prepare(
        `
        SELECT id FROM workflow_runs
        WHERE workflow_id = ? AND cycle_id IS NOT NULL
          AND status IN ('pending', 'running')
        LIMIT 1
      `,
      )
      .get(cycle.flowId) as { id: string } | undefined;
    if (activeRun) {
      throw new FlowV1PersistenceError(
        "flow_tick_active",
        `Flow ${cycle.flowId} already has active Tick ${activeRun.id}.`,
      );
    }

    const now = new Date().toISOString();
    const invocationId = randomUUID();
    const runId = randomUUID();
    const tickSequence = (
      database
        .prepare(
          `
          SELECT COALESCE(MAX(tick_sequence), 0) + 1 AS sequence
          FROM workflow_runs
          WHERE cycle_id = ?
        `,
        )
        .get(cycle.id) as { sequence: number }
    ).sequence;
    const invocationInput = input.input ?? {};
    insertInvocation({
      id: invocationId,
      flowId: cycle.flowId,
      cycleId: cycle.id,
      origin: input.origin,
      idempotencyKey: input.idempotencyKey,
      input: invocationInput,
      now,
    });
    insertTick({
      id: runId,
      flowId: cycle.flowId,
      flowVersionId: cycle.flowVersionId,
      cycleId: cycle.id,
      invocationId,
      tickSequence,
      input: invocationInput,
      now,
    });
    linkInvocationToRun(invocationId, runId, now);
    database
      .prepare(
        `
        UPDATE workflow_cycles
        SET status = 'running', started_at = COALESCE(started_at, ?)
        WHERE id = ?
      `,
      )
      .run(now, cycle.id);
    return requireTickBundle(invocationId, true);
  })();
}

export function getFlowV1Cycle(cycleId: string): FlowV1CycleRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_cycles WHERE id = ?")
    .get(cycleId) as CycleRow | undefined;
  return row ? mapCycle(row) : null;
}

export function getActiveFlowV1Cycle(
  flowId: string,
): FlowV1CycleRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT * FROM workflow_cycles
      WHERE flow_id = ? AND status NOT IN ('completed', 'canceled')
      ORDER BY sequence DESC
      LIMIT 1
    `,
    )
    .get(flowId) as CycleRow | undefined;
  return row ? mapCycle(row) : null;
}

export function listFlowV1Cycles(flowId: string): FlowV1CycleRecord[] {
  return (
    getDb()
      .prepare(
        `
        SELECT * FROM workflow_cycles
        WHERE flow_id = ?
        ORDER BY sequence DESC
      `,
      )
      .all(flowId) as CycleRow[]
  ).map(mapCycle);
}

export function getFlowV1Run(runId: string): FlowV1RunRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT * FROM workflow_runs
      WHERE id = ? AND cycle_id IS NOT NULL
    `,
    )
    .get(runId) as FlowRunRow | undefined;
  return row ? mapRun(row) : null;
}

export function listFlowV1RunsForCycle(
  cycleId: string,
): FlowV1RunRecord[] {
  return (
    getDb()
      .prepare(
        `
        SELECT * FROM workflow_runs
        WHERE cycle_id = ?
        ORDER BY tick_sequence ASC, started_at ASC
      `,
      )
      .all(cycleId) as FlowRunRow[]
  ).map(mapRun);
}

export function getActiveFlowV1RunForFlow(
  flowId: string,
): FlowV1RunRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT * FROM workflow_runs
      WHERE workflow_id = ? AND cycle_id IS NOT NULL
        AND status IN ('pending', 'running')
      ORDER BY started_at DESC
      LIMIT 1
    `,
    )
    .get(flowId) as FlowRunRow | undefined;
  return row ? mapRun(row) : null;
}

export function getFlowV1Invocation(
  invocationId: string,
): FlowV1InvocationRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_invocations WHERE id = ?")
    .get(invocationId) as InvocationRow | undefined;
  return row ? mapInvocation(row) : null;
}

export function getFlowV1CycleCheckpoint(
  cycleId: string,
): FlowV1CycleCheckpointRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_cycle_checkpoints WHERE cycle_id = ?")
    .get(cycleId) as CheckpointRow | undefined;
  return row ? mapCheckpoint(row) : null;
}

export function compareAndSetFlowV1CycleCheckpoint(input: {
  cycleId: string;
  expectedRevision: number;
  state: FlowV1JsonObject;
  cycleStatus?: FlowV1CycleStatus;
  cycleOutcome?: string | null;
  currentNodeId?: string | null;
  runId?: string;
  ownerToken?: string;
}): {
  updated: boolean;
  checkpoint: FlowV1CycleCheckpointRecord;
  cycle: FlowV1CycleRecord;
} {
  if (
    input.cycleStatus &&
    !FLOW_V1_CYCLE_STATUSES.includes(input.cycleStatus)
  ) {
    throw new FlowV1PersistenceError(
      "flow_cycle_status_invalid",
      `Invalid Cycle status: ${input.cycleStatus}.`,
    );
  }
  if ((input.runId === undefined) !== (input.ownerToken === undefined)) {
    throw new FlowV1PersistenceError(
      "flow_checkpoint_owner_invalid",
      "runId and ownerToken must be supplied together.",
    );
  }
  const database = getDb();
  return database.transaction(() => {
    const now = new Date().toISOString();
    const ownerFence = input.runId
      ? `
        AND EXISTS (
          SELECT 1 FROM workflow_runs
          WHERE id = ? AND cycle_id = workflow_cycle_checkpoints.cycle_id
            AND status = 'running' AND owner_token = ?
        )
      `
      : "";
    const update = database.prepare(
      `
        UPDATE workflow_cycle_checkpoints
        SET revision = revision + 1, state_json = ?, updated_at = ?
        WHERE cycle_id = ? AND revision = ?
        ${ownerFence}
      `,
    );
    const args: Array<string | number> = [
      jsonObject(
        input.state,
        "workflow_cycle_checkpoints",
        "state_json",
        input.cycleId,
      ),
      now,
      input.cycleId,
      input.expectedRevision,
    ];
    if (input.runId && input.ownerToken) {
      args.push(input.runId, input.ownerToken);
    }
    const updated = update.run(...args).changes;
    if (
      updated === 1 &&
      (input.cycleStatus ||
        input.cycleOutcome !== undefined ||
        input.currentNodeId !== undefined)
    ) {
      const status = input.cycleStatus;
      const terminal = status === "completed" || status === "canceled";
      database
        .prepare(
          `
          UPDATE workflow_cycles
          SET status = COALESCE(?, status),
            outcome = CASE WHEN ? THEN ? ELSE outcome END,
            current_node_id = CASE WHEN ? THEN ? ELSE current_node_id END,
            completed_at = CASE WHEN ? THEN ? ELSE completed_at END
          WHERE id = ?
        `,
        )
        .run(
          status ?? null,
          input.cycleOutcome !== undefined ? 1 : 0,
          input.cycleOutcome ?? null,
          input.currentNodeId !== undefined ? 1 : 0,
          input.currentNodeId ?? null,
          terminal ? 1 : 0,
          terminal ? now : null,
          input.cycleId,
        );
    }
    const checkpoint = getFlowV1CycleCheckpoint(input.cycleId);
    const cycle = getFlowV1Cycle(input.cycleId);
    if (!checkpoint || !cycle) {
      throw new FlowV1PersistenceError(
        "flow_cycle_not_found",
        `Cycle ${input.cycleId} was not found.`,
      );
    }
    return { updated: updated === 1, checkpoint, cycle };
  })();
}

export function claimFlowV1Tick(input: {
  runId: string;
}): { run: FlowV1RunRecord; token: string } | null {
  requireNonEmpty(input.runId, "runId");
  const token = randomUUID();
  const now = new Date();
  const result = getDb()
    .prepare(
      `
      UPDATE workflow_runs
      SET status = 'running', owner_token = ?, owner_claimed_at = ?,
        finished_at = NULL
      WHERE id = ? AND cycle_id IS NOT NULL
        AND status = 'pending'
    `,
    )
    .run(
      token,
      now.toISOString(),
      input.runId,
    );
  if (result.changes !== 1) {
    return null;
  }
  const run = getFlowV1Run(input.runId);
  if (!run) {
    throw new FlowV1PersistenceError(
      "flow_tick_not_found",
      `Tick ${input.runId} disappeared after it was claimed.`,
    );
  }
  return { run, token };
}

export function touchFlowV1TickClaim(input: {
  runId: string;
  token: string;
}): boolean {
  requireNonEmpty(input.token, "token");
  return (
    getDb()
      .prepare(
        `
        UPDATE workflow_runs
        SET owner_claimed_at = ?
        WHERE id = ? AND cycle_id IS NOT NULL
          AND status = 'running' AND owner_token = ?
      `,
      )
      .run(new Date().toISOString(), input.runId, input.token).changes === 1
  );
}

export function finishFlowV1Tick(input: {
  runId: string;
  ownerToken: string;
  status: Extract<FlowV1RunStatus, "completed" | "failed" | "canceled" | "interrupted">;
  stopReason: FlowV1RunStopReason;
  result?: FlowV1JsonObject;
}): { transitioned: boolean; run: FlowV1RunRecord | null } {
  const database = getDb();
  const now = new Date().toISOString();
  const transitioned = database
    .prepare(
      `
      UPDATE workflow_runs
      SET status = ?, stop_reason = ?, result_json = ?, finished_at = ?,
        owner_token = NULL, owner_claimed_at = NULL
      WHERE id = ? AND cycle_id IS NOT NULL
        AND status = 'running' AND owner_token = ?
    `,
    )
    .run(
      input.status,
      input.stopReason,
      input.result
        ? jsonObject(input.result, "workflow_runs", "result_json", input.runId)
        : null,
      now,
      input.runId,
      input.ownerToken,
    ).changes;
  return {
    transitioned: transitioned === 1,
    run: getFlowV1Run(input.runId),
  };
}

export function pauseFlowV1TickOnError(input: {
  runId: string;
  ownerToken: string;
  code: string;
  message: string;
}): boolean {
  const database = getDb();
  return database.transaction(() => {
    const owned = database
      .prepare(
        `
        SELECT cycle_id
        FROM workflow_runs
        WHERE id = ? AND cycle_id IS NOT NULL
          AND status = 'running' AND owner_token = ?
      `,
      )
      .get(input.runId, input.ownerToken) as
      | { cycle_id: string }
      | undefined;
    if (!owned) {
      return false;
    }
    const now = new Date().toISOString();
    database
      .prepare(
        `
        UPDATE workflow_cycles
        SET status = 'paused_failed'
        WHERE id = ?
          AND status NOT IN ('completed', 'canceled')
      `,
      )
      .run(owned.cycle_id);
    const transitioned = database
      .prepare(
        `
        UPDATE workflow_runs
        SET status = 'failed', stop_reason = 'paused_failed',
          result_json = ?, finished_at = ?, owner_token = NULL,
          owner_claimed_at = NULL
        WHERE id = ? AND status = 'running' AND owner_token = ?
      `,
      )
      .run(
        jsonObject(
          { code: input.code, message: input.message },
          "workflow_runs",
          "result_json",
          input.runId,
        ),
        now,
        input.runId,
        input.ownerToken,
      ).changes;
    return transitioned === 1;
  })();
}

function insertInvocation(input: {
  id: string;
  flowId: string;
  cycleId: string;
  origin: FlowV1InvocationOrigin;
  idempotencyKey: string;
  input: FlowV1JsonObject;
  now: string;
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO workflow_invocations (
        id, flow_id, cycle_id, run_id, origin_kind, origin_json, status,
        idempotency_key, input_json, error_json, requested_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, 'started', ?, ?, NULL, ?, ?)
    `,
    )
    .run(
      input.id,
      input.flowId,
      input.cycleId,
      input.origin.kind,
      jsonObject(
        input.origin as unknown as FlowV1JsonObject,
        "workflow_invocations",
        "origin_json",
        input.id,
      ),
      input.idempotencyKey,
      jsonObject(
        input.input,
        "workflow_invocations",
        "input_json",
        input.id,
      ),
      input.now,
      input.now,
    );
}

function linkInvocationToRun(
  invocationId: string,
  runId: string,
  now: string,
): void {
  getDb()
    .prepare(
      `
      UPDATE workflow_invocations
      SET run_id = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(runId, now, invocationId);
}

function insertTick(input: {
  id: string;
  flowId: string;
  flowVersionId: string;
  cycleId: string;
  invocationId: string;
  tickSequence: number;
  input: FlowV1JsonObject;
  now: string;
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO workflow_runs (
        id, workflow_id, workflow_version_id, status, input_json, result_json,
        started_at, finished_at,
        cycle_id, invocation_id, tick_sequence, stop_reason, owner_token,
        owner_claimed_at
      ) VALUES (
        ?, ?, ?, 'pending', ?, NULL, ?, NULL, ?, ?, ?, NULL, NULL, NULL
      )
    `,
    )
    .run(
      input.id,
      input.flowId,
      input.flowVersionId,
      jsonObject(input.input, "workflow_runs", "input_json", input.id),
      input.now,
      input.cycleId,
      input.invocationId,
      input.tickSequence,
    );
}

function getIdempotentTick(
  flowId: string,
  idempotencyKey: string,
): FlowV1TickBundle | null {
  const row = getDb()
    .prepare(
      `
      SELECT id FROM workflow_invocations
      WHERE flow_id = ? AND idempotency_key = ?
    `,
    )
    .get(flowId, idempotencyKey) as { id: string } | undefined;
  return row ? requireTickBundle(row.id, false) : null;
}

function requireTickBundle(
  invocationId: string,
  created: boolean,
): FlowV1TickBundle {
  const invocation = getFlowV1Invocation(invocationId);
  const cycle = invocation?.cycleId
    ? getFlowV1Cycle(invocation.cycleId)
    : null;
  const run = invocation?.runId ? getFlowV1Run(invocation.runId) : null;
  if (!invocation || !cycle || !run) {
    throw new FlowV1PersistenceError(
      "flow_invocation_incomplete",
      `Invocation ${invocationId} does not reference a complete Cycle and Tick.`,
    );
  }
  return { created, cycle, invocation, run };
}

function assertPublishedBundleVersion(
  flowId: string,
  versionId: string,
): void {
  const row = getDb()
    .prepare(
      `
      SELECT versions.id
      FROM workflow_versions versions
      JOIN workflow_version_bundles bundles
        ON bundles.version_id = versions.id
      WHERE versions.id = ? AND versions.workflow_id = ?
        AND bundles.schema_version = 'tutti.flow.v1'
    `,
    )
    .get(versionId, flowId) as { id: string } | undefined;
  if (!row) {
    throw new FlowV1PersistenceError(
      "flow_version_not_runnable",
      `Workflow version ${versionId} is not a stored tutti.flow.v1 Bundle for Flow ${flowId}.`,
    );
  }
}

function assertStartInput(input: {
  flowId: string;
  flowVersionId: string;
  idempotencyKey: string;
  paramsRevision: number;
}): void {
  requireNonEmpty(input.flowId, "flowId");
  requireNonEmpty(input.flowVersionId, "flowVersionId");
  requireNonEmpty(input.idempotencyKey, "idempotencyKey");
  if (!Number.isInteger(input.paramsRevision) || input.paramsRevision < 0) {
    throw new FlowV1PersistenceError(
      "flow_params_revision_invalid",
      "paramsRevision must be a non-negative integer.",
    );
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (!value.trim()) {
    throw new FlowV1PersistenceError(
      "flow_input_invalid",
      `${name} must be non-empty.`,
    );
  }
}

function jsonObject(
  value: unknown,
  table: string,
  column: string,
  id: string,
): string {
  return stringifyJsonObjectColumn(value, { table, column, id });
}

function parseObject(
  value: string,
  table: string,
  column: string,
  id: string,
): FlowV1JsonObject {
  return parseJsonObjectColumn(value, { table, column, id });
}

function mapCycle(row: CycleRow): FlowV1CycleRecord {
  if (!FLOW_V1_CYCLE_STATUSES.includes(row.status as FlowV1CycleStatus)) {
    throw invalidStoredStatus("workflow_cycles", row.id, row.status);
  }
  return {
    id: row.id,
    flowId: row.flow_id,
    sequence: row.sequence,
    flowVersionId: row.flow_version_id,
    status: row.status as FlowV1CycleStatus,
    outcome: row.outcome,
    currentNodeId: row.current_node_id,
    inputSnapshot: parseObject(
      row.input_snapshot_json,
      "workflow_cycles",
      "input_snapshot_json",
      row.id,
    ),
    paramsRevision: row.params_revision,
    paramsSnapshot: parseObject(
      row.params_snapshot_json,
      "workflow_cycles",
      "params_snapshot_json",
      row.id,
    ),
    memoryHashAtStart: row.memory_hash_at_start,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapInvocation(row: InvocationRow): FlowV1InvocationRecord {
  if (
    !FLOW_V1_INVOCATION_STATUSES.includes(
      row.status as FlowV1InvocationRecord["status"],
    )
  ) {
    throw invalidStoredStatus("workflow_invocations", row.id, row.status);
  }
  const origin = parseObject(
    row.origin_json,
    "workflow_invocations",
    "origin_json",
    row.id,
  ) as unknown as FlowV1InvocationOrigin;
  if (origin.kind !== row.origin_kind) {
    throw new FlowV1PersistenceError(
      "flow_persistence_corrupt",
      `Invocation ${row.id} origin kind does not match its payload.`,
    );
  }
  return {
    id: row.id,
    flowId: row.flow_id,
    cycleId: row.cycle_id,
    runId: row.run_id,
    origin,
    status: row.status as FlowV1InvocationRecord["status"],
    idempotencyKey: row.idempotency_key,
    input: parseObject(
      row.input_json,
      "workflow_invocations",
      "input_json",
      row.id,
    ),
    error: row.error_json
      ? parseObject(
          row.error_json,
          "workflow_invocations",
          "error_json",
          row.id,
        )
      : null,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: FlowRunRow): FlowV1RunRecord {
  if (
    !row.cycle_id ||
    !row.invocation_id ||
    row.tick_sequence === null ||
    !FLOW_V1_RUN_STATUSES.includes(row.status as FlowV1RunStatus) ||
    (row.stop_reason !== null &&
      !FLOW_V1_RUN_STOP_REASONS.includes(
        row.stop_reason as FlowV1RunStopReason,
      ))
  ) {
    throw new FlowV1PersistenceError(
      "flow_persistence_corrupt",
      `Tick ${row.id} has an invalid v1 shape or status.`,
    );
  }
  return {
    id: row.id,
    flowId: row.workflow_id,
    flowVersionId: row.workflow_version_id,
    cycleId: row.cycle_id,
    invocationId: row.invocation_id,
    tickSequence: row.tick_sequence,
    status: row.status as FlowV1RunStatus,
    stopReason: row.stop_reason as FlowV1RunStopReason | null,
    input: parseObject(
      row.input_json,
      "workflow_runs",
      "input_json",
      row.id,
    ),
    result: row.result_json
      ? parseObject(
          row.result_json,
          "workflow_runs",
          "result_json",
          row.id,
        )
      : null,
    ownerToken: row.owner_token,
    ownerClaimedAt: row.owner_claimed_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapCheckpoint(row: CheckpointRow): FlowV1CycleCheckpointRecord {
  return {
    cycleId: row.cycle_id,
    revision: row.revision,
    state: parseObject(
      row.state_json,
      "workflow_cycle_checkpoints",
      "state_json",
      row.cycle_id,
    ),
    updatedAt: row.updated_at,
  };
}

function invalidStoredStatus(
  table: string,
  id: string,
  status: string,
): FlowV1PersistenceError {
  return new FlowV1PersistenceError(
    "flow_persistence_corrupt",
    `${table} row ${id} has invalid status "${status}".`,
  );
}
