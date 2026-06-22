import {
  ScrollArea,
  UnderlineTabs,
} from "@tutti-os/ui-system";
import type { WorkflowRunRecord } from "@/lib/db/workflows";
import type {
  ParsedWorkflow,
  WorkflowDiagnostic,
  WorkflowNode,
} from "@/lib/workflow/types";
import type {
  RunDetail,
  RunNodeDetail,
} from "@/lib/workflow/run-detail";
import type { InspectorTab } from "@/components/workflow/WorkflowWorkbench.types";
import { DiagnosticsPanel } from "@/components/workflow/DiagnosticsPanel";
import { EditPanel } from "@/components/workflow/EditPanel";
import { Metric } from "@/components/workflow/Metric";
import { RunsPanel } from "@/components/workflow/RunsPanel";

type WorkflowInspectorPaneProps = {
  activeTab: InspectorTab;
  visibleRuns: WorkflowRunRecord[];
  selectedRun: RunDetail | null;
  selectedNodeRun: RunNodeDetail | null;
  selectedNode?: WorkflowNode;
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
  nodeOutputs: Record<string, string>;
  latestOutput?: [string, string];
  eventLog: string[];
  versionLabelById: Record<string, string>;
  isRunning: boolean;
  retryingRunId?: string;
  copiedRunField?: string;
  onTabChange: (tab: InspectorTab) => void;
  onLabelChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onSelectRun: (runId: string) => void;
  onRetryRun: (runId: string) => void;
  onCopyRunText: (key: string, text: string) => void;
  onOpenAgentSession: (agentSessionId: string) => void;
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
            if (value !== "edit" && value !== "runs") {
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
            labelDraft={props.labelDraft}
            promptDraft={props.promptDraft}
            nodeOutputs={props.nodeOutputs}
            latestOutput={props.latestOutput}
            eventLog={props.eventLog}
            onLabelChange={props.onLabelChange}
            onPromptChange={props.onPromptChange}
          />
        ) : (
          <RunsPanel
            runs={props.visibleRuns}
            selectedRun={props.selectedRun}
            selectedNodeRun={props.selectedNodeRun}
            versionLabelById={props.versionLabelById}
            isRunning={props.isRunning}
            retryingRunId={props.retryingRunId}
            copiedRunField={props.copiedRunField}
            onSelectRun={props.onSelectRun}
            onRetryRun={props.onRetryRun}
            onCopyRunText={props.onCopyRunText}
            onOpenAgentSession={props.onOpenAgentSession}
          />
        )}
      </ScrollArea>
    </section>
  );
}
