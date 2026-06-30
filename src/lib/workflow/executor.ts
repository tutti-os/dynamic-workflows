import { randomUUID } from "node:crypto";
import { runAgent } from "@/lib/agents/runtime";
import { resolveWorkflowCwd } from "./cwd";
import { createWorkflowExecutionPlan } from "./execution-plan";
import { assertWorkflowScriptValid } from "./parser";
import { renderPrompt, renderTemplate } from "./templates";
import type {
  ParsedWorkflow,
  WorkflowLoopStep,
  WorkflowNode,
  WorkflowRunEvent,
  WorkflowRunRequest,
} from "./types";

export async function* runWorkflow(
  request: WorkflowRunRequest,
): AsyncGenerator<WorkflowRunEvent> {
  const runId = request.runId ?? randomUUID();
  const parsed = assertWorkflowScriptValid(request.script);
  const normalizedRequest = {
    ...request,
    cwd: resolveWorkflowCwd(request.cwd),
  };
  const { executableNodes } = createWorkflowExecutionPlan(parsed);
  const previousSessionNodeIds = createPreviousSessionNodeIds(executableNodes);
  const nodeSessionKeyByNodeId = new Map(
    executableNodes.flatMap((node) =>
      node.kind === "agent" && node.session
        ? [[node.id, node.session] as const]
        : [],
    ),
  );
  const outputs: Record<string, string> = {};
  const sessionIdsByKey: Record<string, string> = {};
  const failed = new Set<string>();
  const completed = new Set<string>();
  const running = new Set<string>();
  let canceled = false;

  yield { type: "run_started", runId, parsed };

  while (completed.size + failed.size < executableNodes.length) {
    if (isSignalAborted(normalizedRequest.signal)) {
      canceled = true;
      break;
    }

    const ready = executableNodes.filter((node) => {
      if (completed.has(node.id) || failed.has(node.id) || running.has(node.id)) {
        return false;
      }
      return node.inputs.every((input) =>
        input.sourceNodeId ? completed.has(input.sourceNodeId) : true,
      ) && isSessionPredecessorCompleted(node, previousSessionNodeIds, completed);
    });

    if (ready.length === 0) {
      for (const node of executableNodes) {
        if (!completed.has(node.id) && !failed.has(node.id)) {
          failed.add(node.id);
          yield {
            type: "node_failed",
            runId,
            nodeId: node.id,
            error: "Node dependencies could not be resolved.",
          };
        }
      }
      break;
    }

    const batch = ready.slice(0, 4);
    for (const node of batch) {
      running.add(node.id);
    }

    for await (const event of streamNodeBatch({
      runId,
      nodes: batch,
      request: normalizedRequest,
      outputs,
      sessionIdsByKey,
    })) {
      yield event;

      if (event.type === "node_event") {
        const sessionKey = nodeSessionKeyByNodeId.get(event.nodeId);
        const agentSessionId = readAgentSessionId(event.event);
        if (sessionKey && agentSessionId) {
          const previousSessionId = sessionIdsByKey[sessionKey];
          sessionIdsByKey[sessionKey] = agentSessionId;
          yield createWorkflowSessionStatusEvent({
            runId,
            nodeId: event.nodeId,
            sessionKey,
            agentSessionId,
            previousSessionId,
          });
        }
      }

      if (event.type === "node_completed") {
        running.delete(event.nodeId);
        completed.add(event.nodeId);
        outputs[event.nodeId] = event.output;
      }

      if (event.type === "node_failed") {
        running.delete(event.nodeId);
        failed.add(event.nodeId);
      }

      if (isSignalAborted(normalizedRequest.signal)) {
        canceled = true;
      }
    }
  }

  const status = canceled
    ? "canceled"
    : failed.size > 0
      ? "failed"
      : "completed";

  yield {
    type: "run_completed",
    runId,
    status,
    outputs,
    ...(status === "canceled" ? { error: "Run canceled." } : {}),
  };
}

