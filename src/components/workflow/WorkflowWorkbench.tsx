"use client";

import {
  useCallback,
  useRef,
  useState,
} from "react";
import { WorkflowErrorBoundary } from "@/components/workflow/WorkflowErrorBoundary";
import { WorkflowHeader } from "@/components/workflow/WorkflowHeader";
import {
  hasCurrentVersion,
  WorkflowGenerationState,
} from "@/components/workflow/WorkflowGenerationState";
import {
  ErrorState,
  LoadingState,
  WorkbenchSkeleton,
} from "@/components/workflow/WorkflowStates";
import { WorkflowWorkbenchDialogs } from "@/components/workflow/WorkflowWorkbenchDialogs";
import { WorkflowWorkbenchWorkspace } from "@/components/workflow/WorkflowWorkbenchWorkspace";
import { useWorkflowDocument } from "@/components/workflow/useWorkflowDocument";
import { useWorkflowFlowLayout } from "@/components/workflow/useWorkflowFlowLayout";
import { useWorkflowRunController } from "@/components/workflow/useWorkflowRunController";
import { useWorkflowRunInputs } from "@/components/workflow/useWorkflowRunInputs";
import { useWorkflowRunPreview } from "@/components/workflow/useWorkflowRunPreview";
import { useWorkflowRunSettings } from "@/components/workflow/useWorkflowRunSettings";
import { useWorkflowScriptEditing } from "@/components/workflow/useWorkflowScriptEditing";
import {
  type InspectorTab,
  type MainView,
} from "@/components/workflow/WorkflowWorkbench.types";
import type {
  WorkflowVersionRecord,
} from "@/lib/db/workflows/types";

type WorkflowWorkbenchProps = {
  workflowId: string;
};

export function WorkflowWorkbench({ workflowId }: WorkflowWorkbenchProps) {
  return (
    <WorkflowErrorBoundary>
      <WorkflowWorkbenchContent workflowId={workflowId} />
    </WorkflowErrorBoundary>
  );
}

