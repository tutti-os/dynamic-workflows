import type { ApiErrorCode } from "@/lib/api/errors";
import type {
  WorkflowRunRecord,
  WorkflowRunStatus,
} from "@/lib/db/workflows/types";
import { createWorkflowExecutionPlan } from "./execution-plan";
import { RUN_TEXT_PREVIEW_CHARS } from "./run-constants";
import type { RunLogEntry } from "./run-log";
import type {
  ParsedWorkflow,
  WorkflowNodeSessionRef,
  WorkflowNodeSessionStatus,
  WorkflowLoopStepRun,
  WorkflowMapItemRun,
  WorkflowNodeStatus,
  WorkflowRunEvent,
  WorkflowHumanTask,
  WorkflowValue,
} from "./types";

export { RUN_TEXT_PREVIEW_CHARS };

export type WorkflowRunResult = {
  outputs: Record<string, WorkflowValue>;
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  nodeSessions: Record<string, WorkflowNodeSessionRef>;
  loopStepRuns: Record<string, WorkflowLoopStepRun>;
  // Optional so existing WorkflowRunResult literals keep compiling; always
  // populated by the run-state reducers below (mirrors loopStepRuns).
  mapItemRuns?: Record<string, WorkflowMapItemRun>;
  // Rendered prompts captured at run time, keyed by top-level node id. Optional
  // so legacy result_json (written before this field existed) reads cleanly.
  nodeInputs?: Record<string, string>;
  error?: string;
  errorCode?: ApiErrorCode;
};

export type WorkflowRunSummary = WorkflowRunResult & {
  status: WorkflowRunStatus;
};

export type RunDetail = {
  run: WorkflowRunRecord;
  log: string;
  humanTasks?: WorkflowHumanTask[];
  logSizeBytes?: number;
  logReturnedBytes?: number;
  logTruncated?: boolean;
};

export function createInitialRunSummary(
  parsed?: ParsedWorkflow,
  options?: {
    status?: WorkflowRunStatus;
    queueExecutableNodes?: boolean;
  },
): WorkflowRunSummary {
  const nodeStatuses: Record<string, WorkflowNodeStatus> = {};
  if (parsed && options?.queueExecutableNodes !== false) {
    for (const node of createWorkflowExecutionPlan(parsed).executableNodes) {
      nodeStatuses[node.id] = "queued";
    }
  }

  return {
    status: options?.status ?? "running",
    outputs: {},
    nodeStatuses,
    nodeSessions: {},
    loopStepRuns: {},
    mapItemRuns: {},
    nodeInputs: {},
  };
}

