import { useCallback, useMemo, useRef, useState } from "react";
import { getApiErrorMessage } from "@/lib/api/errors";
import type {
  WorkflowDetail,
  WorkflowVersionRecord,
} from "@/lib/db/workflows";
import {
  applyRunEventToDetail,
  applyWorkflowRunEvent,
  createInitialRunSummary,
  createRunDetailFromStartedEvent,
  type RunDetail,
} from "@/lib/workflow/run-state";
import type {
  ParsedWorkflow,
  WorkflowNodeStatus,
  WorkflowRunEvent,
} from "@/lib/workflow/types";

export type PendingRunContext = {
  workflowVersionId: string;
  executorKind: string;
  provider?: string;
  model?: string;
  cwd?: string;
  input: unknown;
};

type UseWorkflowRunEventsInput = {
  workflowId: string;
  detail: WorkflowDetail | null;
  selectedVersion: WorkflowVersionRecord | null;
  parsed: ParsedWorkflow;
  replaceParsed: (nextParsed: ParsedWorkflow) => void;
};

export function useWorkflowRunEvents(input: UseWorkflowRunEventsInput): {
  selectedRun: RunDetail | null;
  visibleRuns: WorkflowDetail["runs"];
  nodeStatuses: Record<string, WorkflowNodeStatus>;
  nodeOutputs: Record<string, string>;
  latestOutput: [string, string] | undefined;
  eventLog: string[];
  appendEventLog: (message: string) => void;
  resetVersionRunState: () => void;
  startRunEvents: (options: {
    initialLog: string;
    runContext: PendingRunContext;
  }) => void;
  handleRunEvent: (event: WorkflowRunEvent) => void;
  markPendingNodesSkipped: () => void;
  getActiveRunId: () => string | undefined;
  clearPendingRunContext: () => void;
  clearLiveRun: () => void;
  selectRunDetail: (run: RunDetail) => void;
  selectLiveRun: (runId: string) => boolean;
} {
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [liveRun, setLiveRun] = useState<RunDetail | null>(null);
  const [nodeStatuses, setNodeStatuses] = useState<
    Record<string, WorkflowNodeStatus>
  >({});
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, string>>({});
  const [eventLog, setEventLog] = useState<string[]>([]);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const pendingRunContextRef = useRef<PendingRunContext | undefined>(undefined);

  const appendEventLog = useCallback((message: string) => {
    setEventLog((events) => [...events, message]);
  }, []);

  const resetVersionRunState = useCallback(() => {
    setNodeStatuses({});
    setNodeOutputs({});
  }, []);

  const visibleRuns = useMemo(() => {
    const persistedRuns = input.detail?.runs ?? [];
    if (!liveRun) {
      return persistedRuns;
    }
    return [
      liveRun.run,
      ...persistedRuns.filter((run) => run.id !== liveRun.run.id),
    ];
  }, [input.detail?.runs, liveRun]);

  const latestOutput = useMemo(() => {
    const entries = Object.entries(nodeOutputs);
    return entries.at(-1);
  }, [nodeOutputs]);

  const startRunEvents = useCallback(
    (options: { initialLog: string; runContext: PendingRunContext }) => {
      activeRunIdRef.current = undefined;
      pendingRunContextRef.current = options.runContext;
      setLiveRun(null);
      setNodeOutputs({});
      setNodeStatuses(createInitialRunSummary(input.parsed).nodeStatuses);
      setEventLog([options.initialLog]);
    },
    [input.parsed],
  );

  const markPendingNodesSkipped = useCallback(() => {
    setNodeStatuses((statuses) =>
      Object.fromEntries(
        Object.entries(statuses).map(([nodeId, status]) => [
          nodeId,
          status === "running" || status === "queued" ? "skipped" : status,
        ]),
      ),
    );
  }, []);

  const getActiveRunId = useCallback(() => activeRunIdRef.current, []);

  const clearPendingRunContext = useCallback(() => {
    pendingRunContextRef.current = undefined;
  }, []);

  const clearLiveRun = useCallback(() => {
    setLiveRun(null);
  }, []);

  const selectRunDetail = useCallback((run: RunDetail) => {
    setSelectedRun(run);
  }, []);

  const selectLiveRun = useCallback(
    (runId: string) => {
      if (liveRun?.run.id !== runId) {
        return false;
      }
      setSelectedRun(liveRun);
      return true;
    },
    [liveRun],
  );

  function handleRunEvent(event: WorkflowRunEvent) {
    syncLiveRunEvent(event);
    syncLiveGraphState(event);

    if (event.type === "run_started") {
      input.replaceParsed(event.parsed);
      setEventLog((events) => [...events, `run: ${event.runId}`]);
      return;
    }

    if (event.type === "node_started") {
      setEventLog((events) => [
        ...events,
        `${event.nodeId}: started via ${event.provider}${event.model ? ` / ${event.model}` : ""}`,
      ]);
      return;
    }

    if (event.type === "node_event") {
      const agentEvent = event.event as {
        type?: string;
        text?: string;
        name?: string;
        message?: string;
      };
      if (agentEvent.type === "status" && agentEvent.message) {
        setEventLog((events) => [
          ...events,
          `${event.nodeId}: ${agentEvent.message}`,
        ]);
      }
      if (agentEvent.type === "tool_call") {
        setEventLog((events) => [
          ...events,
          `${event.nodeId}: tool ${agentEvent.name ?? "call"}`,
        ]);
      }
      return;
    }

    if (event.type === "node_completed") {
      setEventLog((events) => [...events, `${event.nodeId}: completed`]);
      return;
    }

    if (event.type === "node_failed") {
      setEventLog((events) => [
        ...events,
        `${event.nodeId}: failed: ${event.error}`,
      ]);
      return;
    }

    if (event.type === "run_completed") {
      setEventLog((events) => {
        if (event.status === "completed") {
          return [...events, "run: completed"];
        }
        const message = event.errorCode
          ? getApiErrorMessage(
              {
                error: {
                  code: event.errorCode,
                  message: event.error ?? "Workflow run failed",
                },
              },
              "WORKFLOW_RUN_FAILED",
            )
          : event.error;
        return [
          ...events,
          `run: ${event.status}${message ? `: ${message}` : ""}`,
        ];
      });
    }
  }

  function syncLiveGraphState(event: WorkflowRunEvent) {
    if (event.type === "run_started") {
      const initialSummary = createInitialRunSummary(event.parsed);
      setNodeStatuses(initialSummary.nodeStatuses);
      setNodeOutputs(initialSummary.outputs);
      return;
    }

    setNodeStatuses((statuses) =>
      applyWorkflowRunEvent(
        {
          status: "running",
          outputs: {},
          nodeStatuses: statuses,
          nodeSessions: {},
        },
        event,
      ).nodeStatuses,
    );
    setNodeOutputs((outputs) =>
      applyWorkflowRunEvent(
        {
          status: "running",
          outputs,
          nodeStatuses: {},
          nodeSessions: {},
        },
        event,
      ).outputs,
    );
  }

  function syncLiveRunEvent(event: WorkflowRunEvent) {
    if (event.type === "run_started") {
      activeRunIdRef.current = event.runId;
      const context = pendingRunContextRef.current;
      const nextLiveRun = createRunDetailFromStartedEvent({
        event,
        workflowId: input.workflowId,
        workflowVersionId:
          context?.workflowVersionId ??
          input.selectedVersion?.id ??
          input.detail?.currentVersion?.id ??
          "",
        executorKind: context?.executorKind ?? "local-agent",
        provider: context?.provider,
        model: context?.model,
        cwd: context?.cwd,
        runInput: context?.input ?? {},
      });
      setLiveRun(nextLiveRun);
      setSelectedRun(nextLiveRun);
      return;
    }

    setLiveRun((current) => {
      if (!current || current.run.id !== event.runId) {
        return current;
      }
      return applyRunEventToDetail(current, event);
    });
    setSelectedRun((current) => {
      if (!current || current.run.id !== event.runId) {
        return current;
      }
      return applyRunEventToDetail(current, event);
    });
  }

  return {
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
  };
}
