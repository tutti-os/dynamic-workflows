import { randomUUID } from "node:crypto";
import {
  cancelWorkflowRunAndHumanTasks,
  claimWorkflowRunForResume,
  claimWorkflowRunForRetry,
  createWorkflowRun,
  deleteWorkflowRunCheckpoint,
  finalizeWorkflowRunExecution,
  getWorkflowRun,
  isWorkflowRunExecutionClaimed,
  isWorkflowRunExecutionOwned,
  listWorkflowRunCheckpoints,
  markWorkflowRunInterrupted,
  markWorkflowRunWaitingOwned,
  releaseWorkflowRunResumeClaim,
  touchWorkflowRunExecutionClaim,
  upsertWorkflowRunCheckpoint,
  updateWorkflowRun,
} from "@/lib/db/workflows/runs";
import {
  createOrGetWorkflowHumanTask,
} from "@/lib/db/workflows/human-tasks";
import {
  getWorkflowVersion,
} from "@/lib/db/workflows/versions";
import type {
  WorkflowRunCheckpointRecord,
  WorkflowRunRecord,
  WorkflowVersionRecord,
} from "@/lib/db/workflows/types";
import {
  workflowMapNodeInvalidError,
  workflowMapRetryInvalidError,
  workflowRetryFromNodeInvalidError,
  workflowRetryNodeInvalidError,
  workflowRunNotFoundError,
  workflowVersionNotFoundError,
} from "@/lib/api/app-error";
import type { AppError } from "@/lib/api/app-error";
import { resolveWorkflowCwdFrom } from "@/lib/workflow/cwd";
import { createWorkflowExecutionPlan } from "@/lib/workflow/execution-plan";
import { runWorkflow } from "@/lib/workflow/executor";
import {
  appendRunLogEvent,
  ensureRunLogDirectory,
  readRunLog,
} from "@/lib/workflow/run-log";
import {
  applyWorkflowRunEvent,
  createInitialRunSummary,
  parseRunLogEvents,
  readRunResult,
  toWorkflowRunResult,
  type WorkflowRunSummary,
} from "@/lib/workflow/run-state";
import { assertWorkflowScriptValid } from "@/lib/workflow/parser";
import { formatRunError, getRunErrorCode } from "@/lib/workflow/run-response";
import {
  createLoopStepSessionNodeId,
  resolveLoopStepSessionSpec,
  resolveSessionKey,
} from "@/lib/workflow/session";
import type {
  WorkflowInputValue,
  WorkflowNode,
  WorkflowLoopRecoveryState,
  WorkflowMapRecoveryState,
  WorkflowRunEvent,
  WorkflowRunRecoveryState,
} from "@/lib/workflow/types";

export type WorkflowRunJobOptions = {
  workflowId: string;
  version: WorkflowVersionRecord;
  agent?: string;
  model?: string;
  cwd: string;
  executorKind: string;
  inputs: Record<string, WorkflowInputValue>;
  input: unknown;
  recovery?: WorkflowRunRecoveryState;
  initialSummary?: WorkflowRunSummary;
};

type RunSubscriber = (event: WorkflowRunEvent, entryId: string) => void;

type ActiveRunJob = {
  abortController: AbortController;
  executionToken: string;
  subscribers: Set<RunSubscriber>;
  wakeRequested: boolean;
  ownershipLost: boolean;
};

const globalForRunJobs = globalThis as typeof globalThis & {
  __dynamicWorkflowRunJobs?: Map<string, ActiveRunJob>;
};

const jobs =
  globalForRunJobs.__dynamicWorkflowRunJobs ??
  new Map<string, ActiveRunJob>();
globalForRunJobs.__dynamicWorkflowRunJobs = jobs;

export function startWorkflowRunJob(
  options: WorkflowRunJobOptions,
): WorkflowRunRecord {
  const executionToken = randomUUID();
  const run = createWorkflowRun({
    workflowId: options.workflowId,
    workflowVersionId: options.version.id,
    executorKind: options.executorKind,
    agent: options.agent,
    model: options.model,
    cwd: options.cwd,
    request: options.input,
    executionToken,
  });
  ensureRunLogDirectory(run.logPath);

  const job: ActiveRunJob = {
    abortController: new AbortController(),
    executionToken,
    subscribers: new Set(),
    wakeRequested: false,
    ownershipLost: false,
  };
  jobs.set(run.id, job);

  void executeWorkflowRunJob(run, options, job);
  return run;
}

export async function resumeWorkflowRunJob(input: {
  workflowId: string;
  runId: string;
}): Promise<WorkflowRunRecord> {
  return resumeWorkflowRunJobInternal(input, false);
}

export async function resumeWorkflowRunAfterHumanTask(input: {
  workflowId: string;
  runId: string;
}): Promise<WorkflowRunRecord> {
  const active = jobs.get(input.runId);
  if (active) {
    active.wakeRequested = true;
    const run = getWorkflowRun(input.runId);
    if (!run) {
      throw workflowRunNotFoundError();
    }
    return run;
  }
  return resumeWorkflowRunJobInternal(input, true);
}

