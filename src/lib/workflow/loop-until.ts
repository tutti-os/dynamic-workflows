import type { WorkflowLoopUntil, WorkflowValue } from "./types";
import { stringifyWorkflowValue } from "./templates";

export function matchesLoopUntil(
  output: WorkflowValue,
  until: WorkflowLoopUntil,
): boolean {
  if ("equals" in until) {
    return output === until.equals;
  }
  return lastNonEmptyLine(stringifyWorkflowValue(output)) === until.finalStatus;
}

export function formatLoopUntil(until: WorkflowLoopUntil): string {
  return "equals" in until
    ? `${until.source} equals ${JSON.stringify(until.equals)}`
    : `${until.source} final status ${JSON.stringify(until.finalStatus)}`;
}

function lastNonEmptyLine(output: string): string {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line) {
      return line;
    }
  }
  return "";
}
