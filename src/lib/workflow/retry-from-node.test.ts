import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput } from "@/lib/agents/types";
import { installMockAgentRuntime } from "./test-support/mock-agent-runtime";
import type { WorkflowValue } from "./types";

// Mock the agent runtime boundary (NOT the executor) so the REAL executor runs
// end to end through run-jobs while we script per-node replies. The shared mock
// emits a session_ref by default, which populates nodeSessions and is exactly
// what exposes a stale crash-recovery attach on the re-run path.
const runAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/runtime", () => ({
  runAgent: runAgentMock,
}));

// A -> B -> C linear chain; B consumes A, C consumes B (via templates).
const CHAIN_SCRIPT = `
export const meta = { name: "retry-chain", description: "Chain fixture" }
const a = await agent({ id: "a", label: "A", prompt: "Do A." })
const b = await agent({ id: "b", label: "B", prompt: "Do B with {{a}}." })
const c = await agent({ id: "c", label: "C", prompt: "Do C with {{b}}." })
`;

// discover -> map -> synthesis; the map re-resolves its source from discover.
const MAP_SCRIPT = `
export const meta = { name: "retry-map", description: "Map fixture" }
const discover = await agent({
  id: "discover",
  label: "Discover",
  output: "json",
  prompt: "List work items as a JSON array.",
})
const migrated = await map({
  id: "migrated",
  label: "Migrate each site",
  source: discover,
  maxItems: 5,
  onItemFailure: "skip",
  step: agent({
    id: "migrate_one",
    label: "Migrate {{item.file}}",
    prompt: "Migrate {{item.file}} as item {{item_index}}.",
  }),
})
const synthesis = await agent({
  id: "synthesis",
  label: "Synthesize",
  prompt: "Summarize {{migrated}}",
})
`;

// A -> human(approve); approve reads {{a}} in its context so a->approve is an
// edge. A is scripted to fail so the run is terminal without resolving approve.
const HUMAN_SCRIPT = `
export const meta = { name: "retry-human", description: "Human fixture" }
const a = await agent({ id: "a", label: "A", prompt: "Do A." })
const approve = await human({
  id: "approve",
  label: "Approve",
  context: [{ label: "Draft", value: "{{a}}", display: "text" }],
  actions: [{ id: "ok", label: "OK" }],
})
`;

let dataDir: string | undefined;

function mockAgentRuntime(
  reply: (input: AgentRunInput) => { text: string; fail?: boolean },
): AgentRunInput[] {
  return installMockAgentRuntime(runAgentMock, reply, { sessionRef: "always" });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 400; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for workflow job.");
}

function bootstrapDataDir(): void {
  dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
}

function readMapOutput(result: unknown): {
  items: Array<{ index: number }>;
  failed: Array<{ index: number }>;
  total: number;
} {
  const outputs = (result as { outputs?: Record<string, WorkflowValue> })
    ?.outputs;
  return outputs?.migrated as unknown as {
    items: Array<{ index: number }>;
    failed: Array<{ index: number }>;
    total: number;
  };
}

afterEach(() => {
  vi.resetModules();
  runAgentMock.mockReset();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
});