async function resumeWorkflowRunJobInternal(input: {
  workflowId: string;
  runId: string;
}, allowWaiting: boolean): Promise<WorkflowRunRecord> {
  const activeRun = getWorkflowRun(input.runId);
  if (!activeRun || activeRun.workflowId !== input.workflowId) {
    throw workflowRunNotFoundError();
  }
  if (jobs.has(activeRun.id)) {
    return activeRun;
  }
  if (
    activeRun.status !== "running" &&
    activeRun.status !== "interrupted" &&
    !(allowWaiting && activeRun.status === "waiting_for_human")
  ) {
    throw new Error("Only interrupted workflow runs can be resumed.");
  }

  const version = getWorkflowVersion(activeRun.workflowVersionId);
  if (!version || version.workflowId !== input.workflowId) {
    throw workflowVersionNotFoundError();
  }

  const job: ActiveRunJob = {
    abortController: new AbortController(),
    executionToken: "",
    subscribers: new Set(),
    wakeRequested: false,
    ownershipLost: false,
  };
  const claim = claimWorkflowRunForResume({
    workflowId: input.workflowId,
    runId: activeRun.id,
  });
  if (!claim) {
    return getWorkflowRun(activeRun.id) ?? activeRun;
  }
  job.executionToken = claim.token;
  jobs.set(activeRun.id, job);
  const run = claim.run;

  try {
    const log = await readRunLog(run.logPath);
    const snapshot = createRunRecoveryState({
      run,
      version,
      log,
      checkpoints: listWorkflowRunCheckpoints(run.id),
    });
    if (snapshot.terminalSummary) {
      jobs.delete(run.id);
      return reconcileWorkflowRunFromTerminalLog(
        run,
        snapshot.terminalSummary,
        claim.token,
      );
    }

    ensureRunLogDirectory(run.logPath);

    void executeWorkflowRunJob(
      run,
      {
        workflowId: run.workflowId,
        version,
        agent: run.agent ?? undefined,
        model: run.model ?? undefined,
        cwd: run.cwd ?? process.cwd(),
        executorKind: run.executorKind,
        inputs: readRunInputs(run.input),
        input: run.input,
        recovery: snapshot.recovery,
        initialSummary: snapshot.summary,
      },
      job,
    );
    return run;
  } catch (error) {
    releaseWorkflowRunResumeClaim({
      runId: run.id,
      token: claim.token,
    });
    jobs.delete(run.id);
    markWorkflowRunInterrupted({
      runId: run.id,
      result: run.result ?? undefined,
    });
    throw error;
  }
}

/**
 * Retry the failed items of a map node by riding the existing recovery
 * machinery: rewrite the stored map checkpoint with the failed completions
 * removed, mark the map node and every node downstream of it as not-completed
 * (so recovery re-runs the cleared items and downstream re-runs on the
 * corrected map output), and relaunch the same run's execution. Upstream
 * completed nodes keep their outputs.
 *
 * Precondition: the run is in a terminal state and its map checkpoint has at
 * least one failed item.
 */
export async function retryFailedMapItems(input: {
  workflowId: string;
  runId: string;
  mapNodeId: string;
}): Promise<WorkflowRunRecord> {
  const { run, version, executableNodes } = loadTerminalRunForRetry({
    workflowId: input.workflowId,
    runId: input.runId,
    invalid: workflowMapRetryInvalidError,
    activeMessage:
      "This run is still executing and cannot retry map items yet.",
    terminalMessage:
      "Only a terminal workflow run can retry failed map items.",
  });

  const mapNode = executableNodes.find((node) => node.id === input.mapNodeId);
  if (!mapNode || mapNode.kind !== "map" || !mapNode.map) {
    throw workflowMapNodeInvalidError(
      `"${input.mapNodeId}" is not a map node in this run.`,
    );
  }

  const checkpoints = listWorkflowRunCheckpoints(run.id);
  const mapCheckpoint = checkpoints.find(
    (checkpoint) =>
      checkpoint.nodeId === input.mapNodeId &&
      checkpoint.checkpoint.kind === "map",
  );
  const mapState =
    mapCheckpoint?.checkpoint.kind === "map"
      ? mapCheckpoint.checkpoint.state
      : undefined;
  const keptCompletions =
    mapState?.completions.filter(
      (completion) => completion.status !== "failed",
    ) ?? [];
  const hasFailedItems =
    (mapState?.completions.length ?? 0) > keptCompletions.length;
  if (!mapState || !hasFailedItems) {
    throw workflowMapRetryInvalidError(
      `Map "${input.mapNodeId}" has no failed items to retry.`,
    );
  }

  // Mark the map node and every node downstream of it as not-completed while
  // upstream stays completed. Downstream stale outputs are dropped so they
  // cannot leak into re-run prompts; each node re-runs and refreshes its own.
  const resetNodeIds = computeDownstreamResetNodeIds(
    executableNodes,
    input.mapNodeId,
  );
  const baseSummary = await reconstructTerminalRunSummary({ run, version });

  return relaunchWorkflowRunFromReset({
    run,
    version,
    baseSummary,
    resetNodeIds,
    // Rewrite the map checkpoint with the failed completions removed so
    // recovery treats the cleared items as pending and re-runs only those.
    // (Failed-item retry PRESERVES completed items — unlike retry-from-node,
    // which deletes reset checkpoints entirely.)
    mutateCheckpoints: () => {
      upsertWorkflowRunCheckpoint({
        runId: run.id,
        nodeId: input.mapNodeId,
        checkpoint: {
          kind: "map",
          state: { items: mapState.items, completions: keptCompletions },
        },
      });
    },
  });
}

