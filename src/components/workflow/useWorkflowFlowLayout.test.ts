import { describe, expect, it } from "vitest";
import { parseWorkflowScript } from "@/lib/workflow/parser";
import { getFlowNodeDimensions } from "./useWorkflowFlowLayout";

describe("workflow flow layout", () => {
  it("reserves vertical space for first-entry and input rows on loop nodes", () => {
    const parsed = parseWorkflowScript(`
const before = agent({ id: "before", prompt: "before" })
const review = loop({
  id: "review",
  inputs: { before },
  maxIterations: 2,
  firstIteration: { startAt: "reviewer" },
  steps: [
    agent({ id: "fix", prompt: "fix" }),
    agent({ id: "reviewer", prompt: "review" }),
  ],
  until: { source: "reviewer", finalStatus: "PASS" },
})
`);
    const loopNode = parsed.nodes.find((node) => node.id === "review");

    expect(loopNode).toBeDefined();
    expect(getFlowNodeDimensions(loopNode!)).toEqual({
      width: 430,
      height: 358,
    });
  });
});
