import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getDb } from "@/lib/db/client";
import {
  getFlowV1BundleForVersion,
  saveFlowV1BundleForVersion,
} from "@/lib/db/workflows/flow-bundles";
import {
  getWorkflowHumanTask,
  resolveWorkflowHumanTask,
} from "@/lib/db/workflows/human-tasks";
import {
  deleteFlowV1Schedule,
  getCurrentFlowV1Params,
  setFlowV1Params,
  upsertFlowV1Schedule,
} from "@/lib/db/workflows/flow-settings";
import {
  compareAndSetFlowV1CycleCheckpoint,
  getActiveFlowV1Cycle,
  getActiveFlowV1RunForFlow,
  getFlowV1Cycle,
  getFlowV1CycleCheckpoint,
  getFlowV1Invocation,
  startFlowV1Cycle,
  startFlowV1Tick,
} from "@/lib/db/workflows/flow-runtime";
import {
  stringifyAuthoringSemanticReviewColumn,
  stringifyWorkflowMetaColumn,
} from "@/lib/db/workflows/json-schemas";
import type { AuthoringSemanticReview } from "@/lib/db/workflows/types";
import { hasWorkflowDiagnosticErrors } from "@/lib/workflow/validation";
import type {
  WorkflowHumanTask,
  WorkflowValue,
} from "@/lib/workflow/types";
import {
  FLOW_V1_MEMORY_TEMPLATE_FILE,
  getFlowV1BundleFile,
} from "./bundle";
import { nextFlowV1CronFire } from "./cron";
import {
  initializeFlowV1Memory,
  resolveFlowV1MemoryConflict as resolveMemoryConflict,
} from "./memory";
import {
  createFlowV1GraphCheckpoint,
  invalidateFlowV1NodeAndDownstream,
  queueFlowV1Node,
} from "./graph-state";
import { parseFlowV1Bundle } from "./parser";
import {
  FlowV1TickSupervisorError,
  requestFlowV1TickCancellation,
  runFlowV1Tick,
  type FlowV1TickExecutionResult,
} from "./tick-supervisor";
import {
  resolveFlowV1ExecutionConfig,
  setFlowV1RuntimeConfig,
  type FlowV1SecretBinding,
} from "./runtime-config";
import type {
  FlowV1Bundle,
  FlowV1JsonObject,
  FlowV1JsonValue,
  FlowV1Reference,
  FlowV1TickBundle,
  ParsedFlowV1,
  FlowV1GraphCheckpoint,
} from "./types";

export class FlowV1ServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowV1ServiceError";
    this.code = code;
  }
}

export function createFlowV1(input: {
  bundle: FlowV1Bundle;
  params?: FlowV1JsonObject;
  projectCwd?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultPermissionMode?: string;
  secretBindings?: Record<string, FlowV1SecretBinding>;
  publish?: boolean;
  activate?: boolean;
  now?: string;
}): {
  flowId: string;
  versionId: string;
  version: number;
  bundleHash: string;
} {
  const flow = requireValidBundle(input.bundle);
  if (
    input.activate &&
    flowRequiresDefaultAgent(flow) &&
    !input.defaultAgent?.trim()
  ) {
    throw new FlowV1ServiceError(
      "flow_default_agent_missing",
      "Flow contains Agent nodes without an explicit Agent and requires a configured default Agent before activation.",
    );
  }
  const database = getDb();
  const created = database.transaction(() => {
    const now = input.now ?? new Date().toISOString();
    const flowId = randomUUID();
    database
      .prepare(
        `
        INSERT INTO workflows (
          id, name, description, current_version_id, created_at, updated_at,
          lifecycle, params_revision
        ) VALUES (?, ?, ?, NULL, ?, ?, 'draft', 0)
      `,
      )
      .run(
        flowId,
        flow.meta.name,
        flow.meta.description,
        now,
        now,
      );
    const version = insertFlowV1Version({
      flowId,
      flow,
      bundle: input.bundle,
      version: 1,
      publish: input.publish ?? true,
      now,
    });
    const params = resolveParams(flow, input.params ?? {});
    setFlowV1Params({ flowId, values: params, expectedRevision: 0 });
    configureSchedule(flowId, flow, params, input.now ?? now);
    if (
      input.projectCwd !== undefined ||
      input.defaultAgent !== undefined ||
      input.defaultModel !== undefined ||
      input.defaultPermissionMode !== undefined ||
      input.secretBindings
    ) {
      setFlowV1RuntimeConfig({
        flowId,
        projectCwd: input.projectCwd,
        defaultAgent: input.defaultAgent,
        defaultModel: input.defaultModel,
        defaultPermissionMode: input.defaultPermissionMode,
        secretBindings: input.secretBindings,
      });
    }
    return {
      flowId,
      versionId: version.versionId,
      version: 1,
      bundleHash: input.bundle.hash,
    };
  })();
  initializeMemoryIfDeclared(created.flowId, flow, input.bundle);
  if (input.activate) {
    setFlowV1Lifecycle({
      flowId: created.flowId,
      lifecycle: "active",
    });
  }
  return created;
}