/**
 * Retry a terminal run from an arbitrary executable node: reset that node plus
 * its transitive dataflow dependents to a fresh (queued, no output, no session)
 * state, delete the checkpoints of every reset node (loop iterations and map
 * expansions are stale once an upstream re-runs), and relaunch the run through
 * the normal recovery path. Upstream nodes keep their outputs and never re-run;
 * inherited session keys they established survive so a reset continuing-role
 * node resumes the kept upstream session.
 *
 * Preconditions: the run is terminal; the node exists and is executable; no
 * node in the reset set is a human node (v1 restriction); and every transitive
 * upstream input source of the node completed in the reconstructed summary.
 */
export async function retryWorkflowRunFromNode(input: {
  workflowId: string;
  runId: string;
  fromNodeId: string;
}): Promise<WorkflowRunRecord> {
  const { run, version, executableNodes } = loadTerminalRunForRetry({
    workflowId: input.workflowId,
    runId: input.runId,
    invalid: workflowRetryFromNodeInvalidError,
    activeMessage:
      "This run is still executing and cannot be retried from a node yet.",
    terminalMessage:
      "Only a terminal workflow run can be retried from a node.",
  });

  const fromNode = executableNodes.find(
    (node) => node.id === input.fromNodeId,
  );
  if (!fromNode) {
    throw workflowRetryNodeInvalidError(
      `"${input.fromNodeId}" is not an executable node in this run.`,
    );
  }

  const resetNodeIds = computeDownstreamResetNodeIds(
    executableNodes,
    input.fromNodeId,
  );

  // v1 restriction: reject if the node itself or any reset dependent is a human
  // node. Re-running a resolved human gate would let the old task satisfy the
  // same executionKey instantly, approving content the human never saw.
  const humanNodeIds = executableNodes
    .filter((node) => resetNodeIds.has(node.id) && node.kind === "human")
    .map((node) => node.id);
  if (humanNodeIds.length > 0) {
    throw workflowRetryFromNodeInvalidError(
      `Cannot retry from "${input.fromNodeId}" because it would re-run human ` +
        `node(s) ${formatNodeIdList(humanNodeIds)}. Re-running a resolved ` +
        `human gate is not supported yet.`,
    );
  }

  // Upstream-completed precondition: every transitive input source of the node
  // must be completed in the reconstructed summary (the source of truth), or
  // the resumed run would stall on unresolved dependencies.
  const baseSummary = await reconstructTerminalRunSummary({ run, version });
  const executableNodeIds = new Set(executableNodes.map((node) => node.id));
  const upstreamSources = computeTransitiveInputSources(
    executableNodes,
    input.fromNodeId,
  );
  const incompleteUpstream = [...upstreamSources].filter(
    (nodeId) =>
      executableNodeIds.has(nodeId) &&
      baseSummary.nodeStatuses[nodeId] !== "completed",
  );
  if (incompleteUpstream.length > 0) {
    throw workflowRetryFromNodeInvalidError(
      `Cannot retry from "${input.fromNodeId}" because upstream ` +
        `node(s) ${formatNodeIdList(incompleteUpstream)} did not complete.`,
    );
  }

  return relaunchWorkflowRunFromReset({
    run,
    version,
    baseSummary,
    resetNodeIds,
    // Delete the checkpoint of every reset node: a loop's iteration progress and
    // a map's item expansion are both stale once an upstream re-runs, and a map
    // downstream of the reset origin must re-resolve its source from scratch.
    mutateCheckpoints: () => {
      for (const nodeId of resetNodeIds) {
        deleteWorkflowRunCheckpoint({ runId: run.id, nodeId });
      }
    },
  });
}

/**
 * Validate that a run is a terminal, non-active retry candidate and return the
 * parsed execution plan. Shared by the failed-item and from-node retry entries;
 * the `invalid` factory decides which 409 error code the non-terminal / active
 * rejections carry.
 */
