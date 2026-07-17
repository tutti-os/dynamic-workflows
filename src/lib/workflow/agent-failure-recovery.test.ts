import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput, AgentRuntimeEvent } from "@/lib/agents/types";
import {
  installMockAgentRuntime,
  type MockAgentReply,
} from "./test-support/mock-agent-runtime";
import type { WorkflowRunEvent, WorkflowRunRequest } from "./types";

const runAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/runtime", () => ({
  runAgent: runAgentMock,
}));

import {
  JSON_CONTRACT_REPAIR_PROMPT,
  TRANSIENT_CONTINUATION_PROMPT,
  runWorkflow,
} from "./executor";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function collectRun(
  request: WorkflowRunRequest,
): Promise<WorkflowRunEvent[]> {
  const events: WorkflowRunEvent[] = [];
  for await (const event of runWorkflow(request)) {
    events.push(event);
  }
  return events;
}

function mockAgentRuntime(
  reply: (input: AgentRunInput) => MockAgentReply,
): AgentRunInput[] {
  return installMockAgentRuntime(runAgentMock, reply, { sessionRef: "always" });
}

/** All node_event status messages (where the executor logs extra attempts). */
function statusMessages(events: WorkflowRunEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== "node_event") {
      return [];
    }
    const inner = event.event as AgentRuntimeEvent;
    return inner.type === "status" && inner.message ? [inner.message] : [];
  });
}

function firstCapturedSessionId(events: WorkflowRunEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "node_event") {
      continue;
    }
    const inner = event.event as AgentRuntimeEvent;
    if (inner.type === "session_ref") {
      return inner.session.agentSessionId;
    }
  }
  return undefined;
}

function nodeFailedError(
  events: WorkflowRunEvent[],
  nodeId: string,
): string | undefined {
  const failed = events.find(
    (event) => event.type === "node_failed" && event.nodeId === nodeId,
  );
  return failed && failed.type === "node_failed" ? failed.error : undefined;
}

function runStatus(events: WorkflowRunEvent[]): string | undefined {
  const done = events.find((event) => event.type === "run_completed");
  return done && done.type === "run_completed" ? done.status : undefined;
}

// A tiny backoff so the in-session continuation never waits on the wall clock.
const FAST_BACKOFF = { transientRetryBackoffMs: 5 } as const;

const SOLO_SCRIPT = `
const solo = await agent({ id: "solo", label: "Solo", prompt: "do the work" })
`;

const JSON_SCRIPT = `
const shaped = await agent({ id: "shaped", label: "Shaped", output: "json", prompt: "return json" })
`;

const LOOP_SCRIPT = `
const delivery = await loop({
  id: "delivery",
  maxIterations: 1,
  steps: [agent({ id: "acceptance", label: "Acceptance", prompt: "Review" })],
  until: { source: "acceptance", finalStatus: "PASS" },
})
`;

const MAP_SCRIPT = `
const checks = await map({
  id: "checks",
  label: "Check each env",
  source: [{ env: "dev" }],
  onItemFailure: "skip",
  step: agent({
    id: "check_one",
    label: "Check {{item.env}}",
    prompt: "Check {{item.env}}",
  }),
})
`;

