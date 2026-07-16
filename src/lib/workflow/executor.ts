import { randomUUID } from "node:crypto";
import { runAgent } from "@/lib/agents/runtime";
import { resolveWorkflowCwd, resolveWorkflowCwdFrom } from "./cwd";
import { createWorkflowExecutionPlan } from "./execution-plan";
import { normalizeWorkflowInputsForSchema } from "./input-schema";
import { extractAgentJsonOutput } from "./json-output";
import { formatLoopUntil, matchesLoopUntil } from "./loop-until";
import { resolveLoopStepRunContext } from "./loop-runtime";
import { assertWorkflowScriptValid } from "./parser";
import {
  createLoopStepSessionNodeId,
  resolveSessionKey,
} from "./session";
import {
  renderPrompt,
  renderTemplate,
  renderTemplateValue,
  renderValueTemplate,
  resolveWorkflowValuePath,
  stringifyWorkflowValue,
} from "./templates";
import type {
  ParsedWorkflow,
  RenderedWorkflowHumanSpec,
  WorkflowAgentLoopStep,
  WorkflowHumanSpec,
  WorkflowHumanTask,
  WorkflowInputValue,
  WorkflowLoopRecoveryState,
  WorkflowLoopStepExecutionRef,
  WorkflowLoopStep,
  WorkflowMapItemCompletion,
  WorkflowMapItemExecutionRef,
  WorkflowMapRecoveryState,
  WorkflowMapSpec,
  WorkflowNode,
  WorkflowNodeStatus,
  WorkflowRunRecoveryState,
  WorkflowRunEvent,
  WorkflowRunRequest,
  WorkflowSessionSpec,
  WorkflowValue,
} from "./types";

