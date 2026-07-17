import type {
  WorkflowRunRecord,
} from "@/lib/db/workflows/types";
import type { RunDetail, RunNodeDetail } from "@/lib/workflow/run-detail";
import type { WorkflowValue } from "@/lib/workflow/types";
import { RunDetailPanel } from "@/components/workflow/RunDetailPanel";
import { RunList } from "@/components/workflow/RunList";
import { RunDetailSkeleton } from "@/components/workflow/WorkflowStates";

type RunsPanelProps = {
  runs: WorkflowRunRecord[];
  selectedRun: RunDetail | null;
  selectedNodeRun: RunNodeDetail | null;
  versionLabelById: Record<string, string>;
  isRunning: boolean;
  isLoadingRunDetail: boolean;
  retryingRunId?: string;
  runActionError?: string;
  copiedRunField?: string;
  onSelectRun: (runId: string) => void;
  onRetryRun: (runId: string) => void;
  onRetryMapItems: (runId: string, mapNodeId: string) => void;
  onRetryFromNode: (runId: string, fromNodeId: string) => void;
  onResumeRun: (runId: string) => void;
  onCancelRun: (runId: string) => void;
  onCopyRunText: (key: string, text: string) => void;
  onOpenAgentSession: (agentSessionId: string) => void;
  onRespondHumanTask: (input: {
    taskId: string;
    action: string;
    values: Record<string, WorkflowValue>;
    revision: number;
  }) => Promise<void>;
};

export function RunsPanel(props: RunsPanelProps) {
  return (
    <div className="runs-panel">
      <RunList
        runs={props.runs}
        selectedRunId={props.selectedRun?.run.id}
        versionLabelById={props.versionLabelById}
        isRunning={props.isRunning}
        loading={props.isRunning && props.runs.length === 0}
        retryingRunId={props.retryingRunId}
        onSelectRun={props.onSelectRun}
        onRetryRun={props.onRetryRun}
        onResumeRun={props.onResumeRun}
      />

      {props.isLoadingRunDetail ? (
        <RunDetailSkeleton />
      ) : props.selectedRun ? (
        <RunDetailPanel
          detail={props.selectedRun}
          selectedNodeRun={props.selectedNodeRun}
          versionLabelById={props.versionLabelById}
          isRunning={props.isRunning}
          retryingRunId={props.retryingRunId}
          runActionError={props.runActionError}
          copiedRunField={props.copiedRunField}
          onRetryRun={props.onRetryRun}
          onRetryMapItems={props.onRetryMapItems}
          onRetryFromNode={props.onRetryFromNode}
          onResumeRun={props.onResumeRun}
          onCancelRun={props.onCancelRun}
          onCopyRunText={props.onCopyRunText}
          onOpenAgentSession={props.onOpenAgentSession}
          onRespondHumanTask={props.onRespondHumanTask}
        />
      ) : null}
    </div>
  );
}
