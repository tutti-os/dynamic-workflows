import type {
  WorkflowRunRecord,
} from "@/lib/db/workflows/types";
import type { RunDetail, RunNodeDetail } from "@/lib/workflow/run-detail";
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
  copiedRunField?: string;
  onSelectRun: (runId: string) => void;
  onRetryRun: (runId: string) => void;
  onResumeRun: (runId: string) => void;
  onCopyRunText: (key: string, text: string) => void;
  onOpenAgentSession: (agentSessionId: string) => void;
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
          copiedRunField={props.copiedRunField}
          onRetryRun={props.onRetryRun}
          onResumeRun={props.onResumeRun}
          onCopyRunText={props.onCopyRunText}
          onOpenAgentSession={props.onOpenAgentSession}
        />
      ) : null}
    </div>
  );
}
