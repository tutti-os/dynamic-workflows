import type { ParsedWorkflow, WorkflowNode } from "./types";

export type WorkflowExecutionPlan = {
  executableNodes: WorkflowNode[];
  executableNodeIds: Set<string>;
};

export function isExecutableWorkflowNode(node: WorkflowNode): boolean {
  return node.kind === "agent" || node.kind === "human" || node.kind === "loop";
}

export function createWorkflowExecutionPlan(
  parsed: ParsedWorkflow,
): WorkflowExecutionPlan {
  const executableNodes = parsed.nodes.filter(isExecutableWorkflowNode);
  return {
    executableNodes,
    executableNodeIds: new Set(executableNodes.map((node) => node.id)),
  };
}
