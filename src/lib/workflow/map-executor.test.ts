import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput, AgentRuntimeEvent } from "@/lib/agents/types";
import type { WorkflowRunEvent, WorkflowRunRequest } from "./types";

const runAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/runtime", () => ({
  runAgent: runAgentMock,
}));

import { runWorkflow } from "./executor";
import {
  applyWorkflowRunEvent,
  createInitialRunSummary,
  toWorkflowRunResult,
} from "./run-state";
import { stringifyJsonObjectColumn } from "@/lib/db/workflows/json-schemas";

// ---------------------------------------------------------------------------
// Harness (mirrors blueprint-behavior.test.ts idioms)
// ---------------------------------------------------------------------------

async function collectRun(request: WorkflowRunRequest): Promise<WorkflowRunEvent[]> {
  const events: WorkflowRunEvent[] = [];
  for await (const event of runWorkflow(request)) {
    events.push(event);
  }
  return events;
}

/**
 * Routes replies off the RENDERED prompt/title. `fail` short-circuits a child
 * into a failed agent run; otherwise the reply text is streamed.
 */
function mockAgentRuntime(
  reply: (input: AgentRunInput) => { text: string; fail?: boolean },
): AgentRunInput[] {
  const calls: AgentRunInput[] = [];
  runAgentMock.mockImplementation(async function* (
    input: AgentRunInput,
  ): AsyncGenerator<AgentRuntimeEvent> {
    calls.push(input);
    const result = reply(input);
    if (result.fail) {
      yield { type: "error", code: "mock_error", message: result.text };
      return;
    }
    yield { type: "text_delta", text: result.text };
    yield { type: "done", status: "completed", reason: "completed" };
  });
  return calls;
}

const DISCOVER_ITEMS = [
  { file: "a.ts", line: 1 },
  { file: "b.ts", line: 2 },
  { file: "c.ts", line: 3 },
];

const MAP_SCRIPT = `
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
    prompt: "Migrate {{item.file}} at line {{item.line}} as item {{item_index}} full {{item}}",
  }),
})
const synthesis = await agent({
  id: "synthesis",
  label: "Synthesize",
  prompt: "Summarize {{migrated}}",
})
`;

function mapScript(options: {
  maxItems?: number;
  onItemFailure?: "skip" | "fail";
}): string {
  return `
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
  maxItems: ${options.maxItems ?? 5},
  onItemFailure: "${options.onItemFailure ?? "skip"}",
  step: agent({
    id: "migrate_one",
    label: "Migrate {{item.file}}",
    prompt: "Migrate {{item.file}} at line {{item.line}} as item {{item_index}} full {{item}}",
  }),
})
const synthesis = await agent({
  id: "synthesis",
  label: "Synthesize",
  prompt: "Summarize {{migrated}}",
})
`;
}

const TWO_STEP_SCRIPT = `
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
  steps: [
    agent({
      id: "process_one",
      label: "Process {{item.file}}",
      prompt: "Process {{item.file}} at line {{item.line}}",
    }),
    agent({
      id: "verify_one",
      label: "Verify {{item.file}}",
      prompt: "Verify {{process_one}} for {{item.file}} (item {{item_index}})",
    }),
  ],
})
const synthesis = await agent({
  id: "synthesis",
  label: "Synthesize",
  prompt: "Summarize {{migrated}}",
})
`;

const LITERAL_SCRIPT = `
const checks = await map({
  id: "checks",
  label: "Check each env",
  source: [{ env: "dev" }, { env: "staging" }, { env: "prod" }],
  onItemFailure: "skip",
  step: agent({
    id: "check_one",
    label: "Check {{item.env}}",
    prompt: "Check {{item.env}} (item {{item_index}}): {{item}}",
  }),
})
const synthesis = await agent({
  id: "synthesis",
  label: "Synthesize",
  prompt: "Summarize {{checks}}",
})
`;

type MapItemStateEvent = Extract<WorkflowRunEvent, { type: "map_item_state" }>;
type NodeCompletedEvent = Extract<WorkflowRunEvent, { type: "node_completed" }>;

function mapItemStates(
  events: WorkflowRunEvent[],
  executionKey: string,
): MapItemStateEvent[] {
  return events.filter(
    (event): event is MapItemStateEvent =>
      event.type === "map_item_state" &&
      event.mapItem.executionKey === executionKey,
  );
}

function nodeOutput(
  events: WorkflowRunEvent[],
  nodeId: string,
): NodeCompletedEvent["output"] | undefined {
  return events.find(
    (event): event is NodeCompletedEvent =>
      event.type === "node_completed" && event.nodeId === nodeId,
  )?.output;
}

