import {
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowVersion,
  listWorkflowRunCheckpoints,
  markWorkflowRunInterrupted,
  upsertWorkflowRunCheckpoint,
  updateWorkflowRun,
  type WorkflowRunCheckpointRecord,
  type WorkflowRunRecord,
  type WorkflowVersionRecord,
} from "@/lib/db/workflows";
import {
  workflowRunNotFoundError,
  workflowVersionNotFoundError,
} from "@/lib/api/app-error";
import {
  claimWorkflowRunForResume,
  releaseWorkflowRunResumeClaim,
} from "@/lib/db/workflows/runs";
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
  WorkflowNode,
  WorkflowLoopRecoveryState,
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
  inputs: Record<string, string>;
  input: unknown;
  recovery?: WorkflowRunRecoveryState;
  initialSummary?: WorkflowRunSummary;
};

type RunSubscriber = (event: WorkflowRunEvent) => void;

type ActiveRunJob = {
  abortController: AbortController;
  subscribers: Set<RunSubscriber>;
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
  const run = createWorkflowRun({
    workflowId: options.workflowId,
    workflowVersionId: options.version.id,
    executorKind: options.executorKind,
    agent: options.agent,
    model: options.model,
    cwd: options.cwd,
    request: options.input,
  });
  ensureRunLogDirectory(run.logPath);

  const job: ActiveRunJob = {
    abortController: new AbortController(),
    subscribers: new Set(),
  };
  jobs.set(run.id, job);

  void executeWorkflowRunJob(run, options, job);
  return run;
}

export async function resumeWorkflowRunJob(input: {
  workflowId: string;
  runId: string;
}): Promise<WorkflowRunRecord> {
  const activeRun = getWorkflowRun(input.runId);
  if (!activeRun || activeRun.workflowId !== input.workflowId) {
    throw workflowRunNotFoundError();
  }
  if (jobs.has(activeRun.id)) {
    return activeRun;
  }
  if (
    activeRun.status !== "running" &&
    activeRun.status !== "interrupted"
  ) {
    throw new Error("Only interrupted workflow runs can be resumed.");
  }

  const version = getWorkflowVersion(activeRun.workflowVersionId);
  if (!version || version.workflowId !== input.workflowId) {
    throw workflowVersionNotFoundError();
  }

  const job: ActiveRunJob = {
    abortController: new AbortController(),
    subscribers: new Set(),
  };
  const claim = claimWorkflowRunForResume({
    workflowId: input.workflowId,
    runId: activeRun.id,
  });
  if (!claim) {
    return getWorkflowRun(activeRun.id) ?? activeRun;
  }
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
      return reconcileWorkflowRunFromTerminalLog(run, snapshot.terminalSummary);
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
    throw error;
  }
}

export async function markWorkflowRunInterruptedIfStale(
  run: WorkflowRunRecord,
): Promise<WorkflowRunRecord> {
  if (run.status !== "running" || jobs.has(run.id)) {
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

export function cancelWorkflowRunJob(runId: string): boolean {
  const job = jobs.get(runId);
  if (!job) {
    return false;
  }
  job.abortController.abort();
  return true;
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
  let summary =
    options.initialSummary ??
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
    for await (const event of runWorkflow({
      runId: run.id,
      script: options.version.script,
      agent: options.agent,
      model: options.model,
      cwd: options.cwd,
      inputs: options.inputs,
      recovery: options.recovery,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.kind !== "loop") {
          return;
        }
        try {
          upsertWorkflowRunCheckpoint({
            runId: run.id,
            nodeId: checkpoint.nodeId,
            checkpoint: checkpoint.state,
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
      appendAndPublish(run, job, event);
      summary = applyWorkflowRunEvent(summary, event);
    }
  } catch (error) {
    const finalStatus = job.abortController.signal.aborted ? "canceled" : "failed";
    const finalEvent: WorkflowRunEvent = {
      type: "run_completed",
      runId: run.id,
      status: finalStatus,
      outputs: summary.outputs,
      error: job.abortController.signal.aborted
        ? "Run canceled."
        : formatRunError(error),
      errorCode: job.abortController.signal.aborted
        ? "WORKFLOW_RUN_FAILED"
        : getRunErrorCode(error),
    };
    appendAndPublish(run, job, finalEvent);
    summary = applyWorkflowRunEvent(summary, finalEvent);
  } finally {
    updateWorkflowRun({
      runId: run.id,
      status: summary.status,
      result: toWorkflowRunResult(summary),
    });
    jobs.delete(run.id);
  }
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
  const loopStates = readLoopRecoveryStates(input.checkpoints);

  return {
    recovery: {
      outputs: summary.outputs,
      completedNodeIds,
      sessionIdsByKey,
      sessionCwdsByKey,
      attachSessionIdsByNodeId,
      loopStates,
    },
    summary,
    terminalSummary,
  };
}

function readLoopRecoveryStates(
  checkpoints: WorkflowRunCheckpointRecord[],
): Record<string, WorkflowLoopRecoveryState> {
  return Object.fromEntries(
    checkpoints.map((checkpoint) => [checkpoint.nodeId, checkpoint.checkpoint]),
  );
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
    error: options.clearError ? undefined : summary.error,
    errorCode: options.clearError ? undefined : summary.errorCode,
  };
}

function reconcileWorkflowRunFromTerminalLog(
  run: WorkflowRunRecord,
  summary: WorkflowRunSummary,
): WorkflowRunRecord {
  updateWorkflowRun({
    runId: run.id,
    status: summary.status,
    result: toWorkflowRunResult(summary),
  });
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

function readRunInputs(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const maybeInputs = (value as { inputs?: unknown }).inputs;
  if (!maybeInputs || typeof maybeInputs !== "object" || Array.isArray(maybeInputs)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(maybeInputs).flatMap(([key, inputValue]) =>
      typeof inputValue === "string" ? [[key, inputValue]] : [],
    ),
  );
}

function appendAndPublish(
  run: WorkflowRunRecord,
  job: ActiveRunJob,
  event: WorkflowRunEvent,
) {
  appendRunLogEvent(run.logPath, event);
  for (const subscriber of job.subscribers) {
    try {
      subscriber(event);
    } catch {
      // UI subscribers are observational; a broken stream must not fail the run.
    }
  }
}
