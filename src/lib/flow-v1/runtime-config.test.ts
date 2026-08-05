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
  vi.restoreAllMocks();
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
      defaultReasoningEffort: null,
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

  it("resolves a selected GitHub connection without persisting its token", async () => {
    const projectCwd = path.join(dataDir, "repository");
    mkdirSync(projectCwd);
    const githubConnections = await import(
      "@/lib/connections/github-cli"
    );
    vi.spyOn(githubConnections, "resolveGitHubCliToken").mockResolvedValue(
      "top-secret-value",
    );
    const service = await import("./flow-service");
    const runtimeConfig = await import("./runtime-config");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const created = service.createFlowV1({
      bundle: configuredBundle(),
      projectCwd,
      secretBindings: {
        GH_TOKEN: {
          kind: "connection",
          provider: "github",
          source: "github_cli",
          host: "github.com",
          login: "octocat",
        },
      },
      activate: true,
    });

    const invoked = await service.invokeFlowV1({
      flowId: created.flowId,
      idempotencyKey: "github-connection-run",
    });

    expect(invoked.execution?.stopReason).toBe("cycle_completed");
    const checkpoint = runtime.getFlowV1CycleCheckpoint(
      invoked.tick.cycle.id,
    );
    expect(checkpoint?.state).toEqual(
      expect.objectContaining({
        nodes: expect.objectContaining({
          inspect: expect.objectContaining({
            output: expect.objectContaining({ hasToken: true }),
          }),
        }),
      }),
    );
    expect(runtimeConfig.getFlowV1RuntimeConfig(created.flowId)).toEqual(
      expect.objectContaining({
        secretBindings: {
          GH_TOKEN: {
            kind: "connection",
            provider: "github",
            source: "github_cli",
            host: "github.com",
            login: "octocat",
          },
        },
      }),
    );
    expect(
      JSON.stringify(
        attempts.listFlowV1NodeAttempts(invoked.tick.cycle.id),
      ),
    ).not.toContain("top-secret-value");
  });

  it("rejects credential values pasted into environment bindings", async () => {
    const service = await import("./flow-service");

    expect(() =>
      service.createFlowV1({
        bundle: configuredBundle(),
        secretBindings: {
          GH_TOKEN: {
            kind: "environment",
            env: `ghp_${"a".repeat(36)}`,
          },
        },
      }),
    ).toThrow(/looks like a credential value/u);
  });

  it("does not inject a bound Secret into a node without explicit access", async () => {
    const service = await import("./flow-service");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const created = service.createFlowV1({
      bundle: configuredBundle(false),
      projectCwd: dataDir,
      secretBindings: {
        GH_TOKEN: {
          kind: "environment",
          env: "FLOW_CONFIG_TEST_TOKEN",
        },
      },
      activate: true,
    });

    const invoked = await service.invokeFlowV1({
      flowId: created.flowId,
      idempotencyKey: "least-privilege-run",
      environment: { GH_TOKEN: "top-secret-value" },
    });

    expect(
      runtime.getFlowV1CycleCheckpoint(invoked.tick.cycle.id)?.state,
    ).toEqual(
      expect.objectContaining({
        nodes: expect.objectContaining({
          inspect: expect.objectContaining({
            output: expect.objectContaining({ hasToken: false }),
          }),
        }),
      }),
    );
  });

  it("rejects connection bindings for plain string Secrets", async () => {
    const service = await import("./flow-service");
    const bundle = createFlowV1Bundle([
      {
        path: "flow.js",
        content: `
          export const schemaVersion = "tutti.flow.v1";
          export const secrets = defineSecrets({
            API_TOKEN: stringSecret({ required: true }),
          });
          completeCycle({ id: "done" });
        `,
      },
    ]);

    expect(() =>
      service.createFlowV1({
        bundle,
        secretBindings: {
          API_TOKEN: {
            kind: "connection",
            provider: "github",
            source: "github_cli",
            host: "github.com",
            login: "octocat",
          },
        },
      }),
    ).toThrow(/does not accept a connection binding/u);
  });

  it("never persists a Secret returned by a Code node", async () => {
    const service = await import("./flow-service");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const created = service.createFlowV1({
      bundle: createFlowV1Bundle([
        {
          path: "flow.js",
          content: `
            export const schemaVersion = "tutti.flow.v1";
            export const secrets = defineSecrets({
              GH_TOKEN: connectionSecret({ provider: "github", required: true }),
            });
            const leak = script({
              id: "leak",
              file: "scripts/leak.mjs",
              secrets: ["GH_TOKEN"],
            });
            completeCycle({ id: "done", inputs: { leak } });
          `,
        },
        {
          path: "scripts/leak.mjs",
          content: `
            export async function run() {
              return { nested: { token: process.env.GH_TOKEN } };
            }
          `,
        },
      ]),
      secretBindings: {
        GH_TOKEN: {
          kind: "environment",
          env: "FLOW_CONFIG_TEST_TOKEN",
        },
      },
      activate: true,
    });

    const invoked = await service.invokeFlowV1({
      flowId: created.flowId,
      idempotencyKey: "secret-output-run",
    });
    const serializedAttempts = JSON.stringify(
      attempts.listFlowV1NodeAttempts(invoked.tick.cycle.id),
    );

    expect(serializedAttempts).toContain("flow_runner_secret_output");
    expect(serializedAttempts).not.toContain("top-secret-value");
  });
});

function configuredBundle(declareSecretAccess = true) {
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
          ${declareSecretAccess ? 'secrets: ["GH_TOKEN"],' : ""}
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