function WorkflowWorkbenchContent({ workflowId }: WorkflowWorkbenchProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [selectedLoopStepId, setSelectedLoopStepId] = useState<
    string | undefined
  >();
  const [activeTab, setActiveTab] = useState<InspectorTab>("edit");
  const [mainView, setMainView] = useState<MainView>("graph");
  const [isRunInputDialogOpen, setIsRunInputDialogOpen] = useState(false);
  const [isAgentEditDialogOpen, setIsAgentEditDialogOpen] = useState(false);
  const appendRunEventLogRef = useRef<(message: string) => void>(() => {});
  const resetRunStateForVersionRef = useRef<() => void>(() => {});
  const appendDocumentEventLog = useCallback((message: string) => {
    appendRunEventLogRef.current(message);
  }, []);
  const resetVersionViewState = useCallback(() => {
    setSelectedNodeId(undefined);
    setSelectedLoopStepId(undefined);
    resetRunStateForVersionRef.current();
  }, []);
  const {
    agents,
    effectiveAgent,
    model,
    modelOptions,
    permissionMode,
    permissionModeOptions,
    cwd,
    agentsLoading,
    agentsError,
    agentsWarning,
    retryAgents,
    setAgent,
    setModel,
    setPermissionMode,
    setCwd,
  } = useWorkflowRunSettings();
  const {
    script,
    parsed,
    selectedNode,
    labelDraft,
    promptDraft,
    appendPromptDraft,
    parseError,
    scriptSaveError,
    scriptSaveDiagnostics,
    diagnosticErrorCount,
    diagnosticWarningCount,
    hasParseErrors,
    isDirty,
    inputSchema,
    workflowInputNames,
    optionalWorkflowInputNames,
    acceptSavedScript,
    setScriptFromEditor,
    resetScriptChanges: resetScriptEditingChanges,
    replaceParsed,
    setParseErrorMessage,
    clearScriptSaveFeedback,
    setScriptSaveFailure,
    updateLabelDraft,
    updatePromptDraft,
    updateAppendPromptDraft,
  } = useWorkflowScriptEditing({ selectedLoopStepId, selectedNodeId });

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
    isGeneratingWorkflow,
    isRetryingGeneration,
    isPublishingVersion,
    generationError,
    agentEditError,
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
    retryWorkflowGeneration,
    publishSelectedVersion,
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
    workflowInputNames: runWorkflowInputNames,
    runInputValues,
    missingRunInputNames,
    workflowInputPayload,
    setRunInputValue,
  } = useWorkflowRunInputs(
    inputSchema,
    workflowInputNames,
    optionalWorkflowInputNames,
  );
  const requiresCwd = Boolean(parsed.meta.requiresCwd);
  const missingCwd = requiresCwd && !cwd.trim();

  const {
    selectedRun,
    visibleRuns,
    nodeStatuses,
    loopStepRuns,
    mapItemRuns,
    nodeOutputs,
    latestOutput,
    eventLog,
    isRunning,
    isCancellingRun,
    isLoadingRunDetail,
    retryingRunId,
    runActionError,
    copiedRunField,
    appendEventLog,
    resetVersionRunState,
    submitRunInputDialog,
    retryRun,
    retryMapItems,
    retryFromNode,
    resumeRun,
    cancelCurrentRun,
    cancelRun,
    selectRun,
    copyRunText,
    openAgentSession,
    respondHumanTask,
    addRunNote,
  } = useWorkflowRunController({
    workflowId,
    detail,
    selectedVersion,
    parsed,
    script,
    isScriptDirty: isDirty,
    effectiveAgent,
    model,
    permissionMode,
    cwd,
    requiresCwd,
    workflowInputPayload,
    missingRunInputNames,
    missingCwd,
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
    displayLoopStepRuns,
    displayMapItemRuns,
    completedCount,
    runningCount,
    failedCount,
  } = useWorkflowRunPreview({
    activeTab,
    selectedRun,
    parsed,
    nodeStatuses,
    loopStepRuns,
    mapItemRuns,
    selectedNodeId,
    selectedLoopStepId,
  });

  const { flowNodes, flowEdges, flowLayoutKey } = useWorkflowFlowLayout({
    onLoopStepSelect: (loopNodeId, stepId) => {
      setSelectedNodeId(loopNodeId);
      setSelectedLoopStepId(stepId);
      if (!isRunPreview) {
        setActiveTab("edit");
      }
    },
    parsed: graphParsed,
    nodeStatuses: displayNodeStatuses,
    loopStepRuns: displayLoopStepRuns,
    mapItemRuns: displayMapItemRuns,
    selectedLoopStepId,
    selectedNodeId,
  });

  function resetScriptChanges() {
    resetScriptEditingChanges();
    appendEventLog("changes reset");
  }

  function requestCurrentWorkflowRun() {
    setIsRunInputDialogOpen(true);
  }

  function openAgentEditDialog() {
    if (isDirty) {
      appendEventLog("agent edit blocked: unsaved changes");
      return;
    }
    setIsAgentEditDialogOpen(true);
  }

  async function handleAgentEditVersionCreated(version: WorkflowVersionRecord) {
    const nextDetail = await loadWorkflow();
    const created =
      nextDetail.versions.find((item) => item.id === version.id) ?? version;
    applyVersion(created);
    resetVersionViewState();
  }

  if (isLoading) {
    return (
      <main className="app-shell">
        <LoadingState fullPage skeleton={<WorkbenchSkeleton />}>
          Loading workflow...
        </LoadingState>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="app-shell">
        <ErrorState
          fullPage
          title="Workflow not found"
          message="The workflow could not be loaded."
        />
      </main>
    );
  }

  if (!hasCurrentVersion(detail)) {
    return (
      <WorkflowGenerationState
        detail={detail}
        isGenerating={isGeneratingWorkflow}
        retrying={isRetryingGeneration}
        generationError={generationError}
        onRetry={() => void retryWorkflowGeneration()}
      />
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
        agentEditing={isAgentEditDialogOpen}
        publishingVersion={isPublishingVersion}
        duplicating={isDuplicatingWorkflow}
        deleting={isDeletingWorkflow}
        running={isRunning}
        cancellingRun={isCancellingRun}
        requiresCwd={requiresCwd}
        onSelectVersion={selectVersion}
        onOpenDetails={openDetailsDialog}
        onSave={() => void saveCurrentVersion()}
        onReset={resetScriptChanges}
        onRestore={() => void restoreSelectedVersion()}
        onAgentEdit={openAgentEditDialog}
        onPublishVersion={() => void publishSelectedVersion()}
        onDuplicate={() => void duplicateCurrentWorkflow()}
        onExport={exportSelectedVersion}
        onDelete={() => void deleteCurrentWorkflow()}
        onCancelRun={cancelCurrentRun}
        onRun={requestCurrentWorkflowRun}
      />

      <WorkflowWorkbenchDialogs
        runInputsOpen={isRunInputDialogOpen}
        detailsOpen={detailsDialogOpen}
        agentEditOpen={isAgentEditDialogOpen}
        workflowId={workflowId}
        agents={agents}
        agent={effectiveAgent}
        model={model}
        modelOptions={modelOptions}
        permissionMode={permissionMode}
        permissionModeOptions={permissionModeOptions}
        cwd={cwd}
        agentsLoading={agentsLoading}
        agentsError={agentsError}
        agentsWarning={agentsWarning}
        requiresCwd={requiresCwd}
        inputSchema={inputSchema}
        workflowInputNames={runWorkflowInputNames}
        optionalWorkflowInputNames={optionalWorkflowInputNames}
        runInputValues={runInputValues}
        missingRunInputNames={missingRunInputNames}
        missingCwd={missingCwd}
        isRunning={isRunning}
        metadataName={metadataName}
        metadataDescription={metadataDescription}
        metadataDirty={metadataDirty}
        isSavingMetadata={isSavingMetadata}
        selectedVersion={selectedVersion}
        onRunInputsOpenChange={setIsRunInputDialogOpen}
        onDetailsOpenChange={handleDetailsDialogOpenChange}
        onAgentEditOpenChange={setIsAgentEditDialogOpen}
        onAgentChange={setAgent}
        onModelChange={setModel}
        onPermissionModeChange={setPermissionMode}
        onCwdChange={setCwd}
        onRetryAgents={retryAgents}
        onRunInputChange={setRunInputValue}
        onRun={submitRunInputDialog}
        onMetadataNameChange={setMetadataName}
        onMetadataDescriptionChange={setMetadataDescription}
        onSaveDetails={() => void saveDetailsDialog()}
        onAgentVersionCreated={handleAgentEditVersionCreated}
        onOpenAgentSession={openAgentSession}
        onLogEvent={appendEventLog}
      />

      <WorkflowWorkbenchWorkspace
        workflowId={workflowId}
        mainView={mainView}
        activeTab={activeTab}
        isRunPreview={isRunPreview}
        selectedRun={selectedRun}
        visibleRuns={visibleRuns}
        selectedNodeRun={selectedRunNodeDetail}
        selectedNode={selectedNode}
        selectedLoopStepId={selectedLoopStepId}
        graphParsed={graphParsed}
        parsedDiagnostics={parsed.diagnostics}
        parseError={parseError}
        scriptSaveError={scriptSaveError ?? agentEditError}
        scriptSaveDiagnostics={scriptSaveDiagnostics}
        flowNodes={flowNodes}
        flowEdges={flowEdges}
        flowLayoutKey={flowLayoutKey}
        script={script}
        hasParseErrors={hasParseErrors}
        diagnosticErrorCount={diagnosticErrorCount}
        diagnosticWarningCount={diagnosticWarningCount}
        runningCount={runningCount}
        completedCount={completedCount}
        failedCount={failedCount}
        labelDraft={labelDraft}
        promptDraft={promptDraft}
        appendPromptDraft={appendPromptDraft}
        nodeOutputs={nodeOutputs}
        latestOutput={latestOutput}
        eventLog={eventLog}
        versionLabelById={versionLabelById}
        isRunning={isRunning}
        isLoadingRunDetail={isLoadingRunDetail}
        retryingRunId={retryingRunId}
        runActionError={runActionError}
        copiedRunField={copiedRunField}
        onMainViewChange={setMainView}
        onScriptChange={setScriptFromEditor}
        onNodeSelect={(nodeId) => {
          setSelectedNodeId(nodeId);
          setSelectedLoopStepId(undefined);
          if (!isRunPreview) {
            setActiveTab("edit");
          }
        }}
        onTabChange={(value) => {
          setActiveTab(value);
          if (value === "runs" && !selectedRun && visibleRuns[0]) {
            selectRun(visibleRuns[0].id);
          }
        }}
        onLabelChange={updateLabelDraft}
        onPromptChange={updatePromptDraft}
        onAppendPromptChange={updateAppendPromptDraft}
        onSelectLoopStep={setSelectedLoopStepId}
        onSelectRun={selectRun}
        onRetryRun={(runId) => void retryRun(runId)}
        onRetryMapItems={(runId, mapNodeId) =>
          void retryMapItems(runId, mapNodeId)
        }
        onRetryFromNode={(runId, fromNodeId) =>
          void retryFromNode(runId, fromNodeId)
        }
        onResumeRun={(runId) => void resumeRun(runId)}
        onCancelRun={(runId) => void cancelRun(runId)}
        onCopyRunText={(key, text) => void copyRunText(key, text)}
        onOpenAgentSession={(agentSessionId) =>
          void openAgentSession(agentSessionId)
        }
        onRespondHumanTask={respondHumanTask}
        onAddRunNote={addRunNote}
      />
    </main>
  );
}
