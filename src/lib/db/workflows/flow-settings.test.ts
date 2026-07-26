import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";

const HOST_SCRIPT = `
export const meta = { name: "settings-host", description: "Settings host" }
const done = await agent({ id: "done", prompt: "done" })
`;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-settings-db-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 params, Schedule, and runtime projection", () => {
  it("stores immutable Params revisions with optimistic concurrency", async () => {
    const fixture = await createFlow();
    const settings = await import("./flow-settings");
    const first = settings.setFlowV1Params({
      flowId: fixture.flowId,
      expectedRevision: 1,
      values: { threshold: 5000, directory: "src" },
    });
    const second = settings.setFlowV1Params({
      flowId: fixture.flowId,
      expectedRevision: 2,
      values: { threshold: 6000, directory: "src" },
    });

    expect(first.revision).toBe(2);
    expect(second.revision).toBe(3);
    expect(settings.getCurrentFlowV1Params(fixture.flowId)?.values).toEqual({
      threshold: 6000,
      directory: "src",
    });
    expect(
      settings.getFlowV1ParamsRevision(fixture.flowId, 2)?.values,
    ).toEqual({ threshold: 5000, directory: "src" });
    expect(() =>
      settings.setFlowV1Params({
        flowId: fixture.flowId,
        expectedRevision: 2,
        values: {},
      }),
    ).toThrow(/revision is 3/u);
  });

  it("keeps one main Schedule and compare-and-sets scheduler state", async () => {
    const fixture = await createFlow();
    const settings = await import("./flow-settings");
    const created = settings.upsertFlowV1Schedule({
      flowId: fixture.flowId,
      status: "active",
      cronExpression: "0 9 * * *",
      timezone: "Asia/Singapore",
      overlapPolicy: "coalesce-latest",
      scheduleInput: { directory: "src" },
      nextFireAt: "2026-07-26T01:00:00.000Z",
    });
    expect(created.revision).toBe(0);

    const updated = settings.upsertFlowV1Schedule({
      flowId: fixture.flowId,
      status: "paused",
      cronExpression: "30 9 * * *",
      timezone: "Asia/Singapore",
      overlapPolicy: "skip",
      scheduleInput: { directory: "packages" },
      nextFireAt: null,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.revision).toBe(1);
    expect(updated.status).toBe("paused");

    const schedulerUpdate = settings.recordFlowV1ScheduleState({
      scheduleId: updated.id,
      expectedRevision: 1,
      nextFireAt: "2026-07-27T01:30:00.000Z",
      lastScheduledAt: "2026-07-26T01:30:00.000Z",
      failureCount: 0,
    });
    expect(schedulerUpdate.updated).toBe(true);
    expect(schedulerUpdate.schedule?.revision).toBe(2);
    expect(
      settings.recordFlowV1ScheduleState({
        scheduleId: updated.id,
        expectedRevision: 1,
        nextFireAt: null,
      }).updated,
    ).toBe(false);

    expect(() =>
      settings.upsertFlowV1Schedule({
        flowId: fixture.flowId,
        status: "active",
        cronExpression: "not-a-cron",
        timezone: "Nowhere/Invalid",
        overlapPolicy: "skip",
        scheduleInput: {},
      }),
    ).toThrow(/exactly five fields/u);
  });

  it("projects current Cycle, latest Tick, counts, lifecycle, and Schedule", async () => {
    const fixture = await createRunnableFlow();
    const runtime = await import("./flow-runtime");
    const settings = await import("./flow-settings");
    settings.setFlowV1Lifecycle({
      flowId: fixture.flowId,
      lifecycle: "active",
    });
    settings.setFlowV1Params({
      flowId: fixture.flowId,
      values: { threshold: 5000 },
    });
    settings.upsertFlowV1Schedule({
      flowId: fixture.flowId,
      status: "active",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      overlapPolicy: "coalesce-latest",
      scheduleInput: {},
    });
    const tick = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "start",
      inputSnapshot: {},
      paramsRevision: 2,
      paramsSnapshot: { threshold: 5000 },
    });

    expect(settings.getFlowV1RuntimeSummary(fixture.flowId)).toEqual(
      expect.objectContaining({
        lifecycle: "active",
        paramsRevision: 2,
        activeCycle: expect.objectContaining({ id: tick.cycle.id }),
        latestRun: expect.objectContaining({ id: tick.run.id }),
        schedule: expect.objectContaining({ status: "active" }),
        cycleCount: 1,
        runCount: 1,
        completedCycleCount: 0,
      }),
    );

    const firstClaim = runtime.claimFlowV1Tick({ runId: tick.run.id });
    runtime.finishFlowV1Tick({
      runId: tick.run.id,
      ownerToken: firstClaim!.token,
      status: "completed",
      stopReason: "waiting_gate",
    });
    runtime.compareAndSetFlowV1CycleCheckpoint({
      cycleId: tick.cycle.id,
      expectedRevision: 0,
      state: { waiting: true },
      cycleStatus: "waiting_gate",
    });
    const laterTickInFirstCycle = runtime.startFlowV1Tick({
      cycleId: tick.cycle.id,
      origin: { kind: "recovery", reason: "resume" },
      idempotencyKey: "resume-first-cycle",
    });
    const laterClaim = runtime.claimFlowV1Tick({
      runId: laterTickInFirstCycle.run.id,
    });
    runtime.finishFlowV1Tick({
      runId: laterTickInFirstCycle.run.id,
      ownerToken: laterClaim!.token,
      status: "completed",
      stopReason: "cycle_completed",
    });
    runtime.compareAndSetFlowV1CycleCheckpoint({
      cycleId: tick.cycle.id,
      expectedRevision: 1,
      state: { terminal: true },
      cycleStatus: "completed",
    });
    const nextCycle = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "next-cycle",
      inputSnapshot: {},
      paramsRevision: 2,
      paramsSnapshot: { threshold: 5000 },
    });

    expect(laterTickInFirstCycle.run.tickSequence).toBe(2);
    expect(nextCycle.run.tickSequence).toBe(1);
    expect(settings.getFlowV1RuntimeSummary(fixture.flowId)?.latestRun?.id).toBe(
      nextCycle.run.id,
    );
  });
});

async function createFlow() {
  const { createFlowV1 } = await import("@/lib/flow-v1/flow-service");
  const created = createFlowV1({
    bundle: createFlowV1Bundle([
      {
        path: "flow.js",
        content: `
          export const schemaVersion = "tutti.flow.v1";
          const done = completeCycle({ id: "done" });
        `,
      },
    ]),
  });
  return {
    flowId: created.flowId,
    versionId: created.versionId,
  };
}

async function createRunnableFlow() {
  return createFlow();
}