function migrateCalls(calls: AgentRunInput[]): AgentRunInput[] {
  return calls.filter((call) => (call.title ?? "").startsWith("Migrate "));
}

const LAST = <T>(items: T[]): T | undefined => items.at(-1);

// ---------------------------------------------------------------------------

describe("map node runtime", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
  });

  it("processes every item with rendered item refs and a structured output", async () => {
    const calls = mockAgentRuntime((input) => {
      if ((input.title ?? "") === "Discover") {
        return { text: JSON.stringify(DISCOVER_ITEMS) };
      }
      if ((input.title ?? "").startsWith("Migrate ")) {
        return { text: `migrated ${(input.title ?? "").slice("Migrate ".length)}` };
      }
      return { text: "SYNTHESIS" };
    });

    const events = await collectRun({
      script: MAP_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
    });

    // Each item became one child, and the label rendered {{item.file}}.
    const migrations = migrateCalls(calls);
    expect(migrations.map((call) => (call.title ?? "")).sort()).toEqual([
      "Migrate a.ts",
      "Migrate b.ts",
      "Migrate c.ts",
    ]);

    // Item refs rendered into the child prompt: {{item.file}}, {{item.line}},
    // {{item_index}}, and the whole {{item}}.
    const first = migrations.find((call) => (call.title ?? "") === "Migrate a.ts");
    expect(first?.prompt).toContain("Migrate a.ts at line 1 as item 1");
    expect(first?.prompt).toContain('{"file":"a.ts","line":1}');

    // Per-child map_item_state lifecycle mirrors loop_step_state.
    const running = mapItemStates(events, "map:migrated:1:migrate_one").find(
      (event) => event.status === "running",
    );
    expect(running).toEqual(
      expect.objectContaining({
        kind: "agent",
        agent: "mock",
        promptMode: "full",
        label: "Migrate a.ts",
      }),
    );
    expect(
      mapItemStates(events, "map:migrated:1:migrate_one").map(
        (event) => event.status,
      ),
    ).toEqual(["running", "completed"]);

    // Map node output shape: items + failed + total.
    const output = nodeOutput(events, "migrated");
    expect(output).toEqual(
      expect.objectContaining({
        total: 3,
        failed: [],
        items: expect.arrayContaining([
          expect.objectContaining({
            index: 1,
            item: { file: "a.ts", line: 1 },
            status: "completed",
            output: "migrated a.ts",
          }),
        ]),
      }),
    );

    // Synthesis sees the full map record.
    const synthesis = calls.find((call) => (call.title ?? "") === "Synthesize");
    expect(synthesis?.prompt).toContain('"total":3');
    expect(synthesis?.prompt).toContain("migrated a.ts");

    expect(LAST(events)).toEqual(
      expect.objectContaining({ type: "run_completed", status: "completed" }),
    );
  });

  it("skips a failed item, keeps it visible, and still completes", async () => {
    const calls = mockAgentRuntime((input) => {
      if ((input.title ?? "") === "Discover") {
        return { text: JSON.stringify(DISCOVER_ITEMS) };
      }
      if ((input.title ?? "") === "Migrate b.ts") {
        return { text: "boom on b.ts", fail: true };
      }
      if ((input.title ?? "").startsWith("Migrate ")) {
        return { text: `migrated ${(input.title ?? "").slice("Migrate ".length)}` };
      }
      return { text: "SYNTHESIS" };
    });

    const events = await collectRun({
      script: MAP_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
    });

    // The map node completes (skip mode) rather than failing.
    expect(
      events.some(
        (event) => event.type === "node_failed" && event.nodeId === "migrated",
      ),
    ).toBe(false);

    // The failed item is recorded and visible in the output.
    const output = nodeOutput(events, "migrated") as {
      items: Array<{ index: number }>;
      failed: Array<{ index: number; item: unknown; error: string }>;
      total: number;
    };
    expect(output.total).toBe(3);
    expect(output.items).toHaveLength(2);
    expect(output.failed).toEqual([
      expect.objectContaining({
        index: 2,
        item: { file: "b.ts", line: 2 },
        error: expect.stringContaining("boom on b.ts"),
      }),
    ]);

    // The failed child emits a failed map_item_state.
    expect(
      LAST(mapItemStates(events, "map:migrated:2:migrate_one"))?.status,
    ).toBe("failed");

    // The failure is visible in the synthesis prompt.
    const synthesis = calls.find((call) => (call.title ?? "") === "Synthesize");
    expect(synthesis?.prompt).toContain("b.ts");
    expect(synthesis?.prompt).toContain("boom on b.ts");

    expect(LAST(events)).toEqual(
      expect.objectContaining({ type: "run_completed", status: "completed" }),
    );
  });

  it("fails the map node on the first item failure in fail mode", async () => {
    mockAgentRuntime((input) => {
      if ((input.title ?? "") === "Discover") {
        return { text: JSON.stringify(DISCOVER_ITEMS) };
      }
      if ((input.title ?? "") === "Migrate b.ts") {
        return { text: "boom on b.ts", fail: true };
      }
      if ((input.title ?? "").startsWith("Migrate ")) {
        return { text: `migrated ${(input.title ?? "").slice("Migrate ".length)}` };
      }
      return { text: "SYNTHESIS" };
    });

    const events = await collectRun({
      script: mapScript({ onItemFailure: "fail" }),
      agent: "mock",
      cwd: process.cwd(),
    });

    const failure = events.find(
      (event) => event.type === "node_failed" && event.nodeId === "migrated",
    );
    expect(failure).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("item 2 failed"),
      }),
    );
    expect(LAST(events)).toEqual(
      expect.objectContaining({ type: "run_completed", status: "failed" }),
    );
  });

  it("fails the map node when the item count exceeds maxItems", async () => {
    mockAgentRuntime((input) => {
      if ((input.title ?? "") === "Discover") {
        return { text: JSON.stringify(DISCOVER_ITEMS) };
      }
      return { text: "should not run" };
    });

    const events = await collectRun({
      script: mapScript({ maxItems: 2 }),
      agent: "mock",
      cwd: process.cwd(),
    });

    const failure = events.find(
      (event) => event.type === "node_failed" && event.nodeId === "migrated",
    );
    expect(failure).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("exceeding maxItems 2"),
      }),
    );
    // No child ran.
    expect(
      events.some((event) => event.type === "map_item_state"),
    ).toBe(false);
    expect(LAST(events)).toEqual(
      expect.objectContaining({ type: "run_completed", status: "failed" }),
    );
  });

  it("fails the map node when the source is not an array", async () => {
    mockAgentRuntime((input) => {
      if ((input.title ?? "") === "Discover") {
        return { text: JSON.stringify({ not: "an array" }) };
      }
      return { text: "should not run" };
    });

    const events = await collectRun({
      script: MAP_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
    });

    const failure = events.find(
      (event) => event.type === "node_failed" && event.nodeId === "migrated",
    );
    expect(failure).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("must resolve to an array"),
      }),
    );
    expect(LAST(events)).toEqual(
      expect.objectContaining({ type: "run_completed", status: "failed" }),
    );
  });

  it("resumes only unfinished items from a persisted map checkpoint", async () => {
    const checkpoints: Array<{ kind: string; state: unknown }> = [];
    const calls = mockAgentRuntime((input) => {
      if ((input.title ?? "").startsWith("Migrate ")) {
        return { text: `migrated ${(input.title ?? "").slice("Migrate ".length)}` };
      }
      return { text: "SYNTHESIS" };
    });

    const recoveredItems = [
      { file: "a.ts", line: 1 },
      { file: "b.ts", line: 2 },
    ];

    const events = await collectRun({
      script: MAP_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
      recovery: {
        completedNodeIds: ["discover"],
        outputs: { discover: recoveredItems },
        mapStates: {
          migrated: {
            items: recoveredItems,
            completions: [
              { index: 1, status: "completed", output: "migrated a.ts (restored)" },
            ],
          },
        },
      },
      onCheckpoint: (checkpoint) => {
        checkpoints.push({ kind: checkpoint.kind, state: checkpoint.state });
      },
    });

    // Discover was not re-run and only the unfinished item (b.ts) executed.
    expect(calls.some((call) => (call.title ?? "") === "Discover")).toBe(false);
    const migrations = migrateCalls(calls);
    expect(migrations.map((call) => (call.title ?? ""))).toEqual(["Migrate b.ts"]);

    // The finished item is restored into the run log.
    const restored = mapItemStates(events, "map:migrated:1:migrate_one");
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(
      expect.objectContaining({ status: "completed", restored: true }),
    );

    // Map checkpoints are emitted with the map recovery shape.
    const mapCheckpoints = checkpoints.filter((entry) => entry.kind === "map");
    expect(mapCheckpoints.length).toBeGreaterThan(0);
    expect(LAST(mapCheckpoints)?.state).toEqual(
      expect.objectContaining({
        items: recoveredItems,
        completions: expect.arrayContaining([
          expect.objectContaining({ index: 2, status: "completed" }),
        ]),
      }),
    );

    // Final output merges the restored and freshly-run items.
    const output = nodeOutput(events, "migrated") as {
      items: Array<{ index: number; output: string }>;
      total: number;
    };
    expect(output.total).toBe(2);
    expect(output.items).toHaveLength(2);
    expect(
      output.items.find((entry) => entry.index === 1)?.output,
    ).toBe("migrated a.ts (restored)");

    expect(LAST(events)).toEqual(
      expect.objectContaining({ type: "run_completed", status: "completed" }),
    );
  });

  it("produces a run result that survives the result_json persistence guard", async () => {
    // Regression: map children emit session_ref events attributed to the map
    // node; combined with the map's object output this used to leave an
    // explicit-undefined lastText in nodeSessions, which the strict JSON
    // guard rejected — completed runs then never persisted and stayed
    // "running" in the UI.
    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      const isDiscover = (input.title ?? "") === "Discover";
      if (!isDiscover) {
        yield {
          type: "session_ref",
          session: {
            agentSessionId: "child-session",
            agent: input.agent,
            status: "running",
          },
        };
      }
      yield {
        type: "text_delta",
        text: isDiscover ? JSON.stringify(DISCOVER_ITEMS.slice(0, 2)) : "done",
      };
      yield { type: "done", status: "completed", reason: "completed" };
    });

    let summary: ReturnType<typeof createInitialRunSummary> | undefined;
    for await (const event of runWorkflow({ script: MAP_SCRIPT, agent: "mock" })) {
      if (event.type === "run_started") {
        summary = createInitialRunSummary(event.parsed);
      } else if (summary) {
        summary = applyWorkflowRunEvent(summary, event);
      }
    }

    expect(summary?.status).toBe("completed");
    expect(() =>
      stringifyJsonObjectColumn(toWorkflowRunResult(summary!), {
        table: "workflow_runs",
        column: "result_json",
        id: "run-regression",
      }),
    ).not.toThrow();
  });

  it("runs a per-item pipeline where step 2 sees step 1's output and item refs", async () => {
    const calls = mockAgentRuntime((input) => {
      if ((input.title ?? "") === "Discover") {
        return { text: JSON.stringify(DISCOVER_ITEMS) };
      }
      if ((input.title ?? "").startsWith("Process ")) {
        return { text: `processed ${(input.title ?? "").slice("Process ".length)}` };
      }
      if ((input.title ?? "").startsWith("Verify ")) {
        return { text: `verified ${(input.title ?? "").slice("Verify ".length)}` };
      }
      return { text: "SYNTHESIS" };
    });

    const events = await collectRun({
      script: TWO_STEP_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
    });

    // Step 2's prompt carries step 1's output plus the item refs for item 1.
    const verifyA = calls.find((call) => (call.title ?? "") === "Verify a.ts");
    expect(verifyA?.prompt).toContain("Verify processed a.ts for a.ts (item 1)");

    // Both steps ran for item 1 in order, each an individually visible execution.
    expect(
      mapItemStates(events, "map:migrated:1:process_one").map((event) => event.status),
    ).toEqual(["running", "completed"]);
    expect(
      mapItemStates(events, "map:migrated:1:verify_one").map((event) => event.status),
    ).toEqual(["running", "completed"]);

    // The LAST step's output shapes items[].
    const output = nodeOutput(events, "migrated") as {
      items: Array<{ index: number; output: string }>;
      failed: unknown[];
      total: number;
    };
    expect(output.total).toBe(3);
    expect(output.failed).toEqual([]);
    expect(output.items.find((entry) => entry.index === 1)?.output).toBe(
      "verified a.ts",
    );
  });

  it("has no cross-item barrier: a failing step 1 on one item still completes the others", async () => {
    const calls = mockAgentRuntime((input) => {
      if ((input.title ?? "") === "Discover") {
        return { text: JSON.stringify(DISCOVER_ITEMS) };
      }
      if ((input.title ?? "") === "Process b.ts") {
        return { text: "boom on b.ts", fail: true };
      }
      if ((input.title ?? "").startsWith("Process ")) {
        return { text: `processed ${(input.title ?? "").slice("Process ".length)}` };
      }
      if ((input.title ?? "").startsWith("Verify ")) {
        return { text: `verified ${(input.title ?? "").slice("Verify ".length)}` };
      }
      return { text: "SYNTHESIS" };
    });

    const events = await collectRun({
      script: TWO_STEP_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
    });

    // Interleaving-insensitive invariant: items a and c complete BOTH steps even
    // though item b's first step failed.
    for (const index of [1, 3]) {
      expect(
        LAST(mapItemStates(events, `map:migrated:${index}:process_one`))?.status,
      ).toBe("completed");
      expect(
        LAST(mapItemStates(events, `map:migrated:${index}:verify_one`))?.status,
      ).toBe("completed");
    }

    // Item b failed at step 1 and its step 2 was skipped (never ran).
    expect(
      LAST(mapItemStates(events, "map:migrated:2:process_one"))?.status,
    ).toBe("failed");
    expect(mapItemStates(events, "map:migrated:2:verify_one")).toHaveLength(0);
    expect(calls.some((call) => (call.title ?? "") === "Verify b.ts")).toBe(false);

    // The failed item attributes the failing step id in failed[].
    const output = nodeOutput(events, "migrated") as {
      items: Array<{ index: number }>;
      failed: Array<{ index: number; step?: string; error: string }>;
      total: number;
    };
    expect(output.total).toBe(3);
    expect(output.items).toHaveLength(2);
    expect(output.failed).toEqual([
      expect.objectContaining({
        index: 2,
        step: "process_one",
        error: expect.stringContaining("boom on b.ts"),
      }),
    ]);

    expect(LAST(events)).toEqual(
      expect.objectContaining({ type: "run_completed", status: "completed" }),
    );
  });

  it("runs a static inline list source without a discover node and resumes it", async () => {
    // Fresh run: no discover agent, the literal items become children directly.
    const firstCheckpoints: Array<{ kind: string; state: unknown }> = [];
    const firstCalls = mockAgentRuntime((input) => {
      if ((input.title ?? "").startsWith("Check ")) {
        return { text: `checked ${(input.title ?? "").slice("Check ".length)}` };
      }
      return { text: "SYNTHESIS" };
    });

    const firstEvents = await collectRun({
      script: LITERAL_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
      onCheckpoint: (checkpoint) => {
        firstCheckpoints.push({ kind: checkpoint.kind, state: checkpoint.state });
      },
    });

    expect(firstCalls.some((call) => (call.title ?? "") === "Discover")).toBe(false);
    const checkTitles = firstCalls
      .filter((call) => (call.title ?? "").startsWith("Check "))
      .map((call) => call.title ?? "")
      .sort();
    expect(checkTitles).toEqual(["Check dev", "Check prod", "Check staging"]);

    // The literal items are checkpointed exactly like a resolved source.
    const literalCheckpoint = firstCheckpoints.find((entry) => entry.kind === "map");
    expect((literalCheckpoint?.state as { items: unknown[] }).items).toEqual([
      { env: "dev" },
      { env: "staging" },
      { env: "prod" },
    ]);

    const firstOutput = nodeOutput(firstEvents, "checks") as { total: number };
    expect(firstOutput.total).toBe(3);
    expect(LAST(firstEvents)).toEqual(
      expect.objectContaining({ type: "run_completed", status: "completed" }),
    );

    // Resume: with one item already completed, only the unfinished items run.
    const resumeCalls = mockAgentRuntime((input) => {
      if ((input.title ?? "").startsWith("Check ")) {
        return { text: `checked ${(input.title ?? "").slice("Check ".length)}` };
      }
      return { text: "SYNTHESIS" };
    });

    const resumeItems = [{ env: "dev" }, { env: "staging" }, { env: "prod" }];
    const resumeEvents = await collectRun({
      script: LITERAL_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
      recovery: {
        mapStates: {
          checks: {
            items: resumeItems,
            completions: [
              { index: 1, status: "completed", output: "checked dev (restored)" },
            ],
          },
        },
      },
    });

    const resumedTitles = resumeCalls
      .filter((call) => (call.title ?? "").startsWith("Check "))
      .map((call) => call.title ?? "")
      .sort();
    expect(resumedTitles).toEqual(["Check prod", "Check staging"]);

    const resumeOutput = nodeOutput(resumeEvents, "checks") as {
      items: Array<{ index: number; output: string }>;
      total: number;
    };
    expect(resumeOutput.total).toBe(3);
    expect(resumeOutput.items.find((entry) => entry.index === 1)?.output).toBe(
      "checked dev (restored)",
    );
    expect(LAST(resumeEvents)).toEqual(
      expect.objectContaining({ type: "run_completed", status: "completed" }),
    );
  });
});
