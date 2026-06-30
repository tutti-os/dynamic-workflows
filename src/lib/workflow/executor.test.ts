import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput, AgentRuntimeEvent } from "@/lib/agents/types";

const runAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/runtime", () => ({
  runAgent: runAgentMock,
}));

import { runWorkflow } from "./executor";

describe("runWorkflow", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
  });

  it("serializes nodes that share an agent session and resumes the session", async () => {
    const calls: AgentRunInput[] = [];
    let activeRuns = 0;
    let maxActiveRuns = 0;

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      yield {
        type: "session_ref",
        session: {
          agentSessionId: input.resumeSessionId ?? "session-1",
          provider: input.provider,
          model: input.model,
          status: "running",
        },
      };
      await delay(5);
      yield {
        type: "text_delta",
        text: `${input.prompt} done`,
      };
      activeRuns -= 1;
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const first = await agent({ id: "first", session: "writer", prompt: "one" })
const second = await agent({ id: "second", session: "writer", prompt: "two" })
`,
      provider: "codex",
      model: "gpt-5",
      cwd: process.cwd(),
    })) {
      events.push(event);
    }

    expect(maxActiveRuns).toBe(1);
    expect(calls.map((call) => call.prompt)).toEqual(["one", "two"]);
    expect(calls[0].resumeSessionId).toBeUndefined();
    expect(calls[1].resumeSessionId).toBe("session-1");
    expect(readStatusMessages(events)).toEqual([
      'Workflow session "writer" is starting a new agent session.',
      'Workflow session "writer" captured agent session session-1.',
      'Workflow session "writer" is reusing agent session session-1.',
      'Workflow session "writer" confirmed agent session session-1.',
    ]);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "completed",
        outputs: {
          first: "one done",
          second: "two done",
        },
      }),
    );
  });

  it("runs a bounded loop until the acceptance step passes", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      const isRd = input.prompt.startsWith("task:");
      const agentSessionId =
        input.resumeSessionId ?? (isRd ? "rd-session" : "acceptance-session");
      yield {
        type: "session_ref",
        session: {
          agentSessionId,
          provider: input.provider,
          status: "running",
        },
      };
      yield {
        type: "text_delta",
        text: loopMockText(input.prompt),
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const delivery = await loop({
  id: "delivery",
  maxIterations: 3,
  steps: [
    agent({
      id: "rd",
      session: "rd_room",
      prompt: \`task: {{task}}
feedback: {{acceptance}}\`,
    }),
    agent({
      id: "acceptance",
      session: "acceptance_room",
      prompt: \`review: {{rd}}\`,
    }),
  ],
  until: { source: "acceptance", includes: "PASS:" },
})
`,
      provider: "codex",
      cwd: process.cwd(),
      inputs: { task: "ship loop" },
    })) {
      events.push(event);
    }

    expect(calls.map((call) => call.prompt)).toEqual([
      "task: ship loop\nfeedback: ",
      "review: first delivery",
      "task: ship loop\nfeedback: FAIL: missing tests",
      "review: revised delivery",
    ]);
    expect(calls.map((call) => call.resumeSessionId)).toEqual([
      undefined,
      undefined,
      "rd-session",
      "acceptance-session",
    ]);
    expect(readStatusMessages(events)).toEqual(
      expect.arrayContaining([
        'Loop "delivery" iteration 1 until check: not matched (acceptance includes "PASS:").',
        'Loop "delivery" iteration 2 until check: matched (acceptance includes "PASS:").',
      ]),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "completed",
        outputs: {
          delivery: expect.stringContaining("Stop reason: until_matched"),
        },
      }),
    );
    const finalEvent = [...events]
      .reverse()
      .find(
        (event) => event.type === "node_completed" && event.nodeId === "delivery",
      );
    expect(finalEvent).toEqual(
      expect.objectContaining({
        output: expect.stringContaining("[acceptance]\nPASS: accepted"),
      }),
    );
  });

  it("completes with max_iterations_reached when until never matches", async () => {
    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      yield {
        type: "text_delta",
        text: `NO: ${input.prompt}`,
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const debate = await loop({
  id: "debate",
  maxIterations: 2,
  steps: [
    agent({ id: "agent_a", prompt: "A sees {{agent_b}}" }),
    agent({ id: "agent_b", prompt: "B sees {{agent_a}}" }),
    agent({ id: "moderator", prompt: "Judge {{agent_a}} {{agent_b}}" }),
  ],
  until: { source: "moderator", includes: "RESOLVED:" },
})
`,
      provider: "mock",
      cwd: process.cwd(),
    })) {
      events.push(event);
    }

    expect(runAgentMock).toHaveBeenCalledTimes(6);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "completed",
        outputs: {
          debate: expect.stringContaining("Stop reason: max_iterations_reached"),
        },
      }),
    );
  });
});

function loopMockText(prompt: string): string {
  if (prompt.startsWith("task:") && prompt.includes("FAIL:")) {
    return "revised delivery";
  }
  if (prompt.startsWith("task:")) {
    return "first delivery";
  }
  if (prompt.includes("revised delivery")) {
    return "PASS: accepted";
  }
  return "FAIL: missing tests";
}

function readStatusMessages(events: unknown[]): string[] {
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") {
      return [];
    }
    const raw = event as {
      type?: unknown;
      event?: {
        type?: unknown;
        message?: unknown;
      };
    };
    if (raw.type !== "node_event" || raw.event?.type !== "status") {
      return [];
    }
    return typeof raw.event.message === "string" ? [raw.event.message] : [];
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
