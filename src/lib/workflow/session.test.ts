import { describe, expect, it } from "vitest";
import {
  createLoopStepSessionNodeId,
  resolveLoopStepSessionSpec,
  resolveSessionKey,
} from "./session";

describe("workflow session helpers", () => {
  it("resolves inherited session keys", () => {
    expect(resolveSessionKey({ mode: "inherit", key: "room" })).toBe("room");
    expect(resolveSessionKey({ mode: "independent" })).toBeUndefined();
    expect(resolveSessionKey(undefined)).toBeUndefined();
  });

  it("lets step sessions override loop defaults", () => {
    expect(
      resolveLoopStepSessionSpec({
        loopSession: { mode: "inherit", key: "loop", scope: "step" },
        stepSession: { mode: "inherit", key: "rd_room" },
        stepId: "rd",
      }),
    ).toEqual({ mode: "inherit", key: "rd_room" });
  });

  it("derives per-step keys from loop scope step", () => {
    expect(
      resolveLoopStepSessionSpec({
        loopSession: { mode: "inherit", key: "delivery", scope: "step" },
        stepId: "acceptance",
      }),
    ).toEqual({ mode: "inherit", key: "delivery.acceptance" });
  });

  it("shares loop-level inherited sessions by default", () => {
    expect(
      resolveLoopStepSessionSpec({
        loopSession: { mode: "inherit", key: "debate" },
        stepId: "agent_a",
      }),
    ).toEqual({ mode: "inherit", key: "debate" });
    expect(
      resolveLoopStepSessionSpec({
        loopSession: { mode: "inherit", key: "debate", scope: "loop" },
        stepId: "agent_b",
      }),
    ).toEqual({ mode: "inherit", key: "debate" });
  });

  it("preserves independent loop defaults", () => {
    expect(
      resolveLoopStepSessionSpec({
        loopSession: { mode: "independent" },
        stepId: "rd",
      }),
    ).toEqual({ mode: "independent" });
  });

  it("creates stable synthetic loop step session node ids", () => {
    expect(createLoopStepSessionNodeId("delivery_loop", "rd")).toBe(
      "delivery_loop.rd",
    );
  });
});