describe("retry from node", () => {
  it("re-runs the node and its downstream fresh while upstream stays put", async () => {
    bootstrapDataDir();

    let bCalls = 0;
    const calls = mockAgentRuntime((input) => {
      const title = input.title ?? "";
      if (title === "A") {
        return { text: "a-out" };
      }
      if (title === "B") {
        bCalls += 1;
        return { text: bCalls === 1 ? "b-v1" : "b-v2" };
      }
      return { text: `c(${input.prompt})` };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const { readRunResult } = await import("@/lib/workflow/run-state");
    const {
      isWorkflowRunJobActive,
      retryWorkflowRunFromNode,
      startWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");

    const detail = createWorkflowFromScript(CHAIN_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }

    const run = startWorkflowRunJob({
      workflowId: detail.workflow.id,
      version,
      cwd: process.cwd(),
      executorKind: "mock",
      inputs: {},
      input: { inputs: {} },
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));
    expect(getWorkflowRun(run.id)?.status).toBe("completed");

    const countTitle = (title: string) =>
      calls.filter((call) => (call.title ?? "") === title).length;
    expect(countTitle("A")).toBe(1);
    expect(countTitle("B")).toBe(1);
    expect(countTitle("C")).toBe(1);

    await retryWorkflowRunFromNode({
      workflowId: detail.workflow.id,
      runId: run.id,
      fromNodeId: "b",
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));
    expect(getWorkflowRun(run.id)?.status).toBe("completed");

    // A never re-ran; B and C re-ran once more each.
    expect(countTitle("A")).toBe(1);
    expect(countTitle("B")).toBe(2);
    expect(countTitle("C")).toBe(2);

    // The re-runs are fresh executions, not crash-recovery attaches to the
    // first run's agent sessions (which would harvest stale output).
    const lastB = [...calls].reverse().find((call) => call.title === "B");
    const lastC = [...calls].reverse().find((call) => call.title === "C");
    expect(lastB?.attachSessionId).toBeUndefined();
    expect(lastC?.attachSessionId).toBeUndefined();

    // C re-ran on the corrected B output; the persisted result reflects it, and
    // A's kept output is untouched.
    expect(lastC?.prompt).toContain("b-v2");
    expect(lastC?.prompt).not.toContain("b-v1");
    const result = readRunResult(getWorkflowRun(run.id)?.result);
    expect(result.outputs?.a).toBe("a-out");
    expect(result.outputs?.b).toBe("b-v2");
    expect(String(result.outputs?.c)).toContain("b-v2");
    expect(result.nodeStatuses.c).toBe("completed");
  });

  it("deletes the map checkpoint so a downstream map re-expands from the new upstream output", async () => {
    bootstrapDataDir();

    let discoverCalls = 0;
    const calls = mockAgentRuntime((input) => {
      const title = input.title ?? "";
      if (title === "Discover") {
        discoverCalls += 1;
        return {
          text:
            discoverCalls === 1
              ? JSON.stringify([{ file: "a.ts" }, { file: "b.ts" }, { file: "c.ts" }])
              : JSON.stringify([{ file: "x.ts" }, { file: "y.ts" }]),
        };
      }
      if (title.startsWith("Migrate ")) {
        return { text: `migrated ${title.slice("Migrate ".length)}` };
      }
      return { text: `synthesis of ${input.prompt}` };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const {
      isWorkflowRunJobActive,
      retryWorkflowRunFromNode,
      startWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");

    const detail = createWorkflowFromScript(MAP_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }

    const run = startWorkflowRunJob({
      workflowId: detail.workflow.id,
      version,
      cwd: process.cwd(),
      executorKind: "mock",
      inputs: {},
      input: { inputs: {} },
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));
    expect(getWorkflowRun(run.id)?.status).toBe("completed");

    const countTitle = (title: string) =>
      calls.filter((call) => (call.title ?? "") === title).length;
    expect(readMapOutput(getWorkflowRun(run.id)?.result).total).toBe(3);
    expect(countTitle("Migrate a.ts")).toBe(1);
    expect(countTitle("Migrate b.ts")).toBe(1);
    expect(countTitle("Migrate c.ts")).toBe(1);

    await retryWorkflowRunFromNode({
      workflowId: detail.workflow.id,
      runId: run.id,
      fromNodeId: "discover",
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));
    expect(getWorkflowRun(run.id)?.status).toBe("completed");

    // Discover re-ran and produced a NEW item set; the map dropped its stale
    // checkpoint and re-expanded over x.ts / y.ts. The old items did not re-run.
    expect(countTitle("Discover")).toBe(2);
    expect(countTitle("Migrate x.ts")).toBe(1);
    expect(countTitle("Migrate y.ts")).toBe(1);
    expect(countTitle("Migrate a.ts")).toBe(1);
    expect(countTitle("Migrate b.ts")).toBe(1);
    expect(countTitle("Migrate c.ts")).toBe(1);
    expect(countTitle("Synthesize")).toBe(2);

    const finalOutput = readMapOutput(getWorkflowRun(run.id)?.result);
    expect(finalOutput.total).toBe(2);
    expect(finalOutput.failed).toHaveLength(0);
  });

  it("rejects retrying a non-terminal run", async () => {
    bootstrapDataDir();
    mockAgentRuntime(() => ({ text: "unused" }));

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { createWorkflowRun } = await import("@/lib/db/workflows/runs");
    const { retryWorkflowRunFromNode } = await import(
      "@/lib/workflow/run-jobs"
    );

    const detail = createWorkflowFromScript(CHAIN_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = createWorkflowRun({
      workflowId: detail.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      request: { inputs: {} },
    });

    await expect(
      retryWorkflowRunFromNode({
        workflowId: detail.workflow.id,
        runId: run.id,
        fromNodeId: "a",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RETRY_FROM_NODE_INVALID" });
  });

  it("rejects an unknown node id", async () => {
    bootstrapDataDir();
    mockAgentRuntime((input) => ({ text: input.title ?? "" }));

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const {
      isWorkflowRunJobActive,
      retryWorkflowRunFromNode,
      startWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");

    const detail = createWorkflowFromScript(CHAIN_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = startWorkflowRunJob({
      workflowId: detail.workflow.id,
      version,
      cwd: process.cwd(),
      executorKind: "mock",
      inputs: {},
      input: { inputs: {} },
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));
    expect(getWorkflowRun(run.id)?.status).toBe("completed");

    await expect(
      retryWorkflowRunFromNode({
        workflowId: detail.workflow.id,
        runId: run.id,
        fromNodeId: "nope",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RETRY_NODE_INVALID" });
  });

  it("rejects a reset set containing a human node, naming it", async () => {
    bootstrapDataDir();
    mockAgentRuntime((input) => {
      const title = input.title ?? "";
      // A fails so the run terminates without ever reaching the human gate.
      return title === "A"
        ? { text: "boom", fail: true }
        : { text: title };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const {
      isWorkflowRunJobActive,
      retryWorkflowRunFromNode,
      startWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");

    const detail = createWorkflowFromScript(HUMAN_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = startWorkflowRunJob({
      workflowId: detail.workflow.id,
      version,
      cwd: process.cwd(),
      executorKind: "mock",
      inputs: {},
      input: { inputs: {} },
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));
    expect(getWorkflowRun(run.id)?.status).toBe("failed");

    await expect(
      retryWorkflowRunFromNode({
        workflowId: detail.workflow.id,
        runId: run.id,
        fromNodeId: "a",
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_RETRY_FROM_NODE_INVALID",
      message: expect.stringContaining("approve"),
    });
  });

  it("rejects when the node's upstream did not complete", async () => {
    bootstrapDataDir();
    mockAgentRuntime((input) => {
      const title = input.title ?? "";
      // A fails, so B and C never run: C's upstream is incomplete.
      return title === "A"
        ? { text: "boom", fail: true }
        : { text: title };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const {
      isWorkflowRunJobActive,
      retryWorkflowRunFromNode,
      startWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");

    const detail = createWorkflowFromScript(CHAIN_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = startWorkflowRunJob({
      workflowId: detail.workflow.id,
      version,
      cwd: process.cwd(),
      executorKind: "mock",
      inputs: {},
      input: { inputs: {} },
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));
    expect(getWorkflowRun(run.id)?.status).toBe("failed");

    await expect(
      retryWorkflowRunFromNode({
        workflowId: detail.workflow.id,
        runId: run.id,
        fromNodeId: "c",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RETRY_FROM_NODE_INVALID" });
  });
});
