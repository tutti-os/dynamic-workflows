import {
  applyRunEventToDetail,
  parseRunLogEvents,
  readNodeStatusesFromRunLog,
  readRunResult,
  type RunDetail,
} from "@/lib/workflow/run-state";
import { renderPrompt } from "@/lib/workflow/templates";
import type {
  ParsedWorkflow,
  WorkflowNode,
  WorkflowNodeSessionRef,
  WorkflowNodeStatus,
  WorkflowRunEvent,
} from "@/lib/workflow/types";

export {
  applyRunEventToDetail,
  limitRunText,
  readNodeStatusesFromRunLog,
  readRunResult,
  RUN_TEXT_PREVIEW_CHARS,
  serializeRunEvent,
  type RunDetail,
} from "@/lib/workflow/run-state";

export type RunNodeDetail = {
  node: WorkflowNode;
  status: WorkflowNodeStatus;
  session?: WorkflowNodeSessionRef;
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
  const eventResult = readRunResultFromEvents(nodeEvents);
  const eventOutput = eventResult.outputs[node.id];

  return {
    node,
    status:
      result.nodeStatuses[node.id] ??
      eventResult.nodeStatuses[node.id] ??
      "idle",
    session: result.nodeSessions[node.id] ?? eventResult.nodeSessions[node.id],
    input: input.trim() ? input : "No input captured.",
    output: result.outputs[node.id] ?? eventOutput ?? "No output captured.",
    log: log.trim() ? log : "No node log events.",
  };
}

export function readRunParsed(log: string): ParsedWorkflow | undefined {
  const startedEvent = parseRunLogEvents(log).find(
    (event): event is Extract<WorkflowRunEvent, { type: "run_started" }> =>
      event.type === "run_started",
  );
  return startedEvent?.parsed;
}

function readWorkflowRunInputs(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") {
    return {};
  }

  const inputs = (input as { inputs?: unknown }).inputs;
  return isStringRecord(inputs) ? inputs : {};
}

function readRunResultFromEvents(events: WorkflowRunEvent[]) {
  const detail: RunDetail = {
    run: {
      id: "preview",
      workflowId: "preview",
      workflowVersionId: "preview",
      executorKind: "local-agent",
      externalRunId: null,
      status: "running",
      provider: null,
      model: null,
      cwd: null,
      input: {},
      result: {
        outputs: {},
        nodeStatuses: {},
        nodeSessions: {},
      },
      logPath: null,
      startedAt: new Date(0).toISOString(),
      finishedAt: null,
    },
    log: "",
  };
  let current = detail;
  for (const event of events) {
    current = applyRunEventToDetail(current, event);
  }
  return readRunResult(current.run.result);
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

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((item) => typeof item === "string")
  );
}
