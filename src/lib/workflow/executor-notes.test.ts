import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput } from "@/lib/agents/types";
import {
  installMockAgentRuntime,
  type MockAgentReply,
} from "@/lib/workflow/test-support/mock-agent-runtime";
import type {
  WorkflowRunEvent,
  WorkflowRunNote,
  WorkflowRunRequest,
} from "./types";

const runAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/runtime", () => ({
  runAgent: runAgentMock,
}));

import { runWorkflow } from "./executor";

const OPERATOR_LABEL = "Operator note (injected):";

function mockAgentRuntime(
  reply: (input: AgentRunInput) => MockAgentReply,
): AgentRunInput[] {
  return installMockAgentRuntime(runAgentMock, reply, { sessionRef: "always" });
}

async function collectRun(
  request: WorkflowRunRequest,
): Promise<WorkflowRunEvent[]> {
  const events: WorkflowRunEvent[] = [];
  for await (const event of runWorkflow(request)) {
    events.push(event);
  }
  return events;
}

function note(input: {
  id: string;
  message: string;
  nodeId?: string;
}): WorkflowRunNote {
  return {
    id: input.id,
    runId: "run",
    message: input.message,
    target: "next-step",
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

/**
 * In-memory stand-in for the DB-backed consume: claims pending notes matching
 * the execution's top-level node (or unscoped), first consumer wins, in arrival
 * order — mirroring consumeMatchingRunNotes so the executor wiring is exercised
 * without a database. The DB atomicity itself is covered in run-notes.test.ts.
 */
function makeNoteConsumer(notes: WorkflowRunNote[]) {
  const pending = [...notes];
  const calls: Array<{ nodeId: string; executionKey: string }> = [];
  const onConsumeNotes: WorkflowRunRequest["onConsumeNotes"] = ({
    nodeId,
    executionKey,
  }) => {
    calls.push({ nodeId, executionKey });
    const claimed: WorkflowRunNote[] = [];
    for (let index = 0; index < pending.length; ) {
      const candidate = pending[index];
      if (!candidate.nodeId || candidate.nodeId === nodeId) {
        pending.splice(index, 1);
        claimed.push({
          ...candidate,
          status: "consumed",
          consumedExecutionKey: executionKey,
        });
      } else {
        index += 1;
      }
    }
    return claimed;
  };
  return { onConsumeNotes, calls };
}

const TWO_NODE_SCRIPT = `
const first = await agent({ id: "first", prompt: "Do the first thing" })
const second = await agent({ id: "second", prompt: "Then do {{first}}" })
`;

describe("operator note injection", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
  });

  it("injects a pending next-step note into the next node's prompt and persisted input", async () => {
    const calls = mockAgentRuntime((input) => ({ text: `ran ${input.title}` }));
    const consumer = makeNoteConsumer([
      note({ id: "n1", message: "Prioritize the failing test" }),
    ]);

    const events = await collectRun({
      runId: "run",
      script: TWO_NODE_SCRIPT,
      cwd: process.cwd(),
      onConsumeNotes: consumer.onConsumeNotes,
    });

    // The FIRST agent execution to reach the consume point claims the note.
    const firstCall = calls.find((call) => call.prompt.startsWith("Do the first"));
    const secondCall = calls.find((call) => call.prompt.startsWith("Then do"));
    expect(firstCall?.prompt).toContain(`${OPERATOR_LABEL}\nPrioritize the failing test`);
    // Once consumed, it is NOT delivered again to the next node.
    expect(secondCall?.prompt).not.toContain(OPERATOR_LABEL);

    // The injected block flows into the persisted rendered prompt (node input).
    const firstStarted = events.find(
      (event) => event.type === "node_started" && event.nodeId === "first",
    );
    expect(firstStarted).toBeDefined();
    expect(
      firstStarted && "input" in firstStarted ? firstStarted.input : "",
    ).toContain(`${OPERATOR_LABEL}\nPrioritize the failing test`);

    // A run_note provenance event records the consumption with the exec key.
    const noteEvents = events.filter((event) => event.type === "run_note");
    expect(noteEvents).toHaveLength(1);
    const recorded = noteEvents[0];
    if (recorded.type !== "run_note") {
      throw new Error("expected run_note");
    }
    expect(recorded.note.id).toBe("n1");
    expect(recorded.note.status).toBe("consumed");
    expect(recorded.note.consumedExecutionKey).toBe("first");
  });

  it("skips nodes other than the note's scoped node", async () => {
    const calls = mockAgentRuntime((input) => ({ text: `ran ${input.title}` }));
    const consumer = makeNoteConsumer([
      note({ id: "n1", message: "Only for second", nodeId: "second" }),
    ]);

    await collectRun({
      runId: "run",
      script: TWO_NODE_SCRIPT,
      cwd: process.cwd(),
      onConsumeNotes: consumer.onConsumeNotes,
    });

    const firstCall = calls.find((call) => call.prompt.startsWith("Do the first"));
    const secondCall = calls.find((call) => call.prompt.startsWith("Then do"));
    expect(firstCall?.prompt).not.toContain(OPERATOR_LABEL);
    expect(secondCall?.prompt).toContain(`${OPERATOR_LABEL}\nOnly for second`);
  });

  it("delivers multiple pending notes together in arrival order", async () => {
    const calls = mockAgentRuntime((input) => ({ text: `ran ${input.title}` }));
    const consumer = makeNoteConsumer([
      note({ id: "n1", message: "First guidance" }),
      note({ id: "n2", message: "Second guidance" }),
    ]);

    await collectRun({
      runId: "run",
      script: TWO_NODE_SCRIPT,
      cwd: process.cwd(),
      onConsumeNotes: consumer.onConsumeNotes,
    });

    const firstCall = calls.find((call) => call.prompt.startsWith("Do the first"));
    const prompt = firstCall?.prompt ?? "";
    expect(prompt).toContain("First guidance");
    expect(prompt).toContain("Second guidance");
    expect(prompt.indexOf("First guidance")).toBeLessThan(
      prompt.indexOf("Second guidance"),
    );
  });

  it("delivers a map-scoped note to exactly one item", async () => {
    const items = [
      { file: "a.ts" },
      { file: "b.ts" },
      { file: "c.ts" },
    ];
    mockAgentRuntime((input) =>
      input.title === "Discover"
        ? { text: JSON.stringify(items) }
        : { text: `ran ${input.title}` },
    );
    const consumer = makeNoteConsumer([
      note({ id: "n1", message: "Extra care on this item", nodeId: "migrated" }),
    ]);

    const script = `
const discover = await agent({
  id: "discover",
  label: "Discover",
  output: "json",
  prompt: "List items as a JSON array.",
})
const migrated = await map({
  id: "migrated",
  label: "Migrate",
  source: discover,
  maxItems: 5,
  onItemFailure: "skip",
  step: agent({ id: "migrate_one", label: "Migrate {{item.file}}", prompt: "Migrate {{item.file}}" }),
})
`;

    const events = await collectRun({
      runId: "run",
      script,
      cwd: process.cwd(),
      onConsumeNotes: consumer.onConsumeNotes,
    });

    const itemInputsWithNote = events.filter(
      (event) =>
        event.type === "map_item_state" &&
        typeof event.input === "string" &&
        event.input.includes(OPERATOR_LABEL),
    );
    expect(itemInputsWithNote).toHaveLength(1);

    // Provenance: exactly one consumption event, keyed to a map item execution.
    const noteEvents = events.filter((event) => event.type === "run_note");
    expect(noteEvents).toHaveLength(1);
    const recorded = noteEvents[0];
    if (recorded.type !== "run_note") {
      throw new Error("expected run_note");
    }
    expect(recorded.note.consumedExecutionKey).toMatch(/^map:migrated:\d+:migrate_one$/);
  });
});
