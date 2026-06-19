"use client";

import {
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Spinner,
} from "@tutti-os/ui-system";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { RunInputsDialog } from "@/components/workflow/RunInputsDialog";
import { WorkflowHeader } from "@/components/workflow/WorkflowHeader";
import { WorkflowDetailsDialog } from "@/components/workflow/WorkflowDetailsDialog";
import { WorkflowInspectorPane } from "@/components/workflow/WorkflowInspectorPane";
import { WorkflowPreviewPane } from "@/components/workflow/WorkflowPreviewPane";
import { useWorkflowDocument } from "@/components/workflow/useWorkflowDocument";
import { useWorkflowFlowLayout } from "@/components/workflow/useWorkflowFlowLayout";
import { useWorkflowRunController } from "@/components/workflow/useWorkflowRunController";
import { useWorkflowRunInputs } from "@/components/workflow/useWorkflowRunInputs";
import { useWorkflowRunPreview } from "@/components/workflow/useWorkflowRunPreview";
import { useWorkflowRunSettings } from "@/components/workflow/useWorkflowRunSettings";
import { useWorkflowScriptEditing } from "@/components/workflow/useWorkflowScriptEditing";
import {
  type FlowNodeData,
  type InspectorTab,
  type MainView,
} from "@/components/workflow/WorkflowWorkbench.types";

type WorkflowWorkbenchProps = {
  workflowId: string;
};

