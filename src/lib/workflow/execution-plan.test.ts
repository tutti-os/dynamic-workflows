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
  until: { source: "check", finalStatus: "PASS" },
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

  it("rejects dependency cycles before execution", () => {
    const parsed = parseWorkflowScript(`
const first = agent({ id: "first", prompt: "Use {{second}}" })
const second = agent({ id: "second", inputs: { first }, prompt: "Use {{first}}" })
`);

    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "workflow.graph.cycle",
        severity: "error",
      }),
    ]));
  });

  it("rejects dependencies on preview-only nodes", () => {
    const parsed = parseWorkflowScript(`
const group = pipeline([])
agent({ id: "worker", prompt: "Use {{group}}" })
`);

    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "workflow.graph.nonExecutableDependency",
        severity: "error",
      }),
    ]));
  });
});
