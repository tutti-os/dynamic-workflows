import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import clsx from "clsx";
import {
  AgentSessionsIcon,
  Badge,
  FailedLinedIcon,
  Spinner,
  StatusDot,
  SuccessLinedIcon,
} from "@tutti-os/ui-system";
import {
  ArrowRight,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";
import type { WorkflowNodeStatus } from "@/lib/workflow/types";
import type { FlowNodeData } from "@/components/workflow/WorkflowWorkbench.types";

export const NODE_TYPES = { workflowNode: WorkflowNodeCard };

function WorkflowNodeCard(props: NodeProps<Node<FlowNodeData>>) {
  const { workflowNode, status } = props.data;
  const refs = workflowNode.inputs.map((input) => input.name);
  const loop = workflowNode.loop;

  return (
    <div
      className={clsx("workflow-node", status, loop ? "loop-node" : null)}
      style={loop ? { width: 430 } : undefined}
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
            <AgentSessionsIcon size={13} />
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
        {loop ? <LoopMiniFlow loop={loop} /> : null}
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

function LoopMiniFlow(props: {
  loop: NonNullable<FlowNodeData["workflowNode"]["loop"]>;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 9,
        marginTop: 2,
      }}
    >
      <div
        aria-label="Loop step flow"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          overflowX: "auto",
          padding: "8px 8px 9px",
          border: "1px solid var(--border-1)",
          borderRadius: 7,
          background: "var(--background)",
        }}
      >
        {props.loop.steps.map((step, index) => (
          <div
            key={step.id}
            style={{
              display: "contents",
            }}
          >
            <div
              style={{
                display: "grid",
                gap: 5,
                minWidth: 118,
                maxWidth: 144,
                minHeight: 62,
                padding: "8px 9px",
                border: "1px solid var(--border-1)",
                borderRadius: 7,
                background: "var(--background-fronted)",
                boxShadow: "0 6px 18px rgb(0 0 0 / 6%)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    display: "inline-grid",
                    width: 20,
                    height: 20,
                    flex: "0 0 auto",
                    placeItems: "center",
                    borderRadius: 999,
                    background: "var(--transparency-block)",
                    color: "var(--status-running)",
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  {index + 1}
                </span>
                <span
                  title={step.label}
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    color: "var(--foreground)",
                    fontSize: 11,
                    fontWeight: 650,
                    lineHeight: 1.2,
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {step.label}
                </span>
              </div>
              <div
                title={`${step.id}${step.session ? ` · ${step.session}` : ""}`}
                style={{
                  overflow: "hidden",
                  color: "var(--text-secondary)",
                  fontSize: 10,
                  lineHeight: 1.25,
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {step.id}
                {step.session ? ` · ${step.session}` : ""}
              </div>
            </div>
            {index < props.loop.steps.length - 1 ? (
              <ArrowRight
                aria-hidden
                size={16}
                strokeWidth={2.1}
                style={{
                  flex: "0 0 auto",
                  color: "var(--text-tertiary)",
                }}
              />
            ) : null}
          </div>
        ))}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          title={`${props.loop.until.source} includes ${JSON.stringify(
            props.loop.until.includes,
          )}`}
          style={{
            display: "flex",
            minWidth: 0,
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            border: "1px dashed var(--border-1)",
            borderRadius: 7,
            color: "var(--text-secondary)",
            fontSize: 10,
            lineHeight: 1.2,
          }}
        >
          <RotateCcw
            aria-hidden
            size={13}
            strokeWidth={2.2}
            style={{ flex: "0 0 auto" }}
          />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            repeat while {props.loop.until.source} misses{" "}
            {JSON.stringify(props.loop.until.includes)}
          </span>
        </div>
        <div
          title={`Exit when ${props.loop.until.source} includes ${JSON.stringify(
            props.loop.until.includes,
          )}, max ${props.loop.maxIterations} iterations`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "6px 8px",
            borderRadius: 7,
            background: "var(--transparency-block)",
            color: "var(--state-success)",
            fontSize: 10,
            fontWeight: 650,
            whiteSpace: "nowrap",
          }}
        >
          <CheckCircle2 aria-hidden size={13} strokeWidth={2.2} />
          exit / max {props.loop.maxIterations}
        </div>
      </div>
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
  if (status === "skipped") {
    return "amber" as const;
  }
  return "neutral" as const;
}
