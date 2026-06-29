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
});

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