describe("agent-execution failure-handling matrix", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
  });

  it("continues one turn in-session after a transient error and completes the node", async () => {
    let call = 0;
    const inputs = mockAgentRuntime(() => {
      call += 1;
      // First turn dies mid-work (error event); the in-session continuation
      // then finishes it.
      return call === 1
        ? { text: "transient boom", fail: true }
        : { text: "final answer" };
    });

    const events = await collectRun({
      script: SOLO_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
      ...FAST_BACKOFF,
    });

    const completed = events.find(
      (event) => event.type === "node_completed" && event.nodeId === "solo",
    );
    expect(completed && completed.type === "node_completed" && completed.output).toBe(
      "final answer",
    );
    expect(runStatus(events)).toBe("completed");

    // Exactly two runAgent calls: the failed turn plus one continuation.
    expect(inputs).toHaveLength(2);
    const capturedSession = firstCapturedSessionId(events);
    expect(capturedSession).toBeTruthy();
    // The continuation resumes the SAME session and carries the continuation
    // prompt (not a rerun of the original prompt).
    expect(inputs[1].resumeSessionId).toBe(capturedSession);
    expect(inputs[1].prompt).toBe(TRANSIENT_CONTINUATION_PROMPT);

    // The extra attempt is visible in the run log.
    expect(statusMessages(events)).toContain(
      "attempt 2: in-session continuation after transient failure",
    );
  });

  it("fails the node with both messages when the continuation also fails", async () => {
    let call = 0;
    const inputs = mockAgentRuntime(() => {
      call += 1;
      return call === 1
        ? { text: "boom one", fail: true }
        : { text: "boom two", fail: true };
    });

    const events = await collectRun({
      script: SOLO_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
      ...FAST_BACKOFF,
    });

    expect(inputs).toHaveLength(2);
    const error = nodeFailedError(events, "solo");
    expect(error).toContain("boom one");
    expect(error).toContain("boom two");
    expect(error).toContain("in-session continuation");
    expect(runStatus(events)).toBe("failed");
  });

  it("never retries a deterministic AGENT_WAITING_FOR_USER_INPUT block", async () => {
    const inputs = mockAgentRuntime(() => ({
      fail: true,
      error: {
        code: "AGENT_WAITING_FOR_USER_INPUT",
        message:
          "Agent session is waiting for user input and cannot finish inside a workflow.",
      },
    }));

    const events = await collectRun({
      script: SOLO_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
      ...FAST_BACKOFF,
    });

    // Deterministic block -> fail fast, exactly one runAgent call, no retry.
    expect(inputs).toHaveLength(1);
    const error = nodeFailedError(events, "solo");
    expect(error).toContain("waiting for user input");
    expect(error).not.toContain("in-session continuation");
    expect(statusMessages(events)).not.toContain(
      "attempt 2: in-session continuation after transient failure",
    );
    expect(runStatus(events)).toBe("failed");
  });

  it("repairs a JSON contract violation with one in-session probe", async () => {
    let call = 0;
    const inputs = mockAgentRuntime(() => {
      call += 1;
      // The turn succeeds but returns prose; the repair probe returns valid JSON.
      return call === 1
        ? { text: "here is your answer, no json at all" }
        : { text: '{"status":"ok","count":2}' };
    });

    const events = await collectRun({
      script: JSON_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
      ...FAST_BACKOFF,
    });

    const completed = events.find(
      (event) => event.type === "node_completed" && event.nodeId === "shaped",
    );
    expect(completed && completed.type === "node_completed" && completed.output).toEqual({
      status: "ok",
      count: 2,
    });
    expect(runStatus(events)).toBe("completed");

    expect(inputs).toHaveLength(2);
    const capturedSession = firstCapturedSessionId(events);
    expect(inputs[1].resumeSessionId).toBe(capturedSession);
    expect(inputs[1].prompt).toBe(JSON_CONTRACT_REPAIR_PROMPT);
    expect(statusMessages(events)).toContain("attempt 2: format repair probe");
  });

  it("fails and notes the fingerprint when the repair returns an identical canned response", async () => {
    const canned = "sorry, I cannot produce that";
    const inputs = mockAgentRuntime(() => ({ text: canned }));

    const events = await collectRun({
      script: JSON_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
      ...FAST_BACKOFF,
    });

    expect(inputs).toHaveLength(2);
    const error = nodeFailedError(events, "shaped");
    expect(error).toContain("did not fix it");
    expect(error).toContain("byte-identical canned response");
    expect(runStatus(events)).toBe("failed");
  });

  it("continues a loop step in-session after a transient error", async () => {
    let call = 0;
    const inputs = mockAgentRuntime((input) => {
      if ((input.title ?? "") !== "Acceptance") {
        return { text: "PASS" };
      }
      call += 1;
      // The step's turn fails once, then the continuation returns the terminal
      // status that satisfies the loop's until.
      return call === 1 ? { text: "loop boom", fail: true } : { text: "PASS" };
    });

    const events = await collectRun({
      script: LOOP_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
      ...FAST_BACKOFF,
    });

    expect(runStatus(events)).toBe("completed");
    expect(inputs).toHaveLength(2);
    expect(inputs[1].resumeSessionId).toBe(firstCapturedSessionId(events));
    expect(inputs[1].prompt).toBe(TRANSIENT_CONTINUATION_PROMPT);
    expect(statusMessages(events)).toContain(
      "attempt 2: in-session continuation after transient failure",
    );
  });

  it("continues a map item in-session after a transient error", async () => {
    let call = 0;
    const inputs = mockAgentRuntime(() => {
      call += 1;
      return call === 1
        ? { text: "map boom", fail: true }
        : { text: "checked dev" };
    });

    const events = await collectRun({
      script: MAP_SCRIPT,
      agent: "mock",
      cwd: process.cwd(),
      ...FAST_BACKOFF,
    });

    expect(runStatus(events)).toBe("completed");
    expect(inputs).toHaveLength(2);
    expect(inputs[1].resumeSessionId).toBe(firstCapturedSessionId(events));
    expect(inputs[1].prompt).toBe(TRANSIENT_CONTINUATION_PROMPT);
    expect(statusMessages(events)).toContain(
      "attempt 2: in-session continuation after transient failure",
    );
    // The map item ends completed, not failed, after the continuation.
    const completed = events.find(
      (event) => event.type === "node_completed" && event.nodeId === "checks",
    );
    expect(completed).toBeTruthy();
  });
});