export function WorkflowWorkbench({ workflowId }: WorkflowWorkbenchProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [activeTab, setActiveTab] = useState<InspectorTab>("edit");
  const [mainView, setMainView] = useState<MainView>("graph");
  const [isRunInputDialogOpen, setIsRunInputDialogOpen] = useState(false);
  const appendRunEventLogRef = useRef<(message: string) => void>(() => {});
  const resetRunStateForVersionRef = useRef<() => void>(() => {});
  const appendDocumentEventLog = useCallback((message: string) => {
    appendRunEventLogRef.current(message);
  }, []);
  const resetVersionViewState = useCallback(() => {
    setSelectedNodeId(undefined);
    resetRunStateForVersionRef.current();
  }, []);
  const {
    providers,
    effectiveProvider,
    model,
    modelOptions,
    cwd,
    setProvider,
    setModel,
    setCwd,
  } = useWorkflowRunSettings();
  const reactFlowInstanceRef = useRef<
    ReactFlowInstance<Node<FlowNodeData>, Edge> | null
  >(null);
  const {
    script,
    parsed,
    selectedNode,
    labelDraft,
    promptDraft,
    parseError,
    scriptSaveError,
    scriptSaveDiagnostics,
    diagnosticErrorCount,
    diagnosticWarningCount,
    hasParseErrors,
    isDirty,
    workflowInputNames,
    acceptSavedScript,
    setScriptFromEditor,
    resetScriptChanges: resetScriptEditingChanges,
    replaceParsed,
    setParseErrorMessage,
    clearScriptSaveFeedback,
    setScriptSaveFailure,
    updateLabelDraft,
    updatePromptDraft,
  } = useWorkflowScriptEditing({ selectedNodeId });

  const {
    detail,
    selectedVersion,
    versionLabelById,
    metadataName,
    metadataDescription,
    metadataDirty,
    detailsDialogOpen,
    isLoading,
    isSaving,
    isSavingMetadata,
    isDuplicatingWorkflow,
    isDeletingWorkflow,
    isViewingOldVersion,
    setMetadataName,
    setMetadataDescription,
    loadWorkflow,
    applyVersion,
    selectVersion,
    saveCurrentVersion,
    restoreSelectedVersion,
    openDetailsDialog,
    handleDetailsDialogOpenChange,
    saveDetailsDialog,
    duplicateCurrentWorkflow,
    deleteCurrentWorkflow,
    exportSelectedVersion,
  } = useWorkflowDocument({
    workflowId,
    script,
    isScriptDirty: isDirty,
    acceptSavedScript,
    clearScriptSaveFeedback,
    setScriptSaveFailure,
    setParseErrorMessage,
    onVersionApplied: resetVersionViewState,
    onLogEvent: appendDocumentEventLog,
  });

  const {
    runInputValues,
    missingRunInputNames,
    workflowInputPayload,
    setRunInputValue,
  } = useWorkflowRunInputs(workflowInputNames);

  const {
    selectedRun,
    visibleRuns,
    nodeStatuses,
    nodeOutputs,
    latestOutput,
    eventLog,
    isRunning,
    isCancellingRun,
    retryingRunId,
    copiedRunField,
    appendEventLog,
    resetVersionRunState,
    submitRunInputDialog,
    retryRun,
    cancelCurrentRun,
    selectRun,
    copyRunText,
  } = useWorkflowRunController({
    workflowId,
    detail,
    selectedVersion,
    parsed,
    script,
    isScriptDirty: isDirty,
    effectiveProvider,
    model,
    cwd,
    workflowInputPayload,
    missingRunInputNames,
    loadWorkflow,
    applyVersion,
    replaceParsed,
    setActiveTab,
    openRunInputDialog: () => setIsRunInputDialogOpen(true),
    closeRunInputDialog: () => setIsRunInputDialogOpen(false),
  });
  appendRunEventLogRef.current = appendEventLog;
  resetRunStateForVersionRef.current = resetVersionRunState;

  const {
    isRunPreview,
    graphParsed,
    selectedRunNodeDetail,
    displayNodeStatuses,
    completedCount,
    runningCount,
    failedCount,
  } = useWorkflowRunPreview({
    activeTab,
    selectedRun,
    parsed,
    nodeStatuses,
    selectedNodeId,
  });

  const { flowNodes, flowEdges, flowLayoutKey } = useWorkflowFlowLayout({
    parsed: graphParsed,
    nodeStatuses: displayNodeStatuses,
    selectedNodeId,
  });

  useEffect(() => {
    if (!reactFlowInstanceRef.current || flowNodes.length === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      void reactFlowInstanceRef.current?.fitView({ padding: 0.22, duration: 180 });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [flowLayoutKey, flowNodes.length]);

  function resetScriptChanges() {
    resetScriptEditingChanges();
    appendEventLog("changes reset");
  }

  function requestCurrentWorkflowRun() {
    setIsRunInputDialogOpen(true);
  }

  if (isLoading) {
    return (
      <main className="app-shell">
        <div className="loading-state">
          <Spinner />
          Loading workflow...
        </div>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="app-shell">
        <div className="loading-state">Workflow not found.</div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <WorkflowHeader
        detail={detail}
        selectedVersion={selectedVersion}
        dirty={isDirty}
        saving={isSaving}
        hasParseErrors={hasParseErrors}
        canRun={parsed.nodes.length > 0 && !hasParseErrors}
        viewingOldVersion={isViewingOldVersion}
        duplicating={isDuplicatingWorkflow}
        deleting={isDeletingWorkflow}
        running={isRunning}
        cancellingRun={isCancellingRun}
        onSelectVersion={selectVersion}
        onOpenDetails={openDetailsDialog}
        onSave={() => void saveCurrentVersion()}
        onReset={resetScriptChanges}
        onRestore={() => void restoreSelectedVersion()}
        onDuplicate={() => void duplicateCurrentWorkflow()}
        onExport={exportSelectedVersion}
        onDelete={() => void deleteCurrentWorkflow()}
        onCancelRun={cancelCurrentRun}
        onRun={requestCurrentWorkflowRun}
      />

      <RunInputsDialog
        open={isRunInputDialogOpen}
        providers={providers}
        provider={effectiveProvider}
        model={model}
        modelOptions={modelOptions}
        cwd={cwd}
        workflowInputNames={workflowInputNames}
        runInputValues={runInputValues}
        missingRunInputNames={missingRunInputNames}
        isRunning={isRunning}
        onOpenChange={setIsRunInputDialogOpen}
        onProviderChange={setProvider}
        onModelChange={setModel}
        onCwdChange={setCwd}
        onRunInputChange={setRunInputValue}
        onRun={submitRunInputDialog}
      />

      <WorkflowDetailsDialog
        open={detailsDialogOpen}
        name={metadataName}
        description={metadataDescription}
        dirty={metadataDirty}
        saving={isSavingMetadata}
        onOpenChange={handleDetailsDialogOpenChange}
        onNameChange={setMetadataName}
        onDescriptionChange={setMetadataDescription}
        onSave={() => void saveDetailsDialog()}
      />

      <section className="workspace">
        <WorkflowPreviewPane
          mainView={mainView}
          isRunPreview={isRunPreview}
          selectedRun={selectedRun}
          graphParsed={graphParsed}
          flowNodes={flowNodes}
          flowEdges={flowEdges}
          script={script}
          hasParseErrors={hasParseErrors}
          diagnosticErrorCount={diagnosticErrorCount}
          diagnosticWarningCount={diagnosticWarningCount}
          onMainViewChange={setMainView}
          onScriptChange={setScriptFromEditor}
          onFlowInit={(instance) => {
            reactFlowInstanceRef.current = instance;
          }}
          onNodeSelect={(nodeId) => {
            setSelectedNodeId(nodeId);
            if (!isRunPreview) {
              setActiveTab("edit");
            }
          }}
        />

        <WorkflowInspectorPane
          activeTab={activeTab}
          visibleRuns={visibleRuns}
          selectedRun={selectedRun}
          selectedNodeRun={selectedRunNodeDetail}
          selectedNode={selectedNode}
          graphParsed={graphParsed}
          parsedDiagnostics={parsed.diagnostics}
          parseError={parseError}
          scriptSaveError={scriptSaveError}
          scriptSaveDiagnostics={scriptSaveDiagnostics}
          runningCount={runningCount}
          completedCount={completedCount}
          failedCount={failedCount}
          labelDraft={labelDraft}
          promptDraft={promptDraft}
          nodeOutputs={nodeOutputs}
          latestOutput={latestOutput}
          eventLog={eventLog}
          versionLabelById={versionLabelById}
          isRunning={isRunning}
          retryingRunId={retryingRunId}
          copiedRunField={copiedRunField}
          onTabChange={(value) => {
            setActiveTab(value);
            if (value === "runs" && !selectedRun && visibleRuns[0]) {
              selectRun(visibleRuns[0].id);
            }
          }}
          onLabelChange={updateLabelDraft}
          onPromptChange={updatePromptDraft}
          onSelectRun={selectRun}
          onRetryRun={(runId) => void retryRun(runId)}
          onCopyRunText={(key, text) => void copyRunText(key, text)}
        />
      </section>
    </main>
  );
}
