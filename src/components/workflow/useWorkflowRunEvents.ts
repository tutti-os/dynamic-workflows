import { useCallback, useMemo, useRef, useState } from "react";
import { getApiErrorMessage } from "@/lib/api/errors";
import type {
  WorkflowDetail,
  WorkflowVersionRecord,
} from "@/lib/db/workflows";
import {
  applyRunEventToDetail,
  limitRunText,
  RUN_TEXT_PREVIEW_CHARS,
  serializeRunEvent,
  type RunDetail,
} from "@/lib/workflow/run-detail";
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
      setNodeStatuses(
        Object.fromEntries(input.parsed.nodes.map((node) => [node.id, "queued"])),
      );
      setEventLog([options.initialLog]);
    },
    [input.parsed.nodes],
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

    if (event.type === "run_started") {
      input.replaceParsed(event.parsed);
      setEventLog((events) => [...events, `run: ${event.runId}`]);
      return;
    }

    if (event.type === "node_started") {
      setNodeStatuses((statuses) => ({
        ...statuses,
        [event.nodeId]: "running",
      }));
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
      if (agentEvent.type === "text_delta" && agentEvent.text) {
        setNodeOutputs((outputs) => ({
          ...outputs,
          [event.nodeId]: `${outputs[event.nodeId] ?? ""}${agentEvent.text}`,
        }));
      }
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
      setNodeStatuses((statuses) => ({
        ...statuses,
        [event.nodeId]: "completed",
      }));
      setNodeOutputs((outputs) => ({
        ...outputs,
        [event.nodeId]: event.output,
      }));
      setEventLog((events) => [...events, `${event.nodeId}: completed`]);
      return;
    }

    if (event.type === "node_failed") {
      setNodeStatuses((statuses) => ({
        ...statuses,
        [event.nodeId]: "failed",
      }));
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

  function syncLiveRunEvent(event: WorkflowRunEvent) {
    if (event.type === "run_started") {
      activeRunIdRef.current = event.runId;
      const context = pendingRunContextRef.current;
      const initialLog = serializeRunEvent(event);
      const nextLiveRun: RunDetail = {
        run: {
          id: event.runId,
          workflowId: input.workflowId,
          workflowVersionId:
            context?.workflowVersionId ??
            input.selectedVersion?.id ??
            input.detail?.currentVersion.id ??
            "",
          executorKind: context?.executorKind ?? "local-agent",
          externalRunId: null,
          status: "running",
          provider: context?.provider ?? null,
          model: context?.model ?? null,
          cwd: context?.cwd ?? null,
          input: context?.input ?? {},
          result: {
            outputs: {},
            nodeStatuses: {},
          },
          logPath: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        },
        log: limitRunText(initialLog),
        logSizeBytes: 0,
        logReturnedBytes: 0,
        logTruncated: initialLog.length > RUN_TEXT_PREVIEW_CHARS,
      };
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
