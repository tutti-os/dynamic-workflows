import { useMemo } from "react";
import {
  MarkerType,
  Position,
  type Edge,
  type Node,
} from "@xyflow/react";
import { formatLoopUntil } from "@/lib/workflow/loop-until";
import type {
  ParsedWorkflow,
  WorkflowLoopStepRun,
  WorkflowNodeStatus,
} from "@/lib/workflow/types";
import type { FlowNodeData } from "@/components/workflow/WorkflowWorkbench.types";

const FLOW_LANE_WIDTH = 300;
const FLOW_LAYER_HEIGHT = 220;
const FLOW_NODE_WIDTH = 230;
const FLOW_NODE_HEIGHT = 132;
const FLOW_LOOP_LANE_WIDTH = 560;
const FLOW_LOOP_NODE_WIDTH = 430;
const FLOW_LOOP_NODE_BASE_HEIGHT = 280;
const FLOW_LOOP_FIRST_ENTRY_HEIGHT = 42;
const FLOW_LOOP_INPUTS_HEIGHT = 36;
const FLOW_ORIGIN_X = 80;
const FLOW_ORIGIN_Y = 56;
const FLOW_PHASE_GAP = 112;

export function useWorkflowFlowLayout(input: {
  onLoopStepSelect?: (loopNodeId: string, stepId: string) => void;
  parsed: ParsedWorkflow;
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  loopStepRuns?: WorkflowLoopStepRun[];
  selectedNodeId?: string;
  selectedLoopStepId?: string;
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
        loopStepRuns: input.loopStepRuns,
        onLoopStepSelect: input.onLoopStepSelect,
        selectedNodeId: input.selectedNodeId,
        selectedLoopStepId: input.selectedLoopStepId,
      }),
    [
      input.nodeStatuses,
      input.loopStepRuns,
      input.onLoopStepSelect,
      input.parsed.nodes,
      input.parsed.phases,
      input.selectedLoopStepId,
      input.selectedNodeId,
    ],
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
  onLoopStepSelect?: (loopNodeId: string, stepId: string) => void;
  parsed: ParsedWorkflow;
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  loopStepRuns?: WorkflowLoopStepRun[];
  selectedNodeId?: string;
  selectedLoopStepId?: string;
}): Node<FlowNodeData>[] {
  const phaseIndex = new Map(
    input.parsed.phases.map((phase, index) => [phase.title, index]),
  );
  const phaseCounters = new Map<string, number>();
  const maxLaneWidthByPhase = new Map<string, number>();
  const phaseYByTitle = createPhaseYPositions(input.parsed);

  return input.parsed.nodes.map((workflowNode) => {
    const phase = workflowNode.phase ?? "Workflow";
    const phasePosition = phaseIndex.get(phase) ?? 0;
    const laneIndex = phaseCounters.get(phase) ?? 0;
    const phaseLaneWidth = maxLaneWidthByPhase.get(phase) ?? FLOW_LANE_WIDTH;
    const { height: nodeHeight, width: nodeWidth } =
      getFlowNodeDimensions(workflowNode);
    phaseCounters.set(phase, laneIndex + 1);
    maxLaneWidthByPhase.set(
      phase,
      Math.max(
        phaseLaneWidth,
        workflowNode.kind === "loop" ? FLOW_LOOP_LANE_WIDTH : FLOW_LANE_WIDTH,
      ),
    );

    return {
      id: workflowNode.id,
      type: "workflowNode",
      initialWidth: nodeWidth,
      initialHeight: nodeHeight,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      position: {
        x: laneIndex * phaseLaneWidth + FLOW_ORIGIN_X,
        y:
          phaseYByTitle.get(phase) ??
          phasePosition * FLOW_LAYER_HEIGHT + FLOW_ORIGIN_Y,
      },
      data: {
        onLoopStepSelect: input.onLoopStepSelect,
        loopStepRuns: input.loopStepRuns?.filter(
          (run) => run.parentNodeId === workflowNode.id,
        ),
        selectedLoopStepId:
          workflowNode.id === input.selectedNodeId
            ? input.selectedLoopStepId
            : undefined,
        workflowNode,
        status: input.nodeStatuses[workflowNode.id] ?? "idle",
      },
      selected: workflowNode.id === input.selectedNodeId,
    };
  });
}

function createPhaseYPositions(parsed: ParsedWorkflow): Map<string, number> {
  const phaseTitles = parsed.phases.map((phase) => phase.title);
  for (const node of parsed.nodes) {
    const phase = node.phase ?? "Workflow";
    if (!phaseTitles.includes(phase)) {
      phaseTitles.push(phase);
    }
  }

  const maxHeightByPhase = new Map<string, number>();
  for (const node of parsed.nodes) {
    const phase = node.phase ?? "Workflow";
    const { height } = getFlowNodeDimensions(node);
    maxHeightByPhase.set(
      phase,
      Math.max(maxHeightByPhase.get(phase) ?? FLOW_NODE_HEIGHT, height),
    );
  }

  let y = FLOW_ORIGIN_Y;
  const phaseYByTitle = new Map<string, number>();
  for (const phaseTitle of phaseTitles.length > 0 ? phaseTitles : ["Workflow"]) {
    phaseYByTitle.set(phaseTitle, y);
    y += Math.max(
      FLOW_LAYER_HEIGHT,
      (maxHeightByPhase.get(phaseTitle) ?? FLOW_NODE_HEIGHT) + FLOW_PHASE_GAP,
    );
  }

  return phaseYByTitle;
}

export function getFlowNodeDimensions(
  workflowNode: ParsedWorkflow["nodes"][number],
): { width: number; height: number } {
  if (workflowNode.kind !== "loop") {
    return { width: FLOW_NODE_WIDTH, height: FLOW_NODE_HEIGHT };
  }

  return {
    width: FLOW_LOOP_NODE_WIDTH,
    height:
      FLOW_LOOP_NODE_BASE_HEIGHT +
      (workflowNode.loop?.firstIteration ? FLOW_LOOP_FIRST_ENTRY_HEIGHT : 0) +
      (workflowNode.inputs.length > 0 ? FLOW_LOOP_INPUTS_HEIGHT : 0),
  };
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
    const samePhase = sourcePhaseIndex === targetPhaseIndex;
    const bypass = targetPhaseIndex - sourcePhaseIndex > 1;

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      label: samePhase ? undefined : edge.label,
      sourceHandle: samePhase || bypass ? "source-right" : "source-bottom",
      targetHandle: samePhase
        ? "target-left"
        : bypass
          ? "target-right"
          : "target-top",
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
    .map((node) => {
      if (node.loop) {
        return `${node.id}:${node.phase ?? "Workflow"}:${node.loop.steps
          .map((step) => step.id)
          .join(",")}:${node.loop.maxIterations}:${node.loop.firstIteration?.startAt ?? "all"}:${formatLoopUntil(node.loop.until)}`;
      }

      return `${node.id}:${node.phase ?? "Workflow"}`;
    })
    .join("|");
  const edgeKey = parsed.edges.map((edge) => edge.id).join("|");
  return `${nodeKey}::${edgeKey}`;
}
