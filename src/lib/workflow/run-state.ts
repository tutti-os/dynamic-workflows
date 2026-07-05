import type { ApiErrorCode } from "@/lib/api/errors";
import type {
  WorkflowRunRecord,
  WorkflowRunStatus,
} from "@/lib/db/workflows/types";
import { createWorkflowExecutionPlan } from "./execution-plan";
import { RUN_TEXT_PREVIEW_CHARS } from "./run-constants";
import type {
  ParsedWorkflow,
  WorkflowNodeSessionRef,
  WorkflowNodeSessionStatus,
  WorkflowNodeStatus,
  WorkflowRunEvent,
} from "./types";

export { RUN_TEXT_PREVIEW_CHARS };

export type WorkflowRunResult = {
  outputs: Record<string, string>;
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  nodeSessions: Record<string, WorkflowNodeSessionRef>;
  error?: string;
  errorCode?: ApiErrorCode;
};

export type WorkflowRunSummary = WorkflowRunResult & {
  status: WorkflowRunStatus;
};

export type RunDetail = {
  run: WorkflowRunRecord;
  log: string;
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
      next.outputs[event.nodeId] =
        `${next.outputs[event.nodeId] ?? ""}${agentEvent.text}`;
      if (next.nodeSessions[event.nodeId]) {
        next.nodeSessions[event.nodeId] = withNodeSessionPatch(
          next.nodeSessions[event.nodeId],
          {
            nodeId: event.nodeId,
            lastText: next.outputs[event.nodeId],
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
          lastText: event.output,
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
    ...(summary.error === undefined ? {} : { error: summary.error }),
    ...(summary.errorCode === undefined ? {} : { errorCode: summary.errorCode }),
  };
}

export function readRunResult(result: unknown): WorkflowRunResult {
  if (!result || typeof result !== "object") {
    return { outputs: {}, nodeStatuses: {}, nodeSessions: {} };
  }

  const raw = result as {
    outputs?: unknown;
    nodeStatuses?: unknown;
    nodeSessions?: unknown;
    error?: unknown;
    errorCode?: unknown;
  };

  return {
    outputs: isStringRecord(raw.outputs) ? raw.outputs : {},
    nodeStatuses: isWorkflowNodeStatusRecord(raw.nodeStatuses)
      ? raw.nodeStatuses
      : {},
    nodeSessions: readNodeSessionRecord(raw.nodeSessions),
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

  return {
    run: {
      ...detail.run,
      status: summary.status,
      finishedAt:
        event.type === "run_completed"
          ? new Date().toISOString()
          : detail.run.finishedAt,
      result: toWorkflowRunResult(summary),
    },
    log: nextLog.log,
    logSizeBytes: detail.logSizeBytes,
    logReturnedBytes: detail.logReturnedBytes,
    logTruncated: detail.logTruncated || nextLog.truncated,
  };
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
  return log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as unknown;
        return isWorkflowRunEvent(event) ? [event] : [];
      } catch {
        return [];
      }
    });
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

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((item) => typeof item === "string")
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
  const next = {
    ...(current ?? {
      nodeId: patch.nodeId,
      agentSessionId: "",
      agent: "",
      status: "running" as const,
    }),
    ...patch,
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
    type === "node_completed" ||
    type === "node_failed" ||
    type === "run_completed"
  );
}
