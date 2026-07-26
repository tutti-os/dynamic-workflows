import { getDb } from "@/lib/db/client";
import {
  getCurrentFlowV1Params,
  listFlowV1SchedulesReady,
  recordFlowV1ScheduleState,
} from "@/lib/db/workflows/flow-settings";
import {
  getActiveFlowV1Cycle,
  getActiveFlowV1RunForFlow,
  startFlowV1Cycle,
  startFlowV1Tick,
} from "@/lib/db/workflows/flow-runtime";
import { getFlowV1BundleForVersion } from "@/lib/db/workflows/flow-bundles";
import type {
  FlowV1RunRecord,
  FlowV1ScheduleRecord,
} from "./types";
import { nextFlowV1CronFire } from "./cron";
import {
  FLOW_V1_MEMORY_TEMPLATE_FILE,
  getFlowV1BundleFile,
} from "./bundle";
import { initializeFlowV1Memory } from "./memory";
import { parseFlowV1Bundle } from "./parser";
import { runFlowV1Tick } from "./tick-supervisor";

export type FlowV1SchedulerAction = {
  scheduleId: string;
  flowId: string;
  scheduledAt: string;
  action:
    | "started_cycle"
    | "resumed_cycle"
    | "coalesced"
    | "skipped_overlap"
    | "skipped_cycle_state"
    | "failed";
  runId: string | null;
  error?: string;
};

export async function runFlowV1SchedulerPass(input: {
  now?: string;
  executeTicks?: boolean;
  projectCwdForFlow?: (flowId: string) => string | undefined;
} = {}): Promise<FlowV1SchedulerAction[]> {
  const now = input.now ?? new Date().toISOString();
  const schedules = listFlowV1SchedulesReady(now);
  const actions: FlowV1SchedulerAction[] = [];
  for (const schedule of schedules) {
    const action = await processSchedule(schedule, now);
    actions.push(action);
    if (input.executeTicks && action.runId) {
      try {
        await runFlowV1Tick({
          runId: action.runId,
          projectCwd: input.projectCwdForFlow?.(action.flowId),
        });
      } catch (error) {
        action.action = "failed";
        action.error =
          error instanceof Error ? error.message : String(error);
      }
    }
  }
  return actions;
}

