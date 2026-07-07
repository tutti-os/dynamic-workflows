import type {
  WorkflowDiagnostic,
  WorkflowDiagnosticSummary,
} from "./types";

export type WorkflowDiagnosticInput = {
  severity: WorkflowDiagnostic["severity"];
  code?: string;
  message: string;
  path?: string;
  hint?: string;
  range?: WorkflowDiagnostic["range"];
};

export function workflowDiagnostic(
  input: WorkflowDiagnosticInput,
): WorkflowDiagnostic {
  return {
    severity: input.severity,
    ...(input.code ? { code: input.code } : {}),
    message: input.message,
    ...(input.path ? { path: input.path } : {}),
    ...(input.hint ? { hint: input.hint } : {}),
    ...(input.range ? { range: input.range } : {}),
  };
}

export function hasWorkflowDiagnosticErrors(
  diagnostics: WorkflowDiagnostic[],
): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function summarizeWorkflowDiagnostics(
  diagnostics: WorkflowDiagnostic[],
): WorkflowDiagnosticSummary {
  return diagnostics.reduce<WorkflowDiagnosticSummary>(
    (summary, diagnostic) => {
      if (diagnostic.severity === "error") {
        summary.errorCount += 1;
      } else if (diagnostic.severity === "warning") {
        summary.warningCount += 1;
      } else {
        summary.infoCount += 1;
      }
      return summary;
    },
    { errorCount: 0, warningCount: 0, infoCount: 0 },
  );
}

export function formatWorkflowDiagnosticsMessage(
  diagnostics: WorkflowDiagnostic[],
): string {
  if (diagnostics.length === 0) {
    return "Workflow script is invalid";
  }
  const [first] = diagnostics;
  const suffix = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : "";
  return `${formatWorkflowDiagnosticLabel(first)}${suffix}`;
}

export function formatWorkflowDiagnosticLabel(
  diagnostic: WorkflowDiagnostic,
): string {
  const path = diagnostic.path ? `${diagnostic.path}: ` : "";
  return `${path}${diagnostic.message}`;
}

export function formatWorkflowDiagnosticLocation(
  diagnostic: WorkflowDiagnostic,
): string | undefined {
  if (diagnostic.path) {
    return diagnostic.path;
  }
  if (diagnostic.range) {
    return `${diagnostic.range.start}-${diagnostic.range.end}`;
  }
  return undefined;
}

export function workflowInputPath(inputName: string, fieldName?: string): string {
  return fieldName ? `inputs.${inputName}.${fieldName}` : `inputs.${inputName}`;
}