export function createFlowV1Version(input: {
  flowId: string;
  bundle: FlowV1Bundle;
  publish?: boolean;
  semanticReview?: AuthoringSemanticReview;
  now?: string;
}): { versionId: string; version: number; bundleHash: string } {
  const flow = requireValidBundle(input.bundle);
  const database = getDb();
  const created = database.transaction(() => {
    const existing = database
      .prepare("SELECT id FROM workflows WHERE id = ?")
      .get(input.flowId) as { id: string } | undefined;
    if (!existing) {
      throw new FlowV1ServiceError(
        "flow_not_found",
        `Flow ${input.flowId} was not found.`,
      );
    }
    const version = (
      database
        .prepare(
          `
          SELECT COALESCE(MAX(version), 0) + 1 AS version
          FROM workflow_versions
          WHERE workflow_id = ?
        `,
        )
        .get(input.flowId) as { version: number }
    ).version;
    const created = insertFlowV1Version({
      flowId: input.flowId,
      flow,
      bundle: input.bundle,
      version,
      publish: false,
      semanticReview: input.semanticReview,
      now: input.now ?? new Date().toISOString(),
    });
    return {
      versionId: created.versionId,
      version,
      bundleHash: input.bundle.hash,
    };
  })();
  if (input.publish) {
    publishFlowV1Version({
      flowId: input.flowId,
      versionId: created.versionId,
      now: input.now,
    });
  }
  return created;
}

export async function invokeFlowV1(input: {
  flowId: string;
  invocationInput?: FlowV1JsonObject;
  idempotencyKey?: string;
  executeTick?: boolean;
  projectCwd?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultPermissionMode?: string;
  environment?: Record<string, string>;
  secrets?: Record<string, string>;
}): Promise<{
  action:
    | "started_cycle"
    | "resumed_cycle"
    | "active_tick"
    | "idempotent_tick";
  tick: FlowV1TickBundle;
  execution: FlowV1TickExecutionResult | null;
}> {
  const database = getDb();
  const flowRow = database
    .prepare(
      `
      SELECT current_version_id, lifecycle, params_revision
      FROM workflows
      WHERE id = ?
    `,
    )
    .get(input.flowId) as
    | {
        current_version_id: string | null;
        lifecycle: string;
        params_revision: number;
      }
    | undefined;
  if (!flowRow?.current_version_id) {
    throw new FlowV1ServiceError(
      "flow_not_runnable",
      `Flow ${input.flowId} has no published v1 Version.`,
    );
  }
  if (flowRow.lifecycle === "archived") {
    throw new FlowV1ServiceError(
      "flow_archived",
      `Flow ${input.flowId} is archived.`,
    );
  }
  const activeRun = getActiveFlowV1RunForFlow(input.flowId);
  if (activeRun) {
    const invocation = getFlowV1Invocation(activeRun.invocationId);
    const cycle = getActiveFlowV1Cycle(input.flowId);
    if (!invocation || !cycle) {
      throw new FlowV1ServiceError(
        "flow_runtime_state_missing",
        "Active Tick is missing its Invocation or Cycle.",
      );
    }
    return {
      action: "active_tick",
      tick: {
        created: false,
        cycle,
        invocation,
        run: activeRun,
      },
      execution: null,
    };
  }

  const { getFlowV1BundleForVersion } = await import(
    "@/lib/db/workflows/flow-bundles"
  );
  const bundle = getFlowV1BundleForVersion(flowRow.current_version_id);
  if (!bundle) {
    throw new FlowV1ServiceError(
      "flow_bundle_missing",
      "Published Flow Version has no Bundle.",
    );
  }
  const parsed = requireValidBundle(bundle);
  const provided = input.invocationInput;
  const activeCycle = getActiveFlowV1Cycle(input.flowId);
  let tick: FlowV1TickBundle;
  let action: "started_cycle" | "resumed_cycle" | "idempotent_tick";
  if (activeCycle) {
    if (
      provided &&
      !isDeepStrictEqual(resolveCycleInputs(parsed, provided), activeCycle.inputSnapshot)
    ) {
      throw new FlowV1ServiceError(
        "flow_active_cycle_input_conflict",
        `Flow ${input.flowId} already has an active Cycle with different inputs.`,
      );
    }
    if (
      activeCycle.status !== "waiting_gate" &&
      activeCycle.status !== "runnable" &&
      activeCycle.status !== "paused_budget"
    ) {
      throw new FlowV1ServiceError(
        "flow_cycle_not_resumable",
        `Cycle ${activeCycle.id} is ${activeCycle.status} and requires explicit recovery.`,
      );
    }
    tick = startFlowV1Tick({
      cycleId: activeCycle.id,
      origin: { kind: "user" },
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    });
    action = tick.created ? "resumed_cycle" : "idempotent_tick";
  } else {
    const cycleInput = resolveCycleInputs(parsed, provided ?? {});
    const params = getCurrentFlowV1Params(input.flowId);
    tick = startFlowV1Cycle({
      flowId: input.flowId,
      flowVersionId: flowRow.current_version_id,
      origin: { kind: "user" },
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      inputSnapshot: cycleInput,
      paramsRevision: flowRow.params_revision,
      paramsSnapshot: params?.values ?? {},
      memoryHashAtStart: initializeMemoryIfDeclared(
        input.flowId,
        parsed,
        bundle,
      )?.hash,
    });
    action = tick.created ? "started_cycle" : "idempotent_tick";
  }
  const execution =
    input.executeTick === false || tick.run.status !== "pending"
      ? null
      : await runFlowV1Tick({
          runId: tick.run.id,
          projectCwd: input.projectCwd,
          defaultAgent: input.defaultAgent,
          defaultModel: input.defaultModel,
          defaultPermissionMode: input.defaultPermissionMode,
          environment: input.environment,
          secrets: input.secrets,
        });
  return { action, tick, execution };
}

