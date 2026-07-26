import {
  runFlowV1SchedulerPass,
  type FlowV1SchedulerAction,
} from "./scheduler";
import { reconcileFlowV1RuntimeOnStartup } from "./recovery";
import { runFlowV1Tick } from "./tick-supervisor";

const DEFAULT_INTERVAL_MS = 30_000;

export type FlowV1SchedulerSupervisor = {
  trigger(): Promise<FlowV1SchedulerAction[]>;
  stop(): void;
  isRunning(): boolean;
  isStopped(): boolean;
};

type SupervisorOptions = {
  intervalMs?: number;
  runImmediately?: boolean;
  executeTicks?: boolean;
  onError?: (error: unknown) => void;
  runPass?: () => Promise<FlowV1SchedulerAction[]>;
};

const globalScheduler = globalThis as typeof globalThis & {
  __dynamicWorkflowsFlowV1Scheduler?: FlowV1SchedulerSupervisor;
};

export function startFlowV1SchedulerSupervisor(
  options: SupervisorOptions = {},
): FlowV1SchedulerSupervisor {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 10) {
    throw new Error("Flow scheduler intervalMs must be at least 10ms.");
  }
  const pass =
    options.runPass ??
    (async () => {
      const recovery = reconcileFlowV1RuntimeOnStartup();
      if (options.executeTicks ?? true) {
        await Promise.allSettled(
          recovery.pendingRunIds.map((runId) =>
            runFlowV1Tick({ runId }),
          ),
        );
      }
      return runFlowV1SchedulerPass({
        executeTicks: options.executeTicks ?? true,
      });
    });
  let running = false;
  let stopped = false;

  const trigger = async (): Promise<FlowV1SchedulerAction[]> => {
    if (running || stopped) {
      return [];
    }
    running = true;
    try {
      return await pass();
    } catch (error) {
      options.onError?.(error);
      return [];
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void trigger();
  }, intervalMs);
  timer.unref?.();
  const supervisor: FlowV1SchedulerSupervisor = {
    trigger,
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      if (globalScheduler.__dynamicWorkflowsFlowV1Scheduler === supervisor) {
        delete globalScheduler.__dynamicWorkflowsFlowV1Scheduler;
      }
    },
    isRunning: () => running,
    isStopped: () => stopped,
  };
  if (options.runImmediately ?? true) {
    void trigger();
  }
  return supervisor;
}

export function ensureFlowV1SchedulerSupervisorStarted(
  options: SupervisorOptions = {},
): FlowV1SchedulerSupervisor {
  const existing = globalScheduler.__dynamicWorkflowsFlowV1Scheduler;
  if (existing && !existing.isStopped()) {
    return existing;
  }
  const supervisor = startFlowV1SchedulerSupervisor(options);
  globalScheduler.__dynamicWorkflowsFlowV1Scheduler = supervisor;
  return supervisor;
}

export function stopFlowV1SchedulerSupervisor(): void {
  globalScheduler.__dynamicWorkflowsFlowV1Scheduler?.stop();
}