export function applyWorkflowRunEvent(
  summary: WorkflowRunSummary,
  event: WorkflowRunEvent,
): WorkflowRunSummary {
  const next: WorkflowRunSummary = {
    status: summary.status,
    outputs: { ...summary.outputs },
    nodeStatuses: { ...summary.nodeStatuses },
    nodeSessions: { ...summary.nodeSessions },
    loopStepRuns: { ...summary.loopStepRuns },
    mapItemRuns: { ...(summary.mapItemRuns ?? {}) },
    nodeInputs: { ...(summary.nodeInputs ?? {}) },
    error: summary.error,
    errorCode: summary.errorCode,
  };

  if (event.type === "run_started") {
    next.status = "running";
    for (const node of createWorkflowExecutionPlan(event.parsed).executableNodes) {
      next.nodeStatuses[node.id] ??= "queued";
    }
    return next;
  }

  if (event.type === "node_started") {
    next.nodeStatuses[event.nodeId] = "running";
    // Only a string lands in nodeInputs: the result_json guard rejects explicit
    // undefined properties, and legacy/non-agent node_started events omit input.
    // Cap with limitRunText — rendered prompts embed upstream outputs and can be
    // large. (Loop/map step records store their prompt uncapped; see report.)
    if (typeof event.input === "string") {
      next.nodeInputs = {
        ...(next.nodeInputs ?? {}),
        [event.nodeId]: limitRunText(event.input),
      };
    }
    return next;
  }

  if (event.type === "loop_step_state") {
    const current = next.loopStepRuns[event.loopStep.executionKey];
    const session = current?.session
      ? withNodeSessionPatch(current.session, {
          nodeId: current.session.nodeId,
          status:
            event.status === "failed"
              ? "failed"
              : event.status === "completed"
                ? "completed"
                : current.session.status,
          ...(event.error ? { lastError: event.error } : {}),
          ...(typeof event.output === "string" ? { lastText: event.output } : {}),
        })
      : undefined;
    next.loopStepRuns[event.loopStep.executionKey] = {
      ...event.loopStep,
      ...(current ?? {}),
      kind: event.kind,
      label: event.label,
      status: event.status,
      ...(event.agent ? { agent: event.agent } : {}),
      ...(event.model ? { model: event.model } : {}),
      ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
      ...(event.promptMode ? { promptMode: event.promptMode } : {}),
      ...(event.input !== undefined ? { input: event.input } : {}),
      ...(event.restored !== undefined ? { restored: event.restored } : {}),
      ...(event.output !== undefined ? { output: event.output } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(session ? { session } : {}),
    };
    if (session) {
      next.nodeSessions[session.nodeId] = session;
    }
    return next;
  }

  if (event.type === "map_item_state") {
    const mapItemRuns = next.mapItemRuns ?? {};
    const current = mapItemRuns[event.mapItem.executionKey];
    const merged = {
      ...event.mapItem,
      ...(current ?? {}),
      kind: event.kind,
      label: event.label,
      status: event.status,
      ...(event.agent ? { agent: event.agent } : {}),
      ...(event.model ? { model: event.model } : {}),
      ...(event.promptMode ? { promptMode: event.promptMode } : {}),
      ...(event.input !== undefined ? { input: event.input } : {}),
      ...(event.restored !== undefined ? { restored: event.restored } : {}),
      ...(event.output !== undefined ? { output: event.output } : {}),
      ...(event.error ? { error: event.error } : {}),
    };
    // A retried item that recovers must not keep showing its old failure:
    // any non-failed state without a fresh error clears the stale one.
    if (event.status !== "failed" && !event.error) {
      delete merged.error;
    }
    mapItemRuns[event.mapItem.executionKey] = merged;
    next.mapItemRuns = mapItemRuns;
    return next;
  }

  if (event.type === "node_event") {
    const agentEvent = event.event as {
      type?: string;
      text?: string;
      message?: string;
      session?: unknown;
    };
    if (agentEvent.type === "text_delta" && agentEvent.text) {
      const previous = next.outputs[event.nodeId];
      next.outputs[event.nodeId] =
        `${typeof previous === "string" ? previous : ""}${agentEvent.text}`;
      if (next.nodeSessions[event.nodeId]) {
        const outputText = next.outputs[event.nodeId];
        next.nodeSessions[event.nodeId] = withNodeSessionPatch(
          next.nodeSessions[event.nodeId],
          {
            nodeId: event.nodeId,
            ...(typeof outputText === "string" ? { lastText: outputText } : {}),
          },
        );
      }
    }
    if (agentEvent.type === "session_ref") {
      const session = readNodeSessionRef(event.nodeId, agentEvent.session);
      if (session) {
        next.nodeSessions[event.nodeId] = withNodeSessionPatch(
          next.nodeSessions[event.nodeId],
          session,
        );
      }
    }
    if (agentEvent.type === "error" && agentEvent.message) {
      next.nodeSessions[event.nodeId] = withNodeSessionPatch(
        next.nodeSessions[event.nodeId],
        {
          nodeId: event.nodeId,
          status: "failed",
          lastError: agentEvent.message,
        },
      );
    }
    if (event.loopStep) {
      const executionKey = event.loopStep.executionKey;
      const current = next.loopStepRuns[executionKey];
      const output =
        agentEvent.type === "text_delta" && agentEvent.text
          ? `${typeof current?.output === "string" ? current.output : ""}${agentEvent.text}`
          : current?.output;
      const sessionNodeId = `${event.loopStep.parentNodeId}.${event.loopStep.stepId}`;
      const sessionPatch =
        agentEvent.type === "session_ref"
          ? readNodeSessionRef(sessionNodeId, agentEvent.session)
          : undefined;
      const session = sessionPatch
        ? withNodeSessionPatch(current?.session, sessionPatch)
        : current?.session
          ? withNodeSessionPatch(current.session, {
              nodeId: current.session.nodeId,
              ...(typeof output === "string" ? { lastText: output } : {}),
              ...(agentEvent.type === "error" && agentEvent.message
                ? { status: "failed", lastError: agentEvent.message }
                : {}),
            })
          : undefined;
      next.loopStepRuns[executionKey] = {
        ...event.loopStep,
        ...(current ?? {}),
        kind: current?.kind ?? "agent",
        label: current?.label ?? event.loopStep.stepId,
        status: agentEvent.type === "error" ? "failed" : (current?.status ?? "running"),
        ...(output !== undefined ? { output } : {}),
        ...(session ? { session } : {}),
        ...(agentEvent.type === "error" && agentEvent.message
          ? { error: agentEvent.message, status: "failed" }
          : {}),
      };
    }
    if (event.mapItem) {
      const mapItemRuns = next.mapItemRuns ?? {};
      const executionKey = event.mapItem.executionKey;
      const current = mapItemRuns[executionKey];
      const output =
        agentEvent.type === "text_delta" && agentEvent.text
          ? `${typeof current?.output === "string" ? current.output : ""}${agentEvent.text}`
          : current?.output;
      mapItemRuns[executionKey] = {
        ...event.mapItem,
        ...(current ?? {}),
        kind: "agent",
        label: current?.label ?? event.mapItem.stepId,
        status:
          agentEvent.type === "error" ? "failed" : (current?.status ?? "running"),
        ...(output !== undefined ? { output } : {}),
        ...(agentEvent.type === "error" && agentEvent.message
          ? { error: agentEvent.message, status: "failed" }
          : {}),
      };
      next.mapItemRuns = mapItemRuns;
    }
    return next;
  }

  if (event.type === "node_completed") {
    next.nodeStatuses[event.nodeId] = "completed";
    next.outputs[event.nodeId] = event.output;
    if (next.nodeSessions[event.nodeId]) {
      next.nodeSessions[event.nodeId] = withNodeSessionPatch(
        next.nodeSessions[event.nodeId],
        {
          nodeId: event.nodeId,
          status: "completed",
          ...(typeof event.output === "string"
            ? { lastText: event.output }
            : {}),
        },
      );
    }
    return next;
  }

  if (event.type === "node_failed") {
    next.status = "failed";
    next.nodeStatuses[event.nodeId] = "failed";
    next.error = event.error;
    next.errorCode = "WORKFLOW_RUN_FAILED";
    if (next.nodeSessions[event.nodeId]) {
      next.nodeSessions[event.nodeId] = withNodeSessionPatch(
        next.nodeSessions[event.nodeId],
        {
          nodeId: event.nodeId,
          status: isCancellationMessage(event.error) ? "canceled" : "failed",
          lastError: event.error,
        },
      );
    }
    return next;
  }

  if (event.type === "human_task_requested") {
    next.nodeStatuses[event.nodeId] = "waiting";
    return next;
  }

  if (event.type === "human_task_resolved") {
    next.nodeStatuses[event.nodeId] = "running";
    return next;
  }

  if (event.type === "run_waiting") {
    next.status = "waiting_for_human";
    next.outputs = { ...next.outputs, ...event.outputs };
    next.error = undefined;
    next.errorCode = undefined;
    return next;
  }

  next.status = event.status;
  next.outputs = {
    ...next.outputs,
    ...event.outputs,
  };
  if (event.status === "canceled") {
    next.nodeSessions = Object.fromEntries(
      Object.entries(next.nodeSessions).map(([nodeId, session]) => [
        nodeId,
        session.status === "running"
          ? { ...session, status: "canceled" as const }
          : session,
      ]),
    );
    next.loopStepRuns = Object.fromEntries(
      Object.entries(next.loopStepRuns).map(([executionKey, run]) => [
        executionKey,
        run.status === "running" || run.status === "waiting"
          ? {
              ...run,
              status: "skipped" as const,
              session: run.session
                ? { ...run.session, status: "canceled" as const }
                : undefined,
            }
          : run,
      ]),
    );
    next.mapItemRuns = Object.fromEntries(
      Object.entries(next.mapItemRuns ?? {}).map(([executionKey, run]) => [
        executionKey,
        run.status === "running" || run.status === "waiting"
          ? {
              ...run,
              status: "skipped" as const,
              session: run.session
                ? { ...run.session, status: "canceled" as const }
                : undefined,
            }
          : run,
      ]),
    );
  }
  if (event.error !== undefined || event.status === "completed") {
    next.error = event.error;
  }
  if (event.errorCode !== undefined || event.status === "completed") {
    next.errorCode = event.errorCode;
  }
  return next;
}

export function toWorkflowRunResult(
  summary: WorkflowRunSummary,
): WorkflowRunResult {
  return {
    outputs: summary.outputs,
    nodeStatuses: summary.nodeStatuses,
    nodeSessions: summary.nodeSessions,
    loopStepRuns: summary.loopStepRuns,
    mapItemRuns: summary.mapItemRuns ?? {},
    nodeInputs: summary.nodeInputs ?? {},
    ...(summary.error === undefined ? {} : { error: summary.error }),
    ...(summary.errorCode === undefined ? {} : { errorCode: summary.errorCode }),
  };
}

export function readRunResult(result: unknown): WorkflowRunResult {
  if (!result || typeof result !== "object") {
    return {
      outputs: {},
      nodeStatuses: {},
      nodeSessions: {},
      loopStepRuns: {},
      mapItemRuns: {},
      nodeInputs: {},
    };
  }

  const raw = result as {
    outputs?: unknown;
    nodeStatuses?: unknown;
    nodeSessions?: unknown;
    loopStepRuns?: unknown;
    mapItemRuns?: unknown;
    nodeInputs?: unknown;
    error?: unknown;
    errorCode?: unknown;
  };

  return {
    outputs: isWorkflowValueRecord(raw.outputs) ? raw.outputs : {},
    nodeStatuses: isWorkflowNodeStatusRecord(raw.nodeStatuses)
      ? raw.nodeStatuses
      : {},
    nodeSessions: readNodeSessionRecord(raw.nodeSessions),
    loopStepRuns: readLoopStepRunRecord(raw.loopStepRuns),
    mapItemRuns: readMapItemRunRecord(raw.mapItemRuns),
    nodeInputs: readStringRecord(raw.nodeInputs),
    error: typeof raw.error === "string" ? raw.error : undefined,
    errorCode:
      typeof raw.errorCode === "string"
        ? (raw.errorCode as ApiErrorCode)
        : undefined,
  };
}

export function createRunDetailFromStartedEvent(input: {
  event: Extract<WorkflowRunEvent, { type: "run_started" }>;
  workflowId: string;
  workflowVersionId: string;
  executorKind: string;
  agent?: string | null;
  model?: string | null;
  cwd?: string | null;
  runInput: unknown;
  startedAt?: string;
}): RunDetail {
  const initialLog = serializeRunEvent(input.event);
  const summary = createInitialRunSummary(input.event.parsed);

  return {
    run: {
      id: input.event.runId,
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
      executorKind: input.executorKind,
      externalRunId: null,
      status: "running",
      agent: input.agent ?? null,
      model: input.model ?? null,
      cwd: input.cwd ?? null,
      input: input.runInput,
      result: toWorkflowRunResult(summary),
      logPath: null,
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: null,
    },
    log: limitRunText(initialLog),
    humanTasks: [],
    logSizeBytes: 0,
    logReturnedBytes: 0,
    logTruncated: initialLog.length > RUN_TEXT_PREVIEW_CHARS,
  };
}

export function applyRunEventToDetail(
  detail: RunDetail,
  event: WorkflowRunEvent,
): RunDetail {
  const currentResult = readRunResult(detail.run.result);
  const summary = applyWorkflowRunEvent(
    {
      status: detail.run.status,
      ...currentResult,
    },
    event,
  );
  const nextLog = appendRunLog(detail.log, event);
  const humanTasks = applyHumanTaskEvent(detail.humanTasks ?? [], event);

  return {
    run: {
      ...detail.run,
      status: summary.status,
      pendingHumanTaskCount: humanTasks.filter(
        (task) => task.status === "pending",
      ).length,
      finishedAt:
        event.type === "run_completed"
          ? new Date().toISOString()
          : detail.run.finishedAt,
      result: toWorkflowRunResult(summary),
    },
    log: nextLog.log,
    humanTasks,
    logSizeBytes: detail.logSizeBytes,
    logReturnedBytes: detail.logReturnedBytes,
    logTruncated: detail.logTruncated || nextLog.truncated,
  };
}

function applyHumanTaskEvent(
  tasks: WorkflowHumanTask[],
  event: WorkflowRunEvent,
): WorkflowHumanTask[] {
  if (event.type === "human_task_requested") {
    return [
      ...tasks.filter((task) => task.id !== event.task.id),
      event.task,
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  if (event.type === "human_task_resolved") {
    return tasks.map((task) =>
      task.id === event.taskId
        ? {
            ...task,
            status: "resolved" as const,
            response: event.response,
            revision: task.status === "pending" ? task.revision + 1 : task.revision,
            resolvedAt: task.resolvedAt ?? new Date().toISOString(),
          }
        : task,
    );
  }
  return tasks;
}

export function readNodeStatusesFromRunLog(
  log: string,
): Record<string, WorkflowNodeStatus> {
  let summary = createInitialRunSummary(undefined, {
    queueExecutableNodes: false,
  });
  for (const event of parseRunLogEvents(log)) {
    summary = applyWorkflowRunEvent(summary, event);
  }
  return summary.nodeStatuses;
}

export function serializeRunEvent(event: WorkflowRunEvent): string {
  return JSON.stringify(event);
}

export function limitRunText(text: string): string {
  if (text.length <= RUN_TEXT_PREVIEW_CHARS) {
    return text;
  }
  return text.slice(text.length - RUN_TEXT_PREVIEW_CHARS);
}

export function parseRunLogEvents(log: string): WorkflowRunEvent[] {
  return parseRunLogEntries(log).map((entry) => entry.event);
}

export function parseRunLogEntries(
  log: string,
): Array<RunLogEntry<WorkflowRunEvent>> {
  return log
    .split(/\r?\n/)
    .flatMap((rawLine, index) => {
      const line = rawLine.trim();
      if (!line) {
        return [];
      }
      try {
        const value = JSON.parse(line) as unknown;
        if (isRunLogEntry(value) && isWorkflowRunEvent(value.event)) {
          return [{ id: value.id, event: value.event }];
        }
        return isWorkflowRunEvent(value)
          ? [{ id: `legacy:${index}`, event: value }]
          : [];
      } catch {
        return [];
      }
    });
}

function isRunLogEntry(value: unknown): value is RunLogEntry {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { id?: unknown }).id === "string" &&
      "event" in value,
  );
}

function appendRunLog(
  log: string,
  event: WorkflowRunEvent,
): { log: string; truncated: boolean } {
  const line = serializeRunEvent(event);
  const nextLog = log ? `${log}\n${line}` : line;
  if (nextLog.length <= RUN_TEXT_PREVIEW_CHARS) {
    return { log: nextLog, truncated: false };
  }
  return {
    log: nextLog.slice(nextLog.length - RUN_TEXT_PREVIEW_CHARS),
    truncated: true,
  };
}

function isWorkflowValueRecord(
  value: unknown,
): value is Record<string, WorkflowValue> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isWorkflowValue)
  );
}

