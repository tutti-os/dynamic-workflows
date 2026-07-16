import { describe, expect, it } from "vitest";
import { AgentJsonOutputError, extractAgentJsonOutput } from "./json-output";

describe("extractAgentJsonOutput", () => {
  it("parses the whole trimmed message as JSON", () => {
    expect(extractAgentJsonOutput('  { "verdict": "pass" }  ')).toEqual({
      verdict: "pass",
    });
  });

  it("parses a top-level JSON array message", () => {
    expect(extractAgentJsonOutput('[{"file": "a.ts"}, {"file": "b.ts"}]')).toEqual([
      { file: "a.ts" },
      { file: "b.ts" },
    ]);
  });

  it("prefers the last fenced code block that parses as JSON", () => {
    const raw = [
      "Here is my analysis.",
      "```json",
      '{ "verdict": "fail" }',
      "```",
      "On reflection:",
      "```json",
      '{ "verdict": "pass" }',
      "```",
    ].join("\n");
    expect(extractAgentJsonOutput(raw)).toEqual({ verdict: "pass" });
  });

  it("falls back to the last balanced top-level object in prose", () => {
    const raw =
      'The list of {items} is below.\nFinal answer: { "verdict": "pass", "score": 9 } done.';
    expect(extractAgentJsonOutput(raw)).toEqual({ verdict: "pass", score: 9 });
  });

  it("ignores braces inside JSON strings when scanning", () => {
    const raw = 'result: { "note": "contains a } brace", "ok": true }';
    expect(extractAgentJsonOutput(raw)).toEqual({
      note: "contains a } brace",
      ok: true,
    });
  });

  it("throws AgentJsonOutputError with a raw excerpt when nothing parses", () => {
    expect(() => extractAgentJsonOutput("no json here at all")).toThrow(
      AgentJsonOutputError,
    );
    expect(() => extractAgentJsonOutput("no json here at all")).toThrow(
      /no json here at all/,
    );
  });
});