export async function dispatchFlowV1(
  input: Omit<Parameters<typeof invokeFlowV1>[0], "executeTick">,
): Promise<Awaited<ReturnType<typeof invokeFlowV1>>> {
  const result = await invokeFlowV1({
    ...input,
    executeTick: false,
  });
  if (result.tick.run.status === "pending") {
    setImmediate(() => {
      void runFlowV1Tick({
        runId: result.tick.run.id,
        projectCwd: input.projectCwd,
        defaultAgent: input.defaultAgent,
        defaultModel: input.defaultModel,
        defaultPermissionMode: input.defaultPermissionMode,
        environment: input.environment,
        secrets: input.secrets,
      }).catch((error) => {
        console.error("[flow-v1 dispatch]", error);
      });
    });
  }
  return result;
}

function initializeMemoryIfDeclared(
  flowId: string,
  flow: ParsedFlowV1,
  bundle: FlowV1Bundle,
) {
  if (!flow.memory) {
    return null;
  }
  const template = getFlowV1BundleFile(
    bundle,
    FLOW_V1_MEMORY_TEMPLATE_FILE,
  );
  if (!template) {
    throw new FlowV1ServiceError(
      "flow_memory_template_missing",
      "Flow Memory declaration has no memory.template.md.",
    );
  }
  return initializeFlowV1Memory({
    flowId,
    template: template.content,
    definition: flow.memory,
  });
}