async function* streamNodeBatch(input: {
  runId: string;
  nodes: WorkflowNode[];
  request: WorkflowRunRequest;
  outputs: Record<string, string>;
  sessionIdsByKey: Record<string, string>;
}): AsyncGenerator<WorkflowRunEvent> {
  type QueueItem =
    | {
        event: WorkflowRunEvent;
      }
    | {
        error: unknown;
      };

  const queue: QueueItem[] = [];
  let pending = input.nodes.length;
  let notify: (() => void) | undefined;

  const wake = () => {
    notify?.();
    notify = undefined;
  };
  const wait = () =>
    new Promise<void>((resolve) => {
      notify = resolve;
    });
  const push = (item: QueueItem) => {
    queue.push(item);
    wake();
  };

  for (const node of input.nodes) {
    void (async () => {
      try {
        for await (const event of runNode({
          runId: input.runId,
          node,
          request: input.request,
          outputs: input.outputs,
          sessionIdsByKey: input.sessionIdsByKey,
        })) {
          push({ event });
        }
      } catch (error) {
        push({ error });
      } finally {
        pending -= 1;
        wake();
      }
    })();
  }

  while (pending > 0 || queue.length > 0) {
    if (queue.length === 0) {
      await wait();
      continue;
    }

    const item = queue.shift();
    if (!item) {
      continue;
    }
    if ("error" in item) {
      throw item.error;
    }
    yield item.event;
  }
}

async function* runNode(input: {
  runId: string;
  node: WorkflowNode;
  request: WorkflowRunRequest;
  outputs: Record<string, string>;
  sessionIdsByKey: Record<string, string>;
}): AsyncGenerator<WorkflowRunEvent> {
  if (input.node.kind === "loop") {
    yield* runLoopNode(input);
    return;
  }
  yield* runAgentNode(input);
}

async function* runAgentNode(input: {
  runId: string;
  node: WorkflowNode;
  request: WorkflowRunRequest;
  outputs: Record<string, string>;
  sessionIdsByKey: Record<string, string>;
}): AsyncGenerator<WorkflowRunEvent> {
  const prompt = renderPrompt(input.node, input.outputs, input.request.inputs);
  const nodeRunId = `${input.runId}:${input.node.id}`;
  const provider = input.node.provider ?? input.request.provider ?? "mock";
  const model = input.node.model ?? input.request.model;
  const cwd = input.request.cwd ?? process.cwd();
  const resumeSessionId = input.node.session
    ? input.sessionIdsByKey[input.node.session]
    : undefined;
  let output = "";

  yield {
    type: "node_started",
    runId: input.runId,
    nodeId: input.node.id,
    node: input.node,
    provider,
    model,
  };

  try {
    throwIfAborted(input.request.signal);

    if (input.node.session) {
      yield {
        type: "node_event",
        runId: input.runId,
        nodeId: input.node.id,
        event: {
          type: "status",
          status: "running",
          stage: "running",
          message: resumeSessionId
            ? `Workflow session "${input.node.session}" is reusing agent session ${resumeSessionId}.`
            : `Workflow session "${input.node.session}" is starting a new agent session.`,
        },
      };
    }

    for await (const event of runAgent({
      runId: nodeRunId,
      provider,
      cwd,
      prompt,
      model,
      resumeSessionId,
      signal: input.request.signal,
    })) {
      throwIfAborted(input.request.signal);

      if (event.type === "text_delta") {
        output += event.text;
      }
      if (event.type === "error") {
        throw new Error(event.message);
      }
      if (event.type === "done" && event.status === "canceled") {
        throw new WorkflowRunCanceledError();
      }
      if (event.type === "done" && event.status === "failed") {
        throw new Error(event.reason ?? "Agent run failed");
      }
      yield {
        type: "node_event",
        runId: input.runId,
        nodeId: input.node.id,
        event,
      };
    }

    throwIfAborted(input.request.signal);

    yield {
      type: "node_completed",
      runId: input.runId,
      nodeId: input.node.id,
      output,
    };
  } catch (error) {
    yield {
      type: "node_failed",
      runId: input.runId,
      nodeId: input.node.id,
      error: toRunErrorMessage(error),
    };
  }
}

