import { quoteTemplateLiteral } from "@/lib/workflow/templates";
import type { EditableRange } from "@/lib/workflow/types";

export type EditableNodeField = "label" | "prompt";

export type EditableNodeRanges = {
  nodeId: string;
  labelRange?: EditableRange;
  promptRange?: EditableRange;
};

export function patchNodeFieldInScript(input: {
  script: string;
  ranges: EditableNodeRanges;
  field: EditableNodeField;
  value: string;
}): { script: string; ranges: EditableNodeRanges } | undefined {
  const rangeKey = input.field === "label" ? "labelRange" : "promptRange";
  const otherRangeKey = input.field === "label" ? "promptRange" : "labelRange";
  const currentRange = input.ranges[rangeKey];
  if (!currentRange) {
    return undefined;
  }

  const nextText =
    input.field === "label"
      ? JSON.stringify(input.value)
      : quoteTemplateLiteral(input.value);
  const nextScript = replaceRange(input.script, currentRange, nextText);
  const delta = nextText.length - (currentRange.end - currentRange.start);
  const otherRange = input.ranges[otherRangeKey];

  return {
    script: nextScript,
    ranges: {
      nodeId: input.ranges.nodeId,
      [rangeKey]: {
        start: currentRange.start,
        end: currentRange.start + nextText.length,
      },
      [otherRangeKey]:
        otherRange && otherRange.start >= currentRange.end
          ? shiftRange(otherRange, delta)
          : otherRange,
    },
  };
}

function replaceRange(script: string, range: EditableRange, value: string): string {
  return `${script.slice(0, range.start)}${value}${script.slice(range.end)}`;
}

function shiftRange(range: EditableRange, offset: number): EditableRange {
  return {
    start: range.start + offset,
    end: range.end + offset,
  };
}
