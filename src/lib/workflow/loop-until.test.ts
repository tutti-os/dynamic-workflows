import { describe, expect, it } from "vitest";
import { matchesLoopUntil } from "./loop-until";

describe("matchesLoopUntil", () => {
  it("matches a scalar resolved from a dotted agent output via equals", () => {
    expect(
      matchesLoopUntil("pass", { source: "review.verdict", equals: "pass" }),
    ).toBe(true);
    expect(
      matchesLoopUntil("fail", { source: "review.verdict", equals: "pass" }),
    ).toBe(false);
  });

  it("matches boolean and numeric equals values strictly", () => {
    expect(matchesLoopUntil(true, { source: "gate.ok", equals: true })).toBe(true);
    expect(matchesLoopUntil("true", { source: "gate.ok", equals: true })).toBe(
      false,
    );
    expect(matchesLoopUntil(3, { source: "gate.score", equals: 3 })).toBe(true);
  });

  it("matches finalStatus against the last non-empty line of a stringified value", () => {
    expect(
      matchesLoopUntil("work done\nPASS\n\n", {
        source: "review",
        finalStatus: "PASS",
      }),
    ).toBe(true);
  });
});