async function* runLoopNode(input: {
  runId: string;
  node: WorkflowNode;
  request: WorkflowRunRequest;
  outputs: Record<string, string>;
  sessionIdsByKey: Record<string, string>;
}): AsyncGenerator<WorkflowRunEvent> {
  const loop = input.node.loop;
  const provider = input.node.provider ?? input.request.provider ?? "mock";
  const model = input.node.model ?? input.request.model;
  const cwd = input.request.cwd ?? process.cwd();

  yield {
    type: "node_started",
    runId: input.runId,
    nodeId: input.node.id,
    node: input.node,
    provider,
    model,
  };

  if (!loop) {
    yield {
      type: "node_failed",
      runId: input.runId,
      nodeId: input.node.id,
      error: "Loop node is missing loop configuration.",
    };
    return;
  }

  const previousStepOutputs: Record<string, string> = {};
  const iterations: Array<{
    index: number;
    outputs: Record<string, string>;
    untilOutput: string;
    untilMatched: boolean;
  }> = [];
  let stopReason: "until_matched" | "max_iterations_reached" =
    "max_iterations_reached";

  try {
    throwIfAborted(input.request.signal);

    yield loopStatusEvent({
      runId: input.runId,
      nodeId: input.node.id,
      message: `Loop "${input.node.id}" started with maxIterations=${loop.maxIterations}.`,
    });

    for (let iteration = 1; iteration <= loop.maxIterations; iteration += 1) {
      throwIfAborted(input.request.signal);

      const currentStepOutputs: Record<string, string> = {};
      yield loopStatusEvent({
        runId: input.runId,
        nodeId: input.node.id,
        message: `Loop "${input.node.id}" iteration ${iteration} started.`,
      });

      for (const step of loop.steps) {
        throwIfAborted(input.request.signal);

        const syntheticId = createLoopStepId(input.node.id, iteration, step.id);
        const prompt = renderLoopStepPrompt({
          step,
          loopNode: input.node,
          workflowOutputs: input.outputs,
          workflowInputs: input.request.inputs,
          previousStepOutputs,
          currentStepOutputs,
        });
        const stepOutput = yield* runLoopAgentStep({
          runId: input.runId,
          nodeId: input.node.id,
          syntheticId,
          step,
          prompt,
          defaultProvider: provider,
          defaultModel: model,
          defaultSession: loop.session,
          cwd,
          signal: input.request.signal,
          sessionIdsByKey: input.sessionIdsByKey,
        });
        currentStepOutputs[step.id] = stepOutput;
        previousStepOutputs[step.id] = stepOutput;
      }

      const untilOutput =
        currentStepOutputs[loop.until.source] ??
        previousStepOutputs[loop.until.source] ??
        "";
      const untilMatched = untilOutput.includes(loop.until.includes);
      iterations.push({
        index: iteration,
        outputs: { ...currentStepOutputs },
        untilOutput,
        untilMatched,
      });

      yield loopStatusEvent({
        runId: input.runId,
        nodeId: input.node.id,
        message: `Loop "${input.node.id}" iteration ${iteration} until check: ${untilMatched ? "matched" : "not matched"} (${loop.until.source} includes ${JSON.stringify(loop.until.includes)}).`,
      });

      if (untilMatched) {
        stopReason = "until_matched";
        break;
      }
    }

    const output = formatLoopOutput({
      node: input.node,
      stopReason,
      iterations,
      latestStepOutputs: previousStepOutputs,
    });

    yield {
      type: "node_completed",
      runId: input.runId,
      nodeId: input.node.id,
      output,
    };
  } catch (error) {
    yield {
      type: "node_failed",
      runId: input.runId,
      nodeId: input.node.id,
      error: toRunErrorMessage(error),
    };
  }
}