function loadTerminalRunForRetry(input: {
  workflowId: string;
  runId: string;
  invalid: (message: string) => AppError;
  activeMessage: string;
  terminalMessage: string;
}): {
  run: WorkflowRunRecord;
  version: WorkflowVersionRecord;
  executableNodes: WorkflowNode[];
} {
  const run = getWorkflowRun(input.runId);
  if (!run || run.workflowId !== input.workflowId) {
    throw workflowRunNotFoundError();
  }
  if (jobs.has(run.id)) {
    throw input.invalid(input.activeMessage);
  }
  if (
    run.status !== "completed" &&
    run.status !== "failed" &&
    run.status !== "canceled"
  ) {
    throw input.invalid(input.terminalMessage);
  }

  const version = getWorkflowVersion(run.workflowVersionId);
  if (!version || version.workflowId !== input.workflowId) {
    throw workflowVersionNotFoundError();
  }

  const parsed = assertWorkflowScriptValid(version.script);
  const { executableNodes } = createWorkflowExecutionPlan(parsed);
  return { run, version, executableNodes };
}

/**
 * Reconstruct the run summary from its log and persisted result. The recovery
 * state's summary — NOT the persisted result alone — is the source of truth for
 * node statuses/outputs used by both retry preconditions and the reset.
 */
async function reconstructTerminalRunSummary(input: {
  run: WorkflowRunRecord;
  version: WorkflowVersionRecord;
}): Promise<WorkflowRunSummary> {
  const log = await readRunLog(input.run.logPath);
  return createRunRecoveryState({
    run: input.run,
    version: input.version,
    log,
    checkpoints: listWorkflowRunCheckpoints(input.run.id),
  }).summary;
}

/**
 * Shared reset/claim/resume plumbing behind both retry entries: reset the given
 * nodes in the summary, atomically claim the run back to running, mutate the
 * run's checkpoints (each entry decides how), rebuild recovery state, and
 * relaunch execution on the same run. Upstream completed nodes keep their
 * outputs and sessions.
 */
async function relaunchWorkflowRunFromReset(input: {
  run: WorkflowRunRecord;
  version: WorkflowVersionRecord;
  baseSummary: WorkflowRunSummary;
  resetNodeIds: Set<string>;
  mutateCheckpoints: () => void;
}): Promise<WorkflowRunRecord> {
  const { run, version } = input;
  const resetSummary = resetSummaryForRetry(
    input.baseSummary,
    input.resetNodeIds,
  );

  const claim = claimWorkflowRunForRetry({
    workflowId: run.workflowId,
    runId: run.id,
    result: toWorkflowRunResult(resetSummary),
  });
  if (!claim) {
    return getWorkflowRun(run.id) ?? run;
  }

  const job: ActiveRunJob = {
    abortController: new AbortController(),
    executionToken: claim.token,
    subscribers: new Set(),
    wakeRequested: false,
    ownershipLost: false,
  };
  jobs.set(run.id, job);

  try {
    input.mutateCheckpoints();

    const snapshot = createRecoveryStateFromSummary({
      run: claim.run,
      version,
      summary: resetSummary,
      checkpoints: listWorkflowRunCheckpoints(run.id),
    });

    ensureRunLogDirectory(run.logPath);
    void executeWorkflowRunJob(
      claim.run,
      {
        workflowId: run.workflowId,
        version,
        agent: run.agent ?? undefined,
        model: run.model ?? undefined,
        cwd: run.cwd ?? process.cwd(),
        executorKind: run.executorKind,
        inputs: readRunInputs(run.input),
        input: run.input,
        recovery: snapshot.recovery,
        initialSummary: { ...resetSummary, status: "running" },
      },
      job,
    );
    return claim.run;
  } catch (error) {
    releaseWorkflowRunResumeClaim({ runId: run.id, token: claim.token });
    if (jobs.get(run.id) === job) {
      jobs.delete(run.id);
    }
    throw error;
  }
}

function formatNodeIdList(nodeIds: string[]): string {
  return nodeIds.map((nodeId) => `"${nodeId}"`).join(", ");
}

/**
 * The origin node plus the transitive set of nodes that consume its output
 * (directly or through intermediate nodes), following dataflow input edges.
 */
function computeDownstreamResetNodeIds(
  nodes: WorkflowNode[],
  originNodeId: string,
): Set<string> {
  const dependentsBySource = new Map<string, string[]>();
  for (const node of nodes) {
    for (const nodeInput of node.inputs) {
      if (!nodeInput.sourceNodeId) {
        continue;
      }
      const dependents = dependentsBySource.get(nodeInput.sourceNodeId) ?? [];
      dependents.push(node.id);
      dependentsBySource.set(nodeInput.sourceNodeId, dependents);
    }
  }

  const reset = new Set<string>([originNodeId]);
  const queue = [originNodeId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of dependentsBySource.get(current) ?? []) {
      if (!reset.has(dependent)) {
        reset.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return reset;
}

/**
 * The transitive set of nodes whose output feeds the target node, following
 * dataflow input edges backward. Used to verify the target's upstream all
 * completed before a retry-from-node resumes.
 */
function computeTransitiveInputSources(
  nodes: WorkflowNode[],
  targetNodeId: string,
): Set<string> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const sources = new Set<string>();
  const queue = [targetNodeId];
  const seen = new Set<string>([targetNodeId]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const nodeInput of nodesById.get(current)?.inputs ?? []) {
      const sourceNodeId = nodeInput.sourceNodeId;
      if (sourceNodeId && !seen.has(sourceNodeId)) {
        seen.add(sourceNodeId);
        sources.add(sourceNodeId);
        queue.push(sourceNodeId);
      }
    }
  }
  return sources;
}

