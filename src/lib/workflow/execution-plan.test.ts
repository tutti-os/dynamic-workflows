import { describe, expect, it } from "vitest";
import { parseWorkflowScript } from "./parser";
import {
  createWorkflowExecutionPlan,
  isExecutableWorkflowNode,
} from "./execution-plan";

describe("workflow execution plan", () => {
  it("treats only agent nodes as executable", () => {
    const parsed = parseWorkflowScript(`
const scan = await agent({ id: "scan", prompt: "scan" })
log("done")
const dynamic = pipeline([])
`);

    const plan = createWorkflowExecutionPlan(parsed);

    expect(parsed.nodes.map((node) => [node.id, node.kind])).toEqual([
      ["scan", "agent"],
      ["log_1", "log"],
      ["dynamic", "pipeline"],
    ]);
    expect(plan.executableNodes.map((node) => node.id)).toEqual(["scan"]);
    expect([...plan.executableNodeIds]).toEqual(["scan"]);
    expect(parsed.nodes.map((node) => isExecutableWorkflowNode(node))).toEqual([
      true,
      false,
      false,
    ]);
  });
});