function isWorkflowValue(value: unknown): value is WorkflowValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isWorkflowValue);
  }
  return (
    typeof value === "object" &&
    Object.values(value).every(isWorkflowValue)
  );
}

function isWorkflowNodeStatusRecord(
  value: unknown,
): value is Record<string, WorkflowNodeStatus> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((item) => isWorkflowNodeStatus(item))
  );
}

function isWorkflowNodeStatus(value: unknown): value is WorkflowNodeStatus {
  return (
    value === "idle" ||
    value === "queued" ||
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "skipped"
  );
}

function readNodeSessionRecord(
  value: unknown,
): Record<string, WorkflowNodeSessionRef> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value);
  if (
    !entries.every(
      ([nodeId, session]) =>
        typeof nodeId === "string" && isWorkflowNodeSessionRef(session),
    )
  ) {
    return {};
  }
  return Object.fromEntries(entries) as Record<string, WorkflowNodeSessionRef>;
}

function readLoopStepRunRecord(
  value: unknown,
): Record<string, WorkflowLoopStepRun> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value);
  if (!entries.every(([executionKey, run]) =>
    typeof executionKey === "string" && isWorkflowLoopStepRun(run)
  )) {
    return {};
  }
  return Object.fromEntries(entries) as Record<string, WorkflowLoopStepRun>;
}

