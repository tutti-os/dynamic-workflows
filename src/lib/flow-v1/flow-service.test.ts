import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "./bundle";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-service-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 creation, publication, and direct Invocation", () => {
  it("creates a Bundle-native active Flow with resolved Params and Schedule", async () => {
    const service = await import("./flow-service");
    const settings = await import("@/lib/db/workflows/flow-settings");
    const { getFlowV1BundleForVersion } = await import(
      "@/lib/db/workflows/flow-bundles"
    );
    const { getDb } = await import("@/lib/db/client");
    const bundle = scheduledBundle();
    const created = service.createFlowV1({
      bundle,
      activate: true,
      now: "2026-07-26T00:00:00.000Z",
    });

    expect(getFlowV1BundleForVersion(created.versionId)?.hash).toBe(
      bundle.hash,
    );
    expect(settings.getCurrentFlowV1Params(created.flowId)).toEqual(
      expect.objectContaining({
        revision: 1,
        values: {
          cron: "0 9 * * *",
          timezone: "Asia/Singapore",
          target: "src",
        },
      }),
    );
    expect(settings.getFlowV1Schedule(created.flowId)).toEqual(
      expect.objectContaining({
        status: "active",
        cronExpression: "0 9 * * *",
        timezone: "Asia/Singapore",
        input: { target: "src" },
        nextFireAt: "2026-07-26T01:00:00.000Z",
      }),
    );
    expect(
      getDb()
        .prepare(
          `
          SELECT lifecycle, current_version_id
          FROM workflows WHERE id = ?
        `,
        )
        .get(created.flowId),
    ).toEqual({
      lifecycle: "active",
      current_version_id: created.versionId,
    });
  });

  it("starts, rejects conflicting input, and resumes a waiting Cycle", async () => {
    const service = await import("./flow-service");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const created = service.createFlowV1({
      bundle: directGateBundle(),
      activate: true,
    });

    const first = await service.invokeFlowV1({
      flowId: created.flowId,
      invocationInput: { item: "large.ts" },
      idempotencyKey: "direct-1",
      environment: { FLOW_DIRECT_APPROVED: "false" },
    });
    expect(first.action).toBe("started_cycle");
    expect(first.execution?.stopReason).toBe("waiting_gate");

    await expect(
      service.invokeFlowV1({
        flowId: created.flowId,
        invocationInput: { item: "different.ts" },
      }),
    ).rejects.toMatchObject({
      code: "flow_active_cycle_input_conflict",
    });

    const resumed = await service.invokeFlowV1({
      flowId: created.flowId,
      idempotencyKey: "direct-2",
      environment: { FLOW_DIRECT_APPROVED: "true" },
    });
    expect(resumed.action).toBe("resumed_cycle");
    expect(resumed.execution?.stopReason).toBe("cycle_completed");
    expect(runtime.listFlowV1Cycles(created.flowId)[0]?.status).toBe(
      "completed",
    );
  });

  it("returns an existing active Tick instead of creating a duplicate", async () => {
    const service = await import("./flow-service");
    const created = service.createFlowV1({
      bundle: directGateBundle(),
      activate: true,
    });
    const pending = await service.invokeFlowV1({
      flowId: created.flowId,
      invocationInput: { item: "large.ts" },
      idempotencyKey: "pending",
      executeTick: false,
    });
    const duplicate = await service.invokeFlowV1({
      flowId: created.flowId,
      invocationInput: { item: "ignored-while-active.ts" },
    });

    expect(duplicate.action).toBe("active_tick");
    expect(duplicate.tick.run.id).toBe(pending.tick.run.id);
    expect(duplicate.tick.cycle.id).toBe(pending.tick.cycle.id);
  });

  it("identifies a completed Tick returned by an idempotent retry", async () => {
    const service = await import("./flow-service");
    const created = service.createFlowV1({
      bundle: directGateBundle(),
      activate: true,
    });
    const first = await service.invokeFlowV1({
      flowId: created.flowId,
      invocationInput: { item: "large.ts" },
      idempotencyKey: "completed-retry",
      environment: { FLOW_DIRECT_APPROVED: "true" },
    });
    expect(first.action).toBe("started_cycle");
    expect(first.execution?.stopReason).toBe("cycle_completed");

    const retry = await service.invokeFlowV1({
      flowId: created.flowId,
      invocationInput: { item: "different-input-is-ignored" },
      idempotencyKey: "completed-retry",
      environment: { FLOW_DIRECT_APPROVED: "true" },
    });

    expect(retry.action).toBe("idempotent_tick");
    expect(retry.tick.created).toBe(false);
    expect(retry.tick.cycle.id).toBe(first.tick.cycle.id);
    expect(retry.tick.run.id).toBe(first.tick.run.id);
    expect(retry.execution).toBeNull();
  });

  it("resolves a Human task and creates exactly one continuation Tick", async () => {
    const service = await import("./flow-service");
    const humanTasks = await import("@/lib/db/workflows/human-tasks");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const created = service.createFlowV1({
      bundle: directHumanBundle(),
      activate: true,
    });
    const first = await service.invokeFlowV1({
      flowId: created.flowId,
      invocationInput: { item: "large.ts" },
      idempotencyKey: "human-direct-1",
    });
    expect(first.execution?.stopReason).toBe("waiting_human");
    const [task] = humanTasks.listFlowV1HumanTasks(first.tick.cycle.id);

    const response = {
      flowId: created.flowId,
      runId: first.tick.run.id,
      taskId: task!.id,
      action: "approve",
      values: { note: "approved" },
      revision: task!.revision,
      resolvedBy: "test-owner",
    };
    const resumed = await service.respondToFlowV1HumanTask(response);
    expect(resumed.execution?.stopReason).toBe("cycle_completed");
    expect(resumed.task.status).toBe("resolved");

    const retry = await service.respondToFlowV1HumanTask(response);
    expect(retry.tick.run.id).toBe(resumed.tick.run.id);
    expect(retry.execution).toBeNull();
    expect(runtime.listFlowV1Cycles(created.flowId)).toHaveLength(1);
  });

  it("retries a failed node while preserving unaffected upstream state", async () => {
    const service = await import("./flow-service");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const created = service.createFlowV1({
      bundle: retryBundle(),
      activate: true,
    });
    const first = await service.invokeFlowV1({
      flowId: created.flowId,
      idempotencyKey: "retry-first",
      environment: { FLOW_RETRY_FAIL: "true" },
    });
    expect(first.execution?.stopReason).toBe("paused_failed");

    const retried = await service.retryFlowV1Node({
      flowId: created.flowId,
      cycleId: first.tick.cycle.id,
      nodeId: "unstable",
      environment: { FLOW_RETRY_FAIL: "false" },
    });

    expect(retried.invalidatedNodeIds).toEqual(["unstable", "done"]);
    expect(retried.execution?.stopReason).toBe("cycle_completed");
    expect(
      attempts
        .listFlowV1NodeAttempts(first.tick.cycle.id)
        .filter((attempt) => attempt.nodeId === "stable"),
    ).toHaveLength(1);
    expect(
      attempts
        .listFlowV1NodeAttempts(first.tick.cycle.id)
        .filter((attempt) => attempt.nodeId === "unstable")
        .map((attempt) => attempt.status),
    ).toEqual(["failed", "failed", "failed", "completed"]);
  });

  it("publishes a new immutable Version and supersedes the previous one", async () => {
    const service = await import("./flow-service");
    const { getDb } = await import("@/lib/db/client");
    const first = service.createFlowV1({
      bundle: directGateBundle(),
      activate: true,
    });
    const secondBundle = directGateBundle("direct-gate-v2");
    const second = service.createFlowV1Version({
      flowId: first.flowId,
      bundle: secondBundle,
      publish: true,
    });

    expect(
      getDb()
        .prepare(
          `
          SELECT id, version_status
          FROM workflow_versions
          WHERE workflow_id = ?
          ORDER BY version ASC
        `,
        )
        .all(first.flowId),
    ).toEqual([
      { id: first.versionId, version_status: "superseded" },
      { id: second.versionId, version_status: "published" },
    ]);
    expect(
      getDb()
        .prepare("SELECT lifecycle FROM workflows WHERE id = ?")
        .get(first.flowId),
    ).toEqual({ lifecycle: "draft" });
  });

  it("supersedes older unpublished Drafts when a newer Draft is published", async () => {
    const service = await import("./flow-service");
    const { getDb } = await import("@/lib/db/client");
    const created = service.createFlowV1({
      bundle: directGateBundle(),
    });
    const firstDraft = service.createFlowV1Version({
      flowId: created.flowId,
      bundle: directGateBundle("draft-v2"),
    });
    const secondDraft = service.createFlowV1Version({
      flowId: created.flowId,
      bundle: directGateBundle("draft-v3"),
    });

    service.publishFlowV1Version({
      flowId: created.flowId,
      versionId: secondDraft.versionId,
    });

    expect(
      getDb()
        .prepare(
          "SELECT version_status FROM workflow_versions WHERE id = ?",
        )
        .get(firstDraft.versionId),
    ).toEqual({ version_status: "superseded" });
  });

  it("enforces declared Param and Cycle input types, ranges, and keys", async () => {
    const service = await import("./flow-service");
    const created = service.createFlowV1({
      bundle: constrainedSchemaBundle(),
      activate: true,
    });

    expect(() =>
      service.configureFlowV1({
        flowId: created.flowId,
        params: { rounds: 11 },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "flow_value_constraint_invalid" }),
    );
    expect(() =>
      service.configureFlowV1({
        flowId: created.flowId,
        params: { rounds: "three" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "flow_value_type_invalid" }),
    );
    await expect(
      service.invokeFlowV1({
        flowId: created.flowId,
        invocationInput: { target: "src", extra: true },
      }),
    ).rejects.toMatchObject({ code: "flow_unknown_value" });
    await expect(
      service.invokeFlowV1({
        flowId: created.flowId,
        invocationInput: { target: "" },
      }),
    ).rejects.toMatchObject({
      code: "flow_value_constraint_invalid",
    });
  });

  it("removes a persisted Schedule when the published Version removes its Trigger", async () => {
    const service = await import("./flow-service");
    const settings = await import("@/lib/db/workflows/flow-settings");
    const created = service.createFlowV1({
      bundle: scheduledBundle(),
      now: "2026-07-26T00:00:00.000Z",
    });
    expect(settings.getFlowV1Schedule(created.flowId)).not.toBeNull();
    const next = service.createFlowV1Version({
      flowId: created.flowId,
      bundle: unscheduledBundle(),
    });

    service.publishFlowV1Version({
      flowId: created.flowId,
      versionId: next.versionId,
      now: "2026-07-26T00:10:00.000Z",
    });

    expect(settings.getFlowV1Schedule(created.flowId)).toBeNull();
    expect(settings.getCurrentFlowV1Params(created.flowId)).toEqual(
      expect.objectContaining({ revision: 2, values: {} }),
    );
  });

  it("rolls back Params and Schedule when runtime configuration is invalid", async () => {
    const service = await import("./flow-service");
    const settings = await import("@/lib/db/workflows/flow-settings");
    const created = service.createFlowV1({
      bundle: scheduledBundle(),
      now: "2026-07-26T00:00:00.000Z",
    });

    expect(() =>
      service.configureFlowV1({
        flowId: created.flowId,
        params: {
          cron: "0 10 * * *",
          timezone: "UTC",
          target: "packages/app",
        },
        projectCwd: path.join(dataDir, "missing"),
      }),
    ).toThrow();

    expect(settings.getCurrentFlowV1Params(created.flowId)).toEqual(
      expect.objectContaining({
        revision: 1,
        values: {
          cron: "0 9 * * *",
          timezone: "Asia/Singapore",
          target: "src",
        },
      }),
    );
    expect(settings.getFlowV1Schedule(created.flowId)).toEqual(
      expect.objectContaining({
        cronExpression: "0 9 * * *",
        timezone: "Asia/Singapore",
        input: { target: "src" },
        revision: 0,
      }),
    );
  });

  it("requires an explicit default Agent before activating Agent nodes", async () => {
    const service = await import("./flow-service");
    const bundle = createFlowV1Bundle([
      {
        path: "flow.js",
        content: `
          export const schemaVersion = "tutti.flow.v1";
          const implement = agent({
            id: "implement",
            prompt: "Implement the plan.",
          });
          completeCycle({ id: "done", inputs: { implement } });
        `,
      },
    ]);

    expect(() =>
      service.createFlowV1({ bundle, activate: true }),
    ).toThrowError(
      expect.objectContaining({ code: "flow_default_agent_missing" }),
    );
    expect(
      service.createFlowV1({
        bundle,
        defaultAgent: "local:codex",
        activate: true,
      }).flowId,
    ).toEqual(expect.any(String));
  });
});

function constrainedSchemaBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const params = defineParams({
          rounds: numberParam({ default: 3, min: 1, max: 10, integer: true }),
        });
        export const inputs = defineInputs({
          target: stringInput({ required: true, minLength: 1 }),
        });
        completeCycle({ id: "done" });
      `,
    },
  ]);
}

function scheduledBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = {
          name: "scheduled-large-files",
          description: "Scheduled large file governance",
        };
        export const params = defineParams({
          cron: cronParam({ default: "0 9 * * *" }),
          timezone: stringParam({ default: "Asia/Singapore" }),
          target: stringParam({ default: "src" }),
        });
        export const inputs = defineInputs({
          target: stringInput({ required: true }),
        });
        export const schedule = cron({
          expression: ref("params.cron"),
          timezone: ref("params.timezone"),
          inputs: { target: ref("params.target") },
        });
        const scan = script({
          id: "scan",
          file: "scripts/scan.mjs",
          inputs: { target: ref("inputs.target") },
        });
        const done = completeCycle({ id: "done", inputs: { scan } });
      `,
    },
    {
      path: "scripts/scan.mjs",
      content: "export async function run(ctx) { return { target: ctx.target }; }",
    },
  ]);
}

function unscheduledBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = {
          name: "manual-large-files",
          description: "Manually invoked large file governance",
        };
        completeCycle({ id: "done" });
      `,
    },
  ]);
}

function directGateBundle(name = "direct-gate") {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = { name: "${name}", description: "Direct gate" };
        export const inputs = defineInputs({
          item: stringInput({ required: true }),
        });
        const check = gate({
          id: "check",
          file: "scripts/check.mjs",
          inputs: { item: ref("inputs.item") },
          outcomes: ["approved"],
        });
        const done = completeCycle({ id: "done", inputs: { check } });
        route(check, { approved: done });
      `,
    },
    {
      path: "scripts/check.mjs",
      content: `
        export async function check(ctx) {
          return process.env.FLOW_DIRECT_APPROVED === "true"
            ? {
                status: "completed",
                outcome: "approved",
                output: { item: ctx.item },
              }
            : { status: "waiting", reason: "not approved" };
        }
      `,
    },
  ]);
}

function directHumanBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = { name: "direct-human", description: "Human task" };
        export const inputs = defineInputs({
          item: stringInput({ required: true }),
        });
        const review = human({
          id: "review",
          inputs: { item: ref("inputs.item") },
          description: "Approve the item.",
          context: [
            { label: "Item", value: "{{item}}", display: "text" },
          ],
          actions: [
            {
              id: "approve",
              label: "Approve",
              intent: "primary",
              fields: [
                {
                  id: "note",
                  type: "text",
                  label: "Note",
                  required: false,
                },
              ],
            },
          ],
        });
        const done = completeCycle({ id: "done", inputs: { review } });
        route(review, { approve: done });
      `,
    },
  ]);
}

function retryBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = { name: "retry", description: "Retry a node" };
        const stable = script({
          id: "stable",
          file: "scripts/stable.mjs",
        });
        const unstable = script({
          id: "unstable",
          file: "scripts/unstable.mjs",
          inputs: { stable },
        });
        const done = completeCycle({ id: "done", inputs: { unstable } });
      `,
    },
    {
      path: "scripts/stable.mjs",
      content: "export async function run() { return { stable: true }; }",
    },
    {
      path: "scripts/unstable.mjs",
      content: `
        export async function run() {
          if (process.env.FLOW_RETRY_FAIL === "true") {
            throw new Error("fixture failed");
          }
          return { recovered: true };
        }
      `,
    },
  ]);
}
