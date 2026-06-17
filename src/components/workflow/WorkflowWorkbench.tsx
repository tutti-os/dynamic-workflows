"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import clsx from "clsx";
import {
  AgentSessionsIcon,
  ArrowLeftIcon,
  Badge,
  Button,
  CheckIcon,
  CopyIcon,
  DashboardIcon,
  DirectoryIcon,
  DownloadIcon,
  FailedLinedIcon,
  FileCodeIcon,
  FileCreateIcon,
  FileTextIcon,
  Input,
  OverviewLayoutIcon,
  PanelIcon,
  PlatformIcon,
  PlayIcon,
  RefreshIcon,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Spinner,
  StatusDot,
  SuccessLinedIcon,
  TaskIcon,
  Textarea,
  UnderlineTabs,
  WarningLinedIcon,
} from "@tutti-os/ui-system";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getApiErrorMessage, readApiError } from "@/lib/api/errors";
import { DiagnosticsPanel } from "@/components/workflow/DiagnosticsPanel";
import { quoteTemplateLiteral } from "@/lib/workflow/templates";
import type { AgentProviderOption } from "@/lib/agents/types";
import type {
  WorkflowDetail,
  WorkflowRunRecord,
  WorkflowVersionRecord,
} from "@/lib/db/workflows";
import type {
  EditableRange,
  ParsedWorkflow,
  WorkflowNode,
  WorkflowNodeStatus,
  WorkflowRunEvent,
  WorkflowDiagnostic,
} from "@/lib/workflow/types";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <textarea
      className="editor-fallback"
      aria-label="Loading workflow editor"
      readOnly
      value="Loading editor..."
    />
  ),
});

type FlowNodeData = {
  workflowNode: WorkflowNode;
  status: WorkflowNodeStatus;
};

type WorkflowWorkbenchProps = {
  workflowId: string;
};

type RunDetail = {
  run: WorkflowRunRecord;
  log: string;
};

type PendingRunContext = {
  workflowVersionId: string;
  executorKind: string;
  provider?: string;
  model?: string;
  cwd?: string;
  input: unknown;
};

const DEFAULT_MODEL_VALUE = "__default__";
const FALLBACK_PROVIDERS: AgentProviderOption[] = [
  {
    id: "mock",
    label: "Mock local agent",
    supported: true,
    models: ["mock"],
  },
];

const EMPTY_PARSED: ParsedWorkflow = {
  meta: { name: "untitled_workflow", description: "Dynamic workflow" },
  nodes: [],
  edges: [],
  phases: [],
  diagnostics: [],
  variableToNodeId: {},
};

