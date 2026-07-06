import { describe, expect, it } from "vitest";
import { normalizeWorkflowInputsForSchema } from "./input-schema";
import type { WorkflowInputSchema } from "./types";

describe("normalizeWorkflowInputsForSchema", () => {
  const schema: WorkflowInputSchema = {
    requirement: { type: "string", required: true },
    maxRounds: { type: "number", default: 3, min: 1, max: 6 },
    dryRun: { type: "boolean", default: false },
    mode: {
      type: "enum",
      options: ["research", "implementation"],
      default: "research",
    },
  };

  it("normalizes primitive inputs and injects defaults", () => {
    expect(
      normalizeWorkflowInputsForSchema(schema, {
        requirement: "rename sessions",
        maxRounds: "4",
        dryRun: "true",
      }),
    ).toEqual({
      requirement: "rename sessions",
      maxRounds: 4,
      dryRun: true,
      mode: "research",
    });
  });

  it("reports missing and invalid values", () => {
    expect(() => normalizeWorkflowInputsForSchema(schema, {})).toThrow(
      "Missing required input: requirement",
    );
    expect(() =>
      normalizeWorkflowInputsForSchema(schema, {
        requirement: "   ",
      }),
    ).toThrow("Missing required input: requirement");
    expect(() =>
      normalizeWorkflowInputsForSchema(schema, {
        requirement: "x",
        maxRounds: 99,
      }),
    ).toThrow("Input maxRounds must be at most 6.");
    expect(() =>
      normalizeWorkflowInputsForSchema(schema, {
        requirement: "x",
        mode: "unknown",
      }),
    ).toThrow("Input mode must be one of: research, implementation");
  });
});
