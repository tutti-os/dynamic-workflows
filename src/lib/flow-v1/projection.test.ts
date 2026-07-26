import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "./bundle";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-projection-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 detail projection", () => {
  it("projects design, current position, counts, and persisted history", async () => {
    const service = await import("./flow-service");
    const { getFlowV1DetailProjection } = await import("./projection");
    const created = service.createFlowV1({
      bundle: waitingBundle(),
      params: { threshold: 1800 },
      projectCwd: dataDir,
      secretBindings: {
        optionalToken: {
          kind: "environment",
          env: "FLOW_PROJECTION_TEST_TOKEN",
        },
      },
      activate: true,
    });
    const invoked = await service.invokeFlowV1({
      flowId: created.flowId,
      idempotencyKey: "projection-1",
    });
    expect(invoked.execution?.stopReason).toBe("waiting_human");

    const projection = getFlowV1DetailProjection(created.flowId);
    expect(projection).toEqual(
      expect.objectContaining({
        schemaVersion: "tutti.flow.v1",
        runtime: expect.objectContaining({
          lifecycle: "active",
          cycleCount: 1,
          runCount: 1,
          activeCycle: expect.objectContaining({
            status: "waiting_human",
            currentNodeId: "review",
          }),
        }),
        selectedCycle: expect.objectContaining({
          status: "waiting_human",
        }),
      }),
    );
    expect(projection?.graph.nodes.map((node) => node.id)).toEqual([
      "scan",
      "review",
      "done",
    ]);
    expect(projection?.checkpoint?.nodes.review).toEqual(
      expect.objectContaining({
        status: "waiting",
        waitingReason: expect.stringContaining("Human task"),
      }),
    );
    expect(projection?.runs).toHaveLength(1);
    expect(projection?.attempts.map((attempt) => attempt.nodeId)).toEqual([
      "scan",
      "review",
    ]);
    expect(projection?.humanTasks).toEqual([
      expect.objectContaining({ nodeId: "review", status: "pending" }),
    ]);
    expect(projection?.configuration).toEqual(
      expect.objectContaining({
        paramsSchema: expect.objectContaining({
          threshold: expect.objectContaining({ required: false }),
        }),
        inputsSchema: expect.objectContaining({
          scope: expect.objectContaining({ required: false }),
        }),
        secretsSchema: expect.objectContaining({
          optionalToken: expect.objectContaining({ required: false }),
        }),
        params: expect.objectContaining({
          revision: 1,
          values: { threshold: 1800 },
        }),
        projectCwd: realpathSync(dataDir),
        secretBindings: {
          optionalToken: {
            kind: "environment",
            env: "FLOW_PROJECTION_TEST_TOKEN",
          },
        },
      }),
    );
  });
});

function waitingBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = { name: "projection", description: "Projection" };
        export const params = defineParams({
          threshold: numberParam({ default: 1000 }),
        });
        export const inputs = defineInputs({
          scope: stringInput({ required: false }),
        });
        export const secrets = defineSecrets({
          optionalToken: stringSecret({ required: false }),
        });
        const scan = script({ id: "scan", file: "scripts/scan.mjs" });
        const review = human({
          id: "review",
          inputs: { result: scan },
          context: [
            { label: "Result", value: "{{result}}", display: "json" },
          ],
          actions: [
            {
              id: "approve",
              label: "Approve",
              intent: "primary",
              fields: [],
            },
          ],
        });
        const done = completeCycle({ id: "done", inputs: { review } });
        route(review, { approve: done });
      `,
    },
    {
      path: "scripts/scan.mjs",
      content: "export async function run() { return { found: true }; }",
    },
  ]);
}