function resetSummaryForRetry(
  summary: WorkflowRunSummary,
  resetNodeIds: Set<string>,
): WorkflowRunSummary {
  const nodeStatuses = { ...summary.nodeStatuses };
  const outputs = { ...summary.outputs };
  const nodeSessions = { ...summary.nodeSessions };
  for (const nodeId of resetNodeIds) {
    nodeStatuses[nodeId] = "queued";
    delete outputs[nodeId];
    // Drop the node's session record too: a queued node with a lingering
    // session would be treated as crash recovery and ATTACH to the old agent
    // session, harvesting its stale output instead of re-running with the
    // corrected prompt.
    delete nodeSessions[nodeId];
  }
  return {
    ...summary,
    status: "running",
    error: undefined,
    errorCode: undefined,
    nodeStatuses,
    outputs,
    nodeSessions,
  };
}

export async function markWorkflowRunInterruptedIfStale(
  run: WorkflowRunRecord,
): Promise<WorkflowRunRecord> {
  if (
    run.status !== "running" ||
    jobs.has(run.id) ||
    isWorkflowRunExecutionClaimed(run.id)
  ) {
    return run;
  }
  const version = getWorkflowVersion(run.workflowVersionId);
  const log = await readRunLog(run.logPath);
  const snapshot = version
    ? createRunRecoveryState({
        run,
        version,
        log,
        checkpoints: listWorkflowRunCheckpoints(run.id),
      })
    : undefined;
  if (snapshot?.terminalSummary) {
    return reconcileWorkflowRunFromTerminalLog(run, snapshot.terminalSummary);
  }
  const summary = snapshot?.summary ??
    createInitialRunSummary(undefined, {
        status: "interrupted",
        queueExecutableNodes: false,
      });
  summary.status = "interrupted";
  summary.error = "Workflow runner was interrupted. Resume this run.";
  summary.errorCode = "WORKFLOW_RUN_FAILED";
  return (
    markWorkflowRunInterrupted({
      runId: run.id,
      result: toWorkflowRunResult(summary),
    }) ?? run
  );
}

/**
 * Reconcile a collection of run records before returning it from a list
 * endpoint. Only `running` candidates are considered (there should be few), and
 * each is routed through {@link markWorkflowRunInterruptedIfStale}, which is a
 * no-op unless the run has no in-process job AND no fresh execution claim from
 * another process/heartbeat. A run legitimately claimed elsewhere stays
 * running; a genuine zombie is marked interrupted so lists stop showing it as
 * running forever.
 */
export async function reconcileStaleRunningRuns(
  runs: WorkflowRunRecord[],
): Promise<WorkflowRunRecord[]> {
  return Promise.all(
    runs.map((run) =>
      run.status === "running"
        ? markWorkflowRunInterruptedIfStale(run)
        : Promise.resolve(run),
    ),
  );
}

export function cancelWorkflowRunJob(runId: string): boolean {
  const job = jobs.get(runId);
  if (!job) {
    return false;
  }
  job.abortController.abort();
  return true;
}

export function cancelWorkflowRun(runId: string): WorkflowRunRecord | null {
  const active = jobs.get(runId);
  const run = getWorkflowRun(runId);
  if (!run) {
    return null;
  }
  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "canceled"
  ) {
    return run;
  }
  let summary: WorkflowRunSummary = {
    status: run.status,
    ...readRunResult(run.result),
  };
  const event: WorkflowRunEvent = {
    type: "run_completed",
    runId,
    status: "canceled",
    outputs: summary.outputs,
    error: "Run canceled.",
    errorCode: "WORKFLOW_RUN_FAILED",
  };
  summary = applyWorkflowRunEvent(summary, event);
  const canceled = cancelWorkflowRunAndHumanTasks({
    runId,
    result: toWorkflowRunResult(summary),
  });
  if (active && canceled.transitioned) {
    active.abortController.abort();
  } else if (canceled.transitioned) {
    appendRunLogEvent(run.logPath, event);
  }
  return canceled.run;
}

export function subscribeWorkflowRunJob(
  runId: string,
  subscriber: RunSubscriber,
): () => void {
  const job = jobs.get(runId);
  if (!job) {
    return () => {};
  }
  job.subscribers.add(subscriber);
  return () => {
    job.subscribers.delete(subscriber);
  };
}

export function isWorkflowRunJobActive(runId: string): boolean {
  return jobs.has(runId);
}

