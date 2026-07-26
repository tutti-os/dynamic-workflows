import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runAgent } from "@/lib/agents/runtime";
import { getDb } from "@/lib/db/client";
import {
  createOrGetFlowV1HumanTask,
} from "@/lib/db/workflows/human-tasks";
import {
  finishFlowV1NodeAttempt,
  listFlowV1NodeAttempts,
  setFlowV1NodeAttemptAgentSession,
  startFlowV1Effect,
  startFlowV1NodeAttempt,
  transitionFlowV1Effect,
} from "@/lib/db/workflows/flow-attempts";
import { getFlowV1BundleForVersion } from "@/lib/db/workflows/flow-bundles";
import {
  claimFlowV1Tick,
  compareAndSetFlowV1CycleCheckpoint,
  finishFlowV1Tick,
  getFlowV1Cycle,
  getFlowV1CycleCheckpoint,
  pauseFlowV1TickOnError,
  startFlowV1Cycle,
  touchFlowV1TickClaim,
} from "@/lib/db/workflows/flow-runtime";
import { getCurrentFlowV1Params } from "@/lib/db/workflows/flow-settings";
import { hasWorkflowDiagnosticErrors } from "@/lib/workflow/validation";
import { runFlowV1CodeModule } from "./code-runner";
import {
  FLOW_V1_MEMORY_TEMPLATE_FILE,
  getFlowV1BundleFile,
} from "./bundle";
import {
  applyFlowV1NodeResult,
  createFlowV1GraphCheckpoint,
  incrementFlowV1NodeAttemptCount,
  markFlowV1NodeRunning,
  planFlowV1Graph,
  queueFlowV1Node,
  requeueUncertainFlowV1Effect,
  requeueWaitingFlowV1Node,
  resetQueuedFlowV1Nodes,
  setFlowV1NodeProgress,
} from "./graph-state";
import { parseFlowV1Bundle } from "./parser";
import { createFlowV1ReviewWorkspace } from "./review-workspace";
import { resolveFlowV1ExecutionConfig } from "./runtime-config";
import {
  applyFlowV1MemoryUpdates,
  getLatestFlowV1MemoryHashForCycle,
  initializeFlowV1Memory,
  readFlowV1Memory,
} from "./memory";
import type {
  FlowV1EffectApplyResult,
  FlowV1EffectReconcileResult,
  FlowV1GraphCheckpoint,
  FlowV1CompositeAgentStep,
  FlowV1HumanSpec,
  FlowV1JsonObject,
  FlowV1JsonValue,
  FlowV1Node,
  FlowV1NodeResult,
  FlowV1RunStopReason,
  ParsedFlowV1,
} from "./types";

export type FlowV1TickExecutionResult = {
  runId: string;
  cycleId: string;
  stopReason: FlowV1RunStopReason;
  executedNodeIds: string[];
  checkpointRevision: number;
  continuationRunId?: string;
};

export class FlowV1TickSupervisorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowV1TickSupervisorError";
    this.code = code;
  }
}

const activeTickControllers = (
  globalThis as typeof globalThis & {
    __flowV1TickControllers?: Map<string, AbortController>;
  }
).__flowV1TickControllers ??= new Map<string, AbortController>();

export function requestFlowV1TickCancellation(runId: string): boolean {
  const controller = activeTickControllers.get(runId);
  if (!controller) {
    return false;
  }
  controller.abort(
    new FlowV1TickSupervisorError(
      "flow_cycle_cancel_requested",
      `Cancellation was requested for Tick ${runId}.`,
    ),
  );
  return true;
}

