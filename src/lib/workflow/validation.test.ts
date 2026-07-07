import { describe, expect, it } from "vitest";
import {
  formatWorkflowDiagnosticLabel,
  formatWorkflowDiagnosticsMessage,
  hasWorkflowDiagnosticErrors,
  summarizeWorkflowDiagnostics,
  workflowDiagnostic,
  workflowInputPath,
} from "./validation";

describe("workflow validation helpers", () => {
  it("creates, summarizes, and formats diagnostics", () => {
    const diagnostics = [
      workflowDiagnostic({
        severity: "error",
        code: "workflow.input.typeMissing",
        message: 'Workflow input "requirement" requires type.',
        path: workflowInputPath("requirement", "type"),
        hint: 'Set type to "string", "number", "boolean", or "enum".',
      }),
      workflowDiagnostic({
        severity: "warning",
        message: 'Workflow input "unused" is declared but not used.',
      }),
    ];

    expect(hasWorkflowDiagnosticErrors(diagnostics)).toBe(true);
    expect(summarizeWorkflowDiagnostics(diagnostics)).toEqual({
      errorCount: 1,
      warningCount: 1,
      infoCount: 0,
    });
    expect(formatWorkflowDiagnosticLabel(diagnostics[0])).toBe(
      'inputs.requirement.type: Workflow input "requirement" requires type.',
    );
    expect(formatWorkflowDiagnosticsMessage(diagnostics)).toBe(
      'inputs.requirement.type: Workflow input "requirement" requires type. (+1 more)',
    );
  });
});
