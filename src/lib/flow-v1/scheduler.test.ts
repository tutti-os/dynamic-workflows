import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "./bundle";

const HOST_SCRIPT = `
export const meta = { name: "scheduler-host", description: "Scheduler host" }
const done = await agent({ id: "done", prompt: "done" })
`;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-scheduler-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 recurring scheduler", () => {
  it("coalesces missed cron fires to the latest and runs one Cycle", async () => {
    const fixture = await createActiveFlow(simpleBundle());
    const settings = await import("@/lib/db/workflows/flow-settings");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1SchedulerPass } = await import("./scheduler");
    settings.upsertFlowV1Schedule({
      flowId: fixture.flowId,
      status: "active",
      cronExpression: "* * * * *",
      timezone: "UTC",
      overlapPolicy: "coalesce-latest",
      scheduleInput: { value: "scheduled" },
      nextFireAt: "2026-07-26T00:01:00.000Z",
    });

    const actions = await runFlowV1SchedulerPass({
      now: "2026-07-26T00:05:30.000Z",
      executeTicks: true,
    });
    expect(actions).toEqual([
      expect.objectContaining({
        action: "started_cycle",
        scheduledAt: "2026-07-26T00:05:00.000Z",
      }),
    ]);
    expect(runtime.listFlowV1Cycles(fixture.flowId)).toEqual([
      expect.objectContaining({
        status: "completed",
        inputSnapshot: { value: "scheduled" },
      }),
    ]);
    expect(settings.getFlowV1Schedule(fixture.flowId)).toEqual(
      expect.objectContaining({
        lastScheduledAt: "2026-07-26T00:05:00.000Z",
        nextFireAt: "2026-07-26T00:06:00.000Z",
        coalescedScheduledAt: null,
      }),
    );
  });

  it("uses the next recurring fire to resume a waiting Gate", async () => {
    const markerPath = path.join(dataDir, "approved.marker");
    const fixture = await createActiveFlow(gateBundle());
    const settings = await import("@/lib/db/workflows/flow-settings");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1SchedulerPass } = await import("./scheduler");
    settings.upsertFlowV1Schedule({
      flowId: fixture.flowId,
      status: "active",
      cronExpression: "* * * * *",
      timezone: "UTC",
      overlapPolicy: "coalesce-latest",
      scheduleInput: { markerPath },
      nextFireAt: "2026-07-26T01:00:00.000Z",
    });

    await runFlowV1SchedulerPass({
      now: "2026-07-26T01:00:10.000Z",
      executeTicks: true,
    });
    expect(runtime.getActiveFlowV1Cycle(fixture.flowId)?.status).toBe(
      "waiting_gate",
    );
    writeFileSync(markerPath, "approved", "utf8");

    const resumed = await runFlowV1SchedulerPass({
      now: "2026-07-26T01:01:10.000Z",
      executeTicks: true,
    });
    expect(resumed[0]?.action).toBe("resumed_cycle");
    expect(runtime.listFlowV1Cycles(fixture.flowId)[0]?.status).toBe(
      "completed",
    );
  });

  it("retains only the latest overlapping fire and compensates after the active Tick", async () => {
    const fixture = await createActiveFlow(simpleBundle());
    const settings = await import("@/lib/db/workflows/flow-settings");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const { runFlowV1SchedulerPass } = await import("./scheduler");
    const schedule = settings.upsertFlowV1Schedule({
      flowId: fixture.flowId,
      status: "active",
      cronExpression: "* * * * *",
      timezone: "UTC",
      overlapPolicy: "coalesce-latest",
      scheduleInput: { value: "scheduled" },
      nextFireAt: "2026-07-26T02:00:00.000Z",
    });
    const active = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "manual-active",
      inputSnapshot: { value: "manual" },
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const overlap = await runFlowV1SchedulerPass({
      now: "2026-07-26T02:03:30.000Z",
    });
    expect(overlap[0]).toEqual(
      expect.objectContaining({
        scheduleId: schedule.id,
        action: "coalesced",
        scheduledAt: "2026-07-26T02:03:00.000Z",
      }),
    );
    expect(
      settings.getFlowV1Schedule(fixture.flowId)?.coalescedScheduledAt,
    ).toBe("2026-07-26T02:03:00.000Z");

    await runFlowV1Tick({ runId: active.run.id });
    const compensation = await runFlowV1SchedulerPass({
      now: "2026-07-26T02:03:30.000Z",
    });
    expect(compensation[0]).toEqual(
      expect.objectContaining({
        action: "started_cycle",
        scheduledAt: "2026-07-26T02:03:00.000Z",
      }),
    );
    expect(
      settings.getFlowV1Schedule(fixture.flowId)?.coalescedScheduledAt,
    ).toBeNull();
  });
});

async function createActiveFlow(
  bundle: ReturnType<typeof createFlowV1Bundle>,
) {
  const { createFlowV1 } = await import("./flow-service");
  const settings = await import("@/lib/db/workflows/flow-settings");
  const created = createFlowV1({ bundle });
  const flowId = created.flowId;
  const versionId = created.versionId;
  settings.setFlowV1Lifecycle({ flowId, lifecycle: "active" });
  return { flowId, versionId };
}

function simpleBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const inputs = defineInputs({
          value: stringInput({ required: true }),
        });
        const work = script({
          id: "work",
          file: "scripts/work.mjs",
          inputs: { value: ref("inputs.value") },
        });
        const done = completeCycle({ id: "done", inputs: { work } });
      `,
    },
    {
      path: "scripts/work.mjs",
      content:
        "export async function run(ctx) { return { value: ctx.value }; }",
    },
  ]);
}

function gateBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const inputs = defineInputs({
          markerPath: stringInput({ required: true }),
        });
        const approval = gate({
          id: "approval",
          file: "scripts/approval.mjs",
          inputs: { markerPath: ref("inputs.markerPath") },
          outcomes: ["approved"],
        });
        const done = completeCycle({
          id: "done",
          inputs: { approval },
        });
        route(approval, { approved: done });
      `,
    },
    {
      path: "scripts/approval.mjs",
      content: `
        import fs from "node:fs";
        export async function check(ctx) {
          return fs.existsSync(ctx.markerPath)
            ? { status: "completed", outcome: "approved" }
            : { status: "waiting", reason: "approval marker missing" };
        }
      `,
    },
  ]);
}