export async function* runWorkflow(
  request: WorkflowRunRequest,
): AsyncGenerator<WorkflowRunEvent> {
  const runId = request.runId ?? randomUUID();
  const executionId = randomUUID();
  const parsed = assertWorkflowScriptValid(request.script);
  assertRequiredWorkflowCwd(parsed, request.cwd);
  const inputs = normalizeWorkflowInputsForSchema(
    parsed.inputSchema,
    request.inputs,
  );
  const normalizedRequest = {
    ...request,
    cwd: resolveWorkflowCwd(request.cwd),
    inputs,
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
  const outputs: Record<string, WorkflowValue> = { ...recovery.outputs };
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
  const waiting = new Set<string>();
  const pendingTaskIds = new Map<string, string>();
  let canceled = false;
  let failureError: string | undefined;

  yield { type: "run_started", runId, executionId, parsed };

  while (completed.size + failed.size < executableNodes.length) {
    if (isSignalAborted(normalizedRequest.signal)) {
      canceled = true;
      break;
    }

    const ready = executableNodes.filter((node) => {
      if (
        completed.has(node.id) ||
        failed.has(node.id) ||
        running.has(node.id) ||
        waiting.has(node.id)
      ) {
        return false;
      }
      return node.inputs.every((input) =>
        input.sourceNodeId ? completed.has(input.sourceNodeId) : true,
      ) && isSessionPredecessorCompleted(node, previousSessionNodeIds, completed);
    });

    if (ready.length === 0) {
      if (failed.size === 0 && waiting.size > 0) {
        yield {
          type: "run_waiting",
          runId,
          pendingTaskIds: [...pendingTaskIds.values()],
          outputs,
        };
        return;
      }
      for (const node of executableNodes) {
        if (!completed.has(node.id) && !failed.has(node.id) && !waiting.has(node.id)) {
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
      mapStatesByNodeId: recovery.mapStates,
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
        waiting.delete(event.nodeId);
        pendingTaskIds.delete(event.nodeId);
        completed.add(event.nodeId);
        outputs[event.nodeId] = event.output;
      }

      if (event.type === "node_failed") {
        running.delete(event.nodeId);
        failed.add(event.nodeId);
        failureError ??= event.error;
      }

      if (event.type === "human_task_requested") {
        running.delete(event.nodeId);
        waiting.add(event.nodeId);
        pendingTaskIds.set(event.nodeId, event.task.id);
      }

      if (event.type === "human_task_resolved") {
        waiting.delete(event.nodeId);
        pendingTaskIds.delete(event.nodeId);
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
  outputs: Record<string, WorkflowValue>;
  sessionIdsByKey: Record<string, string>;
  sessionCwdsByKey: Record<string, string>;
  attachSessionIdsByNodeId: Record<string, string>;
  loopStatesByNodeId: Record<string, WorkflowLoopRecoveryState>;
  mapStatesByNodeId: Record<string, WorkflowMapRecoveryState>;
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
          mapStatesByNodeId: input.mapStatesByNodeId,
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
  outputs: Record<string, WorkflowValue>;
  sessionIdsByKey: Record<string, string>;
  sessionCwdsByKey: Record<string, string>;
  attachSessionIdsByNodeId: Record<string, string>;
  loopStatesByNodeId: Record<string, WorkflowLoopRecoveryState>;
  mapStatesByNodeId: Record<string, WorkflowMapRecoveryState>;
}): AsyncGenerator<WorkflowRunEvent> {
  if (input.node.kind === "loop") {
    yield* runLoopNode(input);
    return;
  }
  if (input.node.kind === "map") {
    yield* runMapNode(input);
    return;
  }
  if (input.node.kind === "human") {
    yield* runHumanNode(input);
    return;
  }
  yield* runAgentNode(input);
}

async function* runAgentNode(input: {
  runId: string;
  node: WorkflowNode;
  request: WorkflowRunRequest;
  outputs: Record<string, WorkflowValue>;
  sessionIdsByKey: Record<string, string>;
  sessionCwdsByKey: Record<string, string>;
  attachSessionIdsByNodeId: Record<string, string>;
  loopStatesByNodeId: Record<string, WorkflowLoopRecoveryState>;
}): AsyncGenerator<WorkflowRunEvent> {
  const nodeRunId = `${input.runId}:${input.node.id}`;
  const agent =
    resolveRuntimeOption(
      input.node.agent,
      input.request.agent,
      input.request.inputs,
    ) ?? "mock";
  const model = resolveRuntimeOption(
    input.node.model,
    input.request.model,
    input.request.inputs,
  );
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
    agent,
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
      agent,
      cwd,
      prompt,
      title: input.node.label,
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

    const nodeOutput =
      input.node.output === "json" ? extractAgentJsonOutput(output) : output;

    yield {
      type: "node_completed",
      runId: input.runId,
      nodeId: input.node.id,
      output: nodeOutput,
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

async function* runHumanNode(input: {
  runId: string;
  node: WorkflowNode;
  request: WorkflowRunRequest;
  outputs: Record<string, WorkflowValue>;
}): AsyncGenerator<WorkflowRunEvent> {
  yield {
    type: "node_started",
    runId: input.runId,
    nodeId: input.node.id,
    node: input.node,
    agent: "human",
  };

  try {
    const human = input.node.human;
    if (!human) {
      throw new Error("Human node is missing configuration.");
    }
    const task = await requestHumanTask({
      request: input.request,
      runId: input.runId,
      nodeId: input.node.id,
      executionKey: `human:${input.node.id}`,
      spec: renderHumanSpec(human, (name) =>
        resolveNodeTemplateValue(input.node, name, input.outputs, input.request.inputs),
      ),
    });
    if (task.status === "pending") {
      yield {
        type: "human_task_requested",
        runId: input.runId,
        nodeId: input.node.id,
        task,
      };
      return;
    }
    if (task.status === "canceled" || !task.response) {
      throw new Error("Human task was canceled.");
    }
    yield {
      type: "human_task_resolved",
      runId: input.runId,
      nodeId: input.node.id,
      taskId: task.id,
      response: task.response,
    };
    yield {
      type: "node_completed",
      runId: input.runId,
      nodeId: input.node.id,
      output: task.response,
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
  outputs: Record<string, WorkflowValue>;
  sessionIdsByKey: Record<string, string>;
  sessionCwdsByKey: Record<string, string>;
  attachSessionIdsByNodeId: Record<string, string>;
  loopStatesByNodeId: Record<string, WorkflowLoopRecoveryState>;
}): AsyncGenerator<WorkflowRunEvent> {
  const loop = input.node.loop;
  const agent =
    resolveRuntimeOption(
      input.node.agent,
      input.request.agent,
      input.request.inputs,
    ) ?? "mock";
  const model = resolveRuntimeOption(
    input.node.model,
    input.request.model,
    input.request.inputs,
  );
  const loopCwd = resolveEffectiveNodeCwd(input.request.cwd, input.node.cwd);

  yield {
    type: "node_started",
    runId: input.runId,
    nodeId: input.node.id,
    node: input.node,
    agent,
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
  const previousStepOutputs: Record<string, WorkflowValue> = {
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

      const currentStepOutputs: Record<string, WorkflowValue> =
        recoveredLoop?.currentIteration === iteration
          ? { ...(recoveredLoop.currentStepOutputs ?? {}) }
          : {};
      yield loopStatusEvent({
        runId: input.runId,
        nodeId: input.node.id,
        message: `Loop "${input.node.id}" iteration ${iteration} started.`,
      });

      const iterationSteps =
        iteration === 1 && loop.firstIteration
          ? loop.steps.slice(
              loop.steps.findIndex(
                (step) => step.id === loop.firstIteration?.startAt,
              ),
            )
          : loop.steps;
      const iterationStepIds = new Set(iterationSteps.map((step) => step.id));
      for (const skippedStep of loop.steps.filter(
        (step) => !iterationStepIds.has(step.id),
      )) {
        yield loopStepStateEvent({
          runId: input.runId,
          loopStep: createLoopStepExecutionRef(
            input.node.id,
            iteration,
            skippedStep.id,
          ),
          step: skippedStep,
          status: "skipped",
        });
      }

      for (const step of iterationSteps) {
        throwIfAborted(input.request.signal);
        const loopStep = createLoopStepExecutionRef(
          input.node.id,
          iteration,
          step.id,
        );
        if (currentStepOutputs[step.id] !== undefined) {
          yield loopStepStateEvent({
            runId: input.runId,
            loopStep,
            step,
            status: "completed",
            restored: true,
            output: currentStepOutputs[step.id],
          });
          yield loopStatusEvent({
            runId: input.runId,
            nodeId: input.node.id,
            message: `Loop step ${createLoopStepId(input.node.id, iteration, step.id)} restored from checkpoint.`,
          });
          continue;
        }

        const syntheticId = createLoopStepId(input.node.id, iteration, step.id);
        const stepCwd = resolveEffectiveNodeCwd(loopCwd, step.cwd);
        let stepOutput: WorkflowValue;
        try {
          if (step.kind === "human") {
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
            const humanOutput = yield* runLoopHumanStep({
              runId: input.runId,
              nodeId: input.node.id,
              loopStep,
              syntheticId,
              step,
              iteration,
              request: input.request,
              spec: renderHumanSpec(step.human, (name) =>
                resolveLoopTemplateValue({
                  name,
                  iteration,
                  loopNode: input.node,
                  workflowOutputs: input.outputs,
                  workflowInputs: input.request.inputs,
                  workflowCwd: stepCwd,
                  previousStepOutputs,
                  currentStepOutputs,
                }),
              ),
            });
            if (humanOutput === undefined) {
              return;
            }
            stepOutput = humanOutput;
          } else {
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
            stepOutput = yield* runLoopAgentStep({
              runId: input.runId,
              nodeId: input.node.id,
              loopStep,
              syntheticId,
              step,
              prompt,
              appendPrompt,
              defaultAgent: agent,
              defaultModel: model,
              defaultSession: loop.session,
              cwd: stepCwd,
              workflowInputs: input.request.inputs,
              signal: input.request.signal,
              sessionIdsByKey: input.sessionIdsByKey,
              sessionCwdsByKey: input.sessionCwdsByKey,
              attachSessionIdsByNodeId: input.attachSessionIdsByNodeId,
            });
          }
        } catch (error) {
          yield loopStepStateEvent({
            runId: input.runId,
            loopStep,
            step,
            status: "failed",
            error: toRunErrorMessage(error),
          });
          throw error;
        }
        yield loopStepStateEvent({
          runId: input.runId,
          loopStep,
          step,
          status: "completed",
          output: stepOutput,
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

      const untilValue = resolveLoopStepOutput(
        loop.until.source,
        currentStepOutputs,
        previousStepOutputs,
      );
      const untilOutput = stringifyWorkflowValue(untilValue);
      const untilMatched = matchesLoopUntil(untilValue ?? "", loop.until);
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
        message: `Loop "${input.node.id}" iteration ${iteration} until check: ${untilMatched ? "matched" : "not matched"} (${formatLoopUntil(loop.until)}).`,
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

async function* runLoopHumanStep(input: {
  runId: string;
  nodeId: string;
  syntheticId: string;
  loopStep: WorkflowLoopStepExecutionRef;
  step: Extract<WorkflowLoopStep, { kind: "human" }>;
  iteration: number;
  request: WorkflowRunRequest;
  spec: RenderedWorkflowHumanSpec;
}): AsyncGenerator<WorkflowRunEvent, WorkflowValue | undefined> {
  yield loopStepStateEvent({
    runId: input.runId,
    loopStep: input.loopStep,
    step: input.step,
    status: "running",
    input: JSON.stringify(input.spec),
  });
  yield loopStatusEvent({
    runId: input.runId,
    nodeId: input.nodeId,
    message: `Loop human step ${input.syntheticId} requested input.`,
  });
  const task = await requestHumanTask({
    request: input.request,
    runId: input.runId,
    nodeId: input.step.id,
    parentNodeId: input.nodeId,
    iteration: input.iteration,
    executionKey: `loop:${input.nodeId}:${input.iteration}:human:${input.step.id}`,
    spec: input.spec,
  });
  if (task.status === "pending") {
    yield loopStepStateEvent({
      runId: input.runId,
      loopStep: input.loopStep,
      step: input.step,
      status: "waiting",
    });
    yield {
      type: "human_task_requested",
      runId: input.runId,
      nodeId: input.nodeId,
      task,
    };
    return undefined;
  }
  if (task.status === "canceled" || !task.response) {
    throw new Error(`Human task ${task.id} was canceled.`);
  }
  yield {
    type: "human_task_resolved",
    runId: input.runId,
    nodeId: input.nodeId,
    taskId: task.id,
    response: task.response,
  };
  yield loopStatusEvent({
    runId: input.runId,
    nodeId: input.nodeId,
    message: `Loop human step ${input.syntheticId} completed with action ${task.response.action}.`,
  });
  return task.response;
}

async function* runLoopAgentStep(input: {
  runId: string;
  nodeId: string;
  syntheticId: string;
  loopStep: WorkflowLoopStepExecutionRef;
  step: WorkflowAgentLoopStep;
  prompt: string;
  appendPrompt?: string;
  defaultAgent: string;
  defaultModel?: string;
  defaultSession?: WorkflowSessionSpec;
  cwd: string;
  workflowInputs?: Record<string, WorkflowInputValue>;
  signal?: AbortSignal;
  sessionIdsByKey: Record<string, string>;
  sessionCwdsByKey: Record<string, string>;
  attachSessionIdsByNodeId: Record<string, string>;
}): AsyncGenerator<WorkflowRunEvent, WorkflowValue> {
  const agent =
    resolveRuntimeOption(input.step.agent, input.defaultAgent, input.workflowInputs) ??
    input.defaultAgent;
  const model = resolveRuntimeOption(
    input.step.model,
    input.defaultModel,
    input.workflowInputs,
  );
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

  yield loopStepStateEvent({
    runId: input.runId,
    loopStep: input.loopStep,
    step: input.step,
    status: "running",
    agent,
    model,
    sessionKey: runContext.sessionKey,
    promptMode: runContext.promptMode,
    input: runContext.prompt,
  });

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
    agent,
    cwd: input.cwd,
    prompt: runContext.prompt,
    title: input.step.label,
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
      loopStep: input.loopStep,
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

  // Extract before signaling completion so a parse failure fails the step.
  const stepOutput =
    input.step.output === "json" ? extractAgentJsonOutput(output) : output;

  yield loopStatusEvent({
    runId: input.runId,
    nodeId: input.nodeId,
    message: `Loop step ${input.syntheticId} completed.`,
  });

  return stepOutput;
}

async function* runMapNode(input: {
  runId: string;
  node: WorkflowNode;
  request: WorkflowRunRequest;
  outputs: Record<string, WorkflowValue>;
  mapStatesByNodeId: Record<string, WorkflowMapRecoveryState>;
}): AsyncGenerator<WorkflowRunEvent> {
  const map = input.node.map;
  const agent =
    resolveRuntimeOption(
      input.node.agent,
      input.request.agent,
      input.request.inputs,
    ) ?? "mock";
  const model = resolveRuntimeOption(
    input.node.model,
    input.request.model,
    input.request.inputs,
  );
  const mapCwd = resolveEffectiveNodeCwd(input.request.cwd, input.node.cwd);

  yield {
    type: "node_started",
    runId: input.runId,
    nodeId: input.node.id,
    node: input.node,
    agent,
    model,
  };

  if (!map) {
    yield {
      type: "node_failed",
      runId: input.runId,
      nodeId: input.node.id,
      error: "Map node is missing map configuration.",
    };
    return;
  }

  const recovered = input.mapStatesByNodeId[input.node.id];

  try {
    throwIfAborted(input.request.signal);

    let items: WorkflowValue[];
    if (recovered) {
      items = recovered.items;
      yield loopStatusEvent({
        runId: input.runId,
        nodeId: input.node.id,
        message: `Map "${input.node.id}" restored ${items.length} item(s) from checkpoint.`,
      });
    } else if (map.items) {
      // Static inline list: skip source resolution and checkpoint the literal
      // items so recovery/retry behave identically to a resolved source.
      items = map.items;
      yield loopStatusEvent({
        runId: input.runId,
        nodeId: input.node.id,
        message: `Map "${input.node.id}" expanded to ${items.length} inline item(s).`,
      });
      await saveMapCheckpoint(input.request, {
        runId: input.runId,
        nodeId: input.node.id,
        items,
        completions: [],
      });
    } else {
      const sourceValue = map.sourceNodeId
        ? input.outputs[map.sourceNodeId]
        : undefined;
      items = resolveMapItems(sourceValue, input.node.id, map);
      if (items.length > map.maxItems) {
        throw new Error(
          `Map "${input.node.id}" resolved ${items.length} items, exceeding maxItems ${map.maxItems}.`,
        );
      }
      yield loopStatusEvent({
        runId: input.runId,
        nodeId: input.node.id,
        message: `Map "${input.node.id}" expanded to ${items.length} item(s).`,
      });
      await saveMapCheckpoint(input.request, {
        runId: input.runId,
        nodeId: input.node.id,
        items,
        completions: [],
      });
    }

    const indexed = items.map((item, position) => ({
      index: position + 1,
      item,
    }));
    const completions = new Map<number, WorkflowMapItemCompletion>();
    for (const completion of recovered?.completions ?? []) {
      completions.set(completion.index, completion);
    }

    // Restored per-item states so the run log reflects already-finished items.
    // Recovery is item-level, so a restored completion is attributed to its
    // failing step (failures) or the last step (successes).
    const lastStep = map.steps[map.steps.length - 1];
    for (const { index, item } of indexed) {
      const completion = completions.get(index);
      if (!completion) {
        continue;
      }
      const restoredStep =
        map.steps.find((step) => step.id === completion.step) ?? lastStep;
      const restoredStepCwd = resolveEffectiveNodeCwd(mapCwd, restoredStep.cwd);
      yield mapItemStateEvent({
        runId: input.runId,
        mapItem: createMapItemExecutionRef(input.node.id, index, restoredStep.id),
        label: renderMapItemText(restoredStep.label, {
          map,
          index,
          item,
          node: input.node,
          workflowOutputs: input.outputs,
          workflowInputs: input.request.inputs,
          cwd: restoredStepCwd,
          stepOutputs: {},
        }),
        status: completion.status,
        restored: true,
        ...(completion.output !== undefined ? { output: completion.output } : {}),
        ...(completion.error ? { error: completion.error } : {}),
      });
    }

    const pending = indexed.filter(({ index }) => !completions.has(index));
    let firstFailure: WorkflowMapItemCompletion | undefined = [
      ...completions.values(),
    ].find(
      (completion) =>
        completion.status === "failed" && map.onItemFailure === "fail",
    );

    if (pending.length > 0 && !(map.onItemFailure === "fail" && firstFailure)) {
      // Internal concurrency pool of up to 4, mirroring streamNodeBatch's merge.
      type QueueItem = { event: WorkflowRunEvent } | { error: unknown };
      const queue: QueueItem[] = [];
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

      let cursor = 0;
      let stopScheduling = false;
      const concurrency = Math.min(4, pending.length);
      let activeWorkers = concurrency;

      const recordCompletion = async (
        completion: WorkflowMapItemCompletion,
      ): Promise<void> => {
        completions.set(completion.index, completion);
        if (completion.status === "failed" && map.onItemFailure === "fail") {
          // In-flight children finish; no new items are scheduled.
          stopScheduling = true;
          firstFailure ??= completion;
        }
        await saveMapCheckpoint(input.request, {
          runId: input.runId,
          nodeId: input.node.id,
          items,
          completions: [...completions.values()],
        });
      };

      for (let worker = 0; worker < concurrency; worker += 1) {
        void (async () => {
          try {
            while (!stopScheduling) {
              const position = cursor;
              cursor += 1;
              if (position >= pending.length) {
                break;
              }
              const { index, item } = pending[position];
              const generator = runMapItem({
                runId: input.runId,
                node: input.node,
                map,
                index,
                item,
                defaultAgent: agent,
                defaultModel: model,
                mapCwd,
                workflowOutputs: input.outputs,
                request: input.request,
              });
              let next = await generator.next();
              while (!next.done) {
                push({ event: next.value });
                next = await generator.next();
              }
              await recordCompletion(next.value);
            }
          } catch (error) {
            push({ error });
          } finally {
            activeWorkers -= 1;
            wake();
          }
        })();
      }

      while (activeWorkers > 0 || queue.length > 0) {
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

    if (map.onItemFailure === "fail" && firstFailure) {
      yield {
        type: "node_failed",
        runId: input.runId,
        nodeId: input.node.id,
        error: `Map "${input.node.id}" item ${firstFailure.index} failed: ${firstFailure.error ?? "unknown error"}`,
      };
      return;
    }

    yield {
      type: "node_completed",
      runId: input.runId,
      nodeId: input.node.id,
      output: buildMapOutput(indexed, completions),
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

// Runs one item through its step pipeline sequentially. There is no cross-item
// barrier — the outer pool schedules ITEMS, and each item's steps run inside
// its own slot. The first failing step fails the item (attributed via `step`)
// and its remaining steps are skipped; the last step's output is the item
// output. Earlier step outputs are available to later steps by step id.
async function* runMapItem(input: {
  runId: string;
  node: WorkflowNode;
  map: WorkflowMapSpec;
  index: number;
  item: WorkflowValue;
  defaultAgent: string;
  defaultModel?: string;
  mapCwd: string;
  workflowOutputs: Record<string, WorkflowValue>;
  request: WorkflowRunRequest;
}): AsyncGenerator<WorkflowRunEvent, WorkflowMapItemCompletion> {
  const stepOutputs: Record<string, WorkflowValue> = {};
  let lastOutput: WorkflowValue = "";

  for (const step of input.map.steps) {
    const mapItem = createMapItemExecutionRef(input.node.id, input.index, step.id);
    const syntheticId = createMapItemId(input.node.id, input.index, step.id);
    const stepCwd = resolveEffectiveNodeCwd(input.mapCwd, step.cwd);
    const context = {
      map: input.map,
      index: input.index,
      item: input.item,
      node: input.node,
      workflowOutputs: input.workflowOutputs,
      workflowInputs: input.request.inputs,
      cwd: stepCwd,
      stepOutputs,
    };
    const label = renderMapItemText(step.label, context);
    const agent =
      resolveRuntimeOption(step.agent, input.defaultAgent, input.request.inputs) ??
      input.defaultAgent;
    const model = resolveRuntimeOption(
      step.model,
      input.defaultModel,
      input.request.inputs,
    );
    const prompt = renderMapItemText(step.prompt, context);
    let output = "";

    yield mapItemStateEvent({
      runId: input.runId,
      mapItem,
      label,
      status: "running",
      agent,
      model,
      promptMode: "full",
      input: prompt,
    });
    yield loopStatusEvent({
      runId: input.runId,
      nodeId: input.node.id,
      message: `Map item ${syntheticId} started.`,
    });

    try {
      for await (const event of runAgent({
        runId: `${input.runId}:${syntheticId}`,
        agent,
        cwd: stepCwd,
        prompt,
        title: label,
        model,
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
          mapItem,
          event,
        };
      }

      // Extract before signaling completion so a parse failure fails the step.
      const stepOutput =
        step.output === "json" ? extractAgentJsonOutput(output) : output;

      yield mapItemStateEvent({
        runId: input.runId,
        mapItem,
        label,
        status: "completed",
        output: stepOutput,
      });
      yield loopStatusEvent({
        runId: input.runId,
        nodeId: input.node.id,
        message: `Map item ${syntheticId} completed.`,
      });
      stepOutputs[step.id] = stepOutput;
      lastOutput = stepOutput;
    } catch (error) {
      if (isCancellationError(error)) {
        // Cancellation aborts the whole map node, not a single skippable item.
        throw error;
      }
      const message = toRunErrorMessage(error);
      yield mapItemStateEvent({
        runId: input.runId,
        mapItem,
        label,
        status: "failed",
        error: message,
      });
      yield loopStatusEvent({
        runId: input.runId,
        nodeId: input.node.id,
        message: `Map item ${syntheticId} failed at step ${step.id}: ${message}`,
      });
      return {
        index: input.index,
        status: "failed",
        step: step.id,
        error: message,
      };
    }
  }

  return { index: input.index, status: "completed", output: lastOutput };
}

type MapItemContext = {
  map: WorkflowMapSpec;
  index: number;
  item: WorkflowValue;
  node: WorkflowNode;
  workflowOutputs: Record<string, WorkflowValue>;
  workflowInputs: Record<string, WorkflowInputValue> | undefined;
  cwd: string;
  /** Outputs of this item's earlier steps, keyed by step id. */
  stepOutputs: Record<string, WorkflowValue>;
};

function renderMapItemText(template: string, context: MapItemContext): string {
  return renderTemplate(template, (name) =>
    resolveMapItemTemplateValue({ ...context, name }),
  );
}

function resolveMapItemTemplateValue(
  input: MapItemContext & { name: string },
): WorkflowValue | undefined {
  if (input.name === "item") {
    return input.item;
  }
  if (input.name === "item_index") {
    return input.index;
  }
  if (input.name === "workflow.cwd") {
    return input.cwd;
  }
  const [root, ...path] = input.name.split(".");
  if (root === "item") {
    return resolveWorkflowValuePath(input.item, path);
  }
  if (input.stepOutputs[root] !== undefined) {
    return resolveWorkflowValuePath(input.stepOutputs[root], path);
  }
  const binding = input.node.inputs.find(
    (item) => item.name === input.name || item.name === root,
  );
  if (binding?.sourceNodeId) {
    return resolveWorkflowValuePath(
      input.workflowOutputs[binding.sourceNodeId],
      path,
    );
  }
  return input.workflowInputs?.[input.name] ?? input.workflowInputs?.[root];
}

function resolveMapItems(
  sourceValue: WorkflowValue | undefined,
  nodeId: string,
  map: WorkflowMapSpec,
): WorkflowValue[] {
  if (Array.isArray(sourceValue)) {
    return sourceValue;
  }
  if (typeof sourceValue === "string") {
    const parsed = coerceMapJsonArray(sourceValue);
    if (parsed) {
      return parsed;
    }
  }
  throw new Error(
    `Map "${nodeId}" source "${map.source}" must resolve to an array; received ${describeMapSource(sourceValue)}.`,
  );
}

function coerceMapJsonArray(raw: string): WorkflowValue[] | undefined {
  try {
    const parsed = extractAgentJsonOutput(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function describeMapSource(value: WorkflowValue | undefined): string {
  if (value === undefined) {
    return "no output";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return "an object";
  }
  return `a ${typeof value} value`;
}

function buildMapOutput(
  indexed: Array<{ index: number; item: WorkflowValue }>,
  completions: Map<number, WorkflowMapItemCompletion>,
): WorkflowValue {
  const items: WorkflowValue[] = [];
  const failed: WorkflowValue[] = [];
  for (const { index, item } of indexed) {
    const completion = completions.get(index);
    if (completion?.status === "completed") {
      items.push({
        index,
        item,
        status: "completed",
        output: completion.output ?? "",
      });
    } else if (completion?.status === "failed") {
      failed.push({
        index,
        item,
        ...(completion.step ? { step: completion.step } : {}),
        error: completion.error ?? "unknown error",
      });
    }
  }
  return { items, failed, total: indexed.length };
}

function createMapItemId(mapId: string, index: number, stepId: string): string {
  return `${mapId}[${index}].${stepId}`;
}

function createMapItemExecutionRef(
  mapId: string,
  index: number,
  stepId: string,
): WorkflowMapItemExecutionRef {
  return {
    executionKey: `map:${mapId}:${index}:${stepId}`,
    parentNodeId: mapId,
    stepId,
    index,
  };
}

function mapItemStateEvent(input: {
  runId: string;
  mapItem: WorkflowMapItemExecutionRef;
  label: string;
  status: WorkflowNodeStatus;
  agent?: string;
  model?: string;
  promptMode?: "full" | "append";
  input?: string;
  restored?: boolean;
  output?: WorkflowValue;
  error?: string;
}): WorkflowRunEvent {
  return {
    type: "map_item_state",
    runId: input.runId,
    mapItem: input.mapItem,
    kind: "agent",
    label: input.label,
    status: input.status,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.promptMode ? { promptMode: input.promptMode } : {}),
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.restored !== undefined ? { restored: input.restored } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

async function saveMapCheckpoint(
  request: WorkflowRunRequest,
  checkpoint: {
    runId: string;
    nodeId: string;
    items: WorkflowValue[];
    completions: WorkflowMapItemCompletion[];
  },
): Promise<void> {
  await request.onCheckpoint?.({
    runId: checkpoint.runId,
    nodeId: checkpoint.nodeId,
    kind: "map",
    state: {
      items: checkpoint.items,
      completions: checkpoint.completions,
    },
  });
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

function resolveRuntimeOption(
  template: string | undefined,
  fallback: string | undefined,
  workflowInputs: Record<string, WorkflowInputValue> = {},
): string | undefined {
  if (template === undefined) {
    return fallback;
  }
  const rendered = renderValueTemplate(
    template,
    (name) => workflowInputs[name],
  ).trim();
  return rendered || fallback;
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
    outputs: sanitizeWorkflowValueRecord(recovery?.outputs),
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
    mapStates: sanitizeMapRecoveryStates(recovery?.mapStates),
  };
}

function sanitizeMapRecoveryStates(
  value: Record<string, WorkflowMapRecoveryState> | undefined,
): Record<string, WorkflowMapRecoveryState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([nodeId, state]) => {
      if (
        !nodeId.trim() ||
        !state ||
        typeof state !== "object" ||
        !Array.isArray(state.items)
      ) {
        return [];
      }
      return [
        [
          nodeId,
          {
            items: state.items.filter(isWorkflowValue),
            completions: Array.isArray(state.completions)
              ? state.completions.flatMap(sanitizeMapItemCompletion)
              : [],
          },
        ],
      ];
    }),
  );
}

function sanitizeMapItemCompletion(
  value: WorkflowMapItemCompletion,
): WorkflowMapItemCompletion[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (
    !Number.isInteger(value.index) ||
    (value.status !== "completed" && value.status !== "failed")
  ) {
    return [];
  }
  return [
    {
      index: value.index,
      status: value.status,
      ...(typeof value.step === "string" ? { step: value.step } : {}),
      ...(value.output !== undefined && isWorkflowValue(value.output)
        ? { output: value.output }
        : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    },
  ];
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

function sanitizeWorkflowValueRecord(
  value: Record<string, WorkflowValue> | undefined,
): Record<string, WorkflowValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) => Boolean(key.trim()) && isWorkflowValue(item),
    ),
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
            previousStepOutputs: sanitizeWorkflowValueRecord(
              state.previousStepOutputs,
            ),
            ...(Number.isInteger(state.currentIteration)
              ? { currentIteration: state.currentIteration }
              : {}),
            currentStepOutputs: sanitizeWorkflowValueRecord(
              state.currentStepOutputs,
            ),
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
      outputs: sanitizeWorkflowValueRecord(value.outputs),
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

function createLoopStepExecutionRef(
  loopId: string,
  iteration: number,
  stepId: string,
): WorkflowLoopStepExecutionRef {
  return {
    executionKey: `loop:${loopId}:${iteration}:${stepId}`,
    parentNodeId: loopId,
    stepId,
    iteration,
  };
}

function loopStepStateEvent(input: {
  runId: string;
  loopStep: WorkflowLoopStepExecutionRef;
  step: WorkflowLoopStep;
  status: WorkflowNodeStatus;
  agent?: string;
  model?: string;
  sessionKey?: string;
  promptMode?: "full" | "append";
  input?: string;
  restored?: boolean;
  output?: WorkflowValue;
  error?: string;
}): WorkflowRunEvent {
  return {
    type: "loop_step_state",
    runId: input.runId,
    loopStep: input.loopStep,
    kind: input.step.kind,
    label: input.step.label,
    status: input.status,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.promptMode ? { promptMode: input.promptMode } : {}),
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.restored !== undefined ? { restored: input.restored } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function renderLoopStepPrompt(input: {
  template: string;
  step: WorkflowAgentLoopStep;
  iteration: number;
  loopNode: WorkflowNode;
  workflowOutputs: Record<string, WorkflowValue>;
  workflowInputs: Record<string, WorkflowInputValue> | undefined;
  workflowCwd: string;
  previousStepOutputs: Record<string, WorkflowValue>;
  currentStepOutputs: Record<string, WorkflowValue>;
}): string {
  return renderTemplate(input.template, (name) =>
    resolveLoopTemplateValue({ ...input, name }),
  );
}

function resolveLoopTemplateValue(input: {
  name: string;
  iteration: number;
  loopNode: WorkflowNode;
  workflowOutputs: Record<string, WorkflowValue>;
  workflowInputs: Record<string, WorkflowInputValue> | undefined;
  workflowCwd: string;
  previousStepOutputs: Record<string, WorkflowValue>;
  currentStepOutputs: Record<string, WorkflowValue>;
}): WorkflowValue | undefined {
  if (input.name === "iteration") {
    return input.iteration;
  }
  if (input.name === "workflow.cwd") {
    return input.workflowCwd;
  }
  const [root, ...path] = input.name.split(".");
  if (input.currentStepOutputs[root] !== undefined) {
    return resolveWorkflowValuePath(input.currentStepOutputs[root], path);
  }
  if (input.previousStepOutputs[root] !== undefined) {
    return resolveWorkflowValuePath(input.previousStepOutputs[root], path);
  }
  const binding = input.loopNode.inputs.find(
    (item) => item.name === input.name || item.name === root,
  );
  if (binding?.sourceNodeId) {
    return resolveWorkflowValuePath(
      input.workflowOutputs[binding.sourceNodeId],
      path,
    );
  }
  return input.workflowInputs?.[input.name] ?? input.workflowInputs?.[root];
}

function resolveNodeTemplateValue(
  node: WorkflowNode,
  name: string,
  outputs: Record<string, WorkflowValue>,
  workflowInputs: Record<string, WorkflowInputValue> | undefined,
): WorkflowValue | undefined {
  const [root, ...path] = name.split(".");
  const binding = node.inputs.find(
    (item) => item.name === name || item.name === root,
  );
  if (binding?.sourceNodeId) {
    return resolveWorkflowValuePath(outputs[binding.sourceNodeId], path);
  }
  return workflowInputs?.[name] ?? workflowInputs?.[root];
}

function renderHumanSpec(
  human: WorkflowHumanSpec,
  resolveValue: (name: string) => WorkflowValue | undefined,
): RenderedWorkflowHumanSpec {
  return {
    ...(human.description !== undefined ? { description: human.description } : {}),
    context: human.context.map((item) => ({
      label: item.label,
      display: item.display,
      value: renderTemplateValue(item.value, resolveValue),
    })),
    actions: human.actions.map((action) => ({
      ...action,
      fields: action.fields.map((field) => ({
        ...field,
        ...(field.defaultValue !== undefined
          ? { defaultValue: renderTemplate(field.defaultValue, resolveValue) }
          : {}),
      })),
    })),
  };
}

async function requestHumanTask(input: {
  request: WorkflowRunRequest;
  runId: string;
  nodeId: string;
  parentNodeId?: string;
  iteration?: number;
  executionKey: string;
  spec: RenderedWorkflowHumanSpec;
}): Promise<WorkflowHumanTask> {
  if (!input.request.onHumanTask) {
    throw new Error("Human task persistence is not configured.");
  }
  return input.request.onHumanTask({
    runId: input.runId,
    nodeId: input.nodeId,
    ...(input.parentNodeId ? { parentNodeId: input.parentNodeId } : {}),
    ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
    executionKey: input.executionKey,
    spec: input.spec,
  });
}

function resolveLoopStepOutput(
  source: string,
  currentStepOutputs: Record<string, WorkflowValue>,
  previousStepOutputs: Record<string, WorkflowValue>,
): WorkflowValue | undefined {
  const [root, ...path] = source.split(".");
  const value = currentStepOutputs[root] ?? previousStepOutputs[root];
  return resolveWorkflowValuePath(value, path);
}

function formatLoopOutput(input: {
  node: WorkflowNode;
  stopReason: "until_matched" | "max_iterations_reached";
  iterations: Array<{
    index: number;
    outputs: Record<string, WorkflowValue>;
    untilOutput: string;
    untilMatched: boolean;
  }>;
  latestStepOutputs: Record<string, WorkflowValue>;
}): string {
  const loop = input.node.loop;
  const lines = [
    `Loop ${input.node.id} completed.`,
    `Stop reason: ${input.stopReason}`,
    `Iterations: ${input.iterations.length}`,
  ];

  if (loop) {
    lines.push(`Until: ${formatLoopUntil(loop.until)}`);
  }

  lines.push("", "Final step outputs:");
  for (const [stepId, output] of Object.entries(input.latestStepOutputs)) {
    lines.push("", `[${stepId}]`, stringifyWorkflowValue(output).trim());
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
