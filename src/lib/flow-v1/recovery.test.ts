import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "./bundle";
import {
  createFlowV1GraphCheckpoint,
  markFlowV1NodeRunning,
  planFlowV1Graph,
} from "./graph-state";
import { parseFlowV1Bundle } from "./parser";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-recovery-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 startup recovery", () => {
  it("interrupts orphaned code attempts and leaves the Cycle retryable", async () => {
    const fixture = await startOwnedNode(scriptBundle(), "scan");
    const recovery = await import("./recovery");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");

    const result = recovery.reconcileFlowV1RuntimeOnStartup({
      now: "2099-07-26T01:00:00.000Z",
      staleAfterMs: 0,
    });

    expect(result.interruptedRunIds).toEqual([fixture.runId]);
    expect(runtime.getFlowV1Run(fixture.runId)).toEqual(
      expect.objectContaining({
        status: "interrupted",
        stopReason: "paused_failed",
      }),
    );
    expect(runtime.getFlowV1Cycle(fixture.cycleId)).toEqual(
      expect.objectContaining({
        status: "paused_failed",
        currentNodeId: "scan",
      }),
    );
    expect(attempts.getFlowV1NodeAttempt(fixture.attemptId)).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          code: "flow_attempt_interrupted",
        }),
      }),
    );
    expect(
      runtime.getFlowV1CycleCheckpoint(fixture.cycleId)?.state,
    ).toEqual(
      expect.objectContaining({
        nodes: expect.objectContaining({
          scan: expect.objectContaining({ status: "failed" }),
        }),
      }),
    );
    expect(recovery.reconcileFlowV1RuntimeOnStartup()).toEqual({
      interruptedRunIds: [],
      uncertainEffectIds: [],
      pendingRunIds: [],
    });
  });

  it("marks an interrupted Effect uncertain so retry must reconcile it", async () => {
    const fixture = await startOwnedNode(effectBundle(), "publish");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const ledger = attempts.startFlowV1Effect({
      cycleId: fixture.cycleId,
      runId: fixture.runId,
      ownerToken: fixture.ownerToken,
      nodeId: "publish",
      attemptId: fixture.attemptId,
      idempotencyKey: `${fixture.cycleId}:publish`,
    });
    const recovery = await import("./recovery");
    const runtime = await import("@/lib/db/workflows/flow-runtime");

    const result = recovery.reconcileFlowV1RuntimeOnStartup({
      now: "2099-07-26T01:00:00.000Z",
      staleAfterMs: 0,
    });

    expect(result.uncertainEffectIds).toEqual([ledger.effect.id]);
    expect(attempts.getFlowV1Effect(ledger.effect.id)?.status).toBe(
      "uncertain",
    );
    expect(attempts.getFlowV1NodeAttempt(fixture.attemptId)?.status).toBe(
      "uncertain",
    );
    expect(runtime.getFlowV1Cycle(fixture.cycleId)?.status).toBe(
      "paused_uncertain",
    );
    expect(
      runtime.getFlowV1CycleCheckpoint(fixture.cycleId)?.state,
    ).toEqual(
      expect.objectContaining({
        nodes: expect.objectContaining({
          publish: expect.objectContaining({ status: "uncertain" }),
        }),
      }),
    );
  });
});

async function startOwnedNode(
  bundle: ReturnType<typeof createFlowV1Bundle>,
  nodeId: string,
) {
  const service = await import("./flow-service");
  const runtime = await import("@/lib/db/workflows/flow-runtime");
  const attempts = await import("@/lib/db/workflows/flow-attempts");
  const created = service.createFlowV1({ bundle, activate: true });
  const invoked = await service.invokeFlowV1({
    flowId: created.flowId,
    executeTick: false,
  });
  const claim = runtime.claimFlowV1Tick({ runId: invoked.tick.run.id })!;
  const flow = parseFlowV1Bundle(bundle);
  let checkpoint = createFlowV1GraphCheckpoint(flow);
  checkpoint = planFlowV1Graph(flow, checkpoint).checkpoint;
  checkpoint = markFlowV1NodeRunning(checkpoint, nodeId);
  runtime.compareAndSetFlowV1CycleCheckpoint({
    cycleId: invoked.tick.cycle.id,
    expectedRevision: 0,
    state: checkpoint as unknown as Record<string, never>,
    cycleStatus: "running",
    currentNodeId: nodeId,
  });
  const attempt = attempts.startFlowV1NodeAttempt({
    cycleId: invoked.tick.cycle.id,
    runId: invoked.tick.run.id,
    ownerToken: claim.token,
    nodeId,
    nodeInput: {},
  });
  return {
    cycleId: invoked.tick.cycle.id,
    runId: invoked.tick.run.id,
    attemptId: attempt.id,
    ownerToken: claim.token,
  };
}

function scriptBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        const scan = script({ id: "scan", file: "scripts/scan.mjs" });
        const done = completeCycle({ id: "done", inputs: { scan } });
      `,
    },
    {
      path: "scripts/scan.mjs",
      content: "export async function run() { return {}; }",
    },
  ]);
}

function effectBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        const publish = effect({
          id: "publish",
          file: "scripts/publish.mjs",
          idempotencyKey: template("{{cycle.id}}:publish"),
        });
        const done = completeCycle({ id: "done", inputs: { publish } });
      `,
    },
    {
      path: "scripts/publish.mjs",
      content: `
        export async function apply() { return { status: "completed" }; }
        export async function reconcile() { return { status: "not_applied" }; }
      `,
    },
  ]);
}