function readMapItemRunRecord(
  value: unknown,
): Record<string, WorkflowMapItemRun> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value);
  if (
    !entries.every(
      ([executionKey, run]) =>
        typeof executionKey === "string" && isWorkflowMapItemRun(run),
    )
  ) {
    return {};
  }
  return Object.fromEntries(entries) as Record<string, WorkflowMapItemRun>;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value).filter(
    ([nodeId, input]) => typeof nodeId === "string" && typeof input === "string",
  );
  return Object.fromEntries(entries) as Record<string, string>;
}

function isWorkflowMapItemRun(value: unknown): value is WorkflowMapItemRun {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.executionKey === "string" &&
    typeof raw.parentNodeId === "string" &&
    typeof raw.stepId === "string" &&
    Number.isInteger(raw.index) &&
    raw.kind === "agent" &&
    typeof raw.label === "string" &&
    isWorkflowNodeStatus(raw.status) &&
    optionalString(raw.agent) &&
    optionalString(raw.model) &&
    optionalString(raw.input) &&
    (raw.promptMode === undefined ||
      raw.promptMode === "full" ||
      raw.promptMode === "append") &&
    (raw.restored === undefined || typeof raw.restored === "boolean") &&
    (raw.output === undefined || isWorkflowValue(raw.output)) &&
    optionalString(raw.error) &&
    (raw.session === undefined || isWorkflowNodeSessionRef(raw.session))
  );
}