async function processSchedule(
  schedule: FlowV1ScheduleRecord,
  now: string,
): Promise<FlowV1SchedulerAction> {
  const timing = advanceToLatestFire(schedule, now);
  const scheduledAt = latestTimestamp(
    timing.latestDueAt,
    schedule.coalescedScheduledAt,
  );
  if (!scheduledAt) {
    return failedAction(
      schedule,
      now,
      "Schedule became ready without a due or coalesced timestamp.",
    );
  }

  const activeRun = getActiveFlowV1RunForFlow(schedule.flowId);
  if (activeRun) {
    const coalesced =
      schedule.overlapPolicy === "coalesce-latest"
        ? scheduledAt
        : null;
    updateSchedule(schedule, {
      nextFireAt: timing.nextFireAt,
      lastScheduledAt: timing.latestDueAt ?? undefined,
      coalescedScheduledAt: coalesced,
    });
    return {
      scheduleId: schedule.id,
      flowId: schedule.flowId,
      scheduledAt,
      action:
        schedule.overlapPolicy === "coalesce-latest"
          ? "coalesced"
          : "skipped_overlap",
      runId: null,
    };
  }

  try {
    const activeCycle = getActiveFlowV1Cycle(schedule.flowId);
    let run: FlowV1RunRecord;
    let action: FlowV1SchedulerAction["action"];
    if (activeCycle) {
      if (
        activeCycle.status !== "waiting_gate" &&
        activeCycle.status !== "runnable"
      ) {
        updateSchedule(schedule, {
          nextFireAt: timing.nextFireAt,
          lastScheduledAt: timing.latestDueAt ?? undefined,
          coalescedScheduledAt: null,
        });
        return {
          scheduleId: schedule.id,
          flowId: schedule.flowId,
          scheduledAt,
          action: "skipped_cycle_state",
          runId: null,
        };
      }
      run = startFlowV1Tick({
        cycleId: activeCycle.id,
        origin: {
          kind: "schedule",
          scheduleId: schedule.id,
          scheduledAt,
        },
        idempotencyKey: scheduleInvocationKey(schedule.id, scheduledAt),
      }).run;
      action = "resumed_cycle";
    } else {
      const flow = readRunnableFlow(schedule.flowId);
      const params = getCurrentFlowV1Params(schedule.flowId);
      const bundle = getFlowV1BundleForVersion(flow.currentVersionId);
      if (!bundle) {
        throw new Error(`Flow ${schedule.flowId} has no pinned Bundle.`);
      }
      const parsed = parseFlowV1Bundle(bundle);
      let memoryHashAtStart: string | undefined;
      if (parsed.memory) {
        const template = getFlowV1BundleFile(
          bundle,
          FLOW_V1_MEMORY_TEMPLATE_FILE,
        );
        if (!template) {
          throw new Error(`Flow ${schedule.flowId} has no Memory template.`);
        }
        memoryHashAtStart = initializeFlowV1Memory({
          flowId: schedule.flowId,
          template: template.content,
          definition: parsed.memory,
        }).hash;
      }
      run = startFlowV1Cycle({
        flowId: schedule.flowId,
        flowVersionId: flow.currentVersionId,
        origin: {
          kind: "schedule",
          scheduleId: schedule.id,
          scheduledAt,
        },
        idempotencyKey: scheduleInvocationKey(schedule.id, scheduledAt),
        inputSnapshot: schedule.input,
        paramsRevision: flow.paramsRevision,
        paramsSnapshot: params?.values ?? {},
        memoryHashAtStart,
      }).run;
      action = "started_cycle";
    }
    updateSchedule(schedule, {
      nextFireAt: timing.nextFireAt,
      lastScheduledAt: timing.latestDueAt ?? scheduledAt,
      coalescedScheduledAt: null,
      failureCount: 0,
    });
    return {
      scheduleId: schedule.id,
      flowId: schedule.flowId,
      scheduledAt,
      action,
      runId: run.id,
    };
  } catch (error) {
    updateSchedule(schedule, {
      nextFireAt: timing.nextFireAt,
      lastScheduledAt: timing.latestDueAt ?? undefined,
      coalescedScheduledAt: schedule.coalescedScheduledAt,
      failureCount: schedule.failureCount + 1,
    });
    return failedAction(
      schedule,
      scheduledAt,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function advanceToLatestFire(
  schedule: FlowV1ScheduleRecord,
  now: string,
): { latestDueAt: string | null; nextFireAt: string } {
  let latestDueAt: string | null = null;
  let nextFireAt =
    schedule.nextFireAt ??
    nextFlowV1CronFire({
      expression: schedule.cronExpression,
      timezone: schedule.timezone,
      after: now,
    });
  let iterations = 0;
  while (nextFireAt <= now) {
    latestDueAt = nextFireAt;
    nextFireAt = nextFlowV1CronFire({
      expression: schedule.cronExpression,
      timezone: schedule.timezone,
      after: nextFireAt,
    });
    iterations += 1;
    if (iterations > 10_000) {
      throw new Error("Schedule catch-up exceeded 10000 missed fires.");
    }
  }
  return { latestDueAt, nextFireAt };
}

function updateSchedule(
  schedule: FlowV1ScheduleRecord,
  update: {
    nextFireAt: string | null;
    lastScheduledAt?: string | null;
    coalescedScheduledAt?: string | null;
    failureCount?: number;
  },
): void {
  const result = recordFlowV1ScheduleState({
    scheduleId: schedule.id,
    expectedRevision: schedule.revision,
    ...update,
  });
  if (!result.updated) {
    throw new Error(
      `Schedule ${schedule.id} changed during this scheduler pass.`,
    );
  }
}

function readRunnableFlow(flowId: string): {
  currentVersionId: string;
  paramsRevision: number;
} {
  const row = getDb()
    .prepare(
      `
      SELECT current_version_id, params_revision
      FROM workflows
      WHERE id = ? AND lifecycle = 'active'
    `,
    )
    .get(flowId) as
    | { current_version_id: string | null; params_revision: number }
    | undefined;
  if (!row?.current_version_id) {
    throw new Error(`Active Flow ${flowId} has no published Version.`);
  }
  return {
    currentVersionId: row.current_version_id,
    paramsRevision: row.params_revision,
  };
}

function scheduleInvocationKey(
  scheduleId: string,
  scheduledAt: string,
): string {
  return `schedule:${scheduleId}:${scheduledAt}`;
}

function latestTimestamp(
  left: string | null,
  right: string | null,
): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left >= right ? left : right;
}

function failedAction(
  schedule: FlowV1ScheduleRecord,
  scheduledAt: string,
  error: string,
): FlowV1SchedulerAction {
  return {
    scheduleId: schedule.id,
    flowId: schedule.flowId,
    scheduledAt,
    action: "failed",
    runId: null,
    error,
  };
}
