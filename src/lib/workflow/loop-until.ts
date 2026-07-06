import type { WorkflowLoopUntil } from "./types";

export function matchesLoopUntil(
  output: string,
  until: WorkflowLoopUntil,
): boolean {
  return lastNonEmptyLine(output) === until.finalStatus;
}

export function formatLoopUntil(until: WorkflowLoopUntil): string {
  return `${until.source} final status ${JSON.stringify(until.finalStatus)}`;
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
