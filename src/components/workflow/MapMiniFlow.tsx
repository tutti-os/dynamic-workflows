import { Layers, ShieldAlert } from "lucide-react";
import type { WorkflowMapItemRun, WorkflowNodeStatus } from "@/lib/workflow/types";
import type { FlowNodeData } from "@/components/workflow/WorkflowWorkbench.types";

type MapMiniFlowProps = {
  map: NonNullable<FlowNodeData["workflowNode"]["map"]>;
  mapNodeId: string;
  itemRuns?: WorkflowMapItemRun[];
};

const MAX_VISIBLE_ITEMS = 6;

// One badge per ITEM: multi-step items produce one run record per step
// execution, so records must be grouped by item index before counting or
// rendering — otherwise a 5-item two-step map reads as "10 items".
type MapItemAggregate = {
  index: number;
  status: WorkflowNodeStatus;
  label: string;
  completedSteps: number;
};

function aggregateMapItemRuns(
  runs: WorkflowMapItemRun[],
  steps: NonNullable<FlowNodeData["workflowNode"]["map"]>["steps"],
): MapItemAggregate[] {
  const stepOrder = new Map(steps.map((step, position) => [step.id, position]));
  const byIndex = new Map<number, WorkflowMapItemRun[]>();
  for (const run of runs) {
    const list = byIndex.get(run.index) ?? [];
    list.push(run);
    byIndex.set(run.index, list);
  }
  return [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, records]) => {
      records.sort(
        (left, right) =>
          (stepOrder.get(left.stepId) ?? 0) - (stepOrder.get(right.stepId) ?? 0),
      );
      const failed = records.find((record) => record.status === "failed");
      const completedSteps = records.filter(
        (record) => record.status === "completed",
      ).length;
      const status: WorkflowNodeStatus = failed
        ? "failed"
        : completedSteps === steps.length
          ? "completed"
          : "running";
      const latest = failed ?? records[records.length - 1];
      return { index, status, label: latest.label, completedSteps };
    });
}

export function MapMiniFlow(props: MapMiniFlowProps) {
  const steps = props.map.steps;
  const pipelineLabel = steps.map((step) => step.label).join(" → ");
  const pipelineIds = steps.map((step) => step.id).join(" → ");
  const items = aggregateMapItemRuns(props.itemRuns ?? [], steps);
  const visibleItems = items.slice(0, MAX_VISIBLE_ITEMS);
  const hiddenCount = items.length - visibleItems.length;
  const targetView = describeMapStepTarget(steps);

  return (
    <div className="loop-mini-flow map-mini-flow">
      <div className="loop-mini-flow-step-group">
        <div className="loop-mini-flow-step map-mini-flow-step">
          <div className="loop-mini-flow-step-title">
            <span className="loop-mini-flow-step-index">
              <Layers aria-hidden size={12} strokeWidth={2.1} />
            </span>
            <span className="loop-mini-flow-step-label" title={pipelineLabel}>
              {pipelineLabel}
            </span>
            <span className="loop-step-badge">
              {items.length > 0
                ? `${items.length}/${props.map.maxItems}`
                : `max ${props.map.maxItems}`}
            </span>
          </div>
          <div
            className="loop-mini-flow-step-session"
            title={`${pipelineIds} · per item of ${props.map.source}`}
          >
            {pipelineIds} · per item of {props.map.source}
          </div>
          <div className="loop-mini-flow-badges">
            <span className="loop-step-badge">fan-out</span>
            {steps.length > 1 ? (
              <span
                className="loop-step-badge"
                title={`${steps.length} steps run per item, in order`}
              >
                {steps.length} steps
              </span>
            ) : null}
            {targetView ? (
              <span className="loop-step-badge" title={targetView.title}>
                {targetView.label}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {visibleItems.length > 0 ? (
        <div aria-label="Map item executions" className="map-mini-flow-items">
          {visibleItems.map((item) => (
            <span
              key={item.index}
              className={`loop-step-badge map-mini-flow-item loop-step-status-${item.status}`}
              title={
                steps.length > 1
                  ? `#${item.index} ${item.label} · ${item.status} (${item.completedSteps}/${steps.length} steps)`
                  : `#${item.index} ${item.label} · ${item.status}`
              }
            >
              #{item.index} · {item.status}
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
          title={`Each item of ${props.map.source} runs ${pipelineIds}, up to ${props.map.maxItems} items.`}
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
  steps: NonNullable<FlowNodeData["workflowNode"]["map"]>["steps"],
): { label: string; title: string } | undefined {
  const step = steps.find((item) => item.agent || item.model);
  if (!step) {
    return undefined;
  }
  const label = [step.agent ?? "run default", step.model]
    .filter(Boolean)
    .join(" / ");
  return {
    label,
    title: `Uses ${label} for map step "${step.id}"`,
  };
}