async function* runLoopAgentStep(input: {
  runId: string;
  nodeId: string;
  syntheticId: string;
  step: WorkflowLoopStep;
  prompt: string;
  defaultProvider: string;
  defaultModel?: string;
  defaultSession?: string;
  cwd: string;
  signal?: AbortSignal;
  sessionIdsByKey: Record<string, string>;
}): AsyncGenerator<WorkflowRunEvent, string> {
  const provider = input.step.provider ?? input.defaultProvider;
  const model = input.step.model ?? input.defaultModel;
  const sessionKey = input.step.session ?? input.defaultSession;
  const resumeSessionId = sessionKey ? input.sessionIdsByKey[sessionKey] : undefined;
  let output = "";

  yield loopStatusEvent({
    runId: input.runId,
    nodeId: input.nodeId,
    message: `Loop step ${input.syntheticId} started.`,
  });

  if (sessionKey) {
    yield loopStatusEvent({
      runId: input.runId,
      nodeId: input.nodeId,
      message: resumeSessionId
        ? `Workflow session "${sessionKey}" is reusing agent session ${resumeSessionId} for ${input.syntheticId}.`
        : `Workflow session "${sessionKey}" is starting a new agent session for ${input.syntheticId}.`,
    });
  }

  for await (const event of runAgent({
    runId: `${input.runId}:${input.syntheticId}`,
    provider,
    cwd: input.cwd,
    prompt: input.prompt,
    model,
    resumeSessionId,
    signal: input.signal,
  })) {
    throwIfAborted(input.signal);

    if (event.type === "text_delta") {
      output += event.text;
    }
    if (event.type === "error") {
      throw new Error(event.message);
    }
    if (event.type === "done" && event.status === "canceled") {
      throw new WorkflowRunCanceledError();
    }
    if (event.type === "done" && event.status === "failed") {
      throw new Error(event.reason ?? "Agent run failed");
    }
    yield {
      type: "node_event",
      runId: input.runId,
      nodeId: input.nodeId,
      event,
    };

    const agentSessionId = readAgentSessionId(event);
    if (sessionKey && agentSessionId) {
      const previousSessionId = input.sessionIdsByKey[sessionKey];
      input.sessionIdsByKey[sessionKey] = agentSessionId;
      yield createWorkflowSessionStatusEvent({
        runId: input.runId,
        nodeId: input.nodeId,
        sessionKey,
        agentSessionId,
        previousSessionId,
        context: input.syntheticId,
      });
    }
  }

  yield loopStatusEvent({
    runId: input.runId,
    nodeId: input.nodeId,
    message: `Loop step ${input.syntheticId} completed.`,
  });

  return output;
}

class WorkflowRunCanceledError extends Error {
  constructor() {
    super("Run canceled.");
    this.name = "WorkflowRunCanceledError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (isSignalAborted(signal)) {
    throw new WorkflowRunCanceledError();
  }
}

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function createPreviousSessionNodeIds(
  nodes: WorkflowNode[],
): Record<string, string> {
  const latestNodeIdBySession = new Map<string, string>();
  const previousNodeIds: Record<string, string> = {};

  for (const node of nodes) {
    if (!node.session) {
      continue;
    }
    const previousNodeId = latestNodeIdBySession.get(node.session);
    if (previousNodeId) {
      previousNodeIds[node.id] = previousNodeId;
    }
    latestNodeIdBySession.set(node.session, node.id);
  }

  return previousNodeIds;
}

function isSessionPredecessorCompleted(
  node: WorkflowNode,
  previousSessionNodeIds: Record<string, string>,
  completed: Set<string>,
): boolean {
  const previousNodeId = previousSessionNodeIds[node.id];
  return !previousNodeId || completed.has(previousNodeId);
}

function readAgentSessionId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const raw = event as { type?: unknown; session?: unknown };
  if (raw.type !== "session_ref" || !raw.session || typeof raw.session !== "object") {
    return undefined;
  }
  const agentSessionId = (raw.session as { agentSessionId?: unknown }).agentSessionId;
  return typeof agentSessionId === "string" && agentSessionId.trim()
    ? agentSessionId.trim()
    : undefined;
}

function loopStatusEvent(input: {
  runId: string;
  nodeId: string;
  message: string;
  status?: "running" | "warning";
}): WorkflowRunEvent {
  return {
    type: "node_event",
    runId: input.runId,
    nodeId: input.nodeId,
    event: {
      type: "status",
      status: input.status ?? "running",
      stage: input.status ?? "running",
      message: input.message,
    },
  };
}

function createLoopStepId(
  loopId: string,
  iteration: number,
  stepId: string,
): string {
  return `${loopId}[${iteration}].${stepId}`;
}

