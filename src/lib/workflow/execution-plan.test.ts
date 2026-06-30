import { describe, expect, it } from "vitest";
import { parseWorkflowScript } from "./parser";
import {
  createWorkflowExecutionPlan,
  isExecutableWorkflowNode,
} from "./execution-plan";

describe("workflow execution plan", () => {
  it("treats agent and loop nodes as executable", () => {
    const parsed = parseWorkflowScript(`
const scan = await agent({ id: "scan", prompt: "scan" })
const review = await loop({
  id: "review",
  maxIterations: 2,
  steps: [agent({ id: "check", prompt: "check" })],
  until: { source: "check", includes: "PASS" },
})
log("done")
const dynamic = pipeline([])
`);

    const plan = createWorkflowExecutionPlan(parsed);

    expect(parsed.nodes.map((node) => [node.id, node.kind])).toEqual([
      ["scan", "agent"],
      ["review", "loop"],
      ["log_1", "log"],
      ["dynamic", "pipeline"],
    ]);
    expect(plan.executableNodes.map((node) => node.id)).toEqual([
      "scan",
      "review",
    ]);
    expect([...plan.executableNodeIds]).toEqual(["scan", "review"]);
    expect(parsed.nodes.map((node) => isExecutableWorkflowNode(node))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});
