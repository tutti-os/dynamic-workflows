import { describe, expect, it } from "vitest";
import { parseFlowV1Bundle } from "@/lib/flow-v1/parser";
import { hasWorkflowDiagnosticErrors } from "@/lib/workflow/validation";
import { createSampleFlowV1Bundle } from "./sample";

describe("sample Flow", () => {
  it("stays valid as the Flow v1 runtime contract evolves", () => {
    const parsed = parseFlowV1Bundle(createSampleFlowV1Bundle());

    expect(hasWorkflowDiagnosticErrors(parsed.diagnostics)).toBe(false);
  });
});
