import { Layers, ShieldAlert } from "lucide-react";
import type { WorkflowMapItemRun } from "@/lib/workflow/types";
import type { FlowNodeData } from "@/components/workflow/WorkflowWorkbench.types";

type MapMiniFlowProps = {
  map: NonNullable<FlowNodeData["workflowNode"]["map"]>;
  mapNodeId: string;
  itemRuns?: WorkflowMapItemRun[];
};

const MAX_VISIBLE_ITEMS = 6;

export function MapMiniFlow(props: MapMiniFlowProps) {
  const step = props.map.step;
  const itemRuns = [...(props.itemRuns ?? [])].sort(
    (left, right) => left.index - right.index,
  );
  const visibleRuns = itemRuns.slice(0, MAX_VISIBLE_ITEMS);
  const hiddenCount = itemRuns.length - visibleRuns.length;
  const targetView = describeMapStepTarget(step);

  return (
    <div className="loop-mini-flow map-mini-flow">
      <div className="loop-mini-flow-step-group">
        <div className="loop-mini-flow-step map-mini-flow-step">
          <div className="loop-mini-flow-step-title">
            <span className="loop-mini-flow-step-index">
              <Layers aria-hidden size={12} strokeWidth={2.1} />
            </span>
            <span className="loop-mini-flow-step-label" title={step.label}>
              {step.label}
            </span>
            <span className="loop-step-badge">
              {itemRuns.length > 0
                ? `${itemRuns.length}/${props.map.maxItems}`
                : `max ${props.map.maxItems}`}
            </span>
          </div>
          <div
            className="loop-mini-flow-step-session"
            title={`${step.id} · one execution per item from ${props.map.source}`}
          >
            {step.id} · per item of {props.map.source}
          </div>
          <div className="loop-mini-flow-badges">
            <span className="loop-step-badge">fan-out</span>
            {targetView ? (
              <span className="loop-step-badge" title={targetView.title}>
                {targetView.label}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {visibleRuns.length > 0 ? (
        <div aria-label="Map item executions" className="map-mini-flow-items">
          {visibleRuns.map((run) => (
            <span
              key={run.executionKey}
              className={`loop-step-badge map-mini-flow-item loop-step-status-${run.status}`}
              title={`#${run.index} ${run.label} · ${run.status}`}
            >
              #{run.index} · {run.status}
            </span>
          ))}
          {hiddenCount > 0 ? (
            <span className="loop-step-badge map-mini-flow-item">
              +{hiddenCount} more
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="loop-mini-flow-footer">
        <div
          className="loop-mini-flow-until"
          title={`Each item of ${props.map.source} runs ${step.id} once, up to ${props.map.maxItems} items.`}
        >
          <Layers aria-hidden size={13} strokeWidth={2.2} />
          <span>
            map {props.map.source} · max {props.map.maxItems}
          </span>
        </div>
        <div
          className="loop-mini-flow-exit"
          title={
            props.map.onItemFailure === "fail"
              ? "A single failed item fails the whole map node."
              : "Failed items are skipped and reported; the map continues."
          }
        >
          <ShieldAlert aria-hidden size={13} strokeWidth={2.2} />
          on item failure / {props.map.onItemFailure}
        </div>
      </div>
    </div>
  );
}

function describeMapStepTarget(
  step: NonNullable<FlowNodeData["workflowNode"]["map"]>["step"],
): { label: string; title: string } | undefined {
  if (!step.agent && !step.model) {
    return undefined;
  }
  const label = [step.agent ?? "run default", step.model]
    .filter(Boolean)
    .join(" / ");
  return {
    label,
    title: `Uses ${label} for each map item`,
  };
}