function renderLoopStepPrompt(input: {
  step: WorkflowLoopStep;
  loopNode: WorkflowNode;
  workflowOutputs: Record<string, string>;
  workflowInputs: Record<string, string> | undefined;
  previousStepOutputs: Record<string, string>;
  currentStepOutputs: Record<string, string>;
}): string {
  const bindings = new Map(
    input.loopNode.inputs.map((binding) => [binding.name, binding.sourceNodeId]),
  );

  return renderTemplate(input.step.prompt, (name) => {
    if (input.currentStepOutputs[name] !== undefined) {
      return input.currentStepOutputs[name];
    }
    if (input.previousStepOutputs[name] !== undefined) {
      return input.previousStepOutputs[name];
    }

    const sourceNodeId = bindings.get(name);
    if (sourceNodeId) {
      return input.workflowOutputs[sourceNodeId] ?? "";
    }
    return input.workflowInputs?.[name] ?? "";
  });
}

function formatLoopOutput(input: {
  node: WorkflowNode;
  stopReason: "until_matched" | "max_iterations_reached";
  iterations: Array<{
    index: number;
    outputs: Record<string, string>;
    untilOutput: string;
    untilMatched: boolean;
  }>;
  latestStepOutputs: Record<string, string>;
}): string {
  const loop = input.node.loop;
  const lines = [
    `Loop ${input.node.id} completed.`,
    `Stop reason: ${input.stopReason}`,
    `Iterations: ${input.iterations.length}`,
  ];

  if (loop) {
    lines.push(
      `Until: ${loop.until.source} includes ${JSON.stringify(loop.until.includes)}`,
    );
  }

  lines.push("", "Final step outputs:");
  for (const [stepId, output] of Object.entries(input.latestStepOutputs)) {
    lines.push("", `[${stepId}]`, output.trim());
  }

  lines.push("", "Iteration summary:");
  for (const iteration of input.iterations) {
    const untilPreview = previewText(iteration.untilOutput);
    lines.push(
      `- Iteration ${iteration.index}: ${iteration.untilMatched ? "matched" : "not matched"}; until output: ${untilPreview}`,
    );
  }

  return lines.join("\n").trim();
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function createWorkflowSessionStatusEvent(input: {
  runId: string;
  nodeId: string;
  sessionKey: string;
  agentSessionId: string;
  previousSessionId?: string;
  context?: string;
}): WorkflowRunEvent {
  const suffix = input.context ? ` for ${input.context}` : "";
  const message = !input.previousSessionId
    ? `Workflow session "${input.sessionKey}" captured agent session ${input.agentSessionId}${suffix}.`
    : input.previousSessionId === input.agentSessionId
      ? `Workflow session "${input.sessionKey}" confirmed agent session ${input.agentSessionId}${suffix}.`
      : `Workflow session "${input.sessionKey}" switched from agent session ${input.previousSessionId} to ${input.agentSessionId}${suffix}.`;

  return {
    type: "node_event",
    runId: input.runId,
    nodeId: input.nodeId,
    event: {
      type: "status",
      status:
        input.previousSessionId && input.previousSessionId !== input.agentSessionId
          ? "warning"
          : "running",
      stage:
        input.previousSessionId && input.previousSessionId !== input.agentSessionId
          ? "warning"
          : "running",
      message,
    },
  };
}

function isCancellationError(error: unknown): boolean {
  return (
    error instanceof WorkflowRunCanceledError ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.message.toLowerCase().includes("abort") ||
        error.message.toLowerCase().includes("cancel")))
  );
}

function toRunErrorMessage(error: unknown): string {
  if (isCancellationError(error)) {
    return "Run canceled.";
  }
  return error instanceof Error ? error.message : "Unknown agent error";
}

export function summarizeWorkflow(parsed: ParsedWorkflow): string {
  return [
    `${parsed.meta.name}: ${parsed.meta.description}`,
    ...parsed.nodes.map(
      (node) =>
        `- ${node.id} (${node.kind}) in ${node.phase ?? "Workflow"}: ${node.label}`,
    ),
  ].join("\n");
}
