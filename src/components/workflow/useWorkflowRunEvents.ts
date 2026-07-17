import { useCallback, useMemo, useRef, useState } from "react";
import { getApiErrorMessage } from "@/lib/api/errors";
import type {
  WorkflowDetail,
  WorkflowRunRecord,
  WorkflowVersionRecord,
} from "@/lib/db/workflows/types";
import {
  applyRunEventToDetail,
  applyWorkflowRunEvent,
  createInitialRunSummary,
  createRunDetailFromStartedEvent,
  type RunDetail,
} from "@/lib/workflow/run-state";
import type {
  ParsedWorkflow,
  WorkflowLoopStepRun,
  WorkflowMapItemRun,
  WorkflowNodeStatus,
  WorkflowRunEvent,
} from "@/lib/workflow/types";
import { stringifyWorkflowValue } from "@/lib/workflow/templates";

export type PendingRunContext = {
  workflowVersionId: string;
  executorKind: string;
  agent?: string;
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
  loopStepRuns: WorkflowLoopStepRun[];
  mapItemRuns: WorkflowMapItemRun[];
  nodeOutputs: Record<string, string>;
  latestOutput: [string, string] | undefined;
  eventLog: string[];
  appendEventLog: (message: string) => void;
  resetVersionRunState: () => void;
  startRunEvents: (options: {
    initialLog: string;
    initialRun?: WorkflowRunRecord;
    initialDetail?: RunDetail;
    runId?: string;
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
  const [loopStepRunsByKey, setLoopStepRunsByKey] = useState<
    Record<string, WorkflowLoopStepRun>
  >({});
  const [mapItemRunsByKey, setMapItemRunsByKey] = useState<
    Record<string, WorkflowMapItemRun>
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
    setLoopStepRunsByKey({});
    setMapItemRunsByKey({});
    setNodeOutputs({});
  }, []);

  const visibleRuns = useMemo(() => {
    const persistedRuns = input.detail?.runs ?? [];
    const latestById = new Map(
      [selectedRun?.run, liveRun?.run]
        .filter((run): run is WorkflowRunRecord => Boolean(run))
        .map((run) => [run.id, run]),
    );
    const merged = persistedRuns.map((run) => latestById.get(run.id) ?? run);

    // A newly-started live run may not be present in the workflow-detail
    // snapshot yet. Keep it at the front until the next detail refresh lands.
    if (liveRun && !persistedRuns.some((run) => run.id === liveRun.run.id)) {
      merged.unshift(liveRun.run);
    }
    return merged;
  }, [input.detail?.runs, liveRun, selectedRun]);

  const latestOutput = useMemo(() => {
    const entries = Object.entries(nodeOutputs);
    return entries.at(-1);
  }, [nodeOutputs]);

  const startRunEvents = useCallback(
    (options: {
      initialLog: string;
      initialRun?: WorkflowRunRecord;
      initialDetail?: RunDetail;
      runId?: string;
      runContext: PendingRunContext;
    }) => {
      activeRunIdRef.current = options.runId ?? options.initialRun?.id;
      pendingRunContextRef.current = options.runContext;
      const initialLiveRun = options.initialRun
        ? options.initialDetail?.run.id === options.initialRun.id
          ? { ...options.initialDetail, run: options.initialRun }
          : {
              run: options.initialRun,
              log: "",
              logSizeBytes: 0,
              logReturnedBytes: 0,
              logTruncated: false,
            }
        : null;
      setLiveRun(initialLiveRun);
      setSelectedRun(initialLiveRun);
      setNodeOutputs({});
      setNodeStatuses(createInitialRunSummary(input.parsed).nodeStatuses);
      setLoopStepRunsByKey({});
      setMapItemRunsByKey({});
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
        `${event.nodeId}: started via ${event.agent}${event.model ? ` / ${event.model}` : ""}`,
      ]);
      return;
    }

    if (event.type === "loop_step_state") {
      setEventLog((events) => [
        ...events,
        `${event.loopStep.parentNodeId} · iteration ${event.loopStep.iteration} · ${event.label}: ${event.status}${event.promptMode ? ` via ${event.promptMode}` : ""}`,
      ]);
      return;
    }

    if (event.type === "map_item_state") {
      setEventLog((events) => [
        ...events,
        `${event.mapItem.parentNodeId} · item #${event.mapItem.index} · ${event.label}: ${event.status}`,
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

    if (event.type === "human_task_requested") {
      setEventLog((events) => [
        ...events,
        `${event.nodeId}: waiting for human input (${event.task.id})`,
      ]);
      return;
    }

    if (event.type === "human_task_resolved") {
      setEventLog((events) => [
        ...events,
        `${event.nodeId}: human action ${event.response.action}`,
      ]);
      return;
    }

    if (event.type === "run_waiting") {
      setEventLog((events) => [
        ...events,
        `run: waiting for ${event.pendingTaskIds.length} human task${event.pendingTaskIds.length === 1 ? "" : "s"}`,
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
      setLoopStepRunsByKey(initialSummary.loopStepRuns);
      setMapItemRunsByKey(initialSummary.mapItemRuns ?? {});
      setNodeOutputs(
        Object.fromEntries(
          Object.entries(initialSummary.outputs).map(([nodeId, value]) => [
            nodeId,
            stringifyWorkflowValue(value),
          ]),
        ),
      );
      return;
    }

    setNodeStatuses((statuses) =>
      applyWorkflowRunEvent(
        {
          status: "running",
          outputs: {},
          nodeStatuses: statuses,
          nodeSessions: {},
          loopStepRuns: {},
        },
        event,
      ).nodeStatuses,
    );
    setLoopStepRunsByKey((loopStepRuns) =>
      applyWorkflowRunEvent(
        {
          status: "running",
          outputs: {},
          nodeStatuses: {},
          nodeSessions: {},
          loopStepRuns,
        },
        event,
      ).loopStepRuns,
    );
    setMapItemRunsByKey((mapItemRuns) =>
      applyWorkflowRunEvent(
        {
          status: "running",
          outputs: {},
          nodeStatuses: {},
          nodeSessions: {},
          loopStepRuns: {},
          mapItemRuns,
        },
        event,
      ).mapItemRuns ?? {},
    );
    setNodeOutputs((outputs) => {
      const nextOutputs = applyWorkflowRunEvent(
        {
          status: "running",
          outputs,
          nodeStatuses: {},
          nodeSessions: {},
          loopStepRuns: {},
        },
        event,
      ).outputs;
      return Object.fromEntries(
        Object.entries(nextOutputs).map(([nodeId, value]) => [
          nodeId,
          stringifyWorkflowValue(value),
        ]),
      );
    });
  }

  function syncLiveRunEvent(event: WorkflowRunEvent) {
    if (event.type === "run_started") {
      activeRunIdRef.current = event.runId;
      const context = pendingRunContextRef.current;
      const createStartedDetail = () =>
        createRunDetailFromStartedEvent({
          event,
          workflowId: input.workflowId,
          workflowVersionId:
            context?.workflowVersionId ??
            input.selectedVersion?.id ??
            input.detail?.currentVersion?.id ??
            "",
          executorKind: context?.executorKind ?? "local-agent",
          agent: context?.agent,
          model: context?.model,
          cwd: context?.cwd,
          runInput: context?.input ?? {},
        });
      const applyStartedEvent = (current: RunDetail | null) =>
        current?.run.id === event.runId
          ? applyRunEventToDetail(current, event)
          : createStartedDetail();
      setLiveRun(applyStartedEvent);
      setSelectedRun(applyStartedEvent);
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
    loopStepRuns: Object.values(loopStepRunsByKey),
    mapItemRuns: Object.values(mapItemRunsByKey),
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
