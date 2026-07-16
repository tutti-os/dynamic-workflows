import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import clsx from "clsx";
import { UserRound } from "lucide-react";
import {
  AgentSessionsIcon,
  Badge,
  FailedLinedIcon,
  Spinner,
  StatusDot,
  SuccessLinedIcon,
} from "@tutti-os/ui-system";
import type { WorkflowNodeStatus } from "@/lib/workflow/types";
import { LoopMiniFlow } from "@/components/workflow/LoopMiniFlow";
import { MapMiniFlow } from "@/components/workflow/MapMiniFlow";
import type { FlowNodeData } from "@/components/workflow/WorkflowWorkbench.types";

export const NODE_TYPES = { workflowNode: WorkflowNodeCard };

function WorkflowNodeCard(props: NodeProps<Node<FlowNodeData>>) {
  const { workflowNode, status } = props.data;
  const refs = workflowNode.inputs.map((input) => input.name);
  const loop = workflowNode.loop;
  const map = workflowNode.map;
  const isWide = Boolean(loop || map);

  return (
    <div
      className={clsx(
        "workflow-node",
        status,
        loop ? "loop-node" : null,
        map ? "map-node" : null,
      )}
      style={isWide ? { width: 430 } : undefined}
    >
      <Handle id="target-top" type="target" position={Position.Top} />
      <Handle
        id="target-right"
        className="workflow-node-side-handle"
        type="target"
        position={Position.Right}
      />
      <Handle
        id="target-left"
        className="workflow-node-side-handle"
        type="target"
        position={Position.Left}
      />
      <div className="workflow-node-inner">
        <div className="node-topline">
          <span className="node-kind">
            {workflowNode.kind === "human" ? (
              <UserRound size={13} />
            ) : (
              <AgentSessionsIcon size={13} />
            )}
            {workflowNode.kind}
          </span>
          <span className={clsx("node-status", status)}>
            {status === "running" ? (
              <Spinner size={14} />
            ) : status === "completed" ? (
              <SuccessLinedIcon size={14} />
            ) : status === "failed" ? (
              <FailedLinedIcon size={14} />
            ) : (
              <StatusDot tone={nodeStatusTone(status)} size="md" />
            )}
          </span>
        </div>
        <div className="node-label">{workflowNode.label}</div>
        <div className="node-meta">{workflowNode.phase ?? "Workflow"}</div>
        {loop ? (
          <LoopMiniFlow
            loop={loop}
            loopNodeId={workflowNode.id}
            selectedStepId={props.data.selectedLoopStepId}
            stepRuns={props.data.loopStepRuns}
            onStepSelect={props.data.onLoopStepSelect}
          />
        ) : null}
        {map ? (
          <MapMiniFlow
            map={map}
            mapNodeId={workflowNode.id}
            itemRuns={props.data.mapItemRuns}
          />
        ) : null}
        {refs.length > 0 ? (
          <div className="node-refs">
            {refs.map((ref) => (
              <Badge variant="muted" key={ref}>
                {ref}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
      <Handle id="source-bottom" type="source" position={Position.Bottom} />
      <Handle
        id="source-right"
        className="workflow-node-side-handle"
        type="source"
        position={Position.Right}
      />
    </div>
  );
}

function nodeStatusTone(status: WorkflowNodeStatus) {
  if (status === "completed") {
    return "green" as const;
  }
  if (status === "running") {
    return "blue" as const;
  }
  if (status === "failed") {
    return "red" as const;
  }
  if (status === "queued") {
    return "amber" as const;
  }
  if (status === "waiting") {
    return "amber" as const;
  }
  if (status === "skipped") {
    return "amber" as const;
  }
  return "neutral" as const;
}
