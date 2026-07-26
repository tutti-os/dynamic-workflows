import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-runtime-db-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 Cycle, Invocation, Tick, and Checkpoint persistence", () => {
  it("atomically creates a Cycle and returns the same Tick for an idempotent Invocation", async () => {
    const fixture = await createRunnableFlow();
    const runtime = await import("./flow-runtime");
    const first = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "agent", agentSessionId: "agent-session-1" },
      idempotencyKey: "invoke-1",
      inputSnapshot: { target: "src" },
      paramsRevision: 3,
      paramsSnapshot: { threshold: 5000 },
      initialCheckpoint: { nodes: {} },
    });

    expect(first.created).toBe(true);
    expect(first.cycle).toEqual(
      expect.objectContaining({
        flowId: fixture.flowId,
        sequence: 1,
        status: "running",
        inputSnapshot: { target: "src" },
        paramsRevision: 3,
      }),
    );
    expect(first.invocation).toEqual(
      expect.objectContaining({
        cycleId: first.cycle.id,
        runId: first.run.id,
        status: "started",
        idempotencyKey: "invoke-1",
      }),
    );
    expect(first.run).toEqual(
      expect.objectContaining({
        status: "pending",
        tickSequence: 1,
        cycleId: first.cycle.id,
      }),
    );
    expect(runtime.getFlowV1CycleCheckpoint(first.cycle.id)).toEqual(
      expect.objectContaining({ revision: 0, state: { nodes: {} } }),
    );

    const duplicate = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "invoke-1",
      inputSnapshot: { ignored: true },
      paramsRevision: 99,
      paramsSnapshot: {},
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.cycle.id).toBe(first.cycle.id);
    expect(duplicate.run.id).toBe(first.run.id);
  });

  it("enforces one unfinished Cycle and one active Tick per Flow", async () => {
    const fixture = await createRunnableFlow();
    const runtime = await import("./flow-runtime");
    const first = start(runtime, fixture, "cycle-1");

    expect(() => start(runtime, fixture, "cycle-2")).toThrow(
      /already has unfinished Cycle/u,
    );
    expect(() =>
      runtime.startFlowV1Tick({
        cycleId: first.cycle.id,
        origin: { kind: "schedule", scheduleId: "main", scheduledAt: "2026-07-25T00:00:00.000Z" },
        idempotencyKey: "tick-while-active",
      }),
    ).toThrow(/already has active Tick/u);

    const firstClaim = runtime.claimFlowV1Tick({ runId: first.run.id });
    expect(firstClaim).toBeTruthy();
    expect(runtime.claimFlowV1Tick({ runId: first.run.id })).toBeNull();
    runtime.finishFlowV1Tick({
      runId: first.run.id,
      ownerToken: firstClaim!.token,
      status: "completed",
      stopReason: "waiting_gate",
      result: { waitingAt: "approval" },
    });
    const checkpoint = runtime.compareAndSetFlowV1CycleCheckpoint({
      cycleId: first.cycle.id,
      expectedRevision: 0,
      state: { waitingAt: "approval" },
      cycleStatus: "waiting_gate",
      currentNodeId: "approval",
    });
    expect(checkpoint.updated).toBe(true);

    const resumed = runtime.startFlowV1Tick({
      cycleId: first.cycle.id,
      origin: {
        kind: "schedule",
        scheduleId: "main",
        scheduledAt: "2026-07-26T00:00:00.000Z",
      },
      idempotencyKey: "schedule:2026-07-26",
    });
    expect(resumed.run.tickSequence).toBe(2);
    expect(resumed.cycle.status).toBe("running");
    const resumedClaim = runtime.claimFlowV1Tick({ runId: resumed.run.id });
    expect(resumedClaim?.run.status).toBe("running");
    expect(
      runtime.touchFlowV1TickClaim({
        runId: resumed.run.id,
        token: resumedClaim!.token,
      }),
    ).toBe(true);
  });

  it("uses compare-and-set revisions and releases singleton after terminal state", async () => {
    const fixture = await createRunnableFlow();
    const runtime = await import("./flow-runtime");
    const first = start(runtime, fixture, "first-cycle");
    const claim = runtime.claimFlowV1Tick({ runId: first.run.id });
    runtime.finishFlowV1Tick({
      runId: first.run.id,
      ownerToken: claim!.token,
      status: "completed",
      stopReason: "cycle_completed",
    });

    const completed = runtime.compareAndSetFlowV1CycleCheckpoint({
      cycleId: first.cycle.id,
      expectedRevision: 0,
      state: { terminal: true },
      cycleStatus: "completed",
      currentNodeId: "done",
    });
    expect(completed.updated).toBe(true);
    expect(completed.checkpoint.revision).toBe(1);
    expect(completed.cycle.completedAt).toBeTruthy();

    const conflict = runtime.compareAndSetFlowV1CycleCheckpoint({
      cycleId: first.cycle.id,
      expectedRevision: 0,
      state: { stale: true },
    });
    expect(conflict.updated).toBe(false);
    expect(conflict.checkpoint.state).toEqual({ terminal: true });

    const second = start(runtime, fixture, "second-cycle");
    expect(second.cycle.sequence).toBe(2);
  });

  it("fences checkpoint writes from an owner whose Tick lease was stolen", async () => {
    const fixture = await createRunnableFlow();
    const runtime = await import("./flow-runtime");
    const { getDb } = await import("../client");
    const first = start(runtime, fixture, "owner-fence");
    const staleOwner = runtime.claimFlowV1Tick({
      runId: first.run.id,
    })!;
    getDb()
      .prepare(
        `
        UPDATE workflow_runs
        SET owner_token = 'replacement-owner',
          owner_claimed_at = '2099-01-01T00:00:00.000Z'
        WHERE id = ?
      `,
      )
      .run(first.run.id);
    const staleWrite = runtime.compareAndSetFlowV1CycleCheckpoint({
      cycleId: first.cycle.id,
      expectedRevision: 0,
      state: { writer: "stale" },
      runId: first.run.id,
      ownerToken: staleOwner.token,
    });
    expect(staleWrite.updated).toBe(false);

    const currentWrite = runtime.compareAndSetFlowV1CycleCheckpoint({
      cycleId: first.cycle.id,
      expectedRevision: 0,
      state: { writer: "current" },
      runId: first.run.id,
      ownerToken: "replacement-owner",
    });
    expect(currentWrite.updated).toBe(true);
    expect(currentWrite.checkpoint.state).toEqual({ writer: "current" });
  });

  it("cascades the v1 runtime history when its Flow is deleted", async () => {
    const fixture = await createRunnableFlow();
    const runtime = await import("./flow-runtime");
    start(runtime, fixture, "cascade-cycle");
    const { getDb } = await import("../client");
    const database = getDb();

    database.prepare("DELETE FROM workflows WHERE id = ?").run(fixture.flowId);
    for (const table of [
      "workflow_cycles",
      "workflow_cycle_checkpoints",
      "workflow_invocations",
      "workflow_runs",
    ]) {
      const row = database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number };
      expect(row.count).toBe(0);
    }
  });
});

function start(
  runtime: typeof import("./flow-runtime"),
  fixture: { flowId: string; versionId: string },
  idempotencyKey: string,
) {
  return runtime.startFlowV1Cycle({
    flowId: fixture.flowId,
    flowVersionId: fixture.versionId,
    origin: { kind: "user" },
    idempotencyKey,
    inputSnapshot: {},
    paramsRevision: 0,
    paramsSnapshot: {},
  });
}

async function createRunnableFlow() {
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
  return { flowId: created.flowId, versionId: created.versionId };
}