async function executeWorkflowRunJob(
  run: WorkflowRunRecord,
  options: WorkflowRunJobOptions,
  job: ActiveRunJob,
) {
  const heartbeat = setInterval(() => {
    try {
      const owned = touchWorkflowRunExecutionClaim({
        runId: run.id,
        executionToken: job.executionToken,
      });
      if (!owned) {
        if (getWorkflowRun(run.id)?.status === "canceled") {
          job.abortController.abort();
        } else {
          loseWorkflowRunOwnership(job);
        }
      }
    } catch {
      loseWorkflowRunOwnership(job);
    }
  }, 15_000);
  heartbeat.unref();
  let executionOptions = options;
  let summary =
    executionOptions.initialSummary ??
    createInitialRunSummary(undefined, {
      status: "running",
      queueExecutableNodes: false,
    });
  summary = {
    ...summary,
    status: "running",
    error: undefined,
    errorCode: undefined,
  };

  try {
    while (true) {
      job.wakeRequested = false;
      let waitingEvent: Extract<WorkflowRunEvent, { type: "run_waiting" }> | undefined;
      try {
        for await (const emittedEvent of runWorkflow({
          runId: run.id,
          script: executionOptions.version.script,
          agent: executionOptions.agent,
          model: executionOptions.model,
          cwd: executionOptions.cwd,
          inputs: executionOptions.inputs,
          recovery: executionOptions.recovery,
          onHumanTask: (request) => createOrGetWorkflowHumanTask(request),
          onCheckpoint: async (checkpoint) => {
            ensureWorkflowRunJobOwned(run.id, job);
            try {
              upsertWorkflowRunCheckpoint({
                runId: run.id,
                nodeId: checkpoint.nodeId,
                checkpoint:
                  checkpoint.kind === "map"
                    ? { kind: "map", state: checkpoint.state }
                    : { kind: "loop", state: checkpoint.state },
              });
            } catch (error) {
              throw new Error(
                `Failed to save workflow run checkpoint for run ${run.id}, node ${checkpoint.nodeId}.`,
                { cause: error },
              );
            }
          },
          signal: job.abortController.signal,
        })) {
          if (isExecutionBoundaryEvent(emittedEvent)) {
            ensureWorkflowRunJobOwned(run.id, job);
          }
          if (job.ownershipLost) {
            return;
          }
          const event =
            emittedEvent.type === "run_completed" &&
            emittedEvent.status !== "canceled" &&
            getWorkflowRun(run.id)?.status === "canceled"
              ? createTerminalRunEvent({
                  runId: run.id,
                  summary,
                  canceled: true,
                })
              : emittedEvent;
          summary = applyWorkflowRunEvent(summary, event);
          if (event.type === "run_waiting") {
            waitingEvent = event;
          } else {
            appendAndPublish(run, job, event);
          }
        }
      } catch (error) {
        if (job.ownershipLost || error instanceof WorkflowRunOwnershipLostError) {
          return;
        }
        const finalEvent = createTerminalRunEvent({
          runId: run.id,
          summary,
          error,
          canceled: job.abortController.signal.aborted,
        });
        appendAndPublish(run, job, finalEvent);
        summary = applyWorkflowRunEvent(summary, finalEvent);
      }

      if (
        !job.ownershipLost &&
        job.abortController.signal.aborted &&
        summary.status !== "canceled"
      ) {
        const canceledEvent = createTerminalRunEvent({
          runId: run.id,
          summary,
          canceled: true,
        });
        appendAndPublish(run, job, canceledEvent);
        summary = applyWorkflowRunEvent(summary, canceledEvent);
      }

      if (summary.status !== "waiting_for_human" || !waitingEvent) {
        break;
      }

      if (!job.wakeRequested) {
        const transition = markWorkflowRunWaitingOwned({
          runId: run.id,
          executionToken: job.executionToken,
          result: toWorkflowRunResult(summary),
          pendingTaskIds: waitingEvent.pendingTaskIds,
        });
        if (transition.transitioned) {
          appendAndPublish(run, job, waitingEvent);
          break;
        }
        if (transition.run?.status !== "running") {
          summary = {
            status: transition.run?.status ?? "interrupted",
            ...readRunResult(transition.run?.result),
          };
          break;
        }
      }

      const snapshot = createRecoveryStateFromSummary({
        run,
        version: executionOptions.version,
        summary,
        checkpoints: listWorkflowRunCheckpoints(run.id),
      });
      summary = { ...snapshot.summary, status: "running" };
      executionOptions = {
        ...executionOptions,
        recovery: snapshot.recovery,
        initialSummary: summary,
      };
    }

    if (
      summary.status === "completed" ||
      summary.status === "failed" ||
      summary.status === "canceled"
    ) {
      finalizeWorkflowRunExecution({
        runId: run.id,
        executionToken: job.executionToken,
        status: summary.status,
        result: toWorkflowRunResult(summary),
      });
    }
  } finally {
    clearInterval(heartbeat);
    if (jobs.get(run.id) === job) {
      jobs.delete(run.id);
    }
  }
}

