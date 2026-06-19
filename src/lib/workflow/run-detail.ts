import type { WorkflowRunRecord } from "@/lib/db/workflows";
import { RUN_TEXT_PREVIEW_CHARS } from "@/lib/workflow/run-constants";
import { renderPrompt } from "@/lib/workflow/templates";
import type {
  ParsedWorkflow,
  WorkflowNode,
  WorkflowNodeStatus,
  WorkflowRunEvent,
} from "@/lib/workflow/types";

export { RUN_TEXT_PREVIEW_CHARS };

export type RunDetail = {
  run: WorkflowRunRecord;
  log: string;
  logSizeBytes?: number;
  logReturnedBytes?: number;
  logTruncated?: boolean;
};

export type RunNodeDetail = {
  node: WorkflowNode;
  status: WorkflowNodeStatus;
  input: string;
  output: string;
  log: string;
};

export function buildRunNodeDetail(
  detail: RunDetail,
  node: WorkflowNode,
): RunNodeDetail {
  const result = readRunResult(detail.run.result);
  const workflowInputs = readWorkflowRunInputs(detail.run.input);
  const input = renderPrompt(node, result.outputs, workflowInputs);
  const nodeEvents = parseRunLogEvents(detail.log).filter(
    (event) => "nodeId" in event && event.nodeId === node.id,
  );
  const log = nodeEvents
    .map(formatRunNodeEvent)
    .join("\n");
  const eventOutput = collectNodeOutputFromEvents(nodeEvents);

  return {
    node,
    status:
      result.nodeStatuses[node.id] ?? readNodeStatusFromEvents(nodeEvents) ?? "idle",
    input: input.trim() ? input : "No input captured.",
    output: result.outputs[node.id] ?? eventOutput ?? "No output captured.",
    log: log.trim() ? log : "No node log events.",
  };
}

export function applyRunEventToDetail(
  detail: RunDetail,
  event: WorkflowRunEvent,
): RunDetail {
  const currentResult = readRunResult(detail.run.result);
  const outputs = { ...currentResult.outputs };
  const nodeStatuses = { ...currentResult.nodeStatuses };
  let status = detail.run.status;
  let finishedAt = detail.run.finishedAt;
  let error = currentResult.error;

  if (event.type === "node_started") {
    nodeStatuses[event.nodeId] = "running";
  }

  if (event.type === "node_event") {
    const agentEvent = event.event as { type?: string; text?: string };
    if (agentEvent.type === "text_delta" && agentEvent.text) {
      outputs[event.nodeId] = `${outputs[event.nodeId] ?? ""}${agentEvent.text}`;
    }
  }

  if (event.type === "node_completed") {
    nodeStatuses[event.nodeId] = "completed";
    outputs[event.nodeId] = event.output;
  }

  if (event.type === "node_failed") {
    status = "failed";
    nodeStatuses[event.nodeId] = "failed";
    error = event.error;
  }

  if (event.type === "run_completed") {
    status = event.status;
    finishedAt = new Date().toISOString();
    error = event.error;
    for (const [nodeId, output] of Object.entries(event.outputs)) {
      outputs[nodeId] = output;
    }
  }

  const nextLog = appendRunLog(detail.log, event);

  return {
    run: {
      ...detail.run,
      status,
      finishedAt,
      result: {
        outputs,
        nodeStatuses,
        error,
      },
    },
    log: nextLog.log,
    logSizeBytes: detail.logSizeBytes,
    logReturnedBytes: detail.logReturnedBytes,
    logTruncated: detail.logTruncated || nextLog.truncated,
  };
}

export function readRunResult(result: unknown): {
  outputs: Record<string, string>;
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  error?: string;
} {
  if (!result || typeof result !== "object") {
    return { outputs: {}, nodeStatuses: {} };
  }

  const raw = result as {
    outputs?: unknown;
    nodeStatuses?: unknown;
    error?: unknown;
  };

  return {
    outputs: isStringRecord(raw.outputs) ? raw.outputs : {},
    nodeStatuses: isWorkflowNodeStatusRecord(raw.nodeStatuses)
      ? raw.nodeStatuses
      : {},
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

export function readRunParsed(log: string): ParsedWorkflow | undefined {
  const startedEvent = parseRunLogEvents(log).find(
    (event): event is Extract<WorkflowRunEvent, { type: "run_started" }> =>
      event.type === "run_started",
  );
  return startedEvent?.parsed;
}

export function readNodeStatusesFromRunLog(
  log: string,
): Record<string, WorkflowNodeStatus> {
  const statuses: Record<string, WorkflowNodeStatus> = {};
  for (const event of parseRunLogEvents(log)) {
    if ("nodeId" in event) {
      const status = readNodeStatusFromEvents([event]);
      if (status) {
        statuses[event.nodeId] = status;
      }
    }
  }
  return statuses;
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

function readWorkflowRunInputs(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") {
    return {};
  }

  const inputs = (input as { inputs?: unknown }).inputs;
  return isStringRecord(inputs) ? inputs : {};
}

function parseRunLogEvents(log: string): WorkflowRunEvent[] {
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

function readNodeStatusFromEvents(
  events: WorkflowRunEvent[],
): WorkflowNodeStatus | undefined {
  let status: WorkflowNodeStatus | undefined;
  for (const event of events) {
    if (event.type === "node_started") {
      status = "running";
    }
    if (event.type === "node_event" && !status) {
      status = "running";
    }
    if (event.type === "node_completed") {
      status = "completed";
    }
    if (event.type === "node_failed") {
      status = "failed";
    }
  }
  return status;
}

function collectNodeOutputFromEvents(
  events: WorkflowRunEvent[],
): string | undefined {
  let output = "";
  for (const event of events) {
    if (event.type === "node_event") {
      const agentEvent = event.event as { type?: string; text?: string };
      if (agentEvent.type === "text_delta" && agentEvent.text) {
        output += agentEvent.text;
      }
    }
    if (event.type === "node_completed") {
      output = event.output;
    }
  }
  return output.trim() ? output : undefined;
}

function formatRunNodeEvent(event: WorkflowRunEvent): string {
  if (event.type === "node_started") {
    return `started via ${event.provider}${event.model ? ` / ${event.model}` : ""}`;
  }
  if (event.type === "node_event") {
    return `event: ${formatCompactJson(event.event)}`;
  }
  if (event.type === "node_completed") {
    return "completed";
  }
  if (event.type === "node_failed") {
    return `failed: ${event.error}`;
  }
  return formatCompactJson(event);
}

function formatCompactJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
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
