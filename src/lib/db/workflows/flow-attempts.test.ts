import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";

const HOST_SCRIPT = `
export const meta = { name: "attempt-host", description: "Attempt host" }
const done = await agent({ id: "done", prompt: "done" })
`;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-attempt-db-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 Node Attempt and Effect persistence", () => {
  it("sequences Node Attempts and requires Tick ownership", async () => {
    const fixture = await createClaimedTick();
    const attempts = await import("./flow-attempts");

    expect(() =>
      attempts.startFlowV1NodeAttempt({
        cycleId: fixture.cycleId,
        runId: fixture.runId,
        ownerToken: "wrong-token",
        nodeId: "scan",
        nodeInput: {},
      }),
    ).toThrow(/not owned/u);

    const first = attempts.startFlowV1NodeAttempt({
      cycleId: fixture.cycleId,
      runId: fixture.runId,
      ownerToken: fixture.ownerToken,
      nodeId: "scan",
      nodeInput: { directory: "src" },
    });
    expect(first.sequence).toBe(1);
    const finished = attempts.finishFlowV1NodeAttempt({
      attemptId: first.id,
      ownerToken: fixture.ownerToken,
      status: "completed",
      output: { path: "src/large.ts", lines: 9000 },
    });
    expect(finished).toEqual(
      expect.objectContaining({
        transitioned: true,
        attempt: expect.objectContaining({
          status: "completed",
          output: { path: "src/large.ts", lines: 9000 },
        }),
      }),
    );

    const second = attempts.startFlowV1NodeAttempt({
      cycleId: fixture.cycleId,
      runId: fixture.runId,
      ownerToken: fixture.ownerToken,
      nodeId: "scan",
      nodeInput: { directory: "src" },
    });
    expect(second.sequence).toBe(2);
    expect(attempts.listFlowV1NodeAttempts(fixture.cycleId)).toHaveLength(2);
  });

  it("writes the Effect ledger before apply and reconciles uncertain outcomes idempotently", async () => {
    const fixture = await createClaimedTick();
    const attempts = await import("./flow-attempts");
    const attempt = attempts.startFlowV1NodeAttempt({
      cycleId: fixture.cycleId,
      runId: fixture.runId,
      ownerToken: fixture.ownerToken,
      nodeId: "create_issue",
      nodeInput: { title: "Split large.ts" },
    });

    const starting = attempts.startFlowV1Effect({
      cycleId: fixture.cycleId,
      runId: fixture.runId,
      ownerToken: fixture.ownerToken,
      nodeId: "create_issue",
      attemptId: attempt.id,
      idempotencyKey: `${fixture.cycleId}:create_issue`,
    });
    expect(starting.created).toBe(true);
    expect(starting.effect.status).toBe("starting");

    const duplicate = attempts.startFlowV1Effect({
      cycleId: fixture.cycleId,
      runId: fixture.runId,
      ownerToken: fixture.ownerToken,
      nodeId: "create_issue",
      attemptId: attempt.id,
      idempotencyKey: `${fixture.cycleId}:create_issue`,
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.effect.id).toBe(starting.effect.id);

    const uncertain = attempts.transitionFlowV1Effect({
      effectId: starting.effect.id,
      runId: fixture.runId,
      ownerToken: fixture.ownerToken,
      status: "uncertain",
      error: { message: "connection dropped after request" },
    });
    expect(uncertain.effect?.status).toBe("uncertain");
    const reconciled = attempts.transitionFlowV1Effect({
      effectId: starting.effect.id,
      runId: fixture.runId,
      ownerToken: fixture.ownerToken,
      status: "completed",
      externalRef: "issue-42",
      result: { number: 42 },
    });
    expect(reconciled).toEqual(
      expect.objectContaining({
        transitioned: true,
        effect: expect.objectContaining({
          status: "completed",
          externalRef: "issue-42",
          result: { number: 42 },
        }),
      }),
    );
  });

  it("round-trips Attempt and Effect records after reopening SQLite", async () => {
    const fixture = await createClaimedTick();
    const attempts = await import("./flow-attempts");
    const attempt = attempts.startFlowV1NodeAttempt({
      cycleId: fixture.cycleId,
      runId: fixture.runId,
      ownerToken: fixture.ownerToken,
      nodeId: "approval",
      nodeInput: {},
    });
    const effect = attempts.startFlowV1Effect({
      cycleId: fixture.cycleId,
      runId: fixture.runId,
      ownerToken: fixture.ownerToken,
      nodeId: "approval",
      attemptId: attempt.id,
      idempotencyKey: "approval-check-1",
    }).effect;
    const { getDb } = await import("../client");
    getDb().close();
    vi.resetModules();

    const reopened = await import("./flow-attempts");
    expect(reopened.getFlowV1NodeAttempt(attempt.id)?.nodeId).toBe("approval");
    expect(reopened.getFlowV1Effect(effect.id)?.status).toBe("starting");
  });
});

async function createClaimedTick() {
  const { createFlowV1 } = await import("@/lib/flow-v1/flow-service");
  const runtime = await import("./flow-runtime");
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
  const flowId = created.flowId;
  const versionId = created.versionId;
  const tick = runtime.startFlowV1Cycle({
    flowId,
    flowVersionId: versionId,
    origin: { kind: "user" },
    idempotencyKey: "start",
    inputSnapshot: {},
    paramsRevision: 0,
    paramsSnapshot: {},
  });
  const claim = runtime.claimFlowV1Tick({ runId: tick.run.id });
  return {
    cycleId: tick.cycle.id,
    runId: tick.run.id,
    ownerToken: claim!.token,
  };
}