export async function runFlowV1Tick(input: {
  runId: string;
  projectCwd?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultPermissionMode?: string;
  environment?: Record<string, string>;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
  immediateContinuationDepth?: number;
}): Promise<FlowV1TickExecutionResult> {
  const claim = claimFlowV1Tick({ runId: input.runId });
  if (!claim) {
    throw new FlowV1TickSupervisorError(
      "flow_tick_not_claimable",
      `Tick ${input.runId} is already owned or terminal.`,
    );
  }
  const { run, token } = claim;
  const ownershipAbort = new AbortController();
  activeTickControllers.set(run.id, ownershipAbort);
  const executionSignal = input.signal
    ? AbortSignal.any([input.signal, ownershipAbort.signal])
    : ownershipAbort.signal;
  const heartbeat = setInterval(() => {
    try {
      if (!touchFlowV1TickClaim({ runId: run.id, token })) {
        ownershipAbort.abort(
          new FlowV1TickSupervisorError(
            "flow_tick_ownership_lost",
            `Tick ${run.id} lost its execution lease.`,
          ),
        );
      }
    } catch (error) {
      ownershipAbort.abort(error);
    }
  }, 20_000);
  heartbeat.unref();
  try {
  const cycle = getFlowV1Cycle(run.cycleId);
  const bundle = getFlowV1BundleForVersion(run.flowVersionId);
  const storedCheckpoint = getFlowV1CycleCheckpoint(run.cycleId);
  if (!cycle || !bundle || !storedCheckpoint) {
    throw new FlowV1TickSupervisorError(
      "flow_runtime_state_missing",
      `Tick ${run.id} is missing its Cycle, Bundle, or Checkpoint.`,
    );
  }
  const flow = parseFlowV1Bundle(bundle);
  if (hasWorkflowDiagnosticErrors(flow.diagnostics)) {
    throw new FlowV1TickSupervisorError(
      "flow_bundle_invalid",
      `Pinned Bundle for Tick ${run.id} no longer passes static validation.`,
    );
  }
  const storedExecutionConfig = resolveFlowV1ExecutionConfig({
    flowId: cycle.flowId,
    flow,
  });
  const executionSecrets = {
    ...storedExecutionConfig.secrets,
    ...input.secrets,
  };
  const missingSecrets = storedExecutionConfig.missingSecretNames.filter(
    (name) => executionSecrets[name] === undefined,
  );
  if (missingSecrets.length > 0) {
    throw new FlowV1TickSupervisorError(
      "flow_secret_binding_missing",
      `Flow is missing required Secret bindings: ${missingSecrets.join(", ")}.`,
    );
  }
  const executionProjectCwd =
    input.projectCwd ?? storedExecutionConfig.projectCwd;
  if (flow.meta.requiresCwd && !executionProjectCwd) {
    throw new FlowV1TickSupervisorError(
      "flow_project_cwd_missing",
      "Flow requires a configured project cwd.",
    );
  }

  let checkpoint = readGraphCheckpoint(flow, storedCheckpoint.state);
  let revision = storedCheckpoint.revision;
  const executedNodeIds: string[] = [];
  for (const node of flow.nodes) {
    if (
      checkpoint.nodes[node.id]?.status === "waiting" &&
      (node.kind === "gate" ||
        node.kind === "human" ||
        node.kind === "loop" ||
        node.kind === "map")
    ) {
      checkpoint = requeueWaitingFlowV1Node(checkpoint, node.id);
    }
    if (
      checkpoint.nodes[node.id]?.status === "uncertain" &&
      node.kind === "effect"
    ) {
      checkpoint = requeueUncertainFlowV1Effect(checkpoint, node.id);
    }
  }

  const persist = (
    next: FlowV1GraphCheckpoint,
    status: Parameters<
      typeof compareAndSetFlowV1CycleCheckpoint
    >[0]["cycleStatus"],
    currentNodeId?: string | null,
    cycleOutcome?: string | null,
  ) => {
    const result = compareAndSetFlowV1CycleCheckpoint({
      cycleId: cycle.id,
      expectedRevision: revision,
      state: toJsonObject(next),
      cycleStatus: status,
      ...(currentNodeId !== undefined ? { currentNodeId } : {}),
      ...(cycleOutcome !== undefined ? { cycleOutcome } : {}),
      runId: run.id,
      ownerToken: token,
    });
    if (!result.updated) {
      throw new FlowV1TickSupervisorError(
        "flow_checkpoint_conflict",
        `Cycle ${cycle.id} Checkpoint changed during Tick ${run.id}.`,
      );
    }
    revision = result.checkpoint.revision;
    checkpoint = next;
  };

  let executions = 0;
  const runFinalizers = async (
    terminalStatus: "completed" | "failed" | "canceled",
  ): Promise<{ node: FlowV1Node; result: FlowV1NodeResult } | null> => {
    const finalizers = flow.nodes.filter(
      (node) =>
        node.kind === "finally" &&
        (node.runOn ?? ["completed", "failed", "canceled"]).includes(
          terminalStatus,
        ) &&
        !(terminalStatus === "failed" && node.retainOnFailure) &&
        checkpoint.nodes[node.id]?.status === "idle",
    );
    for (const node of finalizers) {
      checkpoint = queueFlowV1Node(checkpoint, node.id);
      checkpoint = markFlowV1NodeRunning(checkpoint, node.id);
      persist(checkpoint, "running", node.id);
      const nodeInput = resolveNodeInput(
        flow,
        checkpoint,
        node,
        cycle,
      );
      nodeInput.terminal = { status: terminalStatus };
      const attempt = startFlowV1NodeAttempt({
        cycleId: cycle.id,
        runId: run.id,
        ownerToken: token,
        nodeId: node.id,
        nodeInput,
      });
      const result = await executeNode({
        flow,
        node,
        nodeInput,
        versionId: run.flowVersionId,
        bundle,
        cycleId: cycle.id,
        runId: run.id,
        ownerToken: token,
        attemptId: attempt.id,
        projectCwd: executionProjectCwd,
        defaultAgent: input.defaultAgent,
        defaultModel: input.defaultModel,
        defaultPermissionMode: input.defaultPermissionMode,
        environment: input.environment,
        secrets: executionSecrets,
        signal:
          terminalStatus === "canceled" ? undefined : executionSignal,
      });
      finishFlowV1NodeAttempt({
        attemptId: attempt.id,
        ownerToken: token,
        status: attemptStatus(result),
        ...(result.status === "completed" && result.output !== undefined
          ? { output: result.output }
          : {}),
        ...(result.status === "failed" ||
        result.status === "uncertain" ||
        result.status === "conflict"
          ? { error: result.error }
          : {}),
      });
      checkpoint = applyFlowV1NodeResult(
        flow,
        checkpoint,
        node.id,
        result,
      );
      executedNodeIds.push(node.id);
      executions += 1;
      persist(checkpoint, "running", node.id);
      if (result.status !== "completed") {
        return { node, result };
      }
    }
    return null;
  };
  const finishCancellation = async (): Promise<FlowV1TickExecutionResult> => {
    checkpoint = resetQueuedFlowV1Nodes(checkpoint);
    const finalizerFailure = await runFinalizers("canceled");
    if (finalizerFailure) {
      persist(checkpoint, "paused_failed", finalizerFailure.node.id);
      finishOwnedTick(
        run.id,
        token,
        "failed",
        "paused_failed",
        finalizerFailure.node.id,
      );
      return {
        runId: run.id,
        cycleId: cycle.id,
        stopReason: "paused_failed",
        executedNodeIds,
        checkpointRevision: revision,
      };
    }
    persist(
      checkpoint,
      "canceled",
      cycle.currentNodeId,
      "canceled_by_user",
    );
    finishOwnedTick(
      run.id,
      token,
      "canceled",
      "cycle_canceled",
      cycle.currentNodeId,
    );
    return {
      runId: run.id,
      cycleId: cycle.id,
      stopReason: "cycle_canceled",
      executedNodeIds,
      checkpointRevision: revision,
    };
  };
  const finishNodeFailure = async (
    node: FlowV1Node,
    result: Extract<
      FlowV1NodeResult,
      { status: "failed" | "uncertain" | "conflict" }
    >,
  ): Promise<FlowV1TickExecutionResult> => {
    checkpoint = resetQueuedFlowV1Nodes(checkpoint);
    const finalizerFailure = await runFinalizers("failed");
    const effectiveResult = finalizerFailure?.result ?? result;
    const effectiveNode = finalizerFailure?.node ?? node;
    const cycleStatus =
      effectiveResult.status === "uncertain"
        ? "paused_uncertain"
        : effectiveResult.status === "conflict"
          ? "paused_conflict"
          : "paused_failed";
    persist(checkpoint, cycleStatus, effectiveNode.id);
    const stopReason =
      effectiveResult.status === "uncertain"
        ? "paused_uncertain"
        : effectiveResult.status === "conflict"
          ? "paused_conflict"
          : "paused_failed";
    finishOwnedTick(
      run.id,
      token,
      "failed",
      stopReason,
      effectiveNode.id,
    );
    return {
      runId: run.id,
      cycleId: cycle.id,
      stopReason,
      executedNodeIds,
      checkpointRevision: revision,
    };
  };

  if (isCycleCancellation(executionSignal.reason)) {
    return await finishCancellation();
  }

  while (executions < flow.runtime.maxNodeExecutionsPerTick) {
    let queued = flow.nodes.filter(
      (node) => checkpoint.nodes[node.id]?.status === "queued",
    );
    if (queued.length === 0) {
      const planned = planFlowV1Graph(flow, checkpoint);
      checkpoint = planned.checkpoint;
      queued = planned.readyNodeIds.map((nodeId) =>
        requireNode(flow, nodeId),
      );
    }
    if (queued.length === 0) {
      break;
    }

    const parallelNodes = queued
      .filter(isParallelReadyNode)
      .slice(
        0,
        Math.min(
          flow.runtime.maxParallelNodes,
          flow.runtime.maxNodeExecutionsPerTick - executions,
        ),
      );
    if (parallelNodes.length > 1) {
      const jobs = parallelNodes.map((node) => {
        checkpoint = markFlowV1NodeRunning(checkpoint, node.id);
        persist(checkpoint, "running", node.id);
        const nodeInput = resolveNodeInput(
          flow,
          checkpoint,
          node,
          cycle,
        );
        const agentPrompt =
          node.kind === "agent"
            ? renderAgentPrompt(
                flow,
                checkpoint,
                node,
                nodeInput,
                cycle,
              )
            : undefined;
        const attempt = startFlowV1NodeAttempt({
          cycleId: cycle.id,
          runId: run.id,
          ownerToken: token,
          nodeId: node.id,
          nodeInput,
        });
        return { node, nodeInput, agentPrompt, attempt };
      });
      const results = await Promise.all(
        jobs.map(async (job) => ({
          job,
          result: await executeNode({
            flow,
            node: job.node,
            nodeInput: job.nodeInput,
            versionId: run.flowVersionId,
            bundle,
            cycleId: cycle.id,
            runId: run.id,
            ownerToken: token,
            attemptId: job.attempt.id,
            projectCwd: executionProjectCwd,
            defaultAgent: input.defaultAgent,
            defaultModel: input.defaultModel,
            defaultPermissionMode: input.defaultPermissionMode,
            agentPrompt: job.agentPrompt,
            environment: input.environment,
            secrets: executionSecrets,
            signal: executionSignal,
          }),
        })),
      );
      for (const { job, result } of results) {
        finishFlowV1NodeAttempt({
          attemptId: job.attempt.id,
          ownerToken: token,
          status: attemptStatus(result),
          ...(result.status === "completed" &&
          result.output !== undefined
            ? { output: result.output }
            : {}),
          ...(result.status === "completed" && result.outcome
            ? { controlOutcome: result.outcome }
            : {}),
          ...(result.status === "failed" ||
          result.status === "uncertain" ||
          result.status === "conflict"
            ? { error: result.error }
            : {}),
        });
        checkpoint = applyFlowV1NodeResult(
          flow,
          checkpoint,
          job.node.id,
          result,
        );
        executedNodeIds.push(job.node.id);
        executions += 1;
        persist(checkpoint, "running", job.node.id);
      }
      if (isCycleCancellation(executionSignal.reason)) {
        return await finishCancellation();
      }
      const failed = results.find(
        (
          entry,
        ): entry is typeof entry & {
          result: Extract<
            FlowV1NodeResult,
            { status: "failed" | "uncertain" | "conflict" }
          >;
        } =>
          entry.result.status === "failed" ||
          entry.result.status === "uncertain" ||
          entry.result.status === "conflict",
      );
      if (failed) {
        return await finishNodeFailure(
          failed.job.node,
          failed.result,
        );
      }
      continue;
    }

    for (const node of queued) {
      if (executions >= flow.runtime.maxNodeExecutionsPerTick) {
        break;
      }
      checkpoint = markFlowV1NodeRunning(checkpoint, node.id);
      persist(checkpoint, "running", node.id);
      const nodeInput =
        node.kind === "complete_cycle" || node.kind === "cancel_cycle"
          ? {
              cycle: { id: cycle.id, sequence: cycle.sequence },
            }
          : resolveNodeInput(flow, checkpoint, node, cycle);
      const baseAgentPrompt =
        node.kind === "agent"
          ? renderAgentPrompt(flow, checkpoint, node, nodeInput, cycle)
          : undefined;
      let result: FlowV1NodeResult;
      let nodeAttempt = 0;
      let validationError: string | undefined;
      do {
        nodeAttempt += 1;
        const attempt = startFlowV1NodeAttempt({
          cycleId: cycle.id,
          runId: run.id,
          ownerToken: token,
          nodeId: node.id,
          nodeInput,
        });
        result = await executeNode({
          flow,
          node,
          nodeInput,
          versionId: run.flowVersionId,
          bundle,
          cycleId: cycle.id,
          runId: run.id,
          ownerToken: token,
          attemptId: attempt.id,
          projectCwd: executionProjectCwd,
          defaultAgent: input.defaultAgent,
          defaultModel: input.defaultModel,
          defaultPermissionMode: input.defaultPermissionMode,
          agentPrompt:
            baseAgentPrompt && validationError
              ? appendStructuredOutputCorrection(
                  baseAgentPrompt,
                  validationError,
                )
              : baseAgentPrompt,
          nodeProgress: checkpoint.nodes[node.id]?.progress,
          onNodeProgress: (progress) => {
            checkpoint = setFlowV1NodeProgress(
              checkpoint,
              node.id,
              progress,
            );
            persist(checkpoint, "running", node.id);
          },
          environment: input.environment,
          secrets: executionSecrets,
          signal: executionSignal,
        });
        finishFlowV1NodeAttempt({
          attemptId: attempt.id,
          ownerToken: token,
          status: attemptStatus(result),
          ...(result.status === "completed" &&
          result.output !== undefined
            ? { output: result.output }
            : {}),
          ...(result.status === "completed" && result.outcome
            ? { controlOutcome: result.outcome }
            : {}),
          ...(result.status === "failed" ||
          result.status === "uncertain" ||
          result.status === "conflict"
            ? { error: result.error }
            : {}),
        });
        executions += 1;
        if (
          !shouldRetryNode(node, result, nodeAttempt) ||
          executions >= flow.runtime.maxNodeExecutionsPerTick ||
          executionSignal.aborted
        ) {
          break;
        }
        validationError =
          node.kind === "agent" && result.status === "failed"
            ? result.error.message
            : undefined;
        checkpoint = incrementFlowV1NodeAttemptCount(
          checkpoint,
          node.id,
        );
        persist(checkpoint, "running", node.id);
        await waitForRetry(
          node.kind === "script" ? node.retry!.backoffMs : 0,
          executionSignal,
        );
      } while (true);
      checkpoint = applyFlowV1NodeResult(
        flow,
        checkpoint,
        node.id,
        result,
      );
      executedNodeIds.push(node.id);

      if (isCycleCancellation(executionSignal.reason)) {
        return await finishCancellation();
      }

      if (
        result.status === "failed" ||
        result.status === "uncertain" ||
        result.status === "conflict"
      ) {
        return await finishNodeFailure(node, result);
      }
      if (node.kind === "finally" && result.status === "completed") {
        const completedTerminal = flow.nodes.find(
          (candidate) =>
            candidate.kind === "complete_cycle" &&
            checkpoint.nodes[candidate.id]?.status === "completed",
        );
        const canceledTerminal = flow.nodes.find(
          (candidate) =>
            candidate.kind === "cancel_cycle" &&
            checkpoint.nodes[candidate.id]?.status === "completed",
        );
        const originalFailure = flow.nodes.find(
          (candidate) =>
            candidate.kind !== "finally" &&
            (checkpoint.nodes[candidate.id]?.status === "failed" ||
              checkpoint.nodes[candidate.id]?.status === "uncertain"),
        );
        const terminalStatus = completedTerminal
          ? "completed"
          : canceledTerminal
            ? "canceled"
            : originalFailure
              ? "failed"
              : null;
        if (terminalStatus) {
          const nextFinalizerFailure = await runFinalizers(terminalStatus);
          if (nextFinalizerFailure) {
            checkpoint = resetQueuedFlowV1Nodes(checkpoint);
            persist(
              checkpoint,
              nextFinalizerFailure.result.status === "uncertain"
                ? "paused_uncertain"
                : "paused_failed",
              nextFinalizerFailure.node.id,
            );
            const reason =
              nextFinalizerFailure.result.status === "uncertain"
                ? "paused_uncertain"
                : "paused_failed";
            finishOwnedTick(
              run.id,
              token,
              "failed",
              reason,
              nextFinalizerFailure.node.id,
            );
            return {
              runId: run.id,
              cycleId: cycle.id,
              stopReason: reason,
              executedNodeIds,
              checkpointRevision: revision,
            };
          }
          if (completedTerminal) {
            persist(
              checkpoint,
              "completed",
              completedTerminal.id,
              completedTerminal.terminalOutcome ?? "completed",
            );
            finishOwnedTick(
              run.id,
              token,
              "completed",
              "cycle_completed",
              completedTerminal.id,
            );
            const continuationRunId =
              completedTerminal.continueMode === "immediate" &&
              (input.immediateContinuationDepth ?? 0) <
                flow.runtime.maxImmediateContinuations
                ? await runImmediateContinuation({
                    previousCycleId: cycle.id,
                    flowId: cycle.flowId,
                    inputSnapshot: cycle.inputSnapshot,
                    projectCwd: executionProjectCwd,
                    defaultAgent: input.defaultAgent,
                    defaultModel: input.defaultModel,
                    defaultPermissionMode:
                      input.defaultPermissionMode,
                    environment: input.environment,
                    secrets: executionSecrets,
                    signal: executionSignal,
                    depth:
                      (input.immediateContinuationDepth ?? 0) + 1,
                  })
                : undefined;
            return {
              runId: run.id,
              cycleId: cycle.id,
              stopReason: "cycle_completed",
              executedNodeIds,
              checkpointRevision: revision,
              ...(continuationRunId ? { continuationRunId } : {}),
            };
          }
          if (canceledTerminal) {
            persist(
              checkpoint,
              "canceled",
              canceledTerminal.id,
              canceledTerminal.terminalOutcome ?? "canceled",
            );
            finishOwnedTick(
              run.id,
              token,
              "canceled",
              "cycle_canceled",
              canceledTerminal.id,
            );
            return {
              runId: run.id,
              cycleId: cycle.id,
              stopReason: "cycle_canceled",
              executedNodeIds,
              checkpointRevision: revision,
            };
          }
          if (originalFailure) {
            const originalState = checkpoint.nodes[originalFailure.id]!;
            const status =
              originalState.status === "uncertain"
                ? "paused_uncertain"
                : "paused_failed";
            persist(checkpoint, status, originalFailure.id);
            finishOwnedTick(
              run.id,
              token,
              "completed",
              status,
              originalFailure.id,
            );
            return {
              runId: run.id,
              cycleId: cycle.id,
              stopReason: status,
              executedNodeIds,
              checkpointRevision: revision,
            };
          }
        }
      }
      if (node.kind === "complete_cycle" && result.status === "completed") {
        const finalizerFailure = await runFinalizers("completed");
        if (finalizerFailure) {
          checkpoint = resetQueuedFlowV1Nodes(checkpoint);
          persist(checkpoint, "paused_failed", finalizerFailure.node.id);
          finishOwnedTick(
            run.id,
            token,
            "failed",
            "paused_failed",
            finalizerFailure.node.id,
          );
          return {
            runId: run.id,
            cycleId: cycle.id,
            stopReason: "paused_failed",
            executedNodeIds,
            checkpointRevision: revision,
          };
        }
        persist(
          checkpoint,
          "completed",
          node.id,
          result.outcome ?? node.terminalOutcome ?? "completed",
        );
        finishOwnedTick(
          run.id,
          token,
          "completed",
          "cycle_completed",
          node.id,
        );
        const continuationRunId =
          node.continueMode === "immediate" &&
          (input.immediateContinuationDepth ?? 0) <
            flow.runtime.maxImmediateContinuations
            ? await runImmediateContinuation({
                previousCycleId: cycle.id,
                flowId: cycle.flowId,
                inputSnapshot: cycle.inputSnapshot,
                projectCwd: executionProjectCwd,
                defaultAgent: input.defaultAgent,
                defaultModel: input.defaultModel,
                defaultPermissionMode: input.defaultPermissionMode,
                environment: input.environment,
                secrets: executionSecrets,
                signal: executionSignal,
                depth: (input.immediateContinuationDepth ?? 0) + 1,
              })
            : undefined;
        return {
          runId: run.id,
          cycleId: cycle.id,
          stopReason: "cycle_completed",
          executedNodeIds,
          checkpointRevision: revision,
          ...(continuationRunId ? { continuationRunId } : {}),
        };
      }
      if (node.kind === "cancel_cycle" && result.status === "completed") {
        const finalizerFailure = await runFinalizers("canceled");
        if (finalizerFailure) {
          checkpoint = resetQueuedFlowV1Nodes(checkpoint);
          persist(checkpoint, "paused_failed", finalizerFailure.node.id);
          finishOwnedTick(
            run.id,
            token,
            "failed",
            "paused_failed",
            finalizerFailure.node.id,
          );
          return {
            runId: run.id,
            cycleId: cycle.id,
            stopReason: "paused_failed",
            executedNodeIds,
            checkpointRevision: revision,
          };
        }
        persist(
          checkpoint,
          "canceled",
          node.id,
          result.outcome ?? node.terminalOutcome ?? "canceled",
        );
        finishOwnedTick(
          run.id,
          token,
          "canceled",
          "cycle_canceled",
          node.id,
        );
        return {
          runId: run.id,
          cycleId: cycle.id,
          stopReason: "cycle_canceled",
          executedNodeIds,
          checkpointRevision: revision,
        };
      }
      persist(
        checkpoint,
        result.status === "waiting"
          ? node.kind === "human" || node.kind === "loop"
            ? "waiting_human"
            : "waiting_gate"
          : "running",
        node.id,
      );
    }
  }

  const waiting = flow.nodes.find(
    (node) => checkpoint.nodes[node.id]?.status === "waiting",
  );
  if (waiting) {
    const waitingStatus =
      waiting.kind === "human" || waiting.kind === "loop"
        ? "waiting_human"
        : "waiting_gate";
    const waitingReason =
      waiting.kind === "human" || waiting.kind === "loop"
        ? "waiting_human"
        : "waiting_gate";
    persist(checkpoint, waitingStatus, waiting.id);
    finishOwnedTick(
      run.id,
      token,
      "completed",
      waitingReason,
      waiting.id,
    );
    return {
      runId: run.id,
      cycleId: cycle.id,
      stopReason: waitingReason,
      executedNodeIds,
      checkpointRevision: revision,
    };
  }

  checkpoint = resetQueuedFlowV1Nodes(checkpoint);
  persist(checkpoint, "paused_budget", cycle.currentNodeId);
  finishOwnedTick(
    run.id,
    token,
    "completed",
    "paused_budget",
    cycle.currentNodeId,
  );
  return {
    runId: run.id,
    cycleId: cycle.id,
    stopReason: "paused_budget",
    executedNodeIds,
    checkpointRevision: revision,
  };
  } catch (error) {
    pauseFlowV1TickOnError({
      runId: run.id,
      ownerToken: token,
      code: readErrorCode(error, "flow_tick_execution_failed"),
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (activeTickControllers.get(run.id) === ownershipAbort) {
      activeTickControllers.delete(run.id);
    }
  }
}

function isCycleCancellation(reason: unknown): boolean {
  return (
    reason instanceof FlowV1TickSupervisorError &&
    reason.code === "flow_cycle_cancel_requested"
  );
}

async function runImmediateContinuation(input: {
  previousCycleId: string;
  flowId: string;
  inputSnapshot: FlowV1JsonObject;
  projectCwd?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultPermissionMode?: string;
  environment?: Record<string, string>;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
  depth: number;
}): Promise<string> {
  const row = getDb()
    .prepare(
      `
      SELECT current_version_id, params_revision
      FROM workflows
      WHERE id = ? AND lifecycle = 'active'
    `,
    )
    .get(input.flowId) as
    | { current_version_id: string | null; params_revision: number }
    | undefined;
  if (!row?.current_version_id) {
    throw new FlowV1TickSupervisorError(
      "flow_continuation_not_runnable",
      `Flow ${input.flowId} is not active or has no published Version.`,
    );
  }
  const bundle = getFlowV1BundleForVersion(row.current_version_id);
  if (!bundle) {
    throw new FlowV1TickSupervisorError(
      "flow_continuation_bundle_missing",
      "Immediate continuation Version has no Bundle.",
    );
  }
  const flow = parseFlowV1Bundle(bundle);
  let memoryHashAtStart: string | undefined;
  if (flow.memory) {
    const template = getFlowV1BundleFile(
      bundle,
      FLOW_V1_MEMORY_TEMPLATE_FILE,
    );
    if (!template) {
      throw new FlowV1TickSupervisorError(
        "flow_memory_template_missing",
        "Immediate continuation Version has no Memory template.",
      );
    }
    memoryHashAtStart = initializeFlowV1Memory({
      flowId: input.flowId,
      template: template.content,
      definition: flow.memory,
    }).hash;
  }
  const params = getCurrentFlowV1Params(input.flowId);
  const next = startFlowV1Cycle({
    flowId: input.flowId,
    flowVersionId: row.current_version_id,
    origin: {
      kind: "continuation",
      previousCycleId: input.previousCycleId,
    },
    idempotencyKey: `continuation:${input.previousCycleId}`,
    inputSnapshot: input.inputSnapshot,
    paramsRevision: row.params_revision,
    paramsSnapshot: params?.values ?? {},
    memoryHashAtStart,
  });
  if (next.run.status === "pending") {
    await runFlowV1Tick({
      runId: next.run.id,
      projectCwd: input.projectCwd,
      defaultAgent: input.defaultAgent,
      defaultModel: input.defaultModel,
      defaultPermissionMode: input.defaultPermissionMode,
      environment: input.environment,
      secrets: input.secrets,
      signal: input.signal,
      immediateContinuationDepth: input.depth,
    });
  }
  return next.run.id;
}

async function executeNode(input: {
  flow: ParsedFlowV1;
  node: FlowV1Node;
  nodeInput: FlowV1JsonObject;
  versionId: string;
  bundle: NonNullable<ReturnType<typeof getFlowV1BundleForVersion>>;
  cycleId: string;
  runId: string;
  ownerToken: string;
  attemptId: string;
  projectCwd?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultPermissionMode?: string;
  agentPrompt?: string;
  nodeProgress?: FlowV1JsonObject;
  onNodeProgress?: (progress: FlowV1JsonObject) => void;
  environment?: Record<string, string>;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<FlowV1NodeResult> {
  if (
    input.node.kind === "complete_cycle" ||
    input.node.kind === "cancel_cycle"
  ) {
    return {
      status: "completed",
      ...(input.node.terminalOutcome
        ? { outcome: input.node.terminalOutcome }
        : {}),
    };
  }
  if (input.node.kind === "agent") {
    return executeAgent(input);
  }
  if (input.node.kind === "human") {
    return executeHuman(input);
  }
  if (input.node.kind === "remember") {
    return executeRemember(input);
  }
  if (input.node.kind === "loop") {
    return executeLoop(input);
  }
  if (input.node.kind === "map") {
    return executeMap(input);
  }
  if (
    input.node.kind === "script" ||
    input.node.kind === "transform" ||
    input.node.kind === "gate" ||
    input.node.kind === "finally"
  ) {
    if (!input.node.file) {
      return failure("flow_code_file_missing", "Code node has no file.");
    }
    try {
      const execution = await runFlowV1CodeModule({
        versionId: input.versionId,
        bundle: input.bundle,
        file: input.node.file,
        exportName: input.node.kind === "gate" ? "check" : "run",
        context: input.nodeInput,
        projectCwd: resolveWorkspaceCwd(
          input.node,
          input.nodeInput,
          input.projectCwd,
        ),
        environment: input.environment,
        secrets: input.secrets,
        signal: input.signal,
      });
      if (
        input.node.kind === "script" ||
        input.node.kind === "transform" ||
        input.node.kind === "finally"
      ) {
        return input.node.outcomes.length > 0
          ? readCodeOutcomeResult(input.node, execution.value)
          : { status: "completed", output: execution.value };
      }
      return readGateResult(input.node, execution.value);
    } catch (error) {
      return failure(
        readErrorCode(error, "flow_code_execution_failed"),
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (input.node.kind === "effect") {
    return await executeEffect(input);
  }
  return failure(
    "flow_node_kind_not_implemented",
    `Tick supervisor does not execute ${input.node.kind} nodes yet.`,
  );
}

function executeRemember(
  input: Parameters<typeof executeNode>[0],
): FlowV1NodeResult {
  if (!input.flow.memory || !input.node.memoryUpdates) {
    return failure(
      "flow_memory_contract_invalid",
      `Remember ${input.node.id} has no Memory declaration or updates.`,
    );
  }
  const cycle = getFlowV1Cycle(input.cycleId);
  const baseHash =
    getLatestFlowV1MemoryHashForCycle(input.cycleId) ??
    cycle?.memoryHashAtStart;
  if (!cycle || !baseHash) {
    return failure(
      "flow_memory_base_missing",
      `Remember ${input.node.id} has no Cycle Memory base hash.`,
    );
  }
  try {
    const updates = Object.entries(input.node.memoryUpdates).map(
      ([sectionId, update]) => {
        const raw =
          typeof update.value === "string"
            ? update.value
            : input.nodeInput[`$memory.${sectionId}`];
        if (raw === undefined) {
          throw new FlowV1TickSupervisorError(
            "flow_memory_update_unresolved",
            `Remember ${input.node.id} cannot resolve ${sectionId}.`,
          );
        }
        return {
          sectionId,
          mode: update.mode,
          markdown:
            typeof raw === "string" ? raw : JSON.stringify(raw, null, 2),
        };
      },
    );
    const result = applyFlowV1MemoryUpdates({
      flowId: cycle.flowId,
      cycleId: cycle.id,
      runId: input.runId,
      nodeId: input.node.id,
      definition: input.flow.memory,
      expectedBaseHash: baseHash,
      updates,
    });
    if (result.status === "conflict") {
      return {
        status: "conflict",
        error: {
          code: "flow_memory_conflict",
          message:
            "MEMORY.md changed since this Cycle read it; candidate update was retained.",
        },
      };
    }
    return {
      status: "completed",
      output: { memoryHash: result.resultHash },
    };
  } catch (error) {
    return failure(
      readErrorCode(error, "flow_memory_update_failed"),
      error instanceof Error ? error.message : String(error),
    );
  }
}

function executeHuman(
  input: Parameters<typeof executeNode>[0],
): FlowV1NodeResult {
  if (!input.node.human) {
    return failure(
      "flow_human_spec_missing",
      `Human ${input.node.id} has no valid task specification.`,
    );
  }
  const task = createOrGetFlowV1HumanTask({
    cycleId: input.cycleId,
    runId: input.runId,
    nodeId: input.node.id,
    executionKey: `cycle:${input.cycleId}:node:${input.node.id}`,
    spec: renderHumanSpec(input.node.human, input.nodeInput),
  });
  if (task.status === "pending") {
    return {
      status: "waiting",
      reason: `Human task ${task.id} is awaiting a response.`,
    };
  }
  if (task.status === "canceled" || !task.response) {
    return failure(
      "flow_human_task_canceled",
      `Human task ${task.id} was canceled.`,
    );
  }
  const output = {
    action: task.response.action,
    values: task.response.values,
  };
  return {
    status: "completed",
    ...(input.node.outcomes.includes(task.response.action)
      ? { outcome: task.response.action }
      : {}),
    output,
  };
}

type LoopProgress = {
  kind: "loop";
  iteration: number;
  stepIndex: number;
  outputs: Record<string, FlowV1JsonValue>;
  history: FlowV1JsonValue[];
};

async function executeLoop(
  input: Parameters<typeof executeNode>[0],
): Promise<FlowV1NodeResult> {
  const spec = input.node.loop;
  if (!spec || !input.onNodeProgress) {
    return failure(
      "flow_loop_contract_invalid",
      `Loop ${input.node.id} has no executable specification.`,
    );
  }
  const maxIterations =
    typeof spec.maxIterations === "number"
      ? spec.maxIterations
      : input.nodeInput["$loop.maxIterations"];
  if (
    typeof maxIterations !== "number" ||
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > 10
  ) {
    return failure(
      "flow_loop_max_iterations_invalid",
      `Loop ${input.node.id} maxIterations must resolve to an integer from 1 to 10.`,
    );
  }
  const recovered = readLoopProgress(input.nodeProgress);
  const firstStepIndex = spec.firstIterationStartAt
    ? spec.steps.findIndex(
        (step) => step.id === spec.firstIterationStartAt,
      )
    : 0;
  const progress: LoopProgress = recovered ?? {
    kind: "loop",
    iteration: 1,
    stepIndex: Math.max(0, firstStepIndex),
    outputs: {},
    history: [],
  };
  input.onNodeProgress(asProgress(progress));

  while (progress.iteration <= maxIterations) {
    while (progress.stepIndex < spec.steps.length) {
      const step = spec.steps[progress.stepIndex]!;
      const previousIteration = progress.history.at(-1) ?? null;
      const previousStep =
        isObject(previousIteration) && isObject(previousIteration.outputs)
          ? previousIteration.outputs[step.id] ?? null
          : null;
      const context: FlowV1JsonObject = {
        ...input.nodeInput,
        iteration: progress.iteration,
        history: progress.history,
        previousIteration,
        previousStep,
        previous:
          progress.stepIndex > 0
            ? progress.outputs[
                spec.steps[progress.stepIndex - 1]!.id
              ] ?? null
            : null,
        steps: progress.outputs,
      };
      if (step.kind === "human") {
        const task = createOrGetFlowV1HumanTask({
          cycleId: input.cycleId,
          runId: input.runId,
          nodeId: `${input.node.id}.${step.id}`,
          executionKey: `cycle:${input.cycleId}:loop:${input.node.id}:iteration:${progress.iteration}:step:${step.id}`,
          spec: renderHumanSpec(step.human, context),
        });
        if (task.status === "pending") {
          input.onNodeProgress(asProgress(progress));
          return {
            status: "waiting",
            reason: `Human task ${task.id} is awaiting a response.`,
          };
        }
        if (task.status === "canceled" || !task.response) {
          return failure(
            "flow_loop_human_canceled",
            `Loop Human task ${task.id} was canceled.`,
          );
        }
        progress.outputs[step.id] = {
          action: task.response.action,
          values: task.response.values,
        };
      } else {
        const result = await executeCompositeAgentStep({
          parent: input,
          step,
          context,
          executionId: `loop:${progress.iteration}:${step.id}`,
        });
        if (result.status !== "completed") {
          input.onNodeProgress(asProgress(progress));
          return result;
        }
        progress.outputs[step.id] = result.output ?? null;
      }
      progress.stepIndex += 1;
      input.onNodeProgress(asProgress(progress));
    }

    const sourceOutput = progress.outputs[spec.until.source];
    const matched =
      "finalStatus" in spec.until
        ? isObject(sourceOutput) &&
          sourceOutput.status === spec.until.finalStatus
        : isDeepStrictEqual(sourceOutput, spec.until.equals);
    progress.history.push({
      iteration: progress.iteration,
      outputs: progress.outputs,
    });
    if (matched) {
      return {
        status: "completed",
        outcome: "matched",
        output: {
          iterations: progress.iteration,
          final: sourceOutput ?? null,
          history: progress.history,
        },
      };
    }
    if (progress.iteration >= maxIterations) {
      if (spec.onMaxIterations === "complete") {
        return {
          status: "completed",
          outcome: "exhausted",
          output: {
            iterations: progress.iteration,
            final: sourceOutput ?? null,
            history: progress.history,
            maxIterationsReached: true,
          },
        };
      }
      return failure(
        "flow_loop_max_iterations",
        `Loop ${input.node.id} reached ${maxIterations} iterations.`,
      );
    }
    progress.iteration += 1;
    progress.stepIndex = 0;
    progress.outputs = {};
    input.onNodeProgress(asProgress(progress));
  }
  return failure(
    "flow_loop_state_invalid",
    `Loop ${input.node.id} has invalid progress.`,
  );
}

type MapProgress = {
  kind: "map";
  items: FlowV1JsonValue[];
  itemStates: Array<{
    index: number;
    item: FlowV1JsonValue;
    status: "pending" | "running" | "completed" | "rejected" | "failed";
    stepIndex: number;
    outputs: Record<string, FlowV1JsonValue>;
    error?: FlowV1JsonObject;
    failedStepId?: string;
  }>;
};

async function executeMap(
  input: Parameters<typeof executeNode>[0],
): Promise<FlowV1NodeResult> {
  const spec = input.node.map;
  if (!spec || !input.onNodeProgress) {
    return failure(
      "flow_map_contract_invalid",
      `Map ${input.node.id} has no executable specification.`,
    );
  }
  const rawItems = input.nodeInput["$map.source"];
  if (!Array.isArray(rawItems)) {
    return failure(
      "flow_map_source_invalid",
      `Map ${input.node.id} source must resolve to an array.`,
    );
  }
  if (rawItems.length > spec.maxItems) {
    return failure(
      "flow_map_item_limit",
      `Map ${input.node.id} received ${rawItems.length} items, above maxItems ${spec.maxItems}.`,
    );
  }
  const progress: MapProgress = readMapProgress(input.nodeProgress) ?? {
    kind: "map",
    items: rawItems,
    itemStates: rawItems.map((item, index) => ({
      index,
      item,
      status: "pending",
      stepIndex: 0,
      outputs: {},
    })),
  };
  if (
    !isDeepStrictEqual(progress.items, rawItems) ||
    progress.itemStates.length !== rawItems.length
  ) {
    return failure(
      "flow_map_source_changed",
      `Map ${input.node.id} source changed after progress was checkpointed.`,
    );
  }

  for (const state of progress.itemStates) {
    if (state.status === "running") {
      state.status = "pending";
    }
  }
  input.onNodeProgress(asProgress(progress));
  let nextIndex = 0;
  let fatalResult: FlowV1NodeResult | null = null;
  const takeNext = () => {
    while (nextIndex < progress.itemStates.length) {
      const state = progress.itemStates[nextIndex++]!;
      if (state.status === "pending") {
        return state;
      }
    }
    return null;
  };
  const worker = async () => {
    while (!fatalResult) {
      const state = takeNext();
      if (!state) {
        return;
      }
      state.status = "running";
      input.onNodeProgress!(asProgress(progress));
      while (state.stepIndex < spec.steps.length) {
        const step = spec.steps[state.stepIndex]!;
        const context: FlowV1JsonObject = {
          ...input.nodeInput,
          item: state.item,
          index: state.index,
          previous:
            state.stepIndex > 0
              ? state.outputs[
                  spec.steps[state.stepIndex - 1]!.id
                ] ?? null
              : null,
          steps: state.outputs,
        };
        const result = await executeCompositeAgentStep({
          parent: input,
          step,
          context,
          executionId: `map:${state.index}:${step.id}`,
        });
        if (result.status !== "completed") {
          const error =
            result.status === "failed" ||
            result.status === "uncertain" ||
            result.status === "conflict"
              ? result.error
              : {
                  code: "flow_map_step_incomplete",
                  message: result.reason,
                };
          state.status = "failed";
          state.error = error;
          state.failedStepId = step.id;
          input.onNodeProgress!(asProgress(progress));
          if (spec.onItemFailure === "fail") {
            fatalResult = result;
          }
          break;
        }
        state.outputs[step.id] = result.output ?? null;
        state.stepIndex += 1;
        input.onNodeProgress!(asProgress(progress));
      }
      if (state.status === "running") {
        const semanticOutcome = spec.itemOutcome
          ? readPath(
              state.outputs,
              spec.itemOutcome.source.split(".").filter(Boolean),
            )
          : undefined;
        if (
          typeof semanticOutcome === "string" &&
          spec.itemOutcome?.rejected.includes(semanticOutcome)
        ) {
          state.status = "rejected";
          if (spec.onItemRejected === "fail") {
            fatalResult = failure(
              "flow_map_item_rejected",
              `Map ${input.node.id} item ${state.index} was rejected with ${semanticOutcome}.`,
            );
          }
        } else if (
          spec.itemOutcome &&
          (typeof semanticOutcome !== "string" ||
            !spec.itemOutcome.success.includes(semanticOutcome))
        ) {
          state.status = "failed";
          state.error = {
            code: "flow_map_item_outcome_invalid",
            message: `Map item outcome ${String(semanticOutcome)} is not declared successful or rejected.`,
          };
          if (spec.onItemFailure === "fail") {
            fatalResult = failure(
              "flow_map_item_outcome_invalid",
              String(state.error.message),
            );
          }
        } else {
          state.status = "completed";
        }
        input.onNodeProgress!(asProgress(progress));
      }
    }
  };
  const workerCount = Math.min(
    spec.execution?.access === "write" &&
      spec.execution.isolation === "required"
      ? 1
      : input.flow.runtime.maxParallelNodes,
    progress.itemStates.filter((state) => state.status === "pending").length,
  );
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );
  if (fatalResult) {
    return fatalResult;
  }
  const completed = progress.itemStates
    .filter((state) => state.status === "completed")
    .map((state) => {
      const lastStep = spec.steps.at(-1)!;
      return {
        index: state.index,
        item: state.item,
        output: state.outputs[lastStep.id] ?? null,
        steps: state.outputs,
      };
    });
  const failed = progress.itemStates
    .filter((state) => state.status === "failed")
    .map((state) => ({
      index: state.index,
      item: state.item,
      stepId: state.failedStepId ?? null,
      error: state.error ?? {
        code: "flow_map_item_failed",
        message: "Map item failed without a structural error.",
      },
    }));
  const rejected = progress.itemStates
    .filter((state) => state.status === "rejected")
    .map((state) => {
      const lastStep = spec.steps.at(-1)!;
      return {
        index: state.index,
        item: state.item,
        output: state.outputs[lastStep.id] ?? null,
        steps: state.outputs,
      };
    });
  const outcome =
    completed.length === progress.items.length
      ? "all_succeeded"
      : rejected.length === progress.items.length
        ? "all_rejected"
        : "partial";
  return {
    status: "completed",
    outcome,
    output: {
      succeeded: completed,
      rejected,
      failed,
      total: progress.items.length,
      outcome,
    },
  };
}

async function executeCompositeAgentStep(input: {
  parent: Parameters<typeof executeNode>[0];
  step: FlowV1CompositeAgentStep;
  context: FlowV1JsonObject;
  executionId: string;
}): Promise<FlowV1NodeResult> {
  if (input.parent.nodeProgress) {
    const recovered = listFlowV1NodeAttempts(input.parent.cycleId)
      .filter(
        (attempt) =>
          attempt.nodeId ===
            `${input.parent.node.id}.${input.step.id}` &&
          attempt.status === "completed" &&
          isDeepStrictEqual(attempt.input, input.context),
      )
      .at(-1);
    if (recovered) {
      return {
        status: "completed",
        output: recovered.output ?? null,
      };
    }
  }
  const parentWorkspaceCwd = resolveWorkspaceCwd(
    input.parent.node,
    input.parent.nodeInput,
    input.parent.projectCwd,
  );
  const cwd = input.step.cwd
    ? path.resolve(
        parentWorkspaceCwd,
        input.step.cwd,
      )
    : parentWorkspaceCwd;
  let reviewWorkspace: Awaited<
    ReturnType<typeof createFlowV1ReviewWorkspace>
  > | null = null;
  if (
    input.step.execution?.access === "review" &&
    input.step.execution.isolation === "required"
  ) {
    try {
      reviewWorkspace = await createFlowV1ReviewWorkspace(cwd);
    } catch (error) {
      return failure(
        "flow_review_workspace_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const executionCwd = reviewWorkspace?.cwd ?? cwd;
  const basePrompt = renderCompositeTemplate(
    input.step.prompt,
    input.context,
  );
  const maxAttempts =
    input.step.output?.kind === "json"
      ? structuredValidationMaxAttempts(input.step.output)
      : 1;
  let validationError: string | undefined;
  try {
  for (let validationAttempt = 1; validationAttempt <= maxAttempts; validationAttempt += 1) {
    const attempt = startFlowV1NodeAttempt({
      cycleId: input.parent.cycleId,
      runId: input.parent.runId,
      ownerToken: input.parent.ownerToken,
      nodeId: `${input.parent.node.id}.${input.step.id}`,
      nodeInput: input.context,
    });
    let text = "";
    let result: FlowV1NodeResult;
    try {
      for await (const event of runAgent({
        runId: `${input.parent.runId}:${input.parent.node.id}:${input.executionId}:validation-${validationAttempt}`,
        agent:
          resolveAgentSetting(
            input.step.agent,
            input.parent.nodeInput,
            `$config.${input.step.id}.agent`,
          ) ?? input.parent.defaultAgent ?? "mock",
        cwd: executionCwd,
        prompt: validationError
          ? appendStructuredOutputCorrection(basePrompt, validationError)
          : basePrompt,
        title: input.step.label,
        model:
          resolveAgentSetting(
            input.step.model,
            input.parent.nodeInput,
            `$config.${input.step.id}.model`,
          ) ?? input.parent.defaultModel,
        permissionMode:
          resolveAgentSetting(
            input.step.permissionMode,
            input.parent.nodeInput,
            `$config.${input.step.id}.permissionMode`,
          ) ??
          input.parent.defaultPermissionMode,
        signal: input.parent.signal,
        metadata: {
          flowVersionId: input.parent.versionId,
          cycleId: input.parent.cycleId,
          tickId: input.parent.runId,
          nodeId: input.parent.node.id,
          compositeExecutionId: input.executionId,
          attemptId: attempt.id,
        },
      })) {
        if (event.type === "session_ref") {
          setFlowV1NodeAttemptAgentSession({
            attemptId: attempt.id,
            ownerToken: input.parent.ownerToken,
            agentSessionId: event.session.agentSessionId,
          });
        } else if (event.type === "text_delta") {
          text += event.text;
        } else if (event.type === "error") {
          result = failure(event.code, event.message);
          finishCompositeAttempt(input.parent.ownerToken, attempt.id, result);
          return result;
        } else if (
          event.type === "done" &&
          (event.status === "failed" || event.status === "canceled")
        ) {
          result = failure(
            event.status === "canceled"
              ? "flow_agent_canceled"
              : "flow_agent_failed",
            event.reason ?? `Agent ${input.step.id} ${event.status}.`,
          );
          finishCompositeAttempt(input.parent.ownerToken, attempt.id, result);
          return result;
        }
      }
      if (input.step.output?.kind === "json") {
        result = readStructuredAgentOutput(
          input.step.id,
          text,
          input.step.output.schema,
        );
      } else {
        result = { status: "completed", output: text };
      }
    } catch (error) {
      result = failure(
        readErrorCode(error, "flow_agent_execution_failed"),
        error instanceof Error ? error.message : String(error),
      );
    }
    finishCompositeAttempt(input.parent.ownerToken, attempt.id, result);
    if (
      result.status !== "failed" ||
      result.error.retryable !== true ||
      validationAttempt >= maxAttempts
    ) {
      return result;
    }
    validationError = result.error.message;
  }
  return failure(
    "flow_agent_json_invalid",
    `Agent ${input.step.id} exhausted structured output validation attempts.`,
  );
  } finally {
    await reviewWorkspace?.cleanup();
  }
}

function finishCompositeAttempt(
  ownerToken: string,
  attemptId: string,
  result: FlowV1NodeResult,
) {
  finishFlowV1NodeAttempt({
    attemptId,
    ownerToken,
    status: attemptStatus(result),
    ...(result.status === "completed" && result.output !== undefined
      ? { output: result.output }
      : {}),
    ...(result.status === "failed" ||
    result.status === "uncertain" ||
    result.status === "conflict"
      ? { error: result.error }
      : {}),
  });
}

function renderCompositeTemplate(
  template: string,
  context: FlowV1JsonObject,
): string {
  return template.replace(
    /\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}\}/g,
    (_match, expression: string) => {
      const value = readContextReference(context, expression);
      if (value === undefined) {
        throw new FlowV1TickSupervisorError(
          "flow_composite_prompt_reference_unresolved",
          `Cannot resolve ${expression} in composite prompt.`,
        );
      }
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  );
}

function resolveAgentSetting(
  setting: FlowV1Node["agent"],
  nodeInput: FlowV1JsonObject,
  inputKey: string,
): string | undefined {
  if (typeof setting === "string") {
    return setting;
  }
  if (!setting) {
    return undefined;
  }
  const resolved = nodeInput[inputKey];
  return typeof resolved === "string" && resolved.trim()
    ? resolved
    : undefined;
}

function resolveWorkspaceCwd(
  node: FlowV1Node,
  nodeInput: FlowV1JsonObject,
  projectCwd?: string,
): string {
  const base = path.resolve(projectCwd ?? process.cwd());
  if (!node.workspace) {
    return base;
  }
  const workspace = nodeInput["$workspace"];
  if (!isObject(workspace) || typeof workspace.path !== "string") {
    throw new FlowV1TickSupervisorError(
      "flow_workspace_invalid",
      `Node ${node.id} workspace must resolve to an object containing path.`,
    );
  }
  const resolved = path.resolve(base, workspace.path);
  if (
    node.execution?.isolation === "required" &&
    resolved === base
  ) {
    throw new FlowV1TickSupervisorError(
      "flow_workspace_not_isolated",
      `Node ${node.id} requires an isolated workspace.`,
    );
  }
  return resolved;
}

function readLoopProgress(
  value: FlowV1JsonObject | undefined,
): LoopProgress | null {
  if (
    !value ||
    value.kind !== "loop" ||
    typeof value.iteration !== "number" ||
    typeof value.stepIndex !== "number" ||
    !isObject(value.outputs) ||
    !Array.isArray(value.history)
  ) {
    return null;
  }
  return structuredClone(value) as unknown as LoopProgress;
}

function readMapProgress(
  value: FlowV1JsonObject | undefined,
): MapProgress | null {
  if (
    !value ||
    value.kind !== "map" ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.itemStates) ||
    !value.itemStates.every(
      (state) =>
        isObject(state) &&
        typeof state.index === "number" &&
        (state.status === "pending" ||
          state.status === "running" ||
          state.status === "completed" ||
          state.status === "failed") &&
        typeof state.stepIndex === "number" &&
        isObject(state.outputs),
    )
  ) {
    return null;
  }
  return structuredClone(value) as unknown as MapProgress;
}

function asProgress(
  value: LoopProgress | MapProgress,
): FlowV1JsonObject {
  return structuredClone(value) as unknown as FlowV1JsonObject;
}

function renderHumanSpec(
  spec: FlowV1HumanSpec,
  context: FlowV1JsonObject,
) {
  return {
    ...(spec.description ? { description: spec.description } : {}),
    context: spec.context.map((item) => ({
      label: item.label,
      value: renderHumanContextValue(item.value, context),
      display: item.display,
    })),
    actions: spec.actions,
  };
}

function renderHumanContextValue(
  template: string,
  context: FlowV1JsonObject,
): FlowV1JsonValue {
  const exact = template.match(
    /^\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}\}$/,
  );
  if (exact) {
    const value = readContextReference(context, exact[1]!);
    return value ?? template;
  }
  return template.replace(
    /\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}\}/g,
    (_match, expression: string) => {
      const value = readContextReference(context, expression);
      if (value === undefined) {
        return `{{${expression}}}`;
      }
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  );
}

function readContextReference(
  context: FlowV1JsonObject,
  expression: string,
): FlowV1JsonValue | undefined {
  const [source, ...parts] = expression.split(".");
  return source ? readPath(context[source], parts) : undefined;
}

async function executeAgent(
  input: Parameters<typeof executeNode>[0],
): Promise<FlowV1NodeResult> {
  if (!input.agentPrompt) {
    return failure(
      "flow_agent_prompt_missing",
      `Agent ${input.node.id} has no prompt.`,
    );
  }
  const workspaceCwd = resolveWorkspaceCwd(
    input.node,
    input.nodeInput,
    input.projectCwd,
  );
  const cwd = input.node.cwd
    ? path.resolve(workspaceCwd, input.node.cwd)
    : workspaceCwd;
  let reviewWorkspace: Awaited<
    ReturnType<typeof createFlowV1ReviewWorkspace>
  > | null = null;
  if (
    input.node.execution?.access === "review" &&
    input.node.execution.isolation === "required"
  ) {
    try {
      reviewWorkspace = await createFlowV1ReviewWorkspace(cwd);
    } catch (error) {
      return failure(
        "flow_review_workspace_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const executionCwd = reviewWorkspace?.cwd ?? cwd;
  let text = "";
  try {
    for await (const event of runAgent({
      runId: `${input.runId}:${input.node.id}:${input.attemptId}`,
      agent:
        resolveAgentSetting(
          input.node.agent,
          input.nodeInput,
          "$config.agent",
        ) ?? input.defaultAgent ?? "mock",
      cwd: executionCwd,
      prompt: input.agentPrompt,
      title: input.node.label,
      model:
        resolveAgentSetting(
          input.node.model,
          input.nodeInput,
          "$config.model",
        ) ?? input.defaultModel,
      permissionMode:
        resolveAgentSetting(
          input.node.permissionMode,
          input.nodeInput,
          "$config.permissionMode",
        ) ?? input.defaultPermissionMode,
      signal: input.signal,
      metadata: {
        flowVersionId: input.versionId,
        cycleId: input.cycleId,
        tickId: input.runId,
        nodeId: input.node.id,
        attemptId: input.attemptId,
      },
    })) {
      if (event.type === "session_ref") {
        setFlowV1NodeAttemptAgentSession({
          attemptId: input.attemptId,
          ownerToken: input.ownerToken,
          agentSessionId: event.session.agentSessionId,
        });
      } else if (event.type === "text_delta") {
        text += event.text;
      } else if (event.type === "error") {
        return failure(event.code, event.message);
      } else if (
        event.type === "done" &&
        (event.status === "failed" || event.status === "canceled")
      ) {
        return failure(
          event.status === "canceled"
            ? "flow_agent_canceled"
            : "flow_agent_failed",
          event.reason ?? `Agent ${input.node.id} ${event.status}.`,
        );
      }
    }
  } catch (error) {
    return failure(
      readErrorCode(error, "flow_agent_execution_failed"),
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await reviewWorkspace?.cleanup();
  }
  if (input.node.output?.kind !== "json") {
    return { status: "completed", output: text };
  }
  return readStructuredAgentOutput(
    input.node.id,
    text,
    input.node.output.schema,
  );
}

async function executeEffect(
  input: Parameters<typeof executeNode>[0],
): Promise<FlowV1NodeResult> {
  if (!input.node.file || !input.node.idempotencyKey) {
    return failure(
      "flow_effect_contract_invalid",
      `Effect ${input.node.id} has no file or idempotency key.`,
    );
  }
  const idempotencyKey = resolveIdempotencyKey(
    input.node.idempotencyKey,
    input.cycleId,
  );
  const ledger = startFlowV1Effect({
    cycleId: input.cycleId,
    runId: input.runId,
    ownerToken: input.ownerToken,
    nodeId: input.node.id,
    attemptId: input.attemptId,
    idempotencyKey,
  }).effect;
  if (ledger.status === "completed") {
    return { status: "completed", output: ledger.result ?? undefined };
  }
  try {
    if (
      ledger.status === "starting" &&
      ledger.attemptId !== input.attemptId
    ) {
      const reconciled = await runEffectReconcile(input, ledger);
      if (reconciled.status === "completed") {
        transitionFlowV1Effect({
          effectId: ledger.id,
          runId: input.runId,
          ownerToken: input.ownerToken,
          status: "completed",
          externalRef: reconciled.externalRef,
          result: reconciled.output,
        });
        return { status: "completed", output: reconciled.output };
      }
      if (reconciled.status === "unknown") {
        return uncertain("flow_effect_reconcile_unknown", reconciled.reason);
      }
    } else if (ledger.status === "uncertain") {
      const reconciled = await runEffectReconcile(input, ledger);
      if (reconciled.status === "completed") {
        transitionFlowV1Effect({
          effectId: ledger.id,
          runId: input.runId,
          ownerToken: input.ownerToken,
          status: "completed",
          externalRef: reconciled.externalRef,
          result: reconciled.output,
        });
        return { status: "completed", output: reconciled.output };
      }
      if (reconciled.status === "unknown") {
        return uncertain("flow_effect_reconcile_unknown", reconciled.reason);
      }
    } else if (ledger.status === "failed") {
      return failure(
        "flow_effect_failed",
        `Effect ${input.node.id} previously failed.`,
      );
    }

    const execution = await runFlowV1CodeModule({
      versionId: input.versionId,
      bundle: input.bundle,
      file: input.node.file,
      exportName: "apply",
      context: input.nodeInput,
      projectCwd: resolveWorkspaceCwd(
        input.node,
        input.nodeInput,
        input.projectCwd,
      ),
      environment: input.environment,
      secrets: input.secrets,
      signal: input.signal,
    });
    const applied = readEffectApplyResult(execution.value);
    transitionFlowV1Effect({
      effectId: ledger.id,
      runId: input.runId,
      ownerToken: input.ownerToken,
      status: "completed",
      externalRef: applied.externalRef,
      result: applied.output,
    });
    return { status: "completed", output: applied.output };
  } catch (error) {
    transitionFlowV1Effect({
      effectId: ledger.id,
      runId: input.runId,
      ownerToken: input.ownerToken,
      status: "uncertain",
      error: {
        code: readErrorCode(error, "flow_effect_apply_uncertain"),
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return uncertain(
      readErrorCode(error, "flow_effect_apply_uncertain"),
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function runEffectReconcile(
  input: Parameters<typeof executeNode>[0],
  ledger: ReturnType<typeof startFlowV1Effect>["effect"],
): Promise<FlowV1EffectReconcileResult> {
  const execution = await runFlowV1CodeModule({
    versionId: input.versionId,
    bundle: input.bundle,
    file: input.node.file!,
    exportName: "reconcile",
    context: {
      ...input.nodeInput,
      effect: {
        idempotencyKey: ledger.idempotencyKey,
        externalRef: ledger.externalRef,
        result: ledger.result,
      },
    },
    projectCwd: resolveWorkspaceCwd(
      input.node,
      input.nodeInput,
      input.projectCwd,
    ),
    environment: input.environment,
    secrets: input.secrets,
    signal: input.signal,
  });
  return readEffectReconcileResult(execution.value);
}

function resolveNodeInput(
  flow: ParsedFlowV1,
  checkpoint: FlowV1GraphCheckpoint,
  node: FlowV1Node,
  cycle: NonNullable<ReturnType<typeof getFlowV1Cycle>>,
): FlowV1JsonObject {
  const result: FlowV1JsonObject = {};
  for (const [name, reference] of Object.entries(node.inputs)) {
    if (name.startsWith("$prompt.") || name.startsWith("$human.")) {
      continue;
    }
    const sourceNodeId = flow.variableToNodeId[reference.source];
    let value: FlowV1JsonValue | undefined;
    if (sourceNodeId) {
      value = checkpoint.nodes[sourceNodeId]?.output;
    } else if (reference.source === "params") {
      value = cycle.paramsSnapshot;
    } else if (reference.source === "inputs") {
      value = cycle.inputSnapshot;
    } else if (reference.source === "cycle") {
      value = {
        id: cycle.id,
        sequence: cycle.sequence,
      };
    }
    value = readPath(value, reference.path);
    if (value === undefined) {
      throw new FlowV1TickSupervisorError(
        "flow_node_input_unresolved",
        `Node ${node.id} input ${name} cannot resolve ${reference.expression}.`,
      );
    }
    result[name] = value;
  }
  result.cycle = { id: cycle.id, sequence: cycle.sequence };
  result.params = cycle.paramsSnapshot;
  result.inputs = cycle.inputSnapshot;
  return result;
}

function renderAgentPrompt(
  flow: ParsedFlowV1,
  checkpoint: FlowV1GraphCheckpoint,
  node: FlowV1Node,
  nodeInput: FlowV1JsonObject,
  cycle: NonNullable<ReturnType<typeof getFlowV1Cycle>>,
): string {
  if (!node.prompt) {
    return "";
  }
  const prompt = node.prompt.replace(
    /\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}\}/g,
    (_match, expression: string) => {
      const reference = {
        expression,
        source: expression.split(".")[0]!,
        path: expression.split(".").slice(1),
      };
      const localValue = nodeInput[reference.source];
      const value =
        localValue !== undefined
          ? readPath(localValue, reference.path)
          : resolveFlowReference(flow, checkpoint, reference, cycle);
      if (value === undefined) {
        throw new FlowV1TickSupervisorError(
          "flow_agent_prompt_reference_unresolved",
          `Agent ${node.id} cannot resolve ${expression}.`,
        );
      }
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  );
  if (!node.memorySections?.length) {
    return prompt;
  }
  if (!flow.memory) {
    throw new FlowV1TickSupervisorError(
      "flow_memory_not_declared",
      `Agent ${node.id} requests Memory but the Flow has none.`,
    );
  }
  const memory = readFlowV1Memory(cycle.flowId, flow.memory);
  const sections = node.memorySections.map((sectionId) => {
    const definition = flow.memory!.sections[sectionId];
    return [
      `## ${definition?.title ?? sectionId}`,
      memory.sections[sectionId] ?? "",
    ].join("\n");
  });
  return [
    prompt,
    "",
    `<flow-memory sha256="${memory.hash}">`,
    ...sections,
    "</flow-memory>",
  ].join("\n");
}

function resolveFlowReference(
  flow: ParsedFlowV1,
  checkpoint: FlowV1GraphCheckpoint,
  reference: { source: string; path: string[] },
  cycle: NonNullable<ReturnType<typeof getFlowV1Cycle>>,
): FlowV1JsonValue | undefined {
  const sourceNodeId = flow.variableToNodeId[reference.source];
  let value: FlowV1JsonValue | undefined;
  if (sourceNodeId) {
    value = checkpoint.nodes[sourceNodeId]?.output;
  } else if (reference.source === "params") {
    value = cycle.paramsSnapshot;
  } else if (reference.source === "inputs") {
    value = cycle.inputSnapshot;
  } else if (reference.source === "cycle") {
    value = { id: cycle.id, sequence: cycle.sequence };
  }
  return readPath(value, reference.path);
}

function readGraphCheckpoint(
  flow: ParsedFlowV1,
  value: FlowV1JsonObject,
): FlowV1GraphCheckpoint {
  if (!("nodes" in value)) {
    return createFlowV1GraphCheckpoint(flow);
  }
  const checkpoint = value as unknown as FlowV1GraphCheckpoint;
  for (const node of flow.nodes) {
    if (!checkpoint.nodes?.[node.id]) {
      throw new FlowV1TickSupervisorError(
        "flow_checkpoint_invalid",
        `Checkpoint is missing node ${node.id}.`,
      );
    }
  }
  return structuredClone(checkpoint);
}

function readGateResult(
  node: FlowV1Node,
  value: FlowV1JsonValue,
): FlowV1NodeResult {
  if (!isObject(value) || typeof value.status !== "string") {
    return failure(
      "flow_gate_result_invalid",
      `Gate ${node.id} returned an invalid result.`,
    );
  }
  if (
    value.status === "waiting" &&
    typeof value.reason === "string" &&
    value.reason.trim()
  ) {
    return { status: "waiting", reason: value.reason };
  }
  if (
    value.status === "completed" &&
    typeof value.outcome === "string" &&
    node.outcomes.includes(value.outcome) &&
    (value.output === undefined || isJsonValue(value.output))
  ) {
    return {
      status: "completed",
      outcome: value.outcome,
      ...(value.output !== undefined ? { output: value.output } : {}),
    };
  }
  return failure(
    "flow_gate_result_invalid",
    `Gate ${node.id} returned an invalid status or outcome.`,
  );
}

function readCodeOutcomeResult(
  node: FlowV1Node,
  value: FlowV1JsonValue,
): FlowV1NodeResult {
  if (
    !isObject(value) ||
    typeof value.outcome !== "string" ||
    !node.outcomes.includes(value.outcome) ||
    (value.output !== undefined && !isJsonValue(value.output))
  ) {
    return failure(
      "flow_code_outcome_invalid",
      `${node.kind} ${node.id} returned an invalid or undeclared outcome.`,
    );
  }
  return {
    status: "completed",
    outcome: value.outcome,
    ...(value.output !== undefined ? { output: value.output } : {}),
  };
}

function readEffectApplyResult(
  value: FlowV1JsonValue,
): FlowV1EffectApplyResult {
  if (
    !isObject(value) ||
    (value.externalRef !== undefined &&
      typeof value.externalRef !== "string") ||
    (value.output !== undefined && !isJsonValue(value.output))
  ) {
    throw new FlowV1TickSupervisorError(
      "flow_effect_result_invalid",
      "Effect apply() returned an invalid result.",
    );
  }
  return {
    ...(typeof value.externalRef === "string"
      ? { externalRef: value.externalRef }
      : {}),
    ...(value.output !== undefined ? { output: value.output } : {}),
  };
}

function readEffectReconcileResult(
  value: FlowV1JsonValue,
): FlowV1EffectReconcileResult {
  if (!isObject(value) || typeof value.status !== "string") {
    throw new FlowV1TickSupervisorError(
      "flow_effect_reconcile_invalid",
      "Effect reconcile() returned an invalid result.",
    );
  }
  if (value.status === "not_applied") {
    return { status: "not_applied" };
  }
  if (value.status === "unknown" && typeof value.reason === "string") {
    return { status: "unknown", reason: value.reason };
  }
  if (
    value.status === "completed" &&
    (value.externalRef === undefined ||
      typeof value.externalRef === "string") &&
    (value.output === undefined || isJsonValue(value.output))
  ) {
    return {
      status: "completed",
      ...(typeof value.externalRef === "string"
        ? { externalRef: value.externalRef }
        : {}),
      ...(value.output !== undefined ? { output: value.output } : {}),
    };
  }
  throw new FlowV1TickSupervisorError(
    "flow_effect_reconcile_invalid",
    "Effect reconcile() returned an invalid result.",
  );
}

function resolveIdempotencyKey(
  value: NonNullable<FlowV1Node["idempotencyKey"]>,
  cycleId: string,
): string {
  if (typeof value === "string") {
    return value.replaceAll("{{cycle.id}}", cycleId);
  }
  if (value.expression === "cycle.id") {
    return cycleId;
  }
  throw new FlowV1TickSupervisorError(
    "flow_effect_idempotency_unresolved",
    `Cannot resolve Effect idempotency key ${value.expression}.`,
  );
}

function finishOwnedTick(
  runId: string,
  ownerToken: string,
  status: "completed" | "failed" | "canceled",
  stopReason: FlowV1RunStopReason,
  currentNodeId: string | null,
): void {
  const finished = finishFlowV1Tick({
    runId,
    ownerToken,
    status,
    stopReason,
    result: { currentNodeId, stopReason },
  });
  if (!finished.transitioned) {
    throw new FlowV1TickSupervisorError(
      "flow_tick_ownership_lost",
      `Tick ${runId} lost ownership before finalization.`,
    );
  }
}

function attemptStatus(
  result: FlowV1NodeResult,
): "completed" | "failed" | "waiting" | "uncertain" | "not_selected" {
  switch (result.status) {
    case "completed":
      return "completed";
    case "waiting":
      return "waiting";
    case "uncertain":
      return "uncertain";
    case "conflict":
      return "failed";
    case "skipped":
      return "not_selected";
    case "failed":
      return "failed";
  }
}

function shouldRetryNode(
  node: FlowV1Node,
  result: FlowV1NodeResult,
  attempt: number,
): boolean {
  const scriptRetry =
    node.kind === "script" &&
    result.status === "failed" &&
    node.retry !== undefined &&
    attempt < node.retry.maxAttempts &&
    node.retry.errorCodes.includes(result.error.code);
  const structuredAgentRetry =
    node.kind === "agent" &&
    node.output?.kind === "json" &&
    result.status === "failed" &&
    result.error.retryable === true &&
    attempt < structuredValidationMaxAttempts(node.output);
  return scriptRetry || structuredAgentRetry;
}

function isParallelReadyNode(node: FlowV1Node): boolean {
  return (
    (node.kind === "agent" &&
      !(
        node.output?.kind === "json" &&
        structuredValidationMaxAttempts(node.output) > 1
      )) ||
    (node.kind === "script" && node.retry === undefined) ||
    node.kind === "gate" ||
    node.kind === "effect"
  );
}

function structuredValidationMaxAttempts(
  output: Extract<NonNullable<FlowV1Node["output"]>, { kind: "json" }>,
): number {
  return output.validationMaxAttempts ?? (output.schema ? 2 : 1);
}

function appendStructuredOutputCorrection(
  prompt: string,
  validationError: string,
): string {
  return `${prompt}

Your previous response was rejected by deterministic output validation:
${validationError}
Return only one corrected JSON value matching the declared schema.`;
}

async function waitForRetry(
  backoffMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (backoffMs <= 0 || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, backoffMs);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function readStructuredAgentOutput(
  nodeId: string,
  text: string,
  schema?: FlowV1JsonObject,
): FlowV1NodeResult {
  const parsed = extractJsonValue(text);
  if (parsed === undefined || !isJsonValue(parsed)) {
    return {
      status: "failed",
      error: {
        code: "flow_agent_json_invalid",
        message: `Agent ${nodeId} did not return a valid JSON value.`,
        retryable: true,
      },
    };
  }
  const schemaError = schema ? validateJsonSchema(parsed, schema, "$") : null;
  if (schemaError) {
    return {
      status: "failed",
      error: {
        code: "flow_agent_json_schema_invalid",
        message: `Agent ${nodeId} output failed schema validation: ${schemaError}`,
        retryable: true,
      },
    };
  }
  return { status: "completed", output: parsed };
}

function extractJsonValue(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].at(
    -1,
  )?.[1];
  if (fenced) candidates.push(fenced.trim());
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next deterministic candidate.
    }
  }
  return undefined;
}

function validateJsonSchema(
  value: FlowV1JsonValue,
  schema: FlowV1JsonObject,
  pathLabel: string,
): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => isDeepStrictEqual(entry, value))) {
    return `${pathLabel} must be one of the declared enum values`;
  }
  const type = schema.type;
  if (typeof type === "string") {
    const matches =
      type === "object"
        ? isObject(value)
        : type === "array"
          ? Array.isArray(value)
          : type === "string"
            ? typeof value === "string"
            : type === "number"
              ? typeof value === "number"
              : type === "integer"
                ? typeof value === "number" && Number.isInteger(value)
                : type === "boolean"
                  ? typeof value === "boolean"
                  : type === "null"
                    ? value === null
                    : true;
    if (!matches) return `${pathLabel} must be ${type}`;
  }
  if (isObject(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    for (const key of required) {
      if (!(key in value)) return `${pathLabel}.${key} is required`;
    }
    if (isObject(schema.properties)) {
      for (const [key, childSchema] of Object.entries(schema.properties)) {
        if (key in value && isObject(childSchema)) {
          const error = validateJsonSchema(value[key]!, childSchema, `${pathLabel}.${key}`);
          if (error) return error;
        }
      }
    }
  }
  if (Array.isArray(value) && isObject(schema.items)) {
    for (const [index, item] of value.entries()) {
      const error = validateJsonSchema(item, schema.items, `${pathLabel}[${index}]`);
      if (error) return error;
    }
  }
  return null;
}

function failure(code: string, message: string): FlowV1NodeResult {
  return { status: "failed", error: { code, message } };
}

function uncertain(code: string, message: string): FlowV1NodeResult {
  return { status: "uncertain", error: { code, message } };
}

function readErrorCode(error: unknown, fallback: string): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : fallback;
}

function readPath(
  value: FlowV1JsonValue | undefined,
  parts: string[],
): FlowV1JsonValue | undefined {
  let current = value;
  for (const part of parts) {
    if (!isObject(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function isObject(
  value: FlowV1JsonValue | undefined,
): value is FlowV1JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is FlowV1JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(isJsonValue)
  );
}

function requireNode(flow: ParsedFlowV1, nodeId: string): FlowV1Node {
  const node = flow.nodes.find((entry) => entry.id === nodeId);
  if (!node) {
    throw new Error(`Flow node ${nodeId} was not found.`);
  }
  return node;
}

function toJsonObject(value: FlowV1GraphCheckpoint): FlowV1JsonObject {
  return JSON.parse(JSON.stringify(value)) as FlowV1JsonObject;
}