function isWorkflowLoopStepRun(value: unknown): value is WorkflowLoopStepRun {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.executionKey === "string" &&
    typeof raw.parentNodeId === "string" &&
    typeof raw.stepId === "string" &&
    Number.isInteger(raw.iteration) &&
    (raw.kind === "agent" || raw.kind === "human") &&
    typeof raw.label === "string" &&
    isWorkflowNodeStatus(raw.status) &&
    optionalString(raw.agent) &&
    optionalString(raw.model) &&
    optionalString(raw.sessionKey) &&
    optionalString(raw.input) &&
    (raw.promptMode === undefined || raw.promptMode === "full" || raw.promptMode === "append") &&
    (raw.restored === undefined || typeof raw.restored === "boolean") &&
    (raw.output === undefined || isWorkflowValue(raw.output)) &&
    optionalString(raw.error) &&
    (raw.session === undefined || isWorkflowNodeSessionRef(raw.session))
  );
}

function isWorkflowNodeSessionRef(
  value: unknown,
): value is WorkflowNodeSessionRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.nodeId === "string" &&
    typeof raw.agentSessionId === "string" &&
    typeof raw.agent === "string" &&
    isWorkflowNodeSessionStatus(raw.status) &&
    optionalString(raw.providerSessionId) &&
    optionalString(raw.model) &&
    optionalString(raw.title) &&
    optionalString(raw.lastText) &&
    optionalString(raw.lastError)
  );
}

