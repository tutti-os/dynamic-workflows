import { useMemo } from "react";
import {
  MarkerType,
  Position,
  type Edge,
  type Node,
} from "@xyflow/react";
import type {
  ParsedWorkflow,
  WorkflowNodeStatus,
} from "@/lib/workflow/types";
import type { FlowNodeData } from "@/components/workflow/WorkflowWorkbench.types";

const FLOW_LANE_WIDTH = 300;
const FLOW_LAYER_HEIGHT = 220;
const FLOW_NODE_WIDTH = 230;
const FLOW_NODE_HEIGHT = 132;
const FLOW_ORIGIN_X = 80;
const FLOW_ORIGIN_Y = 56;

export function useWorkflowFlowLayout(input: {
  parsed: ParsedWorkflow;
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  selectedNodeId?: string;
}): {
  flowNodes: Node<FlowNodeData>[];
  flowEdges: Edge[];
  flowLayoutKey: string;
} {
  const flowNodes = useMemo(
    () =>
      buildFlowNodes({
        parsed: input.parsed,
        nodeStatuses: input.nodeStatuses,
        selectedNodeId: input.selectedNodeId,
      }),
    [input.nodeStatuses, input.parsed.nodes, input.parsed.phases, input.selectedNodeId],
  );

  const flowEdges = useMemo(
    () =>
      buildFlowEdges({
        parsed: input.parsed,
        nodeStatuses: input.nodeStatuses,
      }),
    [input.nodeStatuses, input.parsed.edges, input.parsed.nodes, input.parsed.phases],
  );

  const flowLayoutKey = useMemo(
    () => createFlowLayoutKey(input.parsed),
    [input.parsed.edges, input.parsed.nodes],
  );

  return { flowNodes, flowEdges, flowLayoutKey };
}

function buildFlowNodes(input: {
  parsed: ParsedWorkflow;
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  selectedNodeId?: string;
}): Node<FlowNodeData>[] {
  const phaseIndex = new Map(
    input.parsed.phases.map((phase, index) => [phase.title, index]),
  );
  const phaseCounters = new Map<string, number>();

  return input.parsed.nodes.map((workflowNode) => {
    const phase = workflowNode.phase ?? "Workflow";
    const phasePosition = phaseIndex.get(phase) ?? 0;
    const laneIndex = phaseCounters.get(phase) ?? 0;
    phaseCounters.set(phase, laneIndex + 1);

    return {
      id: workflowNode.id,
      type: "workflowNode",
      initialWidth: FLOW_NODE_WIDTH,
      initialHeight: FLOW_NODE_HEIGHT,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      position: {
        x: laneIndex * FLOW_LANE_WIDTH + FLOW_ORIGIN_X,
        y: phasePosition * FLOW_LAYER_HEIGHT + FLOW_ORIGIN_Y,
      },
      data: {
        workflowNode,
        status: input.nodeStatuses[workflowNode.id] ?? "idle",
      },
      selected: workflowNode.id === input.selectedNodeId,
    };
  });
}

function buildFlowEdges(input: {
  parsed: ParsedWorkflow;
  nodeStatuses: Record<string, WorkflowNodeStatus>;
}): Edge[] {
  const phaseIndex = new Map(
    input.parsed.phases.map((phase, index) => [phase.title, index]),
  );
  const nodePhaseById = new Map(
    input.parsed.nodes.map((node) => [node.id, node.phase ?? "Workflow"]),
  );
  const getPhaseIndex = (nodeId: string) =>
    phaseIndex.get(nodePhaseById.get(nodeId) ?? "Workflow") ?? 0;

  return input.parsed.edges.map((edge) => {
    const sourcePhaseIndex = getPhaseIndex(edge.source);
    const targetPhaseIndex = getPhaseIndex(edge.target);
    const bypass = targetPhaseIndex - sourcePhaseIndex > 1;

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      label: edge.label,
      sourceHandle: bypass ? "source-right" : "source-bottom",
      targetHandle: bypass ? "target-right" : "target-top",
      animated: input.nodeStatuses[edge.target] === "running",
      markerEnd: { type: MarkerType.ArrowClosed },
      labelStyle: {
        fill: "var(--foreground)",
        fontSize: 10,
        fontWeight: 500,
      },
      labelBgStyle: {
        fill: "var(--background-fronted)",
        fillOpacity: 0.94,
      },
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 6,
      style: { stroke: "var(--text-tertiary)", strokeWidth: 1.6 },
    };
  });
}

function createFlowLayoutKey(parsed: ParsedWorkflow): string {
  const nodeKey = parsed.nodes
    .map((node) => `${node.id}:${node.phase ?? "Workflow"}`)
    .join("|");
  const edgeKey = parsed.edges.map((edge) => edge.id).join("|");
  return `${nodeKey}::${edgeKey}`;
}