class WorkflowRunOwnershipLostError extends Error {
  constructor() {
    super("Workflow run execution ownership was lost.");
    this.name = "WorkflowRunOwnershipLostError";
  }
}

function loseWorkflowRunOwnership(job: ActiveRunJob): void {
  job.ownershipLost = true;
  job.abortController.abort();
}

function ensureWorkflowRunJobOwned(runId: string, job: ActiveRunJob): void {
  if (
    !job.ownershipLost &&
    isWorkflowRunExecutionOwned({
      runId,
      executionToken: job.executionToken,
    })
  ) {
    return;
  }
  if (getWorkflowRun(runId)?.status === "canceled") {
    job.abortController.abort();
    return;
  }
  loseWorkflowRunOwnership(job);
  throw new WorkflowRunOwnershipLostError();
}

function isExecutionBoundaryEvent(event: WorkflowRunEvent): boolean {
  return event.type === "run_started" ||
    event.type === "node_started" ||
    (event.type === "loop_step_state" && event.status === "running");
}

function createTerminalRunEvent(input: {
  runId: string;
  summary: WorkflowRunSummary;
  error?: unknown;
  canceled: boolean;
}): Extract<WorkflowRunEvent, { type: "run_completed" }> {
  return {
    type: "run_completed",
    runId: input.runId,
    status: input.canceled ? "canceled" : "failed",
    outputs: input.summary.outputs,
    error: input.canceled ? "Run canceled." : formatRunError(input.error),
    errorCode: input.canceled
      ? "WORKFLOW_RUN_FAILED"
      : getRunErrorCode(input.error),
  };
}

function createRunRecoveryState(input: {
  run: WorkflowRunRecord;
  version: WorkflowVersionRecord;
  log: string;
  checkpoints: WorkflowRunCheckpointRecord[];
}): {
  recovery: WorkflowRunRecoveryState;
  summary: WorkflowRunSummary;
  terminalSummary?: WorkflowRunSummary;
} {
  const parsed = assertWorkflowScriptValid(input.version.script);
  let summary = createInitialRunSummary(parsed);
  let terminalSummary: WorkflowRunSummary | undefined;
  for (const event of parseRunLogEvents(input.log)) {
    if (event.type === "run_completed") {
      terminalSummary = applyWorkflowRunEvent(summary, event);
      continue;
    }
    summary = applyWorkflowRunEvent(summary, event);
  }

  const persisted = readRunResult(input.run.result);
  summary = mergePersistedRunResult(summary, persisted, {
    clearError: true,
  });
  terminalSummary = terminalSummary
    ? mergePersistedRunResult(terminalSummary, persisted, {
        clearError: false,
      })
    : undefined;

  return {
    ...createRecoveryStateFromSummary({
      run: input.run,
      version: input.version,
      summary,
      checkpoints: input.checkpoints,
    }),
    terminalSummary,
  };
}

function createRecoveryStateFromSummary(input: {
  run: WorkflowRunRecord;
  version: WorkflowVersionRecord;
  summary: WorkflowRunSummary;
  checkpoints: WorkflowRunCheckpointRecord[];
}): {
  recovery: WorkflowRunRecoveryState;
  summary: WorkflowRunSummary;
} {
  const parsed = assertWorkflowScriptValid(input.version.script);
  const { summary } = input;

  const completedNodeIds = Object.entries(summary.nodeStatuses)
    .filter(([, status]) => status === "completed")
    .map(([nodeId]) => nodeId);
  const attachSessionIdsByNodeId = Object.fromEntries(
    Object.entries(summary.nodeSessions)
      .filter(([nodeId, session]) => {
        const nodeStatus = summary.nodeStatuses[nodeId];
        return session.agentSessionId && nodeStatus !== "completed";
      })
      .map(([nodeId, session]) => [nodeId, session.agentSessionId]),
  );
  const { sessionIdsByKey, sessionCwdsByKey } = deriveSessionRecovery({
    nodes: createWorkflowExecutionPlan(parsed).executableNodes,
    nodeSessions: summary.nodeSessions,
    runCwd: input.run.cwd ?? undefined,
  });
  const { loopStates, mapStates } = readRecoveryCheckpoints(input.checkpoints);

  return {
    recovery: {
      outputs: summary.outputs,
      completedNodeIds,
      sessionIdsByKey,
      sessionCwdsByKey,
      attachSessionIdsByNodeId,
      loopStates,
      mapStates,
    },
    summary,
  };
}

function readRecoveryCheckpoints(
  checkpoints: WorkflowRunCheckpointRecord[],
): {
  loopStates: Record<string, WorkflowLoopRecoveryState>;
  mapStates: Record<string, WorkflowMapRecoveryState>;
} {
  const loopStates: Record<string, WorkflowLoopRecoveryState> = {};
  const mapStates: Record<string, WorkflowMapRecoveryState> = {};
  for (const checkpoint of checkpoints) {
    if (checkpoint.checkpoint.kind === "map") {
      mapStates[checkpoint.nodeId] = checkpoint.checkpoint.state;
    } else {
      loopStates[checkpoint.nodeId] = checkpoint.checkpoint.state;
    }
  }
  return { loopStates, mapStates };
}

