import {
  useEffect,
  useRef,
} from "react";
import type {
  Edge,
  Node,
  ReactFlowInstance,
} from "@xyflow/react";
import { WorkflowInspectorPane } from "@/components/workflow/WorkflowInspectorPane";
import { WorkflowPreviewPane } from "@/components/workflow/WorkflowPreviewPane";
import type {
  WorkflowRunRecord,
} from "@/lib/db/workflows/types";
import type {
  ParsedWorkflow,
  WorkflowDiagnostic,
  WorkflowNode,
  WorkflowNodeStatus,
  WorkflowValue,
} from "@/lib/workflow/types";
import type {
  RunDetail,
  RunNodeDetail,
} from "@/lib/workflow/run-detail";
import type {
  FlowNodeData,
  InspectorTab,
  MainView,
} from "@/components/workflow/WorkflowWorkbench.types";

export function WorkflowWorkbenchWorkspace(props: {
  workflowId: string;
  mainView: MainView;
  activeTab: InspectorTab;
  isRunPreview: boolean;
  selectedRun: RunDetail | null;
  visibleRuns: WorkflowRunRecord[];
  selectedNodeRun: RunNodeDetail | null;
  selectedNode?: WorkflowNode;
  selectedLoopStepId?: string;
  graphParsed: ParsedWorkflow;
  parsedDiagnostics: WorkflowDiagnostic[];
  parseError?: string;
  scriptSaveError?: string;
  scriptSaveDiagnostics: WorkflowDiagnostic[];
  flowNodes: Node<FlowNodeData>[];
  flowEdges: Edge[];
  flowLayoutKey: string;
  script: string;
  hasParseErrors: boolean;
  diagnosticErrorCount: number;
  diagnosticWarningCount: number;
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
  onMainViewChange: (view: MainView) => void;
  onScriptChange: (script: string) => void;
  onNodeSelect: (nodeId: string) => void;
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
}) {
  const reactFlowInstanceRef = useRef<
    ReactFlowInstance<Node<FlowNodeData>, Edge> | null
  >(null);

  useEffect(() => {
    if (!reactFlowInstanceRef.current || props.flowNodes.length === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      void reactFlowInstanceRef.current?.fitView({ padding: 0.22, duration: 180 });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [props.flowLayoutKey, props.flowNodes.length]);

  return (
    <section className="workspace">
      <WorkflowPreviewPane
        mainView={props.mainView}
        isRunPreview={props.isRunPreview}
        selectedRun={props.selectedRun}
        graphParsed={props.graphParsed}
        flowNodes={props.flowNodes}
        flowEdges={props.flowEdges}
        script={props.script}
        hasParseErrors={props.hasParseErrors}
        diagnosticErrorCount={props.diagnosticErrorCount}
        diagnosticWarningCount={props.diagnosticWarningCount}
        requiresCwd={Boolean(props.graphParsed.meta.requiresCwd)}
        onMainViewChange={props.onMainViewChange}
        onScriptChange={props.onScriptChange}
        onFlowInit={(instance) => {
          reactFlowInstanceRef.current = instance;
        }}
        onNodeSelect={props.onNodeSelect}
      />

      <WorkflowInspectorPane
        workflowId={props.workflowId}
        activeTab={props.activeTab}
        visibleRuns={props.visibleRuns}
        selectedRun={props.selectedRun}
        selectedNodeRun={props.selectedNodeRun}
        selectedNode={props.selectedNode}
        selectedLoopStepId={props.selectedLoopStepId}
        graphParsed={props.graphParsed}
        parsedDiagnostics={props.parsedDiagnostics}
        parseError={props.parseError}
        scriptSaveError={props.scriptSaveError}
        scriptSaveDiagnostics={props.scriptSaveDiagnostics}
        runningCount={props.runningCount}
        completedCount={props.completedCount}
        failedCount={props.failedCount}
        labelDraft={props.labelDraft}
        promptDraft={props.promptDraft}
        appendPromptDraft={props.appendPromptDraft}
        nodeOutputs={props.nodeOutputs}
        latestOutput={props.latestOutput}
        eventLog={props.eventLog}
        versionLabelById={props.versionLabelById}
        isRunning={props.isRunning}
        isLoadingRunDetail={props.isLoadingRunDetail}
        retryingRunId={props.retryingRunId}
        runActionError={props.runActionError}
        copiedRunField={props.copiedRunField}
        onTabChange={props.onTabChange}
        onLabelChange={props.onLabelChange}
        onPromptChange={props.onPromptChange}
        onAppendPromptChange={props.onAppendPromptChange}
        onSelectLoopStep={props.onSelectLoopStep}
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
    </section>
  );
}
