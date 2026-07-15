import type {
  ParsedWorkflow,
  WorkflowDiagnostic,
  WorkflowNode,
} from "./types";

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
  const executableNodeIds = new Set(executableNodes.map((node) => node.id));
  return {
    executableNodes,
    executableNodeIds,
  };
}

export function validateWorkflowExecutionGraph(
  parsed: Pick<ParsedWorkflow, "nodes">,
): WorkflowDiagnostic[] {
  const executableNodes = parsed.nodes.filter(isExecutableWorkflowNode);
  const executableNodeIds = new Set(executableNodes.map((node) => node.id));
  const diagnostics: WorkflowDiagnostic[] = [];

  for (const node of executableNodes) {
    for (const input of node.inputs) {
      if (!input.sourceNodeId || executableNodeIds.has(input.sourceNodeId)) {
        continue;
      }
      const source = parsed.nodes.find(
        (candidate) => candidate.id === input.sourceNodeId,
      );
      diagnostics.push({
        severity: "error",
        code: "workflow.graph.nonExecutableDependency",
        message: source
          ? `Executable node "${node.id}" depends on non-executable ${source.kind} node "${source.id}".`
          : `Executable node "${node.id}" depends on unknown node "${input.sourceNodeId}".`,
        path: `nodes.${node.id}.inputs.${input.name}`,
        range: node.sourceRange,
        hint: "Bind the input to an agent, human, or loop node that produces a runtime output.",
      });
    }
  }

  for (const cycle of findDependencyCycles(executableNodes, executableNodeIds)) {
    const [firstNodeId] = cycle;
    const firstNode = executableNodes.find((node) => node.id === firstNodeId);
    diagnostics.push({
      severity: "error",
      code: "workflow.graph.cycle",
      message: `Workflow dependency cycle detected: ${cycle.join(" -> ")}.`,
      path: `nodes.${firstNodeId}`,
      range: firstNode?.sourceRange,
      hint: "Remove one dependency so the workflow graph is acyclic.",
    });
  }

  return diagnostics;
}

function findDependencyCycles(
  nodes: WorkflowNode[],
  executableNodeIds: Set<string>,
): string[][] {
  const dependencies = new Map(
    nodes.map((node) => [
      node.id,
      node.inputs.flatMap((input) =>
        input.sourceNodeId && executableNodeIds.has(input.sourceNodeId)
          ? [input.sourceNodeId]
          : [],
      ),
    ]),
  );
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();

  const visit = (nodeId: string) => {
    if (state.get(nodeId) === "visited") {
      return;
    }
    if (state.get(nodeId) === "visiting") {
      const start = stack.lastIndexOf(nodeId);
      const cycle = [...stack.slice(start), nodeId];
      const key = canonicalCycleKey(cycle.slice(0, -1));
      cycles.set(key, cycle);
      return;
    }

    state.set(nodeId, "visiting");
    stack.push(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) {
      visit(dependency);
    }
    stack.pop();
    state.set(nodeId, "visited");
  };

  for (const node of nodes) {
    visit(node.id);
  }
  return [...cycles.values()];
}

function canonicalCycleKey(nodeIds: string[]): string {
  if (nodeIds.length === 0) {
    return "";
  }
  const rotations = nodeIds.map((_, index) => [
    ...nodeIds.slice(index),
    ...nodeIds.slice(0, index),
  ]);
  return rotations.map((rotation) => rotation.join("\u0000")).sort()[0];
}