function isWorkflowNodeSessionStatus(
  value: unknown,
): value is WorkflowNodeSessionStatus {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled"
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function readNodeSessionRef(
  nodeId: string,
  value: unknown,
): (Partial<WorkflowNodeSessionRef> & { nodeId: string }) | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const agentSessionId =
    typeof raw.agentSessionId === "string" ? raw.agentSessionId.trim() : "";
  const agent =
    typeof raw.agent === "string" && raw.agent.trim()
      ? raw.agent.trim()
      : "";
  if (!agentSessionId || !agent) {
    return undefined;
  }
  const status = isWorkflowNodeSessionStatus(raw.status)
    ? raw.status
    : "running";
  return {
    nodeId,
    agentSessionId,
    agent,
    status,
    ...readOptionalStringProperty(raw, "providerSessionId"),
    ...readOptionalStringProperty(raw, "model"),
    ...readOptionalStringProperty(raw, "title"),
  };
}

function readOptionalStringProperty(
  value: Record<string, unknown>,
  key: keyof WorkflowNodeSessionRef,
): Partial<WorkflowNodeSessionRef> {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? { [key]: raw.trim() } : {};
}

function withNodeSessionPatch(
  current: WorkflowNodeSessionRef | undefined,
  patch: Partial<WorkflowNodeSessionRef> & { nodeId: string },
): WorkflowNodeSessionRef {
  // Explicit undefined values must never land in the session object: the run
  // result is persisted through a strict JSON guard that rejects them.
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<WorkflowNodeSessionRef> & { nodeId: string };
  const next = {
    ...(current ?? {
      nodeId: patch.nodeId,
      agentSessionId: "",
      agent: "",
      status: "running" as const,
    }),
    ...defined,
  };
  return {
    ...next,
    status: next.status ?? "running",
  };
}

function isCancellationMessage(value: string): boolean {
  return value.toLowerCase().includes("cancel");
}

function isWorkflowRunEvent(value: unknown): value is WorkflowRunEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return (
    type === "run_started" ||
    type === "node_started" ||
    type === "node_event" ||
    type === "loop_step_state" ||
    type === "map_item_state" ||
    type === "node_completed" ||
    type === "human_task_requested" ||
    type === "human_task_resolved" ||
    type === "node_failed" ||
    type === "run_waiting" ||
    type === "run_completed"
  );
}
