import {
  applyRunEventToDetail,
  parseRunLogEvents,
  readNodeStatusesFromRunLog,
  readRunResult,
  type RunDetail,
} from "@/lib/workflow/run-state";
import { renderPrompt } from "@/lib/workflow/templates";
import { stringifyWorkflowValue } from "@/lib/workflow/templates";
import type {
  ParsedWorkflow,
  WorkflowAgentLoopStep,
  WorkflowInputValue,
  WorkflowLoopStep,
  WorkflowLoopStepRun,
  WorkflowMapItemRun,
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
  loopStep?: {
    step: WorkflowLoopStep;
    attempts: RunLoopStepAttemptDetail[];
  };
  mapItem?: {
    step: WorkflowAgentLoopStep;
    items: RunMapItemAttemptDetail[];
  };
};

export type RunLoopStepAttemptDetail = WorkflowLoopStepRun & {
  log: string;
};

export type RunMapItemAttemptDetail = WorkflowMapItemRun & {
  log: string;
};

export function buildRunNodeDetail(
  detail: RunDetail,
  node: WorkflowNode,
  selectedLoopStepId?: string,
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
  const allEventResult = readRunResultFromEvents(parseRunLogEvents(detail.log));
  const loopStepRuns = {
    ...allEventResult.loopStepRuns,
    ...result.loopStepRuns,
  };
  const selectedLoopStep = node.loop?.steps.find(
    (step) => step.id === selectedLoopStepId,
  );
  const loopStepAttempts = selectedLoopStep
    ? Object.values(loopStepRuns)
        .filter(
          (run) =>
            run.parentNodeId === node.id && run.stepId === selectedLoopStep.id,
        )
        .sort((left, right) => left.iteration - right.iteration)
        .map((run) => ({
          ...run,
          log: parseRunLogEvents(detail.log)
            .filter((event) => isLoopStepRunEvent(event, run.executionKey))
            .map(formatRunNodeEvent)
            .join("\n") || "No step log events.",
        }))
    : [];

  const mapStep = node.map?.step;
  const mapItemRuns = {
    ...(allEventResult.mapItemRuns ?? {}),
    ...(result.mapItemRuns ?? {}),
  };
  const mapItemAttempts = mapStep
    ? Object.values(mapItemRuns)
        .filter((run) => run.parentNodeId === node.id)
        .sort((left, right) => left.index - right.index)
        .map((run) => ({
          ...run,
          log: parseRunLogEvents(detail.log)
            .filter((event) => isMapItemRunEvent(event, run.executionKey))
            .map(formatRunNodeEvent)
            .join("\n") || "No item log events.",
        }))
    : [];

  return {
    node,
    status:
      result.nodeStatuses[node.id] ??
      eventResult.nodeStatuses[node.id] ??
      "idle",
    session: result.nodeSessions[node.id] ?? eventResult.nodeSessions[node.id],
    input: input.trim() ? input : "No input captured.",
    output:
      result.outputs[node.id] !== undefined || eventOutput !== undefined
        ? stringifyWorkflowValue(result.outputs[node.id] ?? eventOutput)
        : "No output captured.",
    log: log.trim() ? log : "No node log events.",
    ...(selectedLoopStep
      ? {
          loopStep: {
            step: selectedLoopStep,
            attempts: loopStepAttempts,
          },
        }
      : {}),
    ...(mapStep
      ? {
          mapItem: {
            step: mapStep,
            items: mapItemAttempts,
          },
        }
      : {}),
  };
}

function isMapItemRunEvent(
  event: WorkflowRunEvent,
  executionKey: string,
): boolean {
  if (event.type === "map_item_state") {
    return event.mapItem.executionKey === executionKey;
  }
  return event.type === "node_event" &&
    event.mapItem?.executionKey === executionKey;
}

function isLoopStepRunEvent(
  event: WorkflowRunEvent,
  executionKey: string,
): boolean {
  if (event.type === "loop_step_state") {
    return event.loopStep.executionKey === executionKey;
  }
  return event.type === "node_event" &&
    event.loopStep?.executionKey === executionKey;
}

export function readRunParsed(log: string): ParsedWorkflow | undefined {
  const startedEvent = parseRunLogEvents(log).find(
    (event): event is Extract<WorkflowRunEvent, { type: "run_started" }> =>
      event.type === "run_started",
  );
  return startedEvent?.parsed;
}

function readWorkflowRunInputs(input: unknown): Record<string, WorkflowInputValue> {
  if (!input || typeof input !== "object") {
    return {};
  }

  const inputs = (input as { inputs?: unknown }).inputs;
  return isInputValueRecord(inputs) ? inputs : {};
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
      agent: null,
      model: null,
      cwd: null,
      input: {},
      result: {
        outputs: {},
        nodeStatuses: {},
        nodeSessions: {},
        loopStepRuns: {},
        mapItemRuns: {},
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
    return `started via ${event.agent}${event.model ? ` / ${event.model}` : ""}`;
  }
  if (event.type === "node_event") {
    return `event: ${formatCompactJson(event.event)}`;
  }
  if (event.type === "loop_step_state") {
    return `${event.loopStep.executionKey}: ${event.status}${event.promptMode ? ` via ${event.promptMode}` : ""}`;
  }
  if (event.type === "map_item_state") {
    return `${event.mapItem.executionKey}: ${event.status}`;
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

function isInputValueRecord(value: unknown): value is Record<string, WorkflowInputValue> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every(
      (item) =>
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean",
    )
  );
}