export function publishFlowV1Version(input: {
  flowId: string;
  versionId: string;
  now?: string;
}): { versionId: string; bundleHash: string } {
  const bundle = getFlowV1BundleForVersion(input.versionId);
  if (!bundle) {
    throw new FlowV1ServiceError(
      "flow_bundle_missing",
      `Version ${input.versionId} has no Flow v1 Bundle.`,
    );
  }
  const flow = requireValidBundle(bundle);
  const database = getDb();
  const now = input.now ?? new Date().toISOString();
  const currentParams = getCurrentFlowV1Params(input.flowId);
  const compatibleParams = Object.fromEntries(
    Object.keys(flow.params)
      .filter((name) => currentParams?.values[name] !== undefined)
      .map((name) => [name, currentParams!.values[name]!]),
  ) as FlowV1JsonObject;
  const params = resolveParams(flow, compatibleParams);
  database.transaction(() => {
    const version = database
      .prepare(
        `
        SELECT id FROM workflow_versions
        WHERE id = ? AND workflow_id = ?
      `,
      )
      .get(input.versionId, input.flowId) as { id: string } | undefined;
    if (!version) {
      throw new FlowV1ServiceError(
        "flow_version_not_found",
        `Version ${input.versionId} was not found for Flow ${input.flowId}.`,
      );
    }
    database
      .prepare(
        `
        UPDATE workflow_versions
        SET version_status = 'superseded'
        WHERE workflow_id = ? AND id <> ?
          AND version_status = 'published'
      `,
      )
      .run(input.flowId, input.versionId);
    database
      .prepare(
        `
        UPDATE workflow_versions
        SET version_status = 'published', published_at = COALESCE(published_at, ?)
        WHERE id = ?
      `,
      )
      .run(now, input.versionId);
    database
      .prepare(
        `
        UPDATE workflows
        SET name = ?, description = ?, current_version_id = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        flow.meta.name,
        flow.meta.description,
        input.versionId,
        now,
        input.flowId,
      );
    if (
      !currentParams ||
      !isDeepStrictEqual(currentParams.values, params)
    ) {
      setFlowV1Params({
        flowId: input.flowId,
        values: params,
        expectedRevision: currentParams?.revision ?? 0,
      });
    }
    configureSchedule(input.flowId, flow, params, now);
  })();
  initializeMemoryIfDeclared(input.flowId, flow, bundle);
  return { versionId: input.versionId, bundleHash: bundle.hash };
}

export function setFlowV1Lifecycle(input: {
  flowId: string;
  lifecycle: "active" | "paused" | "archived";
}): void {
  if (input.lifecycle === "active") {
    const row = getDb()
      .prepare("SELECT current_version_id FROM workflows WHERE id = ?")
      .get(input.flowId) as
      | { current_version_id: string | null }
      | undefined;
    if (!row?.current_version_id) {
      throw new FlowV1ServiceError(
        "flow_not_runnable",
        `Flow ${input.flowId} has no published Version.`,
      );
    }
    const bundle = getFlowV1BundleForVersion(row.current_version_id);
    if (!bundle) {
      throw new FlowV1ServiceError(
        "flow_bundle_missing",
        "Published Flow Version has no Bundle.",
      );
    }
    const flow = requireValidBundle(bundle);
    const config = resolveFlowV1ExecutionConfig({
      flowId: input.flowId,
      flow,
    });
    if (flow.meta.requiresCwd && !config.projectCwd) {
      throw new FlowV1ServiceError(
        "flow_project_cwd_missing",
        "Flow requires a configured project cwd before activation.",
      );
    }
    if (config.missingSecretNames.length > 0) {
      throw new FlowV1ServiceError(
        "flow_secret_binding_missing",
        `Flow is missing required Secret bindings: ${config.missingSecretNames.join(", ")}.`,
      );
    }
    if (flowRequiresDefaultAgent(flow) && !config.defaultAgent) {
      throw new FlowV1ServiceError(
        "flow_default_agent_missing",
        "Flow contains Agent nodes without an explicit Agent and requires a configured default Agent before activation.",
      );
    }
  }
  const updated = getDb()
    .prepare(
      `
      UPDATE workflows
      SET lifecycle = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(input.lifecycle, new Date().toISOString(), input.flowId).changes;
  if (updated !== 1) {
    throw new FlowV1ServiceError(
      "flow_not_found",
      `Flow ${input.flowId} was not found.`,
    );
  }
}

export function configureFlowV1(input: {
  flowId: string;
  params?: FlowV1JsonObject;
  expectedParamsRevision?: number;
  projectCwd?: string | null;
  defaultAgent?: string | null;
  defaultModel?: string | null;
  defaultPermissionMode?: string | null;
  secretBindings?: Record<string, FlowV1SecretBinding>;
}): {
  params: FlowV1JsonObject;
  paramsRevision: number;
  projectCwd: string | null;
  defaultAgent: string | null;
  defaultModel: string | null;
  defaultPermissionMode: string | null;
  secretBindings: Record<string, FlowV1SecretBinding>;
} {
  const row = getDb()
    .prepare("SELECT current_version_id FROM workflows WHERE id = ?")
    .get(input.flowId) as
    | { current_version_id: string | null }
    | undefined;
  if (!row?.current_version_id) {
    throw new FlowV1ServiceError(
      "flow_not_runnable",
      `Flow ${input.flowId} has no published Version.`,
    );
  }
  const bundle = getFlowV1BundleForVersion(row.current_version_id);
  if (!bundle) {
    throw new FlowV1ServiceError(
      "flow_bundle_missing",
      "Published Flow Version has no Bundle.",
    );
  }
  const flow = requireValidBundle(bundle);
  const database = getDb();
  return database.transaction(() => {
    let paramsRecord = getCurrentFlowV1Params(input.flowId);
    if (input.params) {
      const values = resolveParams(flow, input.params);
      paramsRecord = setFlowV1Params({
        flowId: input.flowId,
        values,
        expectedRevision:
          input.expectedParamsRevision ?? paramsRecord?.revision ?? 0,
      });
      configureSchedule(
        input.flowId,
        flow,
        values,
        new Date().toISOString(),
      );
    }
    const runtimeConfig = setFlowV1RuntimeConfig({
      flowId: input.flowId,
      ...(input.projectCwd !== undefined
        ? { projectCwd: input.projectCwd }
        : {}),
      ...(input.defaultAgent !== undefined
        ? { defaultAgent: input.defaultAgent }
        : {}),
      ...(input.defaultModel !== undefined
        ? { defaultModel: input.defaultModel }
        : {}),
      ...(input.defaultPermissionMode !== undefined
        ? { defaultPermissionMode: input.defaultPermissionMode }
        : {}),
      ...(input.secretBindings
        ? { secretBindings: input.secretBindings }
        : {}),
    });
    return {
      params: paramsRecord?.values ?? {},
      paramsRevision: paramsRecord?.revision ?? 0,
      ...runtimeConfig,
    };
  })();
}

export function cancelFlowV1Cycle(input: {
  flowId: string;
  cycleId?: string;
}): {
  cycleId: string;
  runId: string;
  cancellationRequested: true;
} {
  const cycle = input.cycleId
    ? getFlowV1Cycle(input.cycleId)
    : getActiveFlowV1Cycle(input.flowId);
  if (
    !cycle ||
    cycle.flowId !== input.flowId ||
    cycle.status === "completed" ||
    cycle.status === "canceled"
  ) {
    throw new FlowV1ServiceError(
      "flow_cycle_not_found",
      "No active Cycle was found for cancellation.",
    );
  }
  const activeRun = getActiveFlowV1RunForFlow(input.flowId);
  if (activeRun?.status === "running") {
    if (!requestFlowV1TickCancellation(activeRun.id)) {
      throw new FlowV1ServiceError(
        "flow_cancel_owner_unavailable",
        "The active Tick is owned by another process and cannot be canceled safely.",
      );
    }
    return {
      cycleId: cycle.id,
      runId: activeRun.id,
      cancellationRequested: true,
    };
  }
  const tick =
    activeRun?.status === "pending"
      ? {
          run: activeRun,
        }
      : startFlowV1Tick({
          cycleId: cycle.id,
          origin: { kind: "user" },
          idempotencyKey: `cancel:${cycle.id}`,
          input: { cancel: true },
        });
  const controller = new AbortController();
  controller.abort(
    new FlowV1TickSupervisorError(
      "flow_cycle_cancel_requested",
      `Cancellation was requested for Cycle ${cycle.id}.`,
    ),
  );
  setImmediate(() => {
    void runFlowV1Tick({
      runId: tick.run.id,
      signal: controller.signal,
    }).catch((error) => {
      console.error("[flow-v1 cancel]", error);
    });
  });
  return {
    cycleId: cycle.id,
    runId: tick.run.id,
    cancellationRequested: true,
  };
}

export async function respondToFlowV1HumanTask(input: {
  flowId: string;
  runId: string;
  taskId: string;
  action: string;
  values: Record<string, WorkflowValue>;
  revision: number;
  resolvedBy?: string;
  executeTick?: boolean;
  projectCwd?: string;
  environment?: Record<string, string>;
  secrets?: Record<string, string>;
}): Promise<{
  task: WorkflowHumanTask;
  tick: FlowV1TickBundle;
  execution: FlowV1TickExecutionResult | null;
}> {
  const existing = getWorkflowHumanTask(input.taskId);
  if (
    !existing ||
    existing.runId !== input.runId ||
    !existing.cycleId
  ) {
    throw new FlowV1ServiceError(
      "flow_human_task_not_found",
      "Flow Human task was not found.",
    );
  }
  const cycle = getFlowV1Cycle(existing.cycleId);
  if (!cycle || cycle.flowId !== input.flowId) {
    throw new FlowV1ServiceError(
      "flow_human_task_not_found",
      "Flow Human task does not belong to this Flow.",
    );
  }
  if (cycle.status !== "waiting_human" && existing.status === "pending") {
    throw new FlowV1ServiceError(
      "flow_human_task_conflict",
      `Cycle ${cycle.id} is ${cycle.status}, not waiting for a Human response.`,
    );
  }

  const resolvedRevision =
    existing.status === "pending" ? existing.revision + 1 : existing.revision;
  const idempotencyKey = `human:${existing.id}:${resolvedRevision}`;
  const result = getDb().transaction(() => {
    const task =
      existing.status === "pending"
        ? resolveWorkflowHumanTask({
            runId: input.runId,
            taskId: input.taskId,
            action: input.action,
            values: input.values,
            revision: input.revision,
            resolvedBy: input.resolvedBy,
          })
        : existing;
    if (
      task.response &&
      (task.response.action !== input.action ||
        !isDeepStrictEqual(task.response.values, input.values))
    ) {
      throw new FlowV1ServiceError(
        "flow_human_task_conflict",
        "Human task was already resolved with a different response.",
      );
    }
    const tick = startFlowV1Tick({
      cycleId: existing.cycleId!,
      origin: { kind: "user" },
      idempotencyKey,
      input: {
        humanTaskId: task.id,
        action: input.action,
      },
    });
    return { task, tick };
  })();

  const execution =
    input.executeTick === false || result.tick.run.status !== "pending"
      ? null
      : await runFlowV1Tick({
          runId: result.tick.run.id,
          projectCwd: input.projectCwd,
          environment: input.environment,
          secrets: input.secrets,
        });
  return { ...result, execution };
}

export async function retryFlowV1Node(input: {
  flowId: string;
  cycleId: string;
  nodeId: string;
  idempotencyKey?: string;
  executeTick?: boolean;
  projectCwd?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultPermissionMode?: string;
  environment?: Record<string, string>;
  secrets?: Record<string, string>;
}): Promise<{
  invalidatedNodeIds: string[];
  tick: FlowV1TickBundle;
  execution: FlowV1TickExecutionResult | null;
}> {
  const cycle = getFlowV1Cycle(input.cycleId);
  if (!cycle || cycle.flowId !== input.flowId) {
    throw new FlowV1ServiceError(
      "flow_cycle_not_found",
      `Cycle ${input.cycleId} was not found for Flow ${input.flowId}.`,
    );
  }
  if (
    cycle.status !== "paused_failed" &&
    cycle.status !== "paused_uncertain" &&
    cycle.status !== "paused_conflict"
  ) {
    throw new FlowV1ServiceError(
      "flow_cycle_not_retryable",
      `Cycle ${cycle.id} is ${cycle.status}, not paused on a retryable node.`,
    );
  }
  if (getActiveFlowV1RunForFlow(input.flowId)) {
    throw new FlowV1ServiceError(
      "flow_tick_active",
      `Flow ${input.flowId} already has an active Tick.`,
    );
  }
  const checkpointRecord = getFlowV1CycleCheckpoint(cycle.id);
  const { getFlowV1BundleForVersion } = await import(
    "@/lib/db/workflows/flow-bundles"
  );
  const bundle = getFlowV1BundleForVersion(cycle.flowVersionId);
  if (!checkpointRecord || !bundle) {
    throw new FlowV1ServiceError(
      "flow_runtime_state_missing",
      `Cycle ${cycle.id} is missing its Checkpoint or pinned Bundle.`,
    );
  }
  const flow = requireValidBundle(bundle);
  const checkpoint = readServiceCheckpoint(
    flow,
    checkpointRecord.state,
  );
  const node = flow.nodes.find((entry) => entry.id === input.nodeId);
  const nodeState = checkpoint.nodes[input.nodeId];
  if (
    !node ||
    !nodeState ||
    (nodeState.status !== "failed" &&
      nodeState.status !== "uncertain")
  ) {
    throw new FlowV1ServiceError(
      "flow_node_not_retryable",
      `Node ${input.nodeId} is not the failed or uncertain node in Cycle ${cycle.id}.`,
    );
  }
  const interruptedCompositeRecovery =
    nodeState.error?.code === "flow_attempt_interrupted" &&
    (node.kind === "loop" || node.kind === "map");
  const invalidated = invalidateFlowV1NodeAndDownstream(
    flow,
    checkpoint,
    input.nodeId,
    { preserveRootProgress: interruptedCompositeRecovery },
  );
  const invalidatesHumanDecision = flow.nodes.some(
    (candidate) =>
      invalidated.invalidatedNodeIds.includes(candidate.id) &&
      (candidate.kind === "human" ||
        (candidate.kind === "loop" &&
          candidate.loop?.steps.some((step) => step.kind === "human"))),
  );
  if (invalidatesHumanDecision && !interruptedCompositeRecovery) {
    throw new FlowV1ServiceError(
      "flow_retry_human_decision_forbidden",
      "Retry would invalidate a Human decision. Start a new Cycle or retry a later node.",
    );
  }
  if (node.kind === "finally") {
    invalidated.checkpoint = queueFlowV1Node(
      invalidated.checkpoint,
      node.id,
    );
  }
  const persisted = compareAndSetFlowV1CycleCheckpoint({
    cycleId: cycle.id,
    expectedRevision: checkpointRecord.revision,
    state: invalidated.checkpoint as unknown as FlowV1JsonObject,
    cycleStatus: "runnable",
    currentNodeId: input.nodeId,
  });
  if (!persisted.updated) {
    throw new FlowV1ServiceError(
      "flow_checkpoint_conflict",
      `Cycle ${cycle.id} changed while retrying ${input.nodeId}.`,
    );
  }
  const tick = startFlowV1Tick({
    cycleId: cycle.id,
    origin: { kind: "recovery", reason: `retry node ${input.nodeId}` },
    idempotencyKey:
      input.idempotencyKey ??
      `retry:${cycle.id}:${input.nodeId}:${persisted.checkpoint.revision}`,
  });
  const execution =
    input.executeTick === false
      ? null
      : await runFlowV1Tick({
          runId: tick.run.id,
          projectCwd: input.projectCwd,
          defaultAgent: input.defaultAgent,
          defaultModel: input.defaultModel,
          defaultPermissionMode: input.defaultPermissionMode,
          environment: input.environment,
          secrets: input.secrets,
        });
  return {
    invalidatedNodeIds: invalidated.invalidatedNodeIds,
    tick,
    execution,
  };
}

export async function resolveFlowV1MemoryConflict(input: {
  flowId: string;
  cycleId: string;
  nodeId: string;
  resolution: "keep_current" | "apply_candidate";
  executeTick?: boolean;
}): Promise<{
  resolution: "keep_current" | "apply_candidate";
  resultHash: string;
  tick: FlowV1TickBundle;
  execution: FlowV1TickExecutionResult | null;
}> {
  const cycle = getFlowV1Cycle(input.cycleId);
  if (
    !cycle ||
    cycle.flowId !== input.flowId ||
    cycle.status !== "paused_conflict" ||
    cycle.currentNodeId !== input.nodeId
  ) {
    throw new FlowV1ServiceError(
      "flow_memory_conflict_not_resolvable",
      "The requested node is not the active Memory conflict for this Flow.",
    );
  }
  const bundle = getFlowV1BundleForVersion(cycle.flowVersionId);
  if (!bundle) {
    throw new FlowV1ServiceError(
      "flow_bundle_missing",
      "Memory conflict Cycle has no pinned Bundle.",
    );
  }
  const flow = requireValidBundle(bundle);
  if (!flow.memory) {
    throw new FlowV1ServiceError(
      "flow_memory_not_declared",
      "Memory conflict Cycle has no Memory declaration.",
    );
  }
  const resolved = resolveMemoryConflict({
    flowId: input.flowId,
    cycleId: input.cycleId,
    nodeId: input.nodeId,
    definition: flow.memory,
    resolution: input.resolution,
  });
  const retried = await retryFlowV1Node({
    flowId: input.flowId,
    cycleId: input.cycleId,
    nodeId: input.nodeId,
    executeTick: input.executeTick,
  });
  return {
    ...resolved,
    tick: retried.tick,
    execution: retried.execution,
  };
}

function readServiceCheckpoint(
  flow: ParsedFlowV1,
  value: FlowV1JsonObject,
): FlowV1GraphCheckpoint {
  const nodes = value.nodes;
  if (!nodes || Array.isArray(nodes) || typeof nodes !== "object") {
    return createFlowV1GraphCheckpoint(flow);
  }
  return structuredClone(value) as unknown as FlowV1GraphCheckpoint;
}

function insertFlowV1Version(input: {
  flowId: string;
  flow: ParsedFlowV1;
  bundle: FlowV1Bundle;
  version: number;
  publish: boolean;
  semanticReview?: AuthoringSemanticReview;
  now: string;
}): { versionId: string } {
  const database = getDb();
  const versionId = randomUUID();
  const versionMeta = {
    name: input.flow.meta.name,
    description: input.flow.meta.description,
    requiresCwd: input.flow.meta.requiresCwd,
  };
  database
    .prepare(
      `
      INSERT INTO workflow_versions (
        id, workflow_id, version, meta_json, semantic_review_json, created_at,
        schema_version, version_status, bundle_hash, published_at
      ) VALUES (?, ?, ?, ?, ?, ?,
        'tutti.flow.v1', ?, ?, ?)
    `,
    )
    .run(
      versionId,
      input.flowId,
      input.version,
      stringifyWorkflowMetaColumn(versionMeta, {
        table: "workflow_versions",
        column: "meta_json",
        id: versionId,
      }),
      input.semanticReview
        ? stringifyAuthoringSemanticReviewColumn(input.semanticReview, {
            table: "workflow_versions",
            column: "semantic_review_json",
            id: versionId,
          })
        : null,
      input.now,
      input.publish ? "published" : "draft",
      input.bundle.hash,
      input.publish ? input.now : null,
    );
  saveFlowV1BundleForVersion({ versionId, bundle: input.bundle });
  if (input.publish) {
    database
      .prepare(
        `
        UPDATE workflow_versions
        SET version_status = 'superseded'
        WHERE workflow_id = ? AND id <> ?
          AND version_status = 'published'
      `,
      )
      .run(input.flowId, versionId);
    database
      .prepare(
        `
        UPDATE workflows
        SET name = ?, description = ?, current_version_id = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        input.flow.meta.name,
        input.flow.meta.description,
        versionId,
        input.now,
        input.flowId,
      );
  }
  return { versionId };
}

function requireValidBundle(bundle: FlowV1Bundle): ParsedFlowV1 {
  const flow = parseFlowV1Bundle(bundle);
  if (hasWorkflowDiagnosticErrors(flow.diagnostics)) {
    throw new FlowV1ServiceError(
      "flow_bundle_invalid",
      flow.diagnostics.map((entry) => entry.message).join("; "),
    );
  }
  return flow;
}

function resolveParams(
  flow: ParsedFlowV1,
  supplied: FlowV1JsonObject,
): FlowV1JsonObject {
  return resolveSchemaValues(flow.params, supplied, "Param");
}

function resolveCycleInputs(
  flow: ParsedFlowV1,
  supplied: FlowV1JsonObject,
): FlowV1JsonObject {
  return resolveSchemaValues(flow.inputs, supplied, "Cycle input");
}

function resolveSchemaValues(
  schema: ParsedFlowV1["params"],
  supplied: FlowV1JsonObject,
  kind: string,
): FlowV1JsonObject {
  for (const name of Object.keys(supplied)) {
    if (!schema[name]) {
      throw new FlowV1ServiceError(
        "flow_unknown_value",
        `${kind} "${name}" is not declared by this Flow.`,
      );
    }
  }
  const result: FlowV1JsonObject = {};
  for (const entry of Object.values(schema)) {
    const suppliedValue = supplied[entry.name];
    const defaultValue = entry.config.default;
    if (suppliedValue !== undefined) {
      validateResolvedSchemaValue(entry, suppliedValue, kind);
      result[entry.name] = suppliedValue;
    } else if (defaultValue !== undefined) {
      validateResolvedSchemaValue(entry, defaultValue, kind);
      result[entry.name] = defaultValue;
    } else if (entry.required) {
      throw new FlowV1ServiceError(
        "flow_required_value_missing",
        `${kind} "${entry.name}" is required.`,
      );
    }
  }
  return result;
}

function validateResolvedSchemaValue(
  entry: ParsedFlowV1["params"][string],
  value: FlowV1JsonValue,
  kind: string,
): void {
  const helperType = schemaHelperValueType(entry.helper);
  const valueLabel = `${kind} "${entry.name}"`;
  if (
    (helperType === "string" && typeof value !== "string") ||
    (helperType === "number" &&
      (typeof value !== "number" || !Number.isFinite(value))) ||
    (helperType === "boolean" && typeof value !== "boolean")
  ) {
    throw new FlowV1ServiceError(
      "flow_value_type_invalid",
      `${valueLabel} must be ${articleFor(helperType)} ${helperType}.`,
    );
  }
  if (helperType === "number" && typeof value === "number") {
    if (
      (typeof entry.config.min === "number" &&
        value < entry.config.min) ||
      (typeof entry.config.max === "number" &&
        value > entry.config.max) ||
      (entry.config.integer === true && !Number.isInteger(value))
    ) {
      throw new FlowV1ServiceError(
        "flow_value_constraint_invalid",
        `${valueLabel} violates its numeric constraints.`,
      );
    }
  }
  if (helperType === "string" && typeof value === "string") {
    const pattern =
      typeof entry.config.pattern === "string"
        ? new RegExp(entry.config.pattern, "u")
        : null;
    if (
      (typeof entry.config.minLength === "number" &&
        value.length < entry.config.minLength) ||
      (typeof entry.config.maxLength === "number" &&
        value.length > entry.config.maxLength) ||
      (pattern && !pattern.test(value))
    ) {
      throw new FlowV1ServiceError(
        "flow_value_constraint_invalid",
        `${valueLabel} violates its string constraints.`,
      );
    }
  }
}

function schemaHelperValueType(
  helper: string,
): "string" | "number" | "boolean" | "json" {
  if (helper === "stringParam" || helper === "stringInput" || helper === "cronParam") {
    return "string";
  }
  if (helper === "numberParam" || helper === "numberInput") {
    return "number";
  }
  if (helper === "booleanParam" || helper === "booleanInput") {
    return "boolean";
  }
  return "json";
}

function articleFor(value: string): string {
  return /^[aeiou]/u.test(value) ? "an" : "a";
}

function flowRequiresDefaultAgent(flow: ParsedFlowV1): boolean {
  return flow.nodes.some(
    (node) =>
      (node.kind === "agent" && !node.agent) ||
      (node.kind === "loop" &&
        node.loop?.steps.some(
          (step) => step.kind === "agent" && !step.agent,
        )) ||
      (node.kind === "map" &&
        node.map?.steps.some(
          (step) => step.kind === "agent" && !step.agent,
        )),
  );
}

function configureSchedule(
  flowId: string,
  flow: ParsedFlowV1,
  params: FlowV1JsonObject,
  now: string,
): void {
  if (!flow.schedule) {
    deleteFlowV1Schedule(flowId);
    return;
  }
  const expression = resolveScheduleValue(
    flow.schedule.expression,
    params,
  );
  const timezone = resolveScheduleValue(flow.schedule.timezone, params);
  const scheduleInput: FlowV1JsonObject = {};
  for (const [name, value] of Object.entries(flow.schedule.inputs)) {
    scheduleInput[name] =
      typeof value === "object" &&
      value !== null &&
      "expression" in value
        ? resolveReference(value as FlowV1Reference, params)
        : (value as FlowV1JsonValue);
  }
  upsertFlowV1Schedule({
    flowId,
    status: "active",
    cronExpression: expression,
    timezone,
    overlapPolicy: flow.schedule.overlap,
    scheduleInput,
    nextFireAt: nextFlowV1CronFire({
      expression,
      timezone,
      after: now,
    }),
  });
}

function resolveScheduleValue(
  value: string | FlowV1Reference,
  params: FlowV1JsonObject,
): string {
  if (typeof value === "string") {
    return value;
  }
  const resolved = resolveReference(value, params);
  if (typeof resolved !== "string") {
    throw new FlowV1ServiceError(
      "flow_schedule_binding_invalid",
      `Schedule binding ${value.expression} must resolve to a string.`,
    );
  }
  return resolved;
}

function resolveReference(
  reference: FlowV1Reference,
  params: FlowV1JsonObject,
): FlowV1JsonValue {
  if (reference.source !== "params") {
    throw new FlowV1ServiceError(
      "flow_schedule_binding_invalid",
      `Schedule cannot resolve ${reference.expression} at publication.`,
    );
  }
  let current: FlowV1JsonValue | undefined = params;
  for (const part of reference.path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      current = undefined;
      break;
    }
    current = current[part];
  }
  if (current === undefined) {
    throw new FlowV1ServiceError(
      "flow_schedule_binding_missing",
      `Schedule binding ${reference.expression} is missing.`,
    );
  }
  return current;
}
