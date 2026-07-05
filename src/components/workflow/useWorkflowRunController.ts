import { useState } from "react";
import {
  cancelWorkflowRun,
  loadWorkflowRun,
  openWorkflowAgentSession,
  readApiJsonError,
  startWorkflowRun,
  streamWorkflowRunEvents,
} from "@/components/workflow/workflowApiService";
import type {
  WorkflowDetail,
  WorkflowVersionRecord,
} from "@/lib/db/workflows/types";
import type { RunDetail } from "@/lib/workflow/run-detail";
import type {
  ParsedWorkflow,
  WorkflowNodeStatus,
} from "@/lib/workflow/types";
import type { InspectorTab } from "@/components/workflow/WorkflowWorkbench.types";
import {
  type PendingRunContext,
  useWorkflowRunEvents,
} from "@/components/workflow/useWorkflowRunEvents";
import {
  isAbortError,
  writeClipboardText,
} from "@/components/workflow/workflowClientUtils";

export function useWorkflowRunController(input: {
  workflowId: string;
  detail: WorkflowDetail | null;
  selectedVersion: WorkflowVersionRecord | null;
  parsed: ParsedWorkflow;
  script: string;
  isScriptDirty: boolean;
  effectiveAgent: string;
  model: string;
  cwd: string;
  requiresCwd: boolean;
  workflowInputPayload: Record<string, string>;
  missingRunInputNames: string[];
  missingCwd: boolean;
  loadWorkflow: (options?: { resetScript?: boolean }) => Promise<WorkflowDetail>;
  applyVersion: (version: WorkflowVersionRecord) => void;
  replaceParsed: (nextParsed: ParsedWorkflow) => void;
  setActiveTab: (tab: InspectorTab) => void;
  openRunInputDialog: () => void;
  closeRunInputDialog: () => void;
}): {
  selectedRun: RunDetail | null;
  visibleRuns: WorkflowDetail["runs"];
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  nodeOutputs: Record<string, string>;
  latestOutput: [string, string] | undefined;
  eventLog: string[];
  isRunning: boolean;
  isCancellingRun: boolean;
  isLoadingRunDetail: boolean;
  retryingRunId: string | undefined;
  copiedRunField: string | undefined;
  appendEventLog: (message: string) => void;
  resetVersionRunState: () => void;
  runCurrentWorkflow: () => Promise<void>;
  submitRunInputDialog: () => void;
  retryRun: (runId: string) => Promise<void>;
  resumeRun: (runId: string) => Promise<void>;
  cancelCurrentRun: () => void;
  selectRun: (runId: string) => void;
  copyRunText: (key: string, text: string) => Promise<void>;
  openAgentSession: (agentSessionId: string) => Promise<void>;
} {
  const [isRunning, setIsRunning] = useState(false);
  const [isCancellingRun, setIsCancellingRun] = useState(false);
  const [isLoadingRunDetail, setIsLoadingRunDetail] = useState(false);
  const [retryingRunId, setRetryingRunId] = useState<string | undefined>();
  const [copiedRunField, setCopiedRunField] = useState<string | undefined>();
  const {
    selectedRun,
    visibleRuns,
    nodeStatuses,
    nodeOutputs,
    latestOutput,
    eventLog,
    appendEventLog,
    resetVersionRunState,
    startRunEvents,
    handleRunEvent,
    getActiveRunId,
    clearPendingRunContext,
    clearLiveRun,
    selectRunDetail,
    selectLiveRun,
  } = useWorkflowRunEvents({
    workflowId: input.workflowId,
    detail: input.detail,
    selectedVersion: input.selectedVersion,
    parsed: input.parsed,
    replaceParsed: input.replaceParsed,
  });

  async function executeRunJob(runInput: {
    endpoint: string;
    body?: unknown;
    initialLog: string;
    activeTab: InspectorTab;
    runContext: PendingRunContext;
    resetScriptAfterRun?: string;
    retryRunId?: string;
    failureLogPrefix?: string;
  }) {
    if (runInput.retryRunId) {
      setRetryingRunId(runInput.retryRunId);
    }
    setIsRunning(true);
    setIsCancellingRun(false);
    input.setActiveTab(runInput.activeTab);

    try {
      const startResponse = await startWorkflowRun({
        endpoint: runInput.endpoint,
        body: runInput.body,
      });

      startRunEvents({
        initialLog: runInput.initialLog,
        initialRun: startResponse.run,
        runId: startResponse.run.id,
        runContext: {
          ...runInput.runContext,
          workflowVersionId: startResponse.run.workflowVersionId,
          executorKind: startResponse.run.executorKind,
          agent: startResponse.run.agent ?? undefined,
          model: startResponse.run.model ?? undefined,
          cwd: startResponse.run.cwd ?? undefined,
          input: startResponse.run.input,
        },
      });

      const abortController = new AbortController();
      await streamWorkflowRunEvents({
        workflowId: input.workflowId,
        runId: startResponse.run.id,
        signal: abortController.signal,
        onEvent: handleRunEvent,
      });
      await input.loadWorkflow({
        resetScript: Boolean(
          runInput.resetScriptAfterRun &&
            input.script === runInput.resetScriptAfterRun,
        ),
      });
      await loadRun(startResponse.run.id);
      clearLiveRun();
    } catch (error) {
      if (isAbortError(error)) {
        appendEventLog("run events: disconnected");
        const runId = getActiveRunId();
        if (runId) {
          await loadRun(runId);
          clearLiveRun();
        }
      } else {
        const apiError = readApiJsonError(error, "WORKFLOW_RUN_FAILED");
        appendEventLog(
          `${runInput.failureLogPrefix ?? "run failed"}: ${apiError.message}`,
        );
      }
    } finally {
      setIsRunning(false);
      setIsCancellingRun(false);
      setRetryingRunId(undefined);
      clearPendingRunContext();
    }
  }

  async function requestRunCancel(runId: string) {
    await cancelWorkflowRun({
      workflowId: input.workflowId,
      runId,
    });
  }

  async function runCurrentWorkflow() {
    if (input.missingCwd) {
      input.openRunInputDialog();
      appendEventLog("run blocked: missing cwd");
      return;
    }

    if (input.missingRunInputNames.length > 0) {
      input.openRunInputDialog();
      appendEventLog(
        `run blocked: missing input ${input.missingRunInputNames.join(", ")}`,
      );
      return;
    }

    const runScript = input.script;
    const selectedVersionId =
      input.selectedVersion?.id ?? input.detail?.currentVersion?.id;
    const runBody = {
      ...(input.isScriptDirty ? { script: runScript } : {}),
      ...(!input.isScriptDirty && selectedVersionId
        ? { versionId: selectedVersionId }
        : {}),
      inputs: input.workflowInputPayload,
      agent: input.effectiveAgent,
      model: input.model || undefined,
      cwd: input.cwd || undefined,
    };
    await executeRunJob({
      endpoint: `/api/workflows/${input.workflowId}/run`,
      body: runBody,
      initialLog: "run: started",
      activeTab: "runs",
      runContext: {
        workflowVersionId:
          selectedVersionId ?? "",
        executorKind:
          input.effectiveAgent === "mock" ? "mock" : "local-agent",
        agent: input.effectiveAgent,
        model: input.model || undefined,
        cwd: input.cwd || undefined,
        input: {
          inputs: input.workflowInputPayload,
          agent: input.effectiveAgent,
          model: input.model || undefined,
          cwd: input.cwd || undefined,
          autoSavedVersion: input.isScriptDirty,
          requestedVersionId: selectedVersionId,
        },
      },
      resetScriptAfterRun: runScript,
    });
  }

  function submitRunInputDialog() {
    if (input.missingCwd) {
      return;
    }
    if (input.missingRunInputNames.length > 0) {
      return;
    }
    input.closeRunInputDialog();
    void runCurrentWorkflow();
  }

  async function retryRun(runId: string) {
    if (!input.detail || isRunning) {
      return;
    }

    const sourceRun = input.detail.runs.find((run) => run.id === runId);
    if (!sourceRun) {
      appendEventLog(`retry failed: run ${runId} not found`);
      return;
    }
    const sourceVersion = input.detail.versions.find(
      (version) => version.id === sourceRun.workflowVersionId,
    );

    if (sourceVersion && sourceVersion.id !== input.selectedVersion?.id) {
      if (
        input.isScriptDirty &&
        !window.confirm("Discard unsaved changes and switch to this run version?")
      ) {
        return;
      }
      input.applyVersion(sourceVersion);
    }

    await executeRunJob({
      endpoint: `/api/workflows/${input.workflowId}/runs/${runId}/retry`,
      initialLog: `retry: ${runId}`,
      activeTab: "runs",
      runContext: {
        workflowVersionId: sourceRun.workflowVersionId,
        executorKind: sourceRun.executorKind,
        agent: sourceRun.agent ?? undefined,
        model: sourceRun.model ?? undefined,
        cwd: sourceRun.cwd ?? undefined,
        input: {
          retryOfRunId: runId,
          agent: sourceRun.agent,
          model: sourceRun.model,
          cwd: sourceRun.cwd,
        },
      },
      retryRunId: runId,
      failureLogPrefix: "retry failed",
    });
  }

  async function resumeRun(runId: string) {
    if (!input.detail || isRunning) {
      return;
    }

    const sourceRun = input.detail.runs.find((run) => run.id === runId);
    if (!sourceRun) {
      appendEventLog(`resume failed: run ${runId} not found`);
      return;
    }
    const sourceVersion = input.detail.versions.find(
      (version) => version.id === sourceRun.workflowVersionId,
    );

    if (sourceVersion && sourceVersion.id !== input.selectedVersion?.id) {
      if (
        input.isScriptDirty &&
        !window.confirm("Discard unsaved changes and switch to this run version?")
      ) {
        return;
      }
      input.applyVersion(sourceVersion);
    }

    await executeRunJob({
      endpoint: `/api/workflows/${input.workflowId}/runs/${runId}/resume`,
      initialLog: `resume: ${runId}`,
      activeTab: "runs",
      runContext: {
        workflowVersionId: sourceRun.workflowVersionId,
        executorKind: sourceRun.executorKind,
        agent: sourceRun.agent ?? undefined,
        model: sourceRun.model ?? undefined,
        cwd: sourceRun.cwd ?? undefined,
        input: {
          resumeOfRunId: runId,
          agent: sourceRun.agent,
          model: sourceRun.model,
          cwd: sourceRun.cwd,
        },
      },
      retryRunId: runId,
      failureLogPrefix: "resume failed",
    });
  }

  function cancelCurrentRun() {
    const runId = getActiveRunId();
    if (!runId || isCancellingRun) {
      return;
    }
    setIsCancellingRun(true);
    appendEventLog("run: cancel requested");
    void requestRunCancel(runId).catch((error) => {
      const apiError = readApiJsonError(error, "WORKFLOW_RUN_FAILED");
      setIsCancellingRun(false);
      appendEventLog(`cancel failed: ${apiError.message}`);
    });
  }

  async function loadRun(runId: string) {
    setIsLoadingRunDetail(true);
    try {
      const data = await loadWorkflowRun({
        workflowId: input.workflowId,
        runId,
      });
      selectRunDetail(data);
    } catch (error) {
      const apiError = readApiJsonError(error, "RUN_NOT_FOUND");
      appendEventLog(
        `run detail failed: ${apiError.message}`,
      );
    } finally {
      setIsLoadingRunDetail(false);
    }
  }

  function selectRun(runId: string) {
    if (selectLiveRun(runId)) {
      setIsLoadingRunDetail(false);
      return;
    }
    void loadRun(runId);
  }

  async function copyRunText(key: string, text: string) {
    setCopiedRunField(key);
    window.setTimeout(() => {
      setCopiedRunField((current) => (current === key ? undefined : current));
    }, 1600);

    try {
      await writeClipboardText(text);
    } catch (error) {
      setCopiedRunField((current) => (current === key ? undefined : current));
      appendEventLog(
        `copy failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  async function openAgentSession(agentSessionId: string) {
    try {
      await openWorkflowAgentSession(agentSessionId);
      appendEventLog(`agent session opened: ${agentSessionId}`);
    } catch (error) {
      const apiError = readApiJsonError(error, "WORKFLOW_RUN_FAILED");
      appendEventLog(`agent session open failed: ${apiError.message}`);
    }
  }

  return {
    selectedRun,
    visibleRuns,
    nodeStatuses,
    nodeOutputs,
    latestOutput,
    eventLog,
    isRunning,
    isCancellingRun,
    isLoadingRunDetail,
    retryingRunId,
    copiedRunField,
    appendEventLog,
    resetVersionRunState,
    runCurrentWorkflow,
    submitRunInputDialog,
    retryRun,
    resumeRun,
    cancelCurrentRun,
    selectRun,
    copyRunText,
    openAgentSession,
  };
}
