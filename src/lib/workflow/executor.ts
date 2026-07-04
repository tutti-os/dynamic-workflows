import { randomUUID } from "node:crypto";
import { runAgent } from "@/lib/agents/runtime";
import { resolveWorkflowCwd, resolveWorkflowCwdFrom } from "./cwd";
import { createWorkflowExecutionPlan } from "./execution-plan";
import { resolveLoopStepRunContext } from "./loop-runtime";
import { assertWorkflowScriptValid } from "./parser";
import {
  createLoopStepSessionNodeId,
  resolveSessionKey,
} from "./session";
import { renderPrompt, renderTemplate } from "./templates";
import type {
  ParsedWorkflow,
  WorkflowLoopRecoveryState,
  WorkflowLoopStep,
  WorkflowNode,
  WorkflowRunRecoveryState,
  WorkflowRunEvent,
  WorkflowRunRequest,
  WorkflowSessionSpec,
} from "./types";

export async function* runWorkflow(
  request: WorkflowRunRequest,
): AsyncGenerator<WorkflowRunEvent> {
  const runId = request.runId ?? randomUUID();
  const parsed = assertWorkflowScriptValid(request.script);
  assertRequiredWorkflowCwd(parsed, request.cwd);
  const normalizedRequest = {
    ...request,
    cwd: resolveWorkflowCwd(request.cwd),
  };
  const { executableNodes } = createWorkflowExecutionPlan(parsed);
  const previousSessionNodeIds = createPreviousSessionNodeIds(executableNodes);
  const nodeSessionKeyByNodeId = new Map(
    executableNodes.flatMap((node) => {
      const sessionKey =
        node.kind === "agent" ? resolveSessionKey(node.session) : undefined;
      return sessionKey ? [[node.id, sessionKey] as const] : [];
    }),
  );
  const recovery = normalizeRecoveryState(request.recovery);
  const outputs: Record<string, string> = { ...recovery.outputs };
  const sessionIdsByKey: Record<string, string> = {
    ...recovery.sessionIdsByKey,
  };
  const sessionCwdsByKey: Record<string, string> = {
    ...recovery.sessionCwdsByKey,
  };
  const failed = new Set<string>();
  const completed = new Set<string>(
    recovery.completedNodeIds.filter((nodeId) =>
      executableNodes.some((node) => node.id === nodeId),
    ),
  );
  const running = new Set<string>();
  let canceled = false;
  let failureError: string | undefined;

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
          failureError ??= "Node dependencies could not be resolved.";
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
      sessionCwdsByKey,
      attachSessionIdsByNodeId: recovery.attachSessionIdsByNodeId,
      loopStatesByNodeId: recovery.loopStates,
    })) {
      yield event;

      if (event.type === "node_event") {
        const sessionKey = nodeSessionKeyByNodeId.get(event.nodeId);
        const agentSessionId = readAgentSessionId(event.event);
        if (sessionKey && agentSessionId) {
          const previousSessionId = sessionIdsByKey[sessionKey];
          sessionIdsByKey[sessionKey] = agentSessionId;
          if (previousSessionId !== agentSessionId) {
            yield createWorkflowSessionStatusEvent({
              runId,
              nodeId: event.nodeId,
              sessionKey,
              agentSessionId,
              previousSessionId,
            });
          }
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
        failureError ??= event.error;
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
    ...(status === "failed" && failureError ? { error: failureError } : {}),
  };
}

async function* streamNodeBatch(input: {
  runId: string;
  nodes: WorkflowNode[];
  request: WorkflowRunRequest;
  outputs: Record<string, string>;
  sessionIdsByKey: Record<string, string>;
  sessionCwdsByKey: Record<string, string>;
  attachSessionIdsByNodeId: Record<string, string>;
  loopStatesByNodeId: Record<string, WorkflowLoopRecoveryState>;
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
          sessionCwdsByKey: input.sessionCwdsByKey,
          attachSessionIdsByNodeId: input.attachSessionIdsByNodeId,
          loopStatesByNodeId: input.loopStatesByNodeId,
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
  sessionCwdsByKey: Record<string, string>;
  attachSessionIdsByNodeId: Record<string, string>;
  loopStatesByNodeId: Record<string, WorkflowLoopRecoveryState>;
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
  sessionCwdsByKey: Record<string, string>;
  attachSessionIdsByNodeId: Record<string, string>;
  loopStatesByNodeId: Record<string, WorkflowLoopRecoveryState>;
}): AsyncGenerator<WorkflowRunEvent> {
  const nodeRunId = `${input.runId}:${input.node.id}`;
  const provider = input.node.provider ?? input.request.provider ?? "mock";
  const model = input.node.model ?? input.request.model;
  const cwd = resolveEffectiveNodeCwd(input.request.cwd, input.node.cwd);
  const prompt = renderPrompt(input.node, input.outputs, input.request.inputs, {
    cwd,
  });
  const sessionKey = resolveSessionKey(input.node.session);
  const resumeSessionId = sessionKey
    ? input.sessionIdsByKey[sessionKey]
    : undefined;
  const attachSessionId = input.attachSessionIdsByNodeId[input.node.id];
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

    if (sessionKey) {
      assertSessionCwd({
        sessionKey,
        cwd,
        sessionCwdsByKey: input.sessionCwdsByKey,
      });
      yield {
        type: "node_event",
        runId: input.runId,
        nodeId: input.node.id,
        event: {
          type: "status",
          status: "running",
          stage: "running",
          message: attachSessionId
            ? `Workflow session "${sessionKey}" is attaching to agent session ${attachSessionId}.`
            : resumeSessionId
            ? `Workflow session "${sessionKey}" is reusing agent session ${resumeSessionId}.`
            : `Workflow session "${sessionKey}" is starting a new agent session.`,
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
      attachSessionId,
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
  sessionCwdsByKey: Record<string, string>;
  attachSessionIdsByNodeId: Record<string, string>;
  loopStatesByNodeId: Record<string, WorkflowLoopRecoveryState>;
}): AsyncGenerator<WorkflowRunEvent> {
  const loop = input.node.loop;
  const provider = input.node.provider ?? input.request.provider ?? "mock";
  const model = input.node.model ?? input.request.model;
  const loopCwd = resolveEffectiveNodeCwd(input.request.cwd, input.node.cwd);

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

  const recoveredLoop = input.loopStatesByNodeId[input.node.id];
  const previousStepOutputs: Record<string, string> = {
    ...(recoveredLoop?.previousStepOutputs ?? {}),
  };
  const iterations = [...(recoveredLoop?.iterations ?? [])];
  let stopReason: "until_matched" | "max_iterations_reached" =
    "max_iterations_reached";

  try {
    throwIfAborted(input.request.signal);

    yield loopStatusEvent({
      runId: input.runId,
      nodeId: input.node.id,
      message: `Loop "${input.node.id}" started with maxIterations=${loop.maxIterations}.`,
    });

    const recoveredStopReason = readRecoveredLoopStopReason(recoveredLoop, loop);
    if (recoveredStopReason) {
      stopReason = recoveredStopReason;
      const output = formatLoopOutput({
        node: input.node,
        stopReason,
        iterations,
        latestStepOutputs: previousStepOutputs,
      });
      if (shouldFailRecoveredLoop(loop, stopReason)) {
        yield {
          type: "node_failed",
          runId: input.runId,
          nodeId: input.node.id,
          error: output,
        };
        return;
      }
      yield {
        type: "node_completed",
        runId: input.runId,
        nodeId: input.node.id,
        output,
      };
      return;
    }

    for (
      let iteration = recoveredLoop?.nextIteration ?? 1;
      iteration <= loop.maxIterations;
      iteration += 1
    ) {
      throwIfAborted(input.request.signal);

      const currentStepOutputs: Record<string, string> =
        recoveredLoop?.currentIteration === iteration
          ? { ...(recoveredLoop.currentStepOutputs ?? {}) }
          : {};
      yield loopStatusEvent({
        runId: input.runId,
        nodeId: input.node.id,
        message: `Loop "${input.node.id}" iteration ${iteration} started.`,
      });

      for (const step of loop.steps) {
        throwIfAborted(input.request.signal);
        if (currentStepOutputs[step.id] !== undefined) {
          yield loopStatusEvent({
            runId: input.runId,
            nodeId: input.node.id,
            message: `Loop step ${createLoopStepId(input.node.id, iteration, step.id)} restored from checkpoint.`,
          });
          continue;
        }

        const syntheticId = createLoopStepId(input.node.id, iteration, step.id);
        const stepCwd = resolveEffectiveNodeCwd(loopCwd, step.cwd);
        const prompt = renderLoopStepPrompt({
          template: step.prompt,
          step,
          iteration,
          loopNode: input.node,
          workflowOutputs: input.outputs,
          workflowInputs: input.request.inputs,
          workflowCwd: stepCwd,
          previousStepOutputs,
          currentStepOutputs,
        });
        const appendPrompt = step.appendPrompt
          ? renderLoopStepPrompt({
              template: step.appendPrompt,
              step,
              iteration,
              loopNode: input.node,
              workflowOutputs: input.outputs,
              workflowInputs: input.request.inputs,
              workflowCwd: stepCwd,
              previousStepOutputs,
              currentStepOutputs,
            })
          : undefined;
        const stepOutput = yield* runLoopAgentStep({
          runId: input.runId,
          nodeId: input.node.id,
          syntheticId,
          step,
          prompt,
          appendPrompt,
          defaultProvider: provider,
          defaultModel: model,
          defaultSession: loop.session,
          cwd: stepCwd,
          signal: input.request.signal,
          sessionIdsByKey: input.sessionIdsByKey,
          sessionCwdsByKey: input.sessionCwdsByKey,
          attachSessionIdsByNodeId: input.attachSessionIdsByNodeId,
        });
        currentStepOutputs[step.id] = stepOutput;
        previousStepOutputs[step.id] = stepOutput;
        await saveLoopCheckpoint(input.request, {
          runId: input.runId,
          nodeId: input.node.id,
          state: {
            nextIteration: iteration,
            currentIteration: iteration,
            currentStepOutputs: { ...currentStepOutputs },
            previousStepOutputs: { ...previousStepOutputs },
            iterations: [...iterations],
          },
        });
        yield loopStatusEvent({
          runId: input.runId,
          nodeId: input.node.id,
          message: `Loop step ${syntheticId} checkpoint saved.`,
        });
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
      await saveLoopCheckpoint(input.request, {
        runId: input.runId,
        nodeId: input.node.id,
        state: {
          nextIteration: iteration + 1,
          previousStepOutputs: { ...previousStepOutputs },
          iterations: [...iterations],
        },
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

    if (
      shouldFailRecoveredLoop(loop, stopReason)
    ) {
      yield {
        type: "node_failed",
        runId: input.runId,
        nodeId: input.node.id,
        error: output,
      };
      return;
    }

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
  appendPrompt?: string;
  defaultProvider: string;
  defaultModel?: string;
  defaultSession?: WorkflowSessionSpec;
  cwd: string;
  signal?: AbortSignal;
  sessionIdsByKey: Record<string, string>;
  sessionCwdsByKey: Record<string, string>;
  attachSessionIdsByNodeId: Record<string, string>;
}): AsyncGenerator<WorkflowRunEvent, string> {
  const provider = input.step.provider ?? input.defaultProvider;
  const model = input.step.model ?? input.defaultModel;
  const runContext = resolveLoopStepRunContext({
    stepId: input.step.id,
    stepSession: input.step.session,
    loopSession: input.defaultSession,
    prompt: input.prompt,
    appendPrompt: input.appendPrompt,
    sessionIdsByKey: input.sessionIdsByKey,
  });
  const sessionNodeId = createLoopStepSessionNodeId(input.nodeId, input.step.id);
  const attachSessionId = input.attachSessionIdsByNodeId[sessionNodeId];
  let output = "";

  yield loopStatusEvent({
    runId: input.runId,
    nodeId: input.nodeId,
    message: `Loop step ${input.syntheticId} started.`,
  });

  if (runContext.sessionKey) {
    assertSessionCwd({
      sessionKey: runContext.sessionKey,
      cwd: input.cwd,
      sessionCwdsByKey: input.sessionCwdsByKey,
    });
    yield loopStatusEvent({
      runId: input.runId,
      nodeId: input.nodeId,
      message: attachSessionId
        ? `Workflow session "${runContext.sessionKey}" is attaching to agent session ${attachSessionId} for ${input.syntheticId}.`
        : runContext.resumeSessionId
          ? `Workflow session "${runContext.sessionKey}" is reusing agent session ${runContext.resumeSessionId} for ${input.syntheticId}${runContext.promptMode === "append" ? " with appendPrompt" : " with full prompt"}.`
        : `Workflow session "${runContext.sessionKey}" is starting a new agent session for ${input.syntheticId}.`,
    });
  }

  for await (const event of runAgent({
    runId: `${input.runId}:${input.syntheticId}`,
    provider,
    cwd: input.cwd,
    prompt: runContext.prompt,
    model,
    resumeSessionId: runContext.resumeSessionId,
    attachSessionId,
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
    const agentSessionId = readAgentSessionId(event);
    yield {
      type: "node_event",
      runId: input.runId,
      nodeId: agentSessionId && runContext.sessionKey ? sessionNodeId : input.nodeId,
      event,
    };

    if (runContext.sessionKey && agentSessionId) {
      const previousSessionId = input.sessionIdsByKey[runContext.sessionKey];
      input.sessionIdsByKey[runContext.sessionKey] = agentSessionId;
      if (previousSessionId !== agentSessionId) {
        yield createWorkflowSessionStatusEvent({
          runId: input.runId,
          nodeId: sessionNodeId,
          sessionKey: runContext.sessionKey,
          agentSessionId,
          previousSessionId,
          context: input.syntheticId,
        });
      }
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

function resolveEffectiveNodeCwd(
  defaultCwd: string | undefined,
  overrideCwd: string | undefined,
): string {
  if (overrideCwd?.trim()) {
    return resolveWorkflowCwdFrom(defaultCwd, overrideCwd);
  }
  return defaultCwd ?? process.cwd();
}

function assertRequiredWorkflowCwd(
  parsed: ParsedWorkflow,
  cwd: string | undefined,
): void {
  if (parsed.meta.requiresCwd && !cwd?.trim()) {
    throw new Error("Workflow cwd is required.");
  }
}

function normalizeRecoveryState(
  recovery: WorkflowRunRecoveryState | undefined,
): Required<WorkflowRunRecoveryState> {
  return {
    outputs: sanitizeStringRecord(recovery?.outputs),
    completedNodeIds: Array.isArray(recovery?.completedNodeIds)
      ? recovery.completedNodeIds.filter(
          (nodeId): nodeId is string =>
            typeof nodeId === "string" && Boolean(nodeId.trim()),
        )
      : [],
    sessionIdsByKey: sanitizeStringRecord(recovery?.sessionIdsByKey),
    sessionCwdsByKey: sanitizeStringRecord(recovery?.sessionCwdsByKey),
    attachSessionIdsByNodeId: sanitizeStringRecord(
      recovery?.attachSessionIdsByNodeId,
    ),
    loopStates: sanitizeLoopRecoveryStates(recovery?.loopStates),
  };
}

function sanitizeStringRecord(
  value: Record<string, string> | undefined,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" &&
        Boolean(entry[0].trim()) &&
        typeof entry[1] === "string" &&
        Boolean(entry[1].trim()),
    ),
  );
}

function sanitizeLoopRecoveryStates(
  value: Record<string, WorkflowLoopRecoveryState> | undefined,
): Record<string, WorkflowLoopRecoveryState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([nodeId, state]) => {
      if (!nodeId.trim() || !state || typeof state !== "object") {
        return [];
      }
      const nextIteration = Number.isInteger(state.nextIteration)
        ? state.nextIteration
        : 1;
      return [
        [
          nodeId,
          {
            nextIteration,
            previousStepOutputs: sanitizeStringRecord(state.previousStepOutputs),
            ...(Number.isInteger(state.currentIteration)
              ? { currentIteration: state.currentIteration }
              : {}),
            currentStepOutputs: sanitizeStringRecord(state.currentStepOutputs),
            iterations: Array.isArray(state.iterations)
              ? state.iterations.flatMap((iteration) =>
                  sanitizeLoopIterationCheckpoint(iteration),
                )
              : [],
          },
        ],
      ];
    }),
  );
}

function sanitizeLoopIterationCheckpoint(
  value: WorkflowLoopRecoveryState["iterations"][number],
): WorkflowLoopRecoveryState["iterations"] {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (
    !Number.isInteger(value.index) ||
    typeof value.untilOutput !== "string" ||
    typeof value.untilMatched !== "boolean"
  ) {
    return [];
  }
  return [
    {
      index: value.index,
      outputs: sanitizeStringRecord(value.outputs),
      untilOutput: value.untilOutput,
      untilMatched: value.untilMatched,
    },
  ];
}

function readRecoveredLoopStopReason(
  recoveredLoop: WorkflowLoopRecoveryState | undefined,
  loop: NonNullable<WorkflowNode["loop"]>,
): "until_matched" | "max_iterations_reached" | undefined {
  const latestIteration = recoveredLoop?.iterations.at(-1);
  if (!latestIteration) {
    return undefined;
  }
  if (latestIteration.untilMatched) {
    return "until_matched";
  }
  if ((recoveredLoop?.nextIteration ?? 1) > loop.maxIterations) {
    return "max_iterations_reached";
  }
  return undefined;
}

function shouldFailRecoveredLoop(
  loop: NonNullable<WorkflowNode["loop"]>,
  stopReason: "until_matched" | "max_iterations_reached",
): boolean {
  return stopReason === "max_iterations_reached" && loop.onMaxIterations === "fail";
}

async function saveLoopCheckpoint(
  request: WorkflowRunRequest,
  checkpoint: {
    runId: string;
    nodeId: string;
    state: WorkflowLoopRecoveryState;
  },
): Promise<void> {
  await request.onCheckpoint?.({
    runId: checkpoint.runId,
    nodeId: checkpoint.nodeId,
    kind: "loop",
    state: checkpoint.state,
  });
}

function assertSessionCwd(input: {
  sessionKey: string;
  cwd: string;
  sessionCwdsByKey: Record<string, string>;
}): void {
  const previousCwd = input.sessionCwdsByKey[input.sessionKey];
  if (!previousCwd) {
    input.sessionCwdsByKey[input.sessionKey] = input.cwd;
    return;
  }
  if (previousCwd !== input.cwd) {
    throw new Error(
      `Workflow session "${input.sessionKey}" already started in ${previousCwd}, cannot resume from ${input.cwd}.`,
    );
  }
}

function createPreviousSessionNodeIds(
  nodes: WorkflowNode[],
): Record<string, string> {
  const latestNodeIdBySession = new Map<string, string>();
  const previousNodeIds: Record<string, string> = {};

  for (const node of nodes) {
    const sessionKey = resolveSessionKey(node.session);
    if (!sessionKey) {
      continue;
    }
    const previousNodeId = latestNodeIdBySession.get(sessionKey);
    if (previousNodeId) {
      previousNodeIds[node.id] = previousNodeId;
    }
    latestNodeIdBySession.set(sessionKey, node.id);
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
  template: string;
  step: WorkflowLoopStep;
  iteration: number;
  loopNode: WorkflowNode;
  workflowOutputs: Record<string, string>;
  workflowInputs: Record<string, string> | undefined;
  workflowCwd: string;
  previousStepOutputs: Record<string, string>;
  currentStepOutputs: Record<string, string>;
}): string {
  const bindings = new Map(
    input.loopNode.inputs.map((binding) => [binding.name, binding.sourceNodeId]),
  );

  return renderTemplate(input.template, (name) => {
    if (name === "iteration") {
      return String(input.iteration);
    }
    if (name === "workflow.cwd") {
      return input.workflowCwd;
    }
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
