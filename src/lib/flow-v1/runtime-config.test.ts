import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "./bundle";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-config-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  process.env.FLOW_CONFIG_TEST_TOKEN = "top-secret-value";
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  delete process.env.FLOW_CONFIG_TEST_TOKEN;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 runtime configuration", () => {
  it("injects persisted cwd and environment-backed Secrets without persisting values", async () => {
    const projectCwd = path.join(dataDir, "repository");
    mkdirSync(projectCwd);
    const service = await import("./flow-service");
    const runtimeConfig = await import("./runtime-config");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const created = service.createFlowV1({
      bundle: configuredBundle(),
      projectCwd,
      secretBindings: {
        GH_TOKEN: {
          kind: "environment",
          env: "FLOW_CONFIG_TEST_TOKEN",
        },
      },
      activate: true,
    });
    const resolvedProjectCwd = realpathSync(projectCwd);

    const invoked = await service.invokeFlowV1({
      flowId: created.flowId,
      idempotencyKey: "configured-run",
    });

    expect(invoked.execution?.stopReason).toBe("cycle_completed");
    const checkpoint = runtime.getFlowV1CycleCheckpoint(
      invoked.tick.cycle.id,
    );
    expect(checkpoint?.state).toEqual(
      expect.objectContaining({
        nodes: expect.objectContaining({
          inspect: expect.objectContaining({
            output: {
              cwd: resolvedProjectCwd,
              hasToken: true,
            },
          }),
        }),
      }),
    );
    expect(runtimeConfig.getFlowV1RuntimeConfig(created.flowId)).toEqual({
      projectCwd: resolvedProjectCwd,
      defaultAgent: null,
      defaultModel: null,
      defaultPermissionMode: null,
      secretBindings: {
        GH_TOKEN: {
          kind: "environment",
          env: "FLOW_CONFIG_TEST_TOKEN",
        },
      },
    });
    expect(
      JSON.stringify(
        attempts.listFlowV1NodeAttempts(invoked.tick.cycle.id),
      ),
    ).not.toContain("top-secret-value");
  });
});

function configuredBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = {
          name: "configured-flow",
          description: "Configured cwd and Secret bindings",
          requiresCwd: true,
        };
        export const secrets = defineSecrets({
          GH_TOKEN: connectionSecret({ provider: "github", required: true }),
        });
        const inspect = script({
          id: "inspect",
          file: "scripts/inspect.mjs",
        });
        const done = completeCycle({ id: "done", inputs: { inspect } });
      `,
    },
    {
      path: "scripts/inspect.mjs",
      content: `
        export async function run() {
          return {
            cwd: process.cwd(),
            hasToken: process.env.GH_TOKEN === "top-secret-value",
          };
        }
      `,
    },
  ]);
}
