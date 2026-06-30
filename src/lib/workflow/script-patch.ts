import { quoteTemplateLiteral } from "@/lib/workflow/templates";
import type { EditableRange } from "@/lib/workflow/types";

export type EditableNodeField = "label" | "prompt" | "appendPrompt";

export type EditableNodeRanges = {
  nodeId: string;
  labelRange?: EditableRange;
  promptRange?: EditableRange;
  appendPromptRange?: EditableRange;
};

type EditableNodeRangeKey = Exclude<keyof EditableNodeRanges, "nodeId">;

export function patchNodeFieldInScript(input: {
  script: string;
  ranges: EditableNodeRanges;
  field: EditableNodeField;
  value: string;
}): { script: string; ranges: EditableNodeRanges } | undefined {
  const rangeKey = fieldToRangeKey(input.field);
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
  const ranges: EditableNodeRanges = {
    nodeId: input.ranges.nodeId,
    labelRange: patchRange(
      input.ranges.labelRange,
      rangeKey === "labelRange",
      currentRange,
      delta,
    ),
    promptRange: patchRange(
      input.ranges.promptRange,
      rangeKey === "promptRange",
      currentRange,
      delta,
    ),
    appendPromptRange: patchRange(
      input.ranges.appendPromptRange,
      rangeKey === "appendPromptRange",
      currentRange,
      delta,
    ),
  };

  return {
    script: nextScript,
    ranges,
  };
}

function fieldToRangeKey(field: EditableNodeField): EditableNodeRangeKey {
  if (field === "label") {
    return "labelRange";
  }
  if (field === "appendPrompt") {
    return "appendPromptRange";
  }
  return "promptRange";
}

function patchRange(
  range: EditableRange | undefined,
  isPatchedRange: boolean,
  currentRange: EditableRange,
  delta: number,
): EditableRange | undefined {
  if (!range) {
    return undefined;
  }
  if (isPatchedRange) {
    return {
      start: currentRange.start,
      end: currentRange.start + (currentRange.end - currentRange.start) + delta,
    };
  }
  return range.start >= currentRange.end ? shiftRange(range, delta) : range;
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
