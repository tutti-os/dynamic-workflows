import {
  ScrollArea,
  UnderlineTabs,
} from "@tutti-os/ui-system";
import type {
  WorkflowRunRecord,
} from "@/lib/db/workflows/types";
import type {
  ParsedWorkflow,
  WorkflowDiagnostic,
  WorkflowLoopStep,
  WorkflowNode,
  WorkflowValue,
} from "@/lib/workflow/types";
import type {
  RunDetail,
  RunNodeDetail,
} from "@/lib/workflow/run-detail";
import type { InspectorTab } from "@/components/workflow/WorkflowWorkbench.types";
import { AuthoringPanel } from "@/components/workflow/AuthoringPanel";
import { DiagnosticsPanel } from "@/components/workflow/DiagnosticsPanel";
import { EditPanel } from "@/components/workflow/EditPanel";
import { Metric } from "@/components/workflow/Metric";
import { RunsPanel } from "@/components/workflow/RunsPanel";

type WorkflowInspectorPaneProps = {
  workflowId: string;
  activeTab: InspectorTab;
  visibleRuns: WorkflowRunRecord[];
  selectedRun: RunDetail | null;
  selectedNodeRun: RunNodeDetail | null;
  selectedNode?: WorkflowNode;
  selectedLoopStepId?: string;
  graphParsed: ParsedWorkflow;
  parsedDiagnostics: WorkflowDiagnostic[];
  parseError?: string;
  scriptSaveError?: string;
  scriptSaveDiagnostics: WorkflowDiagnostic[];
  runningCount: number;
  completedCount: number;
  failedCount: number;
  labelDraft: string;
  promptDraft: string;
  appendPromptDraft: string;
  nodeOutputs: Record<string, string>;
  latestOutput?: [string, string];
  eventLog: string[];
  versionLabelById: Record<string, string>;
  isRunning: boolean;
  isLoadingRunDetail: boolean;
  retryingRunId?: string;
  runActionError?: string;
  copiedRunField?: string;
  onTabChange: (tab: InspectorTab) => void;
  onLabelChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onAppendPromptChange: (value: string) => void;
  onSelectLoopStep: (stepId: string | undefined) => void;
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

export function WorkflowInspectorPane(props: WorkflowInspectorPaneProps) {
  return (
    <section className="pane inspector-pane">
      <div className="pane-header">
        <div className="pane-title">
          <h2>Run & Edit</h2>
          <p>Patch editable node fields or inspect run output.</p>
        </div>
      </div>
      <ScrollArea className="inspector">
        <UnderlineTabs
          ariaLabel="Workflow inspector"
          value={props.activeTab}
          onValueChange={(value) => {
            if (value !== "edit" && value !== "runs" && value !== "authoring") {
              return;
            }
            props.onTabChange(value);
          }}
          tabs={[
            { value: "edit", label: "Edit" },
            {
              value: "runs",
              label: "Runs",
              count: props.visibleRuns.length || undefined,
            },
            { value: "authoring", label: "Authoring" },
          ]}
          className="inspector-tabs"
        />

        {props.activeTab === "runs" ? (
          <div className="status-strip">
            <Metric label="Nodes" value={props.graphParsed.nodes.length} />
            <Metric label="Running" value={props.runningCount} tone="blue" />
            <Metric label="Done" value={props.completedCount} tone="green" />
            <Metric label="Failed" value={props.failedCount} tone="red" />
          </div>
        ) : null}

        <DiagnosticsPanel
          title="Script diagnostics"
          message={props.parseError}
          diagnostics={props.parsedDiagnostics}
        />
        <DiagnosticsPanel
          title="Save diagnostics"
          message={props.scriptSaveError}
          diagnostics={props.scriptSaveDiagnostics}
        />

        {props.activeTab === "edit" ? (
          <EditPanel
            selectedNode={props.selectedNode}
            selectedLoopStepId={props.selectedLoopStepId}
            labelDraft={props.labelDraft}
            promptDraft={props.promptDraft}
            appendPromptDraft={props.appendPromptDraft}
            nodeOutputs={props.nodeOutputs}
            latestOutput={props.latestOutput}
            eventLog={props.eventLog}
            onLabelChange={props.onLabelChange}
            onPromptChange={props.onPromptChange}
            onAppendPromptChange={props.onAppendPromptChange}
            onSelectLoopStep={props.onSelectLoopStep}
          />
        ) : props.activeTab === "authoring" ? (
          <AuthoringPanel
            workflowId={props.workflowId}
            active={props.activeTab === "authoring"}
            onOpenAgentSession={props.onOpenAgentSession}
          />
        ) : (
          <RunsPanel
            runs={props.visibleRuns}
            selectedRun={props.selectedRun}
            selectedNodeRun={props.selectedNodeRun}
            versionLabelById={props.versionLabelById}
            isRunning={props.isRunning}
            isLoadingRunDetail={props.isLoadingRunDetail}
            retryingRunId={props.retryingRunId}
            runActionError={props.runActionError}
            copiedRunField={props.copiedRunField}
            onSelectRun={props.onSelectRun}
            onRetryRun={props.onRetryRun}
            onRetryMapItems={props.onRetryMapItems}
            onRetryFromNode={props.onRetryFromNode}
            onResumeRun={props.onResumeRun}
            onCancelRun={props.onCancelRun}
            onCopyRunText={props.onCopyRunText}
            onOpenAgentSession={props.onOpenAgentSession}
            onRespondHumanTask={props.onRespondHumanTask}
          />
        )}
      </ScrollArea>
    </section>
  );
}
