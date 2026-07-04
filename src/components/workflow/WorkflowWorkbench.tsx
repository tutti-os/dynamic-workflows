"use client";

import {
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Badge,
  Button,
  DashboardIcon,
  FailedLinedIcon,
  LoadingIcon,
  Spinner,
} from "@tutti-os/ui-system";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AgentEditDialog } from "@/components/workflow/AgentEditDialog";
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
import type {
  WorkflowDetail,
  WorkflowVersionRecord,
} from "@/lib/db/workflows";

type WorkflowWorkbenchProps = {
  workflowId: string;
};

export function WorkflowWorkbench({ workflowId }: WorkflowWorkbenchProps) {
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
    cwd,
    setAgent,
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
    appendPromptDraft,
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
    isAgentEditingWorkflow,
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
    runInputValues,
    missingRunInputNames,
    workflowInputPayload,
    setRunInputValue,
  } = useWorkflowRunInputs(workflowInputNames);
  const requiresCwd = Boolean(parsed.meta.requiresCwd);
  const missingCwd = requiresCwd && !cwd.trim();

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
    resumeRun,
    cancelCurrentRun,
    selectRun,
    copyRunText,
    openAgentSession,
  } = useWorkflowRunController({
    workflowId,
    detail,
    selectedVersion,
    parsed,
    script,
    isScriptDirty: isDirty,
    effectiveAgent,
    model,
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
    onLoopStepSelect: (loopNodeId, stepId) => {
      setSelectedNodeId(loopNodeId);
      setSelectedLoopStepId(stepId);
      if (!isRunPreview) {
        setActiveTab("edit");
      }
    },
    parsed: graphParsed,
    nodeStatuses: displayNodeStatuses,
    selectedLoopStepId,
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
        agentEditing={isAgentEditingWorkflow || isAgentEditDialogOpen}
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

      <RunInputsDialog
        open={isRunInputDialogOpen}
        agents={agents}
        agent={effectiveAgent}
        model={model}
        modelOptions={modelOptions}
        cwd={cwd}
        requiresCwd={requiresCwd}
        workflowInputNames={workflowInputNames}
        runInputValues={runInputValues}
        missingRunInputNames={missingRunInputNames}
        missingCwd={missingCwd}
        isRunning={isRunning}
        onOpenChange={setIsRunInputDialogOpen}
        onAgentChange={setAgent}
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

      <AgentEditDialog
        open={isAgentEditDialogOpen}
        workflowId={workflowId}
        baseVersion={selectedVersion}
        agents={agents}
        agent={effectiveAgent}
        model={model}
        modelOptions={modelOptions}
        cwd={cwd}
        onOpenChange={setIsAgentEditDialogOpen}
        onAgentChange={setAgent}
        onModelChange={setModel}
        onCwdChange={setCwd}
        onVersionCreated={handleAgentEditVersionCreated}
        onOpenAgentSession={openAgentSession}
        onLogEvent={appendEventLog}
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
          requiresCwd={Boolean(graphParsed.meta.requiresCwd)}
          onMainViewChange={setMainView}
          onScriptChange={setScriptFromEditor}
          onFlowInit={(instance) => {
            reactFlowInstanceRef.current = instance;
          }}
          onNodeSelect={(nodeId) => {
            setSelectedNodeId(nodeId);
            setSelectedLoopStepId(undefined);
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
          selectedLoopStepId={selectedLoopStepId}
          graphParsed={graphParsed}
          parsedDiagnostics={parsed.diagnostics}
          parseError={parseError}
          scriptSaveError={scriptSaveError ?? agentEditError}
          scriptSaveDiagnostics={scriptSaveDiagnostics}
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
          onAppendPromptChange={updateAppendPromptDraft}
          onSelectLoopStep={setSelectedLoopStepId}
          onSelectRun={selectRun}
          onRetryRun={(runId) => void retryRun(runId)}
          onResumeRun={(runId) => void resumeRun(runId)}
          onCopyRunText={(key, text) => void copyRunText(key, text)}
          onOpenAgentSession={(agentSessionId) =>
            void openAgentSession(agentSessionId)
          }
        />
      </section>
    </main>
  );
}

function hasCurrentVersion(
  detail: WorkflowDetail,
): detail is WorkflowDetail & { currentVersion: WorkflowVersionRecord } {
  return Boolean(detail.currentVersion);
}

function WorkflowGenerationState(props: {
  detail: WorkflowDetail;
  isGenerating: boolean;
  retrying: boolean;
  generationError?: string;
  onRetry: () => void;
}) {
  const generation = props.detail.generation;
  const failed = generation?.status === "failed";
  const errorMessage =
    props.generationError ?? generation?.error?.message ?? "Generation failed.";

  return (
    <main className="app-shell">
      <header className="detail-topbar generation-topbar">
        <div className="detail-titlebar">
          <Button asChild variant="outline" size="icon-lg" aria-label="Home">
            <Link href="/">
              <DashboardIcon />
            </Link>
          </Button>
          <div className="detail-heading">
            <div className="detail-heading-title">
              <h1>{props.detail.workflow.name}</h1>
            </div>
            <div className="detail-meta">
              <Badge variant={failed ? "destructive" : "pending"}>
                {failed ? "generation failed" : "generating"}
              </Badge>
              <span className="detail-description">
                {props.detail.workflow.description}
              </span>
            </div>
          </div>
        </div>
      </header>

      <section className="workflow-generation-state">
        <div className="workflow-generation-status">
          {failed ? (
            <span className="generation-status-icon failed">
              <FailedLinedIcon size={24} />
            </span>
          ) : (
            <span className="generation-status-icon">
              {props.isGenerating ? (
                <LoadingIcon className="spin" size={24} />
              ) : (
                <Spinner />
              )}
            </span>
          )}
          <div className="generation-status-copy">
            <h2>
              {failed ? "Workflow generation failed" : "Generating workflow"}
            </h2>
            <p>
              {failed
                ? errorMessage
                : "The workflow detail is ready. The script is being generated and will open here when it finishes."}
            </p>
          </div>
          {failed ? (
            <Button
              className="generation-retry-button"
              type="button"
              disabled={props.retrying}
              onClick={props.onRetry}
            >
              {props.retrying ? (
                <LoadingIcon className="spin" data-icon="inline-start" />
              ) : null}
              Retry generation
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