export function WorkflowWorkbench({ workflowId }: WorkflowWorkbenchProps) {
  const router = useRouter();
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [script, setScript] = useState("");
  const [savedScript, setSavedScript] = useState("");
  const [parsed, setParsed] = useState<ParsedWorkflow>(EMPTY_PARSED);
  const [selectedVersionId, setSelectedVersionId] = useState<string | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [liveRun, setLiveRun] = useState<RunDetail | null>(null);
  const [activeTab, setActiveTab] = useState<"edit" | "runs">("edit");
  const [labelDraft, setLabelDraft] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [metadataName, setMetadataName] = useState("");
  const [metadataDescription, setMetadataDescription] = useState("");
  const [providers, setProviders] =
    useState<AgentProviderOption[]>(FALLBACK_PROVIDERS);
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingMetadata, setIsSavingMetadata] = useState(false);
  const [isDuplicatingWorkflow, setIsDuplicatingWorkflow] = useState(false);
  const [isDeletingWorkflow, setIsDeletingWorkflow] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [nodeStatuses, setNodeStatuses] = useState<
    Record<string, WorkflowNodeStatus>
  >({});
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, string>>({});
  const [eventLog, setEventLog] = useState<string[]>([]);
  const [parseError, setParseError] = useState<string | undefined>();
  const [scriptSaveError, setScriptSaveError] = useState<string | undefined>();
  const [scriptSaveDiagnostics, setScriptSaveDiagnostics] = useState<
    WorkflowDiagnostic[]
  >([]);
  const [isCancellingRun, setIsCancellingRun] = useState(false);
  const [isRetryingRunId, setIsRetryingRunId] = useState<string | undefined>();
  const [copiedRunField, setCopiedRunField] = useState<string | undefined>();
  const runAbortControllerRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const pendingRunContextRef = useRef<PendingRunContext | undefined>(undefined);

  const loadWorkflow = useCallback(
    async (options?: { resetScript?: boolean }) => {
      const response = await fetch(`/api/workflows/${workflowId}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(getApiErrorMessage(data, "WORKFLOW_NOT_FOUND"));
      }
      const nextDetail = (await response.json()) as WorkflowDetail;
      setDetail(nextDetail);
      setMetadataName(nextDetail.workflow.name);
      setMetadataDescription(nextDetail.workflow.description);
      if (options?.resetScript) {
        setSelectedVersionId(nextDetail.currentVersion.id);
        setScript(nextDetail.currentVersion.script);
        setSavedScript(nextDetail.currentVersion.script);
      }
      return nextDetail;
    },
    [workflowId],
  );

  useEffect(() => {
    setIsLoading(true);
    loadWorkflow({ resetScript: true })
      .catch((error) => {
        setParseError(error instanceof Error ? error.message : "Load failed");
      })
      .finally(() => setIsLoading(false));
  }, [loadWorkflow]);

  useEffect(() => {
    fetch("/api/agents/providers")
      .then((response) => response.json())
      .then((data: { providers?: AgentProviderOption[] }) => {
        const nextProviders =
          data.providers && data.providers.length > 0
            ? data.providers
            : FALLBACK_PROVIDERS;
        setProviders(nextProviders);
        const preferredProvider =
          nextProviders.find((item) => item.supported && item.id === "codex") ??
          nextProviders.find((item) => item.supported && item.id !== "mock") ??
          nextProviders.find((item) => item.supported);
        if (preferredProvider) {
          setProvider(preferredProvider.id);
        }
      })
      .catch(() => {
        setProviders(FALLBACK_PROVIDERS);
      });
  }, []);

  const parseScript = useCallback(async (nextScript: string) => {
    try {
      const response = await fetch("/api/workflows/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: nextScript }),
      });
      const nextParsed = (await response.json()) as ParsedWorkflow;
      setParsed(nextParsed);
      setParseError(undefined);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "Parse failed");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void parseScript(script);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [parseScript, script]);

  const selectedNode = useMemo(
    () => parsed.nodes.find((node) => node.id === selectedNodeId),
    [parsed.nodes, selectedNodeId],
  );
  const selectedVersion = useMemo(() => {
    if (!detail) {
      return null;
    }
    return (
      detail.versions.find((version) => version.id === selectedVersionId) ??
      detail.currentVersion
    );
  }, [detail, selectedVersionId]);
  const versionLabelById = useMemo(() => {
    return Object.fromEntries(
      (detail?.versions ?? []).map((version) => [
        version.id,
        `v${version.version}`,
      ]),
    );
  }, [detail?.versions]);
  const visibleRuns = useMemo(() => {
    const persistedRuns = detail?.runs ?? [];
    if (!liveRun) {
      return persistedRuns;
    }
    return [
      liveRun.run,
      ...persistedRuns.filter((run) => run.id !== liveRun.run.id),
    ];
  }, [detail?.runs, liveRun]);
  const latestOutput = useMemo(() => {
    const entries = Object.entries(nodeOutputs);
    return entries.at(-1);
  }, [nodeOutputs]);

  useEffect(() => {
    setLabelDraft(selectedNode?.label ?? "");
    setPromptDraft(selectedNode?.prompt ?? selectedNode?.message ?? "");
  }, [selectedNode]);

  const flowNodes = useMemo<Node<FlowNodeData>[]>(() => {
    const phaseIndex = new Map(
      parsed.phases.map((phase, index) => [phase.title, index]),
    );
    const phaseCounters = new Map<string, number>();

    return parsed.nodes.map((workflowNode) => {
      const phase = workflowNode.phase ?? "Workflow";
      const x = (phaseIndex.get(phase) ?? 0) * 330 + 40;
      const yIndex = phaseCounters.get(phase) ?? 0;
      phaseCounters.set(phase, yIndex + 1);

      return {
        id: workflowNode.id,
        type: "workflowNode",
        position: { x, y: yIndex * 164 + 48 },
        data: {
          workflowNode,
          status: nodeStatuses[workflowNode.id] ?? "idle",
        },
        selected: workflowNode.id === selectedNodeId,
      };
    });
  }, [nodeStatuses, parsed.nodes, parsed.phases, selectedNodeId]);

  const flowEdges = useMemo<Edge[]>(() => {
    return parsed.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      animated: nodeStatuses[edge.target] === "running",
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "var(--text-tertiary)", strokeWidth: 1.6 },
    }));
  }, [nodeStatuses, parsed.edges]);

  const effectiveProvider = provider || FALLBACK_PROVIDERS[0].id;
  const selectedProvider =
    providers.find((item) => item.id === effectiveProvider) ?? providers[0];
  const modelOptions = selectedProvider?.models ?? [];
  const completedCount = Object.values(nodeStatuses).filter(
    (status) => status === "completed",
  ).length;
  const runningCount = Object.values(nodeStatuses).filter(
    (status) => status === "running",
  ).length;
  const failedCount = Object.values(nodeStatuses).filter(
    (status) => status === "failed",
  ).length;
  const diagnosticErrorCount = parsed.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
  const diagnosticWarningCount = parsed.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  ).length;
  const hasParseErrors = Boolean(parseError) || diagnosticErrorCount > 0;
  const isDirty = script !== savedScript;
  const metadataDirty =
    detail !== null &&
    (metadataName !== detail.workflow.name ||
      metadataDescription !== detail.workflow.description);
  const isViewingCurrentVersion =
    Boolean(detail && selectedVersion) &&
    selectedVersion?.id === detail?.currentVersion.id;
  const isViewingOldVersion = Boolean(detail && selectedVersion) && !isViewingCurrentVersion;

  function applyVersion(version: WorkflowVersionRecord) {
    setSelectedVersionId(version.id);
    setScript(version.script);
    setSavedScript(version.script);
    setSelectedNodeId(undefined);
    setNodeStatuses({});
    setNodeOutputs({});
  }

  function selectVersion(versionId: string) {
    if (!detail) {
      return;
    }
    const version = detail.versions.find((item) => item.id === versionId);
    if (!version || version.id === selectedVersion?.id) {
      return;
    }
    if (
      isDirty &&
      !window.confirm("Discard unsaved changes and switch versions?")
    ) {
      return;
    }
    applyVersion(version);
    setEventLog((events) => [...events, `viewing: v${version.version}`]);
  }

  async function saveCurrentVersion() {
    setIsSaving(true);
    setScriptSaveError(undefined);
    setScriptSaveDiagnostics([]);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      const data = (await response.json()) as { detail?: WorkflowDetail };
      if (!response.ok || !data.detail) {
        const apiError = readApiError(data, "WORKFLOW_SAVE_FAILED");
        setScriptSaveDiagnostics(apiError.diagnostics ?? []);
        throw new Error(apiError.message);
      }
      setDetail(data.detail);
      setSelectedVersionId(data.detail.currentVersion.id);
      setScript(data.detail.currentVersion.script);
      setSavedScript(data.detail.currentVersion.script);
      setEventLog((events) => [
        ...events,
        `saved: v${data.detail?.currentVersion.version ?? ""}`,
      ]);
      setScriptSaveError(undefined);
      setScriptSaveDiagnostics([]);
    } catch (error) {
      setScriptSaveError(error instanceof Error ? error.message : "Save failed");
      setEventLog((events) => [
        ...events,
        `save failed: ${error instanceof Error ? error.message : "unknown"}`,
      ]);
    } finally {
      setIsSaving(false);
    }
  }

  async function saveWorkflowMetadata() {
    if (!metadataName.trim()) {
      setEventLog((events) => [...events, "details failed: name is required"]);
      return;
    }

    setIsSavingMetadata(true);
    try {
      const response = await fetch(`/api/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: metadataName,
          description: metadataDescription,
        }),
      });
      const data = (await response.json()) as WorkflowDetail;
      if (!response.ok || !data.workflow) {
        throw new Error(getApiErrorMessage(data, "WORKFLOW_UPDATE_FAILED"));
      }
      setDetail(data);
      setMetadataName(data.workflow.name);
      setMetadataDescription(data.workflow.description);
      setEventLog((events) => [...events, "details: saved"]);
    } catch (error) {
      setEventLog((events) => [
        ...events,
        `details failed: ${error instanceof Error ? error.message : "unknown"}`,
      ]);
    } finally {
      setIsSavingMetadata(false);
    }
  }

  async function duplicateCurrentWorkflow() {
    setIsDuplicatingWorkflow(true);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          versionId: selectedVersion?.id,
        }),
      });
      const data = (await response.json()) as WorkflowDetail;
      if (!response.ok || !data.workflow) {
        throw new Error(getApiErrorMessage(data, "WORKFLOW_DUPLICATE_FAILED"));
      }
      router.push(`/workflows/${data.workflow.id}`);
    } catch (error) {
      setEventLog((events) => [
        ...events,
        `duplicate failed: ${error instanceof Error ? error.message : "unknown"}`,
      ]);
    } finally {
      setIsDuplicatingWorkflow(false);
    }
  }

  async function deleteCurrentWorkflow() {
    if (!detail) {
      return;
    }
    if (
      !window.confirm(
        `Delete workflow "${detail.workflow.name}" and all local runs?`,
      )
    ) {
      return;
    }

    setIsDeletingWorkflow(true);
    try {
      const response = await fetch(`/api/workflows/${workflowId}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(getApiErrorMessage(data, "WORKFLOW_DELETE_FAILED"));
      }
      router.push("/");
    } catch (error) {
      setEventLog((events) => [
        ...events,
        `delete failed: ${error instanceof Error ? error.message : "unknown"}`,
      ]);
      setIsDeletingWorkflow(false);
    }
  }

  async function restoreSelectedVersion() {
    if (!selectedVersion || isViewingCurrentVersion || isDirty) {
      return;
    }

    setIsSaving(true);
    setScriptSaveError(undefined);
    setScriptSaveDiagnostics([]);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: selectedVersion.script }),
      });
      const data = (await response.json()) as { detail?: WorkflowDetail };
      if (!response.ok || !data.detail) {
        const apiError = readApiError(data, "WORKFLOW_SAVE_FAILED");
        setScriptSaveDiagnostics(apiError.diagnostics ?? []);
        throw new Error(apiError.message);
      }
      setDetail(data.detail);
      setSelectedVersionId(data.detail.currentVersion.id);
      setScript(data.detail.currentVersion.script);
      setSavedScript(data.detail.currentVersion.script);
      setEventLog((events) => [
        ...events,
        `restored: v${selectedVersion.version} -> v${data.detail?.currentVersion.version ?? ""}`,
      ]);
      setScriptSaveError(undefined);
      setScriptSaveDiagnostics([]);
    } catch (error) {
      setScriptSaveError(error instanceof Error ? error.message : "Restore failed");
      setEventLog((events) => [
        ...events,
        `restore failed: ${error instanceof Error ? error.message : "unknown"}`,
      ]);
    } finally {
      setIsSaving(false);
    }
  }

  function exportSelectedVersion() {
    if (!detail || !selectedVersion) {
      return;
    }

    const filename = `${sanitizeFilename(detail.workflow.name)}-v${selectedVersion.version}.workflow.js`;
    downloadTextFile({
      filename,
      content: selectedVersion.script,
      mimeType: "text/javascript;charset=utf-8",
    });
    setEventLog((events) => [...events, `exported: ${filename}`]);
  }

  async function executeRunStream(input: {
    endpoint: string;
    body?: unknown;
    initialLog: string;
    activeTab: "edit" | "runs";
    runContext: PendingRunContext;
    resetScriptAfterRun?: string;
    retryRunId?: string;
  }) {
    const abortController = new AbortController();
    runAbortControllerRef.current = abortController;
    activeRunIdRef.current = undefined;
    pendingRunContextRef.current = input.runContext;
    if (input.retryRunId) {
      setIsRetryingRunId(input.retryRunId);
    }
    setIsRunning(true);
    setIsCancellingRun(false);
    setNodeOutputs({});
    setNodeStatuses(
      Object.fromEntries(parsed.nodes.map((node) => [node.id, "queued"])),
    );
    setEventLog([input.initialLog]);
    setActiveTab(input.activeTab);

    try {
      const response = await fetch(input.endpoint, {
        method: "POST",
        headers: input.body ? { "Content-Type": "application/json" } : undefined,
        body: input.body ? JSON.stringify(input.body) : undefined,
        signal: abortController.signal,
      });

      if (!response.body) {
        throw new Error("Run stream did not start");
      }

      await readEventStream(response.body, handleRunEvent);
      const completedRunId = activeRunIdRef.current;
      const nextDetail = await loadWorkflow();
      if (input.resetScriptAfterRun && script === input.resetScriptAfterRun) {
        setSelectedVersionId(nextDetail.currentVersion.id);
        setScript(nextDetail.currentVersion.script);
        setSavedScript(nextDetail.currentVersion.script);
      }
      if (completedRunId) {
        await loadRun(completedRunId);
        setLiveRun(null);
      }
    } catch (error) {
      if (isAbortError(error)) {
        markPendingNodesSkipped();
        setEventLog((events) => [...events, "run: canceled"]);
        await refreshWorkflowAfterAbort();
        const runId = activeRunIdRef.current;
        if (runId) {
          await loadRun(runId);
          setLiveRun(null);
        }
      } else {
        setEventLog((events) => [
          ...events,
          `run failed: ${error instanceof Error ? error.message : "unknown"}`,
        ]);
      }
    } finally {
      setIsRunning(false);
      setIsCancellingRun(false);
      setIsRetryingRunId(undefined);
      runAbortControllerRef.current = null;
      pendingRunContextRef.current = undefined;
    }
  }

  async function runCurrentWorkflow() {
    const runScript = script;
    const runBody = {
      script: runScript,
      provider: effectiveProvider,
      model: model || undefined,
      cwd: cwd || undefined,
    };
    await executeRunStream({
      endpoint: `/api/workflows/${workflowId}/run`,
      body: runBody,
      initialLog: "run: started",
      activeTab: "runs",
      runContext: {
        workflowVersionId: selectedVersion?.id ?? detail?.currentVersion.id ?? "",
        executorKind: effectiveProvider === "mock" ? "mock" : "local-agent",
        provider: effectiveProvider,
        model: model || undefined,
        cwd: cwd || undefined,
        input: {
          provider: effectiveProvider,
          model: model || undefined,
          cwd: cwd || undefined,
          autoSavedVersion: isDirty,
        },
      },
      resetScriptAfterRun: runScript,
    });
  }

  async function retryRun(runId: string) {
    if (!detail || isRunning) {
      return;
    }

    const sourceRun = detail.runs.find((run) => run.id === runId);
    if (!sourceRun) {
      setEventLog((events) => [...events, `retry failed: run ${runId} not found`]);
      return;
    }
    const sourceVersion = detail.versions.find(
      (version) => version.id === sourceRun.workflowVersionId,
    );

    if (sourceVersion && sourceVersion.id !== selectedVersion?.id) {
      if (
        isDirty &&
        !window.confirm("Discard unsaved changes and switch to this run version?")
      ) {
        return;
      }
      applyVersion(sourceVersion);
    }

    await executeRunStream({
      endpoint: `/api/workflows/${workflowId}/runs/${runId}/retry`,
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
    setEventLog((events) => [...events, "run: cancel requested"]);
    runAbortControllerRef.current.abort();
  }

  async function loadRun(runId: string) {
    const response = await fetch(`/api/workflows/${workflowId}/runs/${runId}`);
    const data = (await response.json()) as RunDetail;
    if (!response.ok) {
      setEventLog((events) => [
        ...events,
        `run detail failed: ${getApiErrorMessage(data, "RUN_NOT_FOUND")}`,
      ]);
      return;
    }
    setSelectedRun({ run: data.run, log: data.log });
  }

  function selectRun(runId: string) {
    if (liveRun?.run.id === runId) {
      setSelectedRun(liveRun);
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
      setEventLog((events) => [
        ...events,
        `copy failed: ${error instanceof Error ? error.message : "unknown"}`,
      ]);
    }
  }

  function handleRunEvent(event: WorkflowRunEvent) {
    syncLiveRunEvent(event);

    if (event.type === "run_started") {
      setParsed(event.parsed);
      activeRunIdRef.current = event.runId;
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
        return [...events, `run: ${event.status}${message ? `: ${message}` : ""}`];
      });
    }
  }

  function syncLiveRunEvent(event: WorkflowRunEvent) {
    if (event.type === "run_started") {
      const context = pendingRunContextRef.current;
      const nextLiveRun: RunDetail = {
        run: {
          id: event.runId,
          workflowId,
          workflowVersionId:
            context?.workflowVersionId ??
            selectedVersion?.id ??
            detail?.currentVersion.id ??
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
        log: serializeRunEvent(event),
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

  function markPendingNodesSkipped() {
    setNodeStatuses((statuses) =>
      Object.fromEntries(
        Object.entries(statuses).map(([nodeId, status]) => [
          nodeId,
          status === "running" || status === "queued" ? "skipped" : status,
        ]),
      ),
    );
  }

  async function refreshWorkflowAfterAbort() {
    const runId = activeRunIdRef.current;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await delay(220);
      const nextDetail = await loadWorkflow();
      const run = runId
        ? nextDetail.runs.find((item) => item.id === runId)
        : undefined;
      if (!run || run.status !== "running") {
        return;
      }
    }
  }

  function applyPromptPatch() {
    if (!selectedNode?.promptRange) {
      return;
    }
    setScript(
      replaceRange(script, selectedNode.promptRange, quoteTemplateLiteral(promptDraft)),
    );
  }

  function applyLabelPatch() {
    if (!selectedNode?.labelRange) {
      return;
    }
    setScript(replaceRange(script, selectedNode.labelRange, JSON.stringify(labelDraft)));
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
      <header className="detail-topbar">
        <div className="detail-titlebar">
          <Button asChild variant="outline" size="icon-lg" aria-label="Home">
            <Link href="/">
              <DashboardIcon />
            </Link>
          </Button>
          <Button asChild variant="outline" size="icon-lg" aria-label="Back to workflows">
            <Link href="/">
              <ArrowLeftIcon />
            </Link>
          </Button>
          <div className="detail-heading">
            <h1>{detail.workflow.name}</h1>
            <div className="detail-meta">
              <VersionSelect
                versions={detail.versions}
                currentVersionId={detail.currentVersion.id}
                selectedVersionId={selectedVersion?.id ?? detail.currentVersion.id}
                onValueChange={selectVersion}
              />
              {isViewingOldVersion ? (
                <Badge variant="warning">viewing old version</Badge>
              ) : null}
              {isDirty ? <Badge variant="warning">unsaved</Badge> : null}
              <span className="detail-description">{detail.workflow.description}</span>
            </div>
          </div>
        </div>

        <div className="detail-controls">
          <ControlField label="Provider">
            <ProviderSelect
              providers={providers}
              value={effectiveProvider}
              onValueChange={(value) => {
                setProvider(value);
                setModel("");
              }}
            />
          </ControlField>
          <ControlField label="Model">
            {modelOptions.length > 0 ? (
              <ModelSelect
                models={modelOptions}
                value={model}
                onValueChange={setModel}
              />
            ) : (
              <Input
                value={model}
                placeholder="Default model"
                aria-label="Agent model"
                onChange={(event) => setModel(event.target.value)}
              />
            )}
          </ControlField>
          <ControlField label="CWD">
            <Input
              value={cwd}
              placeholder="cwd: server workspace"
              aria-label="Agent working directory"
              onChange={(event) => setCwd(event.target.value)}
            />
          </ControlField>
          <Button
            variant="outline"
            size="icon-lg"
            title="Parse script"
            aria-label="Parse script"
            onClick={() => void parseScript(script)}
          >
            <RefreshIcon />
          </Button>
          <Button
            variant="outline"
            onClick={() => void saveCurrentVersion()}
            disabled={isSaving || !isDirty || hasParseErrors}
          >
            {isSaving ? <Spinner size={14} /> : <FileCreateIcon data-icon="inline-start" />}
            Save
          </Button>
          {isViewingOldVersion ? (
            <Button
              variant="outline"
              onClick={() => void restoreSelectedVersion()}
              disabled={isSaving || isDirty || hasParseErrors}
              title={
                isDirty
                  ? "Save or discard local edits before restoring this version"
                  : "Restore this version as a new current version"
              }
            >
              {isSaving ? <Spinner size={14} /> : <RefreshIcon data-icon="inline-start" />}
              Restore as new version
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => void duplicateCurrentWorkflow()}
            disabled={isDuplicatingWorkflow || isDeletingWorkflow}
          >
            {isDuplicatingWorkflow ? (
              <Spinner size={14} />
            ) : (
              <FileCreateIcon data-icon="inline-start" />
            )}
            Duplicate
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={exportSelectedVersion}
            disabled={!selectedVersion}
          >
            <DownloadIcon data-icon="inline-start" />
            Export
          </Button>
          <Button
            className="delete-workflow-button"
            variant="outline"
            onClick={() => void deleteCurrentWorkflow()}
            disabled={isDeletingWorkflow || isRunning}
          >
            {isDeletingWorkflow ? (
              <Spinner size={14} />
            ) : (
              <FailedLinedIcon data-icon="inline-start" />
            )}
            Delete
          </Button>
          {isRunning ? (
            <Button
              className="cancel-run-button"
              variant="outline"
              onClick={cancelCurrentRun}
              disabled={isCancellingRun}
            >
              {isCancellingRun ? (
                <Spinner size={14} />
              ) : (
                <FailedLinedIcon data-icon="inline-start" />
              )}
              Cancel
            </Button>
          ) : (
            <Button
              className="run-button"
              onClick={() => void runCurrentWorkflow()}
              disabled={parsed.nodes.length === 0 || hasParseErrors}
            >
              <PlayIcon data-icon="inline-start" />
              Run
            </Button>
          )}
        </div>
      </header>

      <section className="workspace">
        <section className="pane script-pane">
          <div className="pane-header">
            <div className="pane-title">
              <h2>Workflow Script</h2>
              <p>Each save creates a new version.</p>
            </div>
            <FileCodeIcon size={18} />
          </div>
          <div className="editor-wrap">
            <MonacoEditor
              height="100%"
              language="typescript"
              value={script}
              theme="vs"
              beforeMount={(monaco) => {
                monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
                  noSemanticValidation: true,
                });
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbersMinChars: 3,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                padding: { top: 12, bottom: 12 },
                tabSize: 2,
              }}
              onChange={(value) => {
                setScript(value ?? "");
                setScriptSaveError(undefined);
                setScriptSaveDiagnostics([]);
              }}
            />
          </div>
          <div className="editor-statusbar">
            <span>TypeScript</span>
            <span>Spaces: 2</span>
            <span
              className={clsx(
                hasParseErrors
                  ? "status-error"
                  : diagnosticWarningCount > 0
                    ? "status-warning"
                    : "status-ok",
              )}
            >
              <StatusDot
                tone={
                  hasParseErrors
                    ? "red"
                    : diagnosticWarningCount > 0
                      ? "amber"
                      : "green"
                }
              />
              {hasParseErrors
                ? `${diagnosticErrorCount || 1} error`
                : diagnosticWarningCount > 0
                  ? `${diagnosticWarningCount} warning`
                  : "No errors"}
            </span>
          </div>
        </section>

        <section className="pane graph-pane">
          <div className="pane-header">
            <div className="pane-title">
              <h2>DAG Preview</h2>
              <p>
                {parsed.nodes.length} nodes, {parsed.edges.length} edges across{" "}
                {parsed.phases.length} phases
              </p>
            </div>
            <OverviewLayoutIcon size={18} />
          </div>
          <div className="graph-wrap">
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              fitView
              minZoom={0.35}
              maxZoom={1.4}
              onNodeClick={(_event, node) => {
                setActiveTab("edit");
                setSelectedNodeId(node.id);
              }}
            >
              <Background color="var(--border-1)" gap={24} />
              <Controls />
            </ReactFlow>
          </div>
        </section>

        <section className="pane inspector-pane">
          <div className="pane-header">
            <div className="pane-title">
              <h2>Run & Edit</h2>
              <p>Patch editable node fields or inspect run output.</p>
            </div>
            <PanelIcon size={18} />
          </div>
          <ScrollArea className="inspector">
            <UnderlineTabs
              ariaLabel="Workflow inspector"
              value={activeTab}
              onValueChange={setActiveTab}
              tabs={[
                { value: "edit", label: "Edit" },
                { value: "runs", label: "Runs", count: visibleRuns.length || undefined },
              ]}
              className="inspector-tabs"
            />

            <div className="status-strip">
              <Metric label="Nodes" value={parsed.nodes.length} />
              <Metric label="Running" value={runningCount} tone="blue" />
              <Metric label="Done" value={completedCount} tone="green" />
              <Metric label="Failed" value={failedCount} tone="red" />
            </div>

            <DiagnosticsPanel
              title="Script diagnostics"
              message={parseError}
              diagnostics={parsed.diagnostics}
            />
            <DiagnosticsPanel
              title="Save diagnostics"
              message={scriptSaveError}
              diagnostics={scriptSaveDiagnostics}
            />

            {activeTab === "edit" ? (
              <EditPanel
                metadataName={metadataName}
                metadataDescription={metadataDescription}
                metadataDirty={metadataDirty}
                isSavingMetadata={isSavingMetadata}
                selectedNode={selectedNode}
                labelDraft={labelDraft}
                promptDraft={promptDraft}
                nodeOutputs={nodeOutputs}
                latestOutput={latestOutput}
                eventLog={eventLog}
                onMetadataNameChange={setMetadataName}
                onMetadataDescriptionChange={setMetadataDescription}
                onSaveMetadata={() => void saveWorkflowMetadata()}
                onLabelChange={setLabelDraft}
                onPromptChange={setPromptDraft}
                onApplyLabel={applyLabelPatch}
                onApplyPrompt={applyPromptPatch}
              />
            ) : (
              <RunsPanel
                runs={visibleRuns}
                selectedRun={selectedRun}
                versionLabelById={versionLabelById}
                isRunning={isRunning}
                retryingRunId={isRetryingRunId}
                copiedRunField={copiedRunField}
                onSelectRun={selectRun}
                onRetryRun={(runId) => void retryRun(runId)}
                onCopyRunText={(key, text) => void copyRunText(key, text)}
              />
            )}
          </ScrollArea>
        </section>
      </section>
    </main>
  );
}

function EditPanel(props: {
  metadataName: string;
  metadataDescription: string;
  metadataDirty: boolean;
  isSavingMetadata: boolean;
  selectedNode?: WorkflowNode;
  labelDraft: string;
  promptDraft: string;
  nodeOutputs: Record<string, string>;
  latestOutput?: [string, string];
  eventLog: string[];
  onMetadataNameChange: (value: string) => void;
  onMetadataDescriptionChange: (value: string) => void;
  onSaveMetadata: () => void;
  onLabelChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onApplyLabel: () => void;
  onApplyPrompt: () => void;
}) {
  const selectedNode = props.selectedNode;
  return (
    <div className="edit-panel">
      <div className="metadata-panel">
        <div className="field">
          <label htmlFor="workflow-name">Workflow name</label>
          <Input
            id="workflow-name"
            value={props.metadataName}
            maxLength={120}
            onChange={(event) => props.onMetadataNameChange(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="workflow-description">Description</label>
          <Textarea
            id="workflow-description"
            rows={3}
            value={props.metadataDescription}
            maxLength={500}
            onChange={(event) =>
              props.onMetadataDescriptionChange(event.target.value)
            }
          />
        </div>
        <Button
          variant="outline"
          onClick={props.onSaveMetadata}
          disabled={
            props.isSavingMetadata ||
            !props.metadataDirty ||
            !props.metadataName.trim()
          }
        >
          {props.isSavingMetadata ? (
            <Spinner size={14} />
          ) : (
            <FileTextIcon data-icon="inline-start" />
          )}
          Save details
        </Button>
      </div>

      {selectedNode ? (
        <>
          <div className="field">
            <label htmlFor="node-label">Label</label>
            <Input
              id="node-label"
              value={props.labelDraft}
              onChange={(event) => props.onLabelChange(event.target.value)}
            />
            <Button
              variant="outline"
              onClick={props.onApplyLabel}
              disabled={!selectedNode.labelRange}
            >
              <FileTextIcon data-icon="inline-start" />
              Apply label
            </Button>
          </div>

          <div className="field">
            <label htmlFor="node-prompt">Prompt</label>
            <Textarea
              id="node-prompt"
              rows={8}
              value={props.promptDraft}
              onChange={(event) => props.onPromptChange(event.target.value)}
            />
            <Button
              variant="outline"
              onClick={props.onApplyPrompt}
              disabled={!selectedNode.promptRange}
            >
              <FileCodeIcon data-icon="inline-start" />
              Apply prompt
            </Button>
          </div>

          <div className="field">
            <label>Inputs</label>
            <div className="node-refs">
              {selectedNode.inputs.length > 0 ? (
                selectedNode.inputs.map((input) => (
                  <Badge variant="default" key={input.name}>
                    {input.name} ← {input.sourceVariable}
                  </Badge>
                ))
              ) : (
                <Badge variant="muted">none</Badge>
              )}
            </div>
          </div>

          {props.nodeOutputs[selectedNode.id] ? (
            <div className="field">
              <label>Output</label>
              <pre className="output-box">{props.nodeOutputs[selectedNode.id]}</pre>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="empty-state">
            <TaskIcon size={22} />
            <p>Select a node to edit label, prompt, and inspect output.</p>
          </div>
          {props.latestOutput ? (
            <div className="field">
              <label>Latest Output: {props.latestOutput[0]}</label>
              <pre className="output-box">{props.latestOutput[1]}</pre>
            </div>
          ) : null}
        </>
      )}

      <div className="field">
        <label>Event Log</label>
        <pre className="event-log">
          {props.eventLog.length > 0
            ? props.eventLog.join("\n")
            : "No run events yet."}
        </pre>
      </div>
    </div>
  );
}

function RunsPanel(props: {
  runs: WorkflowRunRecord[];
  selectedRun: RunDetail | null;
  versionLabelById: Record<string, string>;
  isRunning: boolean;
  retryingRunId?: string;
  copiedRunField?: string;
  onSelectRun: (runId: string) => void;
  onRetryRun: (runId: string) => void;
  onCopyRunText: (key: string, text: string) => void;
}) {
  const selectedRunError = getRunError(props.selectedRun?.run.result);

  return (
    <div className="runs-panel">
      <div className="run-list">
        {props.runs.length > 0 ? (
          props.runs.map((run) => {
            const versionLabel = getRunVersionLabel(run, props.versionLabelById);
            const retrying = props.retryingRunId === run.id;
            return (
              <div
                className={clsx(
                  "run-row",
                  props.selectedRun?.run.id === run.id && "active",
                )}
                key={run.id}
              >
                <button
                  className="run-row-main"
                  type="button"
                  onClick={() => props.onSelectRun(run.id)}
                >
                  <StatusDot
                    tone={runStatusTone(run.status)}
                    pulse={run.status === "running"}
                  />
                  <div>
                    <strong>{run.id}</strong>
                    <span>
                      {run.provider ?? run.executorKind}
                      {run.model ? ` · ${run.model}` : ""} · {versionLabel}
                    </span>
                  </div>
                  <Badge variant={runStatusBadge(run.status)}>{run.status}</Badge>
                  <time>{formatDate(run.startedAt)}</time>
                </button>
                {canRetryRun(run.status) ? (
                  <Button
                    className="run-row-action"
                    size="sm"
                    variant="outline"
                    type="button"
                    disabled={props.isRunning}
                    onClick={() => props.onRetryRun(run.id)}
                  >
                    {retrying ? (
                      <Spinner size={14} />
                    ) : (
                      <RefreshIcon data-icon="inline-start" />
                    )}
                    Retry
                  </Button>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="empty-state">
            <DirectoryIcon size={22} />
            <p>No runs yet.</p>
          </div>
        )}
      </div>

      {props.selectedRun ? (
        <>
          <div className="run-detail-header">
            <div className="run-detail-meta">
              <Badge variant={runStatusBadge(props.selectedRun.run.status)}>
                {props.selectedRun.run.status}
              </Badge>
              <Badge variant="default">
                {getRunVersionLabel(props.selectedRun.run, props.versionLabelById)}
              </Badge>
              <span>
                {props.selectedRun.run.provider ??
                  props.selectedRun.run.executorKind}
                {props.selectedRun.run.model
                  ? ` · ${props.selectedRun.run.model}`
                  : ""}
              </span>
            </div>
            <div className="run-detail-actions">
              <CopyTextButton
                copied={props.copiedRunField === `id:${props.selectedRun.run.id}`}
                label="Copy ID"
                onClick={() =>
                  props.onCopyRunText(
                    `id:${props.selectedRun?.run.id}`,
                    props.selectedRun?.run.id ?? "",
                  )
                }
              />
              {canRetryRun(props.selectedRun.run.status) ? (
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={props.isRunning}
                  onClick={() => props.onRetryRun(props.selectedRun?.run.id ?? "")}
                >
                  {props.retryingRunId === props.selectedRun.run.id ? (
                    <Spinner size={14} />
                  ) : (
                    <RefreshIcon data-icon="inline-start" />
                  )}
                  Retry
                </Button>
              ) : null}
            </div>
          </div>

          <div className="run-facts">
            <RunFact label="Run ID" value={props.selectedRun.run.id} />
            <RunFact
              label="Started"
              value={formatDate(props.selectedRun.run.startedAt)}
            />
            <RunFact
              label="Finished"
              value={
                props.selectedRun.run.finishedAt
                  ? formatDate(props.selectedRun.run.finishedAt)
                  : "Running"
              }
            />
            <RunFact
              label="CWD"
              value={props.selectedRun.run.cwd ?? "server workspace"}
            />
            <RunFact
              label="Log path"
              value={props.selectedRun.run.logPath ?? "No log path"}
            />
          </div>

          {selectedRunError ? (
            <div className="diagnostic error">
              <WarningLinedIcon size={14} />
              {selectedRunError}
            </div>
          ) : null}

          <RunTextBlock
            label="Input"
            text={formatJson(props.selectedRun.run.input)}
            copyKey={`input:${props.selectedRun.run.id}`}
            copiedRunField={props.copiedRunField}
            onCopy={props.onCopyRunText}
          />
          <RunTextBlock
            label="Result"
            text={formatJson(props.selectedRun.run.result)}
            copyKey={`result:${props.selectedRun.run.id}`}
            copiedRunField={props.copiedRunField}
            onCopy={props.onCopyRunText}
          />
          <RunTextBlock
            label="Debug Log"
            text={props.selectedRun.log || "No log file content."}
            copyKey={`log:${props.selectedRun.run.id}`}
            copiedRunField={props.copiedRunField}
            onCopy={props.onCopyRunText}
          />
        </>
      ) : null}
    </div>
  );
}

function RunTextBlock(props: {
  label: string;
  text: string;
  copyKey: string;
  copiedRunField?: string;
  onCopy: (key: string, text: string) => void;
}) {
  return (
    <div className="field">
      <div className="field-heading">
        <label>{props.label}</label>
        <CopyTextButton
          copied={props.copiedRunField === props.copyKey}
          label="Copy"
          onClick={() => props.onCopy(props.copyKey, props.text)}
        />
      </div>
      <pre className={props.label === "Debug Log" ? "event-log" : "output-box"}>
        {props.text}
      </pre>
    </div>
  );
}

function RunFact(props: { label: string; value: string }) {
  return (
    <div className="run-fact">
      <span>{props.label}</span>
      <strong title={props.value}>{props.value}</strong>
    </div>
  );
}

function CopyTextButton(props: {
  copied: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      className="copy-text-button"
      size="sm"
      variant="outline"
      type="button"
      onClick={props.onClick}
    >
      {props.copied ? (
        <CheckIcon data-icon="inline-start" />
      ) : (
        <CopyIcon data-icon="inline-start" />
      )}
      {props.copied ? "Copied" : props.label}
    </Button>
  );
}

function VersionSelect(props: {
  versions: WorkflowVersionRecord[];
  currentVersionId: string;
  selectedVersionId: string;
  onValueChange: (versionId: string) => void;
}) {
  const selected = props.versions.find(
    (version) => version.id === props.selectedVersionId,
  );
  const selectedLabel = selected ? `v${selected.version}` : "Version";

  return (
    <Select value={props.selectedVersionId} onValueChange={props.onValueChange}>
      <SelectTrigger className="version-select-trigger">
        <Badge
          variant={
            props.selectedVersionId === props.currentVersionId
              ? "success"
              : "warning"
          }
        >
          {selectedLabel}
        </Badge>
      </SelectTrigger>
      <SelectContent align="start">
        {props.versions.map((version) => (
          <SelectItem key={version.id} value={version.id}>
            v{version.version}
            {version.id === props.currentVersionId ? " · current" : ""}
            {" · "}
            {formatDate(version.createdAt)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Metric(props: {
  label: string;
  value: number;
  tone?: "blue" | "green" | "red" | "neutral";
}) {
  return (
    <div className="metric">
      <div>
        <strong>{props.value}</strong>
        <span>{props.label}</span>
      </div>
      <StatusDot tone={props.tone ?? "neutral"} />
    </div>
  );
}

function WorkflowNodeCard(props: NodeProps<Node<FlowNodeData>>) {
  const { workflowNode, status } = props.data;
  const refs = workflowNode.inputs.map((input) => input.name);

  return (
    <div className={clsx("workflow-node", status)}>
      <Handle type="target" position={Position.Left} />
      <div className="workflow-node-inner">
        <div className="node-topline">
          <span className="node-kind">
            <AgentSessionsIcon size={13} />
            {workflowNode.kind}
          </span>
          <span className={clsx("node-status", status)}>
            {status === "running" ? (
              <Spinner size={14} />
            ) : status === "completed" ? (
              <SuccessLinedIcon size={14} />
            ) : status === "failed" ? (
              <FailedLinedIcon size={14} />
            ) : (
              <StatusDot tone={nodeStatusTone(status)} size="md" />
            )}
          </span>
        </div>
        <div className="node-label">{workflowNode.label}</div>
        <div className="node-meta">{workflowNode.phase ?? "Workflow"}</div>
        {refs.length > 0 ? (
          <div className="node-refs">
            {refs.map((ref) => (
              <Badge variant="muted" key={ref}>
                {ref}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ControlField(props: { label: string; children: ReactNode }) {
  return (
    <label className="detail-control-field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function ProviderSelect(props: {
  providers: AgentProviderOption[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const options = props.providers.length > 0 ? props.providers : FALLBACK_PROVIDERS;
  const selectedValue = props.value || options[0]?.id || FALLBACK_PROVIDERS[0].id;
  const selected = options.find((item) => item.id === selectedValue);

  return (
    <Select
      value={selectedValue}
      onValueChange={(value) => {
        if (value) {
          props.onValueChange(value);
        }
      }}
    >
      <SelectTrigger className="control-select">
        <PlatformIcon size={16} />
        <span className="select-display">{selected?.label ?? "Provider"}</span>
      </SelectTrigger>
      <SelectContent align="start">
        {options.map((item) => (
          <SelectItem key={item.id} value={item.id} disabled={!item.supported}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModelSelect(props: {
  models: string[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value || DEFAULT_MODEL_VALUE}
      onValueChange={(value) =>
        props.onValueChange(value === DEFAULT_MODEL_VALUE ? "" : value)
      }
    >
      <SelectTrigger className="control-select">
        <span className="select-display">
          {props.value || "Default model"}
        </span>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value={DEFAULT_MODEL_VALUE}>Default model</SelectItem>
        {props.models.map((item) => (
          <SelectItem key={item} value={item}>
            {item}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const NODE_TYPES = { workflowNode: WorkflowNodeCard };

function replaceRange(script: string, range: EditableRange, value: string): string {
  return `${script.slice(0, range.start)}${value}${script.slice(range.end)}`;
}

function getRunVersionLabel(
  run: WorkflowRunRecord,
  versionLabelById: Record<string, string>,
): string {
  return versionLabelById[run.workflowVersionId] ?? run.workflowVersionId.slice(0, 8);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function nodeStatusTone(status: WorkflowNodeStatus) {
  if (status === "completed") {
    return "green" as const;
  }
  if (status === "running") {
    return "blue" as const;
  }
  if (status === "failed") {
    return "red" as const;
  }
  if (status === "queued") {
    return "amber" as const;
  }
  if (status === "skipped") {
    return "amber" as const;
  }
  return "neutral" as const;
}

function runStatusTone(status: WorkflowRunRecord["status"]) {
  if (status === "completed") {
    return "green" as const;
  }
  if (status === "running") {
    return "blue" as const;
  }
  if (status === "failed") {
    return "red" as const;
  }
  if (status === "canceled") {
    return "amber" as const;
  }
  return "neutral" as const;
}

function runStatusBadge(status: WorkflowRunRecord["status"]) {
  if (status === "completed") {
    return "success" as const;
  }
  if (status === "running") {
    return "pending" as const;
  }
  if (status === "failed") {
    return "destructive" as const;
  }
  if (status === "canceled") {
    return "warning" as const;
  }
  return "default" as const;
}

function canRetryRun(status: WorkflowRunRecord["status"]): boolean {
  return status === "completed" || status === "failed";
}

function applyRunEventToDetail(
  detail: RunDetail,
  event: WorkflowRunEvent,
): RunDetail {
  const currentResult = readRunResult(detail.run.result);
  const outputs = { ...currentResult.outputs };
  const nodeStatuses = { ...currentResult.nodeStatuses };
  let status = detail.run.status;
  let finishedAt = detail.run.finishedAt;
  let error = currentResult.error;

  if (event.type === "node_started") {
    nodeStatuses[event.nodeId] = "running";
  }

  if (event.type === "node_event") {
    const agentEvent = event.event as { type?: string; text?: string };
    if (agentEvent.type === "text_delta" && agentEvent.text) {
      outputs[event.nodeId] = `${outputs[event.nodeId] ?? ""}${agentEvent.text}`;
    }
  }

  if (event.type === "node_completed") {
    nodeStatuses[event.nodeId] = "completed";
    outputs[event.nodeId] = event.output;
  }

  if (event.type === "node_failed") {
    status = "failed";
    nodeStatuses[event.nodeId] = "failed";
    error = event.error;
  }

  if (event.type === "run_completed") {
    status = event.status;
    finishedAt = new Date().toISOString();
    error = event.error;
    for (const [nodeId, output] of Object.entries(event.outputs)) {
      outputs[nodeId] = output;
    }
  }

  return {
    run: {
      ...detail.run,
      status,
      finishedAt,
      result: {
        outputs,
        nodeStatuses,
        error,
      },
    },
    log: appendRunLog(detail.log, event),
  };
}

function readRunResult(result: unknown): {
  outputs: Record<string, string>;
  nodeStatuses: Record<string, string>;
  error?: string;
} {
  if (!result || typeof result !== "object") {
    return { outputs: {}, nodeStatuses: {} };
  }

  const raw = result as {
    outputs?: unknown;
    nodeStatuses?: unknown;
    error?: unknown;
  };

  return {
    outputs: isStringRecord(raw.outputs) ? raw.outputs : {},
    nodeStatuses: isStringRecord(raw.nodeStatuses) ? raw.nodeStatuses : {},
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function appendRunLog(log: string, event: WorkflowRunEvent): string {
  const line = serializeRunEvent(event);
  return log ? `${log}\n${line}` : line;
}

function serializeRunEvent(event: WorkflowRunEvent): string {
  return JSON.stringify(event);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function getRunError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : undefined;
}

function sanitizeFilename(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "workflow"
  );
}

function downloadTextFile(input: {
  filename: string;
  content: string;
  mimeType: string;
}) {
  const blob = new Blob([input.content], { type: input.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = input.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back below for local browser environments that expose the API
      // but reject writes without an explicit clipboard permission grant.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: WorkflowRunEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const dataLine = chunk
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!dataLine) {
        continue;
      }
      onEvent(JSON.parse(dataLine.slice(6)) as WorkflowRunEvent);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error && error.name === "AbortError"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
