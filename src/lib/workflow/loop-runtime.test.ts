import { describe, expect, it } from "vitest";
import { resolveLoopStepRunContext } from "./loop-runtime";

describe("resolveLoopStepRunContext", () => {
  it("uses the full prompt before a session exists", () => {
    expect(
      resolveLoopStepRunContext({
        stepId: "rd",
        stepSession: { mode: "inherit", key: "rd_room" },
        prompt: "full prompt",
        appendPrompt: "append prompt",
        sessionIdsByKey: {},
      }),
    ).toEqual({
      prompt: "full prompt",
      promptMode: "full",
      sessionKey: "rd_room",
    });
  });

  it("uses appendPrompt when resuming an inherited session", () => {
    expect(
      resolveLoopStepRunContext({
        stepId: "rd",
        stepSession: { mode: "inherit", key: "rd_room" },
        prompt: "full prompt",
        appendPrompt: "append prompt",
        sessionIdsByKey: { rd_room: "agent-session-1" },
      }),
    ).toEqual({
      prompt: "append prompt",
      promptMode: "append",
      sessionKey: "rd_room",
      resumeSessionId: "agent-session-1",
    });
  });

  it("falls back to full prompt when no appendPrompt is configured", () => {
    expect(
      resolveLoopStepRunContext({
        stepId: "acceptance",
        stepSession: { mode: "inherit", key: "acceptance_room" },
        prompt: "review full prompt",
        sessionIdsByKey: { acceptance_room: "agent-session-2" },
      }),
    ).toEqual({
      prompt: "review full prompt",
      promptMode: "full",
      sessionKey: "acceptance_room",
      resumeSessionId: "agent-session-2",
    });
  });

  it("does not resume or append for independent sessions", () => {
    expect(
      resolveLoopStepRunContext({
        stepId: "rd",
        stepSession: { mode: "independent" },
        prompt: "full prompt",
        appendPrompt: "append prompt",
        sessionIdsByKey: { rd_room: "agent-session-1" },
      }),
    ).toEqual({
      prompt: "full prompt",
      promptMode: "full",
    });
  });

  it("derives loop-scoped step session keys before resolving prompts", () => {
    expect(
      resolveLoopStepRunContext({
        stepId: "acceptance",
        loopSession: { mode: "inherit", key: "delivery", scope: "step" },
        prompt: "review full prompt",
        appendPrompt: "review append prompt",
        sessionIdsByKey: { "delivery.acceptance": "agent-session-3" },
      }),
    ).toEqual({
      prompt: "review append prompt",
      promptMode: "append",
      sessionKey: "delivery.acceptance",
      resumeSessionId: "agent-session-3",
    });
  });
});
