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

  it("reserves loop-style width and height for map nodes", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "list" })
const migrated = await map({
  id: "migrated",
  source: discover,
  maxItems: 5,
  step: agent({ id: "migrate_one", label: "Migrate {{item.file}}", prompt: "do {{item}}" }),
})
`);
    const mapNode = parsed.nodes.find((node) => node.id === "migrated");

    expect(mapNode).toBeDefined();
    expect(mapNode!.kind).toBe("map");
    const dimensions = getFlowNodeDimensions(mapNode!);
    expect(dimensions.width).toBe(430);
    // A map node reserves a mini-flow container plus item badge row, well above
    // the default node height so the MapMiniFlow is not clipped.
    expect(dimensions.height).toBeGreaterThan(240);
  });
});
