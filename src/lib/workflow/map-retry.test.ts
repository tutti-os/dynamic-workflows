import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput, AgentRuntimeEvent } from "@/lib/agents/types";
import type { WorkflowValue } from "./types";

// Mock the agent runtime boundary (NOT the executor) so the REAL executor runs
// end to end through run-jobs while we still force a specific item to fail.
const runAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/runtime", () => ({
  runAgent: runAgentMock,
}));

const DISCOVER_ITEMS = [
  { file: "a.ts", line: 1 },
  { file: "b.ts", line: 2 },
  { file: "c.ts", line: 3 },
];

const SCRIPT = `
export const meta = { name: "map-retry", description: "Map retry fixture" }
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

let dataDir: string | undefined;

function mockAgentRuntime(
  reply: (input: AgentRunInput) => { text: string; fail?: boolean },
): AgentRunInput[] {
  const calls: AgentRunInput[] = [];
  let sessionCounter = 0;
  runAgentMock.mockImplementation(async function* (
    input: AgentRunInput,
  ): AsyncGenerator<AgentRuntimeEvent> {
    calls.push(input);
    const result = reply(input);
    // Real adapters report a session ref; emitting one here populates
    // nodeSessions, which is what makes the stale-attach regression visible.
    sessionCounter += 1;
    yield {
      type: "session_ref",
      session: {
        agentSessionId:
          input.attachSessionId ??
          input.resumeSessionId ??
          `mock-session-${sessionCounter}`,
        agent: input.agent,
        status: "running",
      },
    };
    if (result.fail) {
      yield { type: "error", code: "mock_error", message: result.text };
      return;
    }
    yield { type: "text_delta", text: result.text };
    yield { type: "done", status: "completed", reason: "completed" };
  });
  return calls;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
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

describe("map failed-item retry", () => {
  it("re-runs only the failed item and re-synthesizes the corrected output", async () => {
    bootstrapDataDir();

    let migrateBCalls = 0;
    const calls = mockAgentRuntime((input) => {
      const title = input.title ?? "";
      if (title === "Discover") {
        return { text: JSON.stringify(DISCOVER_ITEMS) };
      }
      if (title === "Migrate b.ts") {
        migrateBCalls += 1;
        // Transient failure the first time; succeeds on retry.
        return migrateBCalls === 1
          ? { text: "boom on b.ts", fail: true }
          : { text: "migrated b.ts" };
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
    const { readRunResult } = await import("@/lib/workflow/run-state");
    const {
      isWorkflowRunJobActive,
      retryFailedMapItems,
      startWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");

    const detail = createWorkflowFromScript(SCRIPT);
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
    const firstOutput = readMapOutput(getWorkflowRun(run.id)?.result);
    expect(firstOutput.total).toBe(3);
    expect(firstOutput.items.map((item) => item.index).sort()).toEqual([1, 3]);
    expect(firstOutput.failed.map((item) => item.index)).toEqual([2]);

    const countTitle = (title: string) =>
      calls.filter((call) => (call.title ?? "") === title).length;
    expect(countTitle("Discover")).toBe(1);
    expect(countTitle("Migrate a.ts")).toBe(1);
    expect(countTitle("Migrate b.ts")).toBe(1);
    expect(countTitle("Migrate c.ts")).toBe(1);
    expect(countTitle("Synthesize")).toBe(1);

    await retryFailedMapItems({
      workflowId: detail.workflow.id,
      runId: run.id,
      mapNodeId: "migrated",
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));

    expect(getWorkflowRun(run.id)?.status).toBe("completed");

    // Only the cleared item re-ran; upstream discover and the healthy items did
    // not; the downstream synthesis re-ran on the corrected map output.
    expect(countTitle("Discover")).toBe(1);
    expect(countTitle("Migrate a.ts")).toBe(1);
    expect(countTitle("Migrate b.ts")).toBe(2);
    expect(countTitle("Migrate c.ts")).toBe(1);
    expect(countTitle("Synthesize")).toBe(2);

    const lastSynthesis = [...calls]
      .reverse()
      .find((call) => (call.title ?? "") === "Synthesize");
    expect(lastSynthesis?.prompt).toContain("migrated b.ts");
    expect(lastSynthesis?.prompt).not.toContain("boom on b.ts");
    // The re-run must be a fresh execution, not a crash-recovery attach to the
    // first run's agent session (which would harvest the stale output).
    expect(lastSynthesis?.attachSessionId).toBeUndefined();
    const lastMigrateB = [...calls]
      .reverse()
      .find((call) => (call.title ?? "") === "Migrate b.ts");
    expect(lastMigrateB?.attachSessionId).toBeUndefined();

    // The item moved from failed[] into items[] in the persisted result.
    const finalOutput = readMapOutput(getWorkflowRun(run.id)?.result);
    expect(finalOutput.total).toBe(3);
    expect(finalOutput.failed).toHaveLength(0);
    expect(finalOutput.items.map((item) => item.index).sort()).toEqual([
      1, 2, 3,
    ]);

    // Sanity: the persisted result surface is a well-formed run result.
    const finalResult = readRunResult(getWorkflowRun(run.id)?.result);
    expect(finalResult.nodeStatuses.migrated).toBe("completed");

    // The recovered item's run record must not keep showing its old failure.
    const retriedRecord = Object.values(finalResult.mapItemRuns ?? {}).find(
      (record) => record.index === 2,
    );
    expect(retriedRecord?.status).toBe("completed");
    expect(retriedRecord?.error).toBeUndefined();
  });

  it("rejects retrying a non-terminal run", async () => {
    bootstrapDataDir();
    mockAgentRuntime(() => ({ text: "unused" }));

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { createWorkflowRun } = await import("@/lib/db/workflows/runs");
    const { retryFailedMapItems } = await import("@/lib/workflow/run-jobs");

    const detail = createWorkflowFromScript(SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    // A fresh run defaults to "running" — a non-terminal state.
    const run = createWorkflowRun({
      workflowId: detail.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      request: { inputs: {} },
    });

    await expect(
      retryFailedMapItems({
        workflowId: detail.workflow.id,
        runId: run.id,
        mapNodeId: "migrated",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_MAP_RETRY_INVALID" });
  });

  it("rejects a map node with no failed items", async () => {
    bootstrapDataDir();
    mockAgentRuntime((input) => {
      const title = input.title ?? "";
      if (title === "Discover") {
        return { text: JSON.stringify(DISCOVER_ITEMS) };
      }
      if (title.startsWith("Migrate ")) {
        return { text: `migrated ${title.slice("Migrate ".length)}` };
      }
      return { text: "synthesis" };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const {
      isWorkflowRunJobActive,
      retryFailedMapItems,
      startWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");

    const detail = createWorkflowFromScript(SCRIPT);
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
      retryFailedMapItems({
        workflowId: detail.workflow.id,
        runId: run.id,
        mapNodeId: "migrated",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_MAP_RETRY_INVALID" });
  });

  it("rejects a non-map node id", async () => {
    bootstrapDataDir();
    mockAgentRuntime((input) => {
      const title = input.title ?? "";
      if (title === "Discover") {
        return { text: JSON.stringify(DISCOVER_ITEMS) };
      }
      if (title.startsWith("Migrate ")) {
        return { text: `migrated ${title.slice("Migrate ".length)}` };
      }
      return { text: "synthesis" };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const {
      isWorkflowRunJobActive,
      retryFailedMapItems,
      startWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");

    const detail = createWorkflowFromScript(SCRIPT);
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
      retryFailedMapItems({
        workflowId: detail.workflow.id,
        runId: run.id,
        mapNodeId: "discover",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_MAP_NODE_INVALID" });
  });
});