function mergePersistedRunResult(
  summary: WorkflowRunSummary,
  persisted: ReturnType<typeof readRunResult>,
  options: { clearError: boolean },
): WorkflowRunSummary {
  return {
    ...summary,
    outputs: {
      ...summary.outputs,
      ...persisted.outputs,
    },
    nodeStatuses: {
      ...summary.nodeStatuses,
      ...persisted.nodeStatuses,
    },
    nodeSessions: {
      ...summary.nodeSessions,
      ...persisted.nodeSessions,
    },
    loopStepRuns: {
      ...summary.loopStepRuns,
      ...persisted.loopStepRuns,
    },
    mapItemRuns: {
      ...(summary.mapItemRuns ?? {}),
      ...(persisted.mapItemRuns ?? {}),
    },
    nodeInputs: {
      ...(summary.nodeInputs ?? {}),
      ...(persisted.nodeInputs ?? {}),
    },
    error: options.clearError ? undefined : summary.error,
    errorCode: options.clearError ? undefined : summary.errorCode,
  };
}

function reconcileWorkflowRunFromTerminalLog(
  run: WorkflowRunRecord,
  summary: WorkflowRunSummary,
  executionToken?: string,
): WorkflowRunRecord {
  if (
    executionToken &&
    (summary.status === "completed" ||
      summary.status === "failed" ||
      summary.status === "canceled")
  ) {
    finalizeWorkflowRunExecution({
      runId: run.id,
      executionToken,
      status: summary.status,
      result: toWorkflowRunResult(summary),
    });
  } else {
    updateWorkflowRun({
      runId: run.id,
      status: summary.status,
      result: toWorkflowRunResult(summary),
    });
  }
  return getWorkflowRun(run.id) ?? run;
}

function deriveSessionRecovery(input: {
  nodes: WorkflowNode[];
  nodeSessions: WorkflowRunSummary["nodeSessions"];
  runCwd?: string;
}): Pick<WorkflowRunRecoveryState, "sessionIdsByKey" | "sessionCwdsByKey"> {
  const sessionIdsByKey: Record<string, string> = {};
  const sessionCwdsByKey: Record<string, string> = {};
  for (const node of input.nodes) {
    if (node.kind === "agent") {
      const sessionKey = resolveSessionKey(node.session);
      const session = input.nodeSessions[node.id];
      if (sessionKey && session?.agentSessionId) {
        sessionIdsByKey[sessionKey] = session.agentSessionId;
        const sessionCwd = safeResolveWorkflowCwdFrom(
          input.runCwd,
          node.cwd,
        );
        if (sessionCwd) {
          sessionCwdsByKey[sessionKey] = sessionCwd;
        }
      }
    }
    if (node.kind === "loop" && node.loop) {
      for (const step of node.loop.steps) {
        const stepSession = resolveLoopStepSessionSpec({
          loopSession: node.loop.session,
          stepSession: step.session,
          stepId: step.id,
        });
        const sessionKey = resolveSessionKey(stepSession);
        const sessionNodeId = createLoopStepSessionNodeId(node.id, step.id);
        const session = input.nodeSessions[sessionNodeId];
        if (sessionKey && session?.agentSessionId) {
          sessionIdsByKey[sessionKey] = session.agentSessionId;
          const loopCwd = safeResolveWorkflowCwdFrom(input.runCwd, node.cwd);
          const sessionCwd = safeResolveWorkflowCwdFrom(loopCwd, step.cwd);
          if (sessionCwd) {
            sessionCwdsByKey[sessionKey] = sessionCwd;
          }
        }
      }
    }
  }
  return { sessionIdsByKey, sessionCwdsByKey };
}

function safeResolveWorkflowCwdFrom(
  baseCwd: string | undefined,
  input?: string,
): string | undefined {
  try {
    return resolveWorkflowCwdFrom(baseCwd, input);
  } catch {
    return undefined;
  }
}

function readRunInputs(value: unknown): Record<string, WorkflowInputValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const maybeInputs = (value as { inputs?: unknown }).inputs;
  if (!maybeInputs || typeof maybeInputs !== "object" || Array.isArray(maybeInputs)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(maybeInputs).flatMap(([key, inputValue]) =>
      typeof inputValue === "string" ||
      typeof inputValue === "number" ||
      typeof inputValue === "boolean"
        ? [[key, inputValue]]
        : [],
    ),
  );
}

function appendAndPublish(
  run: WorkflowRunRecord,
  job: ActiveRunJob,
  event: WorkflowRunEvent,
) {
  const entry = appendRunLogEvent(run.logPath, event);
  for (const subscriber of job.subscribers) {
    try {
      subscriber(event, entry.id);
    } catch {
      // UI subscribers are observational; a broken stream must not fail the run.
    }
  }
}
