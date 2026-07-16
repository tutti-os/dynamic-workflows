import { useMemo } from "react";
import type { InspectorTab } from "@/components/workflow/WorkflowWorkbench.types";
import {
  buildRunNodeDetail,
  readNodeStatusesFromRunLog,
  readRunParsed,
  readRunResult,
  type RunDetail,
  type RunNodeDetail,
} from "@/lib/workflow/run-detail";
import type {
  ParsedWorkflow,
  WorkflowNodeStatus,
  WorkflowLoopStepRun,
} from "@/lib/workflow/types";

export function useWorkflowRunPreview(input: {
  activeTab: InspectorTab;
  selectedRun: RunDetail | null;
  parsed: ParsedWorkflow;
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  loopStepRuns: WorkflowLoopStepRun[];
  selectedNodeId?: string;
  selectedLoopStepId?: string;
}): {
  isRunPreview: boolean;
  graphParsed: ParsedWorkflow;
  selectedRunNodeDetail: RunNodeDetail | null;
  displayNodeStatuses: Record<string, WorkflowNodeStatus>;
  displayLoopStepRuns: WorkflowLoopStepRun[];
  completedCount: number;
  runningCount: number;
  failedCount: number;
} {
  const selectedRunResult = useMemo(
    () => readRunResult(input.selectedRun?.run.result),
    [input.selectedRun?.run.result],
  );

  const selectedRunLogNodeStatuses = useMemo(
    () =>
      input.selectedRun
        ? readNodeStatusesFromRunLog(input.selectedRun.log)
        : {},
    [input.selectedRun?.log],
  );

  const selectedRunDisplayNodeStatuses = useMemo(
    () => ({
      ...selectedRunLogNodeStatuses,
      ...selectedRunResult.nodeStatuses,
    }),
    [selectedRunLogNodeStatuses, selectedRunResult.nodeStatuses],
  );

  const isRunPreview = input.activeTab === "runs" && Boolean(input.selectedRun);

  const runPreviewParsed = useMemo(
    () => (input.selectedRun ? readRunParsed(input.selectedRun.log) : undefined),
    [input.selectedRun?.log],
  );

  const graphParsed = isRunPreview
    ? (runPreviewParsed ?? input.parsed)
    : input.parsed;

  const graphSelectedNode = useMemo(
    () => graphParsed.nodes.find((node) => node.id === input.selectedNodeId),
    [graphParsed.nodes, input.selectedNodeId],
  );

  const selectedRunNodeDetail = useMemo(
    () =>
      input.selectedRun && graphSelectedNode
        ? buildRunNodeDetail(
            input.selectedRun,
            graphSelectedNode,
            input.selectedLoopStepId,
          )
        : null,
    [graphSelectedNode, input.selectedLoopStepId, input.selectedRun],
  );

  const displayNodeStatuses = isRunPreview
    ? selectedRunDisplayNodeStatuses
    : input.nodeStatuses;

  const statusCounts = useMemo(() => {
    const counts = {
      completedCount: 0,
      runningCount: 0,
      failedCount: 0,
    };

    for (const status of Object.values(displayNodeStatuses)) {
      if (status === "completed") {
        counts.completedCount += 1;
      }
      if (status === "running") {
        counts.runningCount += 1;
      }
      if (status === "failed") {
        counts.failedCount += 1;
      }
    }

    return counts;
  }, [displayNodeStatuses]);

  return {
    isRunPreview,
    graphParsed,
    selectedRunNodeDetail,
    displayNodeStatuses,
    displayLoopStepRuns: isRunPreview
      ? Object.values(selectedRunResult.loopStepRuns)
      : input.loopStepRuns,
    ...statusCounts,
  };
}
