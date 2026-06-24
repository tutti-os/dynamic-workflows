import { useRef, useState } from "react";
import {
  apiJson,
  readApiJsonError,
} from "@/components/workflow/workflowApiClient";
import type {
  WorkflowDetail,
  WorkflowVersionRecord,
} from "@/lib/db/workflows";
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
  delay,
  isAbortError,
  readEventStream,
  writeClipboardText,
} from "@/components/workflow/workflowClientUtils";

export function useWorkflowRunController(input: {
  workflowId: string;
  detail: WorkflowDetail | null;
  selectedVersion: WorkflowVersionRecord | null;
  parsed: ParsedWorkflow;
  script: string;
  isScriptDirty: boolean;
  effectiveProvider: string;
  model: string;
  cwd: string;
  workflowInputPayload: Record<string, string>;
  missingRunInputNames: string[];
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
  retryingRunId: string | undefined;
  copiedRunField: string | undefined;
  appendEventLog: (message: string) => void;
  resetVersionRunState: () => void;
  runCurrentWorkflow: () => Promise<void>;
  submitRunInputDialog: () => void;
  retryRun: (runId: string) => Promise<void>;
  cancelCurrentRun: () => void;
  selectRun: (runId: string) => void;
  copyRunText: (key: string, text: string) => Promise<void>;
  openAgentSession: (agentSessionId: string) => Promise<void>;
} {
  const [isRunning, setIsRunning] = useState(false);
  const [isCancellingRun, setIsCancellingRun] = useState(false);
  const [retryingRunId, setRetryingRunId] = useState<string | undefined>();
  const [copiedRunField, setCopiedRunField] = useState<string | undefined>();
  const runAbortControllerRef = useRef<AbortController | null>(null);
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
    markPendingNodesSkipped,
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

  async function executeRunStream(streamInput: {
    endpoint: string;
    body?: unknown;
    initialLog: string;
    activeTab: InspectorTab;
    runContext: PendingRunContext;
    resetScriptAfterRun?: string;
    retryRunId?: string;
  }) {
    const abortController = new AbortController();
    runAbortControllerRef.current = abortController;
    if (streamInput.retryRunId) {
      setRetryingRunId(streamInput.retryRunId);
    }
    setIsRunning(true);
    setIsCancellingRun(false);
    startRunEvents({
      initialLog: streamInput.initialLog,
      runContext: streamInput.runContext,
    });
    input.setActiveTab(streamInput.activeTab);

    try {
      const response = await fetch(streamInput.endpoint, {
        method: "POST",
        headers: streamInput.body
          ? { "Content-Type": "application/json" }
          : undefined,
        body: streamInput.body ? JSON.stringify(streamInput.body) : undefined,
        signal: abortController.signal,
      });

      if (!response.body) {
        throw new Error("Run stream did not start");
      }

      await readEventStream(response.body, handleRunEvent);
      const completedRunId = getActiveRunId();
      await input.loadWorkflow({
        resetScript: Boolean(
          streamInput.resetScriptAfterRun &&
            input.script === streamInput.resetScriptAfterRun,
        ),
      });
      if (completedRunId) {
        await loadRun(completedRunId);
        clearLiveRun();
      }
    } catch (error) {
      if (isAbortError(error)) {
        markPendingNodesSkipped();
        appendEventLog("run: canceled");
        await refreshWorkflowAfterAbort();
        const runId = getActiveRunId();
        if (runId) {
          await loadRun(runId);
          clearLiveRun();
        }
      } else {
        appendEventLog(
          `run failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    } finally {
      setIsRunning(false);
      setIsCancellingRun(false);
      setRetryingRunId(undefined);
      runAbortControllerRef.current = null;
      clearPendingRunContext();
    }
  }

  async function runCurrentWorkflow() {
    if (input.missingRunInputNames.length > 0) {
      input.openRunInputDialog();
      appendEventLog(
        `run blocked: missing input ${input.missingRunInputNames.join(", ")}`,
      );
      return;
    }

    const runScript = input.script;
    const runBody = {
      script: runScript,
      inputs: input.workflowInputPayload,
      provider: input.effectiveProvider,
      model: input.model || undefined,
      cwd: input.cwd || undefined,
    };
    await executeRunStream({
      endpoint: `/api/workflows/${input.workflowId}/run`,
      body: runBody,
      initialLog: "run: started",
      activeTab: "runs",
      runContext: {
        workflowVersionId:
          input.selectedVersion?.id ?? input.detail?.currentVersion?.id ?? "",
        executorKind:
          input.effectiveProvider === "mock" ? "mock" : "local-agent",
        provider: input.effectiveProvider,
        model: input.model || undefined,
        cwd: input.cwd || undefined,
        input: {
          inputs: input.workflowInputPayload,
          provider: input.effectiveProvider,
          model: input.model || undefined,
          cwd: input.cwd || undefined,
          autoSavedVersion: input.isScriptDirty,
        },
      },
      resetScriptAfterRun: runScript,
    });
  }

  function submitRunInputDialog() {
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

    await executeRunStream({
      endpoint: `/api/workflows/${input.workflowId}/runs/${runId}/retry`,
      initialLog: `retry: ${runId}`,
      activeTab: "runs",
      runContext: {
        workflowVersionId: sourceRun.workflowVersionId,
        executorKind: sourceRun.executorKind,
        provider: sourceRun.provider ?? undefined,
        model: sourceRun.model ?? undefined,
        cwd: sourceRun.cwd ?? undefined,
        input: {
          retryOfRunId: runId,
          provider: sourceRun.provider,
          model: sourceRun.model,
          cwd: sourceRun.cwd,
        },
      },
      retryRunId: runId,
    });
  }

  function cancelCurrentRun() {
    if (!runAbortControllerRef.current || isCancellingRun) {
      return;
    }
    setIsCancellingRun(true);
    appendEventLog("run: cancel requested");
    runAbortControllerRef.current.abort();
  }

  async function loadRun(runId: string) {
    try {
      const data = await apiJson<RunDetail>(
        `/api/workflows/${input.workflowId}/runs/${runId}`,
        undefined,
        "RUN_NOT_FOUND",
      );
      selectRunDetail(data);
    } catch (error) {
      const apiError = readApiJsonError(error, "RUN_NOT_FOUND");
      appendEventLog(
        `run detail failed: ${apiError.message}`,
      );
    }
  }

  function selectRun(runId: string) {
    if (selectLiveRun(runId)) {
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
      await apiJson<{ ok: boolean }>(
        "/api/agent-sessions/open",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentSessionId }),
        },
        "WORKFLOW_RUN_FAILED",
      );
      appendEventLog(`agent session opened: ${agentSessionId}`);
    } catch (error) {
      const apiError = readApiJsonError(error, "WORKFLOW_RUN_FAILED");
      appendEventLog(`agent session open failed: ${apiError.message}`);
    }
  }

  async function refreshWorkflowAfterAbort() {
    const runId = getActiveRunId();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await delay(220);
      const nextDetail = await input.loadWorkflow();
      const run = runId
        ? nextDetail.runs.find((item) => item.id === runId)
        : undefined;
      if (!run || run.status !== "running") {
        return;
      }
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
    retryingRunId,
    copiedRunField,
    appendEventLog,
    resetVersionRunState,
    runCurrentWorkflow,
    submitRunInputDialog,
    retryRun,
    cancelCurrentRun,
    selectRun,
    copyRunText,
    openAgentSession,
  };
}
