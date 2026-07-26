"use client";

import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge as ReactFlowEdge,
  type Node as ReactFlowNode,
} from "@xyflow/react";
import { useMemo, useState } from "react";
import { AgentCatalogStatus } from "@/components/workflow/AgentCatalogStatus";
import {
  WorkflowAgentSelect,
  WorkflowModelSelect,
  WorkflowPermissionModeSelect,
} from "@/components/workflow/WorkflowRunSelectors";
import { useWorkflowRunSettings } from "@/components/workflow/useWorkflowRunSettings";
import type {
  FlowV1DetailProjection,
  FlowV1NodeAttemptRecord,
} from "@/lib/flow-v1/types";
import type {
  WorkflowHumanAction,
  WorkflowHumanTask,
  WorkflowValue,
} from "@/lib/workflow/types";

type FlowView = "design" | "live" | "review";
type FlowAction = "start" | "resume" | "retry" | "cancel";

export function FlowRuntimeOverview(props: {
  workflowId: string;
  projection: FlowV1DetailProjection;
  onRefresh: () => Promise<unknown>;
}) {
  const [view, setView] = useState<FlowView>("live");
  const [historicalProjection, setHistoricalProjection] =
    useState<FlowV1DetailProjection | null>(null);
  const [pendingAction, setPendingAction] = useState<FlowAction | null>(
    null,
  );
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [invocationInputText, setInvocationInputText] = useState("{}");
  const projection = historicalProjection ?? props.projection;
  const { runtime, selectedCycle, checkpoint } = projection;
  const currentNode = selectedCycle?.currentNodeId
    ? projection.graph.nodes.find(
        (node) => node.id === selectedCycle.currentNodeId,
      )
    : undefined;
  const currentState = currentNode
    ? checkpoint?.nodes[currentNode.id]
    : undefined;
  const action = historicalProjection
    ? null
    : resolveFlowAction(projection);

  async function runAction(next: FlowAction) {
    const latestRun =
      runtime.latestRun ?? projection.runs.at(-1) ?? null;
    let endpoint = `/api/workflows/${props.workflowId}/run`;
    let body: Record<string, unknown> | undefined;
    if (next === "start") {
      body = { inputs: parseJsonObject(invocationInputText, "Cycle inputs") };
    } else if (next === "resume" && latestRun) {
      endpoint = `/api/workflows/${props.workflowId}/runs/${latestRun.id}/resume`;
    } else if (next === "retry" && latestRun) {
      endpoint = `/api/workflows/${props.workflowId}/runs/${latestRun.id}/retry`;
      body = selectedCycle?.currentNodeId
        ? { fromNodeId: selectedCycle.currentNodeId }
        : undefined;
    } else if (next === "cancel" && latestRun) {
      endpoint = `/api/workflows/${props.workflowId}/runs/${latestRun.id}/cancel`;
    }
    setPendingAction(next);
    setActionMessage(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!response.ok) {
        throw new Error(readActionError(payload));
      }
      setActionMessage(
        next === "cancel"
          ? "Cancellation requested."
          : "The next Tick has been queued.",
      );
      await props.onRefresh();
      window.setTimeout(() => {
        void props.onRefresh();
      }, 750);
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : "Flow action failed.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function inspectCycle(cycleId: string) {
    if (cycleId === props.projection.selectedCycle?.id) {
      setHistoricalProjection(null);
      return;
    }
    setActionMessage(null);
    try {
      const response = await fetch(
        `/api/workflows/${props.workflowId}?cycleId=${encodeURIComponent(cycleId)}`,
      );
      const payload = (await response.json()) as {
        flowV1?: FlowV1DetailProjection;
        error?: unknown;
      };
      if (!response.ok || !payload.flowV1) {
        throw new Error(
          readActionError(payload as unknown as Record<string, unknown>),
        );
      }
      setHistoricalProjection(payload.flowV1);
      setView("review");
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Cycle history could not be loaded.",
      );
    }
  }

  return (
    <section className="flow-runtime-overview" aria-label="Flow runtime">
      <div className="flow-runtime-heading">
        <div>
          <span className="flow-runtime-eyebrow">Persistent Flow</span>
          <h2>{currentNode?.label ?? "Ready for the next Cycle"}</h2>
          <p>
            {currentState?.waitingReason ??
              currentState?.error?.message ??
              (selectedCycle
                ? `Cycle #${selectedCycle.sequence} is ${selectedCycle.status}${selectedCycle.outcome ? ` with outcome ${selectedCycle.outcome}` : ""}.`
                : "This Flow has not started a Cycle yet.")}
          </p>
        </div>
        <div className="flow-runtime-tabs" role="tablist">
          {(["design", "live", "review"] as const).map((item) => (
            <button
              aria-selected={view === item}
              className={view === item ? "is-active" : undefined}
              key={item}
              onClick={() => setView(item)}
              role="tab"
              type="button"
            >
              {capitalize(item)}
            </button>
          ))}
        </div>
      </div>

      <div className="flow-runtime-actions">
        {action === "start" &&
        Object.keys(projection.configuration.inputsSchema).length >
          0 ? (
          <label className="flow-runtime-inputs">
            <span>Cycle inputs (JSON)</span>
            <textarea
              onChange={(event) =>
                setInvocationInputText(event.currentTarget.value)
              }
              rows={3}
              value={invocationInputText}
            />
          </label>
        ) : null}
        {action ? (
          <button
            className={
              action === "cancel"
                ? "flow-runtime-action-danger"
                : "flow-runtime-action-primary"
            }
            disabled={pendingAction !== null}
            onClick={() => void runAction(action)}
            type="button"
          >
            {pendingAction === action
              ? "Working…"
              : flowActionLabel(action)}
          </button>
        ) : null}
        {selectedCycle?.status === "waiting_human" ? (
          <span>
            Human decision pending · use the task card below to continue.
          </span>
        ) : null}
        {historicalProjection ? (
          <button
            onClick={() => {
              setHistoricalProjection(null);
              setView("live");
            }}
            type="button"
          >
            Back to live Cycle
          </button>
        ) : null}
        {actionMessage ? <span role="status">{actionMessage}</span> : null}
      </div>

      <div className="flow-runtime-summary">
        <RuntimeMetric label="Lifecycle" value={runtime.lifecycle} />
        <RuntimeMetric
          label="Cycle"
          value={
            selectedCycle
              ? `#${selectedCycle.sequence} · ${selectedCycle.status}${selectedCycle.outcome ? ` · ${selectedCycle.outcome}` : ""}`
              : "not started"
          }
        />
        <RuntimeMetric
          label="Current node"
          value={currentNode?.label ?? "—"}
          detail={currentState?.waitingReason}
        />
        <RuntimeMetric label="Cycles" value={String(runtime.cycleCount)} />
        <RuntimeMetric label="Ticks" value={String(runtime.runCount)} />
        <RuntimeMetric
          label="Next schedule"
          value={formatTimestamp(runtime.schedule?.nextFireAt)}
        />
      </div>

      {view === "design" ? (
        <DesignView
          projection={projection}
          workflowId={props.workflowId}
          onRefresh={props.onRefresh}
        />
      ) : null}
      {view === "live" ? (
        <LiveView
          projection={projection}
          workflowId={props.workflowId}
          onRefresh={props.onRefresh}
          onInspectCycle={inspectCycle}
        />
      ) : null}
      {view === "review" ? (
        <ReviewView
          projection={projection}
          workflowId={props.workflowId}
          canResolve={!historicalProjection}
          onRefresh={props.onRefresh}
        />
      ) : null}
    </section>
  );
}

function DesignView(props: {
  workflowId: string;
  projection: FlowV1DetailProjection;
  onRefresh: () => Promise<unknown>;
}) {
  return (
    <div className="flow-runtime-panel">
      <div className="flow-runtime-panel-title">
        <h3>Flow design</h3>
        <span>
          {props.projection.graph.nodes.length} nodes ·{" "}
          {props.projection.graph.edges.length} edges
        </span>
      </div>
      <FlowGraph mode="design" projection={props.projection} />
      <ConfigurationEditor
        projection={props.projection}
        workflowId={props.workflowId}
        onRefresh={props.onRefresh}
      />
    </div>
  );
}

function ConfigurationEditor(props: {
  workflowId: string;
  projection: FlowV1DetailProjection;
  onRefresh: () => Promise<unknown>;
}) {
  const configuration = props.projection.configuration;
  const runSettings = useWorkflowRunSettings({
    agent: configuration.defaultAgent ?? undefined,
    model: configuration.defaultModel ?? undefined,
    permissionMode: configuration.defaultPermissionMode ?? undefined,
  });
  const [paramsText, setParamsText] = useState(
    JSON.stringify(configuration.params?.values ?? {}, null, 2),
  );
  const [projectCwd, setProjectCwd] = useState(
    configuration.projectCwd ?? "",
  );
  const [secretEnvs, setSecretEnvs] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.keys(configuration.secretsSchema).map((name) => [
        name,
        configuration.secretBindings[name]?.env ?? "",
      ]),
    ),
  );
  const [pending, setPending] = useState<"save" | "lifecycle" | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setPending("save");
    setMessage(null);
    try {
      const params = parseJsonObject(paramsText, "Params");
      const secretBindings = Object.fromEntries(
        Object.entries(secretEnvs)
          .filter(([, env]) => env.trim())
          .map(([name, env]) => [
            name,
            { kind: "environment", env: env.trim() },
          ]),
      );
      await patchFlow(props.workflowId, {
        params,
        expectedParamsRevision: configuration.params?.revision ?? 0,
        projectCwd: projectCwd.trim() || null,
        defaultAgent: runSettings.effectiveAgent,
        defaultModel: runSettings.model.trim() || null,
        defaultPermissionMode:
          runSettings.permissionMode.trim() || null,
        secretBindings,
      });
      setMessage("Configuration saved.");
      await props.onRefresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Configuration could not be saved.",
      );
    } finally {
      setPending(null);
    }
  }

  async function toggleLifecycle() {
    setPending("lifecycle");
    setMessage(null);
    try {
      await patchFlow(props.workflowId, {
        lifecycle:
          props.projection.runtime.lifecycle === "active"
            ? "paused"
            : "active",
      });
      await props.onRefresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Lifecycle could not be changed.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flow-runtime-configuration">
      <div className="flow-runtime-panel-title">
        <h3>Variables & runtime</h3>
        <button
          disabled={pending !== null}
          onClick={() => void toggleLifecycle()}
          type="button"
        >
          {pending === "lifecycle"
            ? "Updating…"
            : props.projection.runtime.lifecycle === "active"
              ? "Pause schedule"
              : "Activate Flow"}
        </button>
      </div>
      <div className="flow-runtime-config-grid">
        <label>
          <span>
            Params · revision {configuration.params?.revision ?? 0}
          </span>
          <textarea
            onChange={(event) => setParamsText(event.currentTarget.value)}
            rows={7}
            value={paramsText}
          />
        </label>
        <label>
          <span>Project cwd</span>
          <input
            onChange={(event) => setProjectCwd(event.currentTarget.value)}
            placeholder="/absolute/path/to/project"
            value={projectCwd}
          />
        </label>
        <label>
          <span>Default Agent</span>
          <WorkflowAgentSelect
            agents={runSettings.agents}
            value={runSettings.effectiveAgent}
            fallbackValue="mock"
            disabled={runSettings.agentsLoading}
            onValueChange={runSettings.setAgent}
          />
        </label>
        <label>
          <span>Default model</span>
          <WorkflowModelSelect
            models={runSettings.modelOptions}
            value={runSettings.model}
            disabled={runSettings.agentsLoading}
            onValueChange={runSettings.setModel}
          />
        </label>
        <label>
          <span>Default permissions</span>
          <WorkflowPermissionModeSelect
            modes={runSettings.permissionModeOptions}
            value={runSettings.permissionMode}
            disabled={runSettings.agentsLoading}
            onValueChange={runSettings.setPermissionMode}
          />
        </label>
        {Object.entries(configuration.secretsSchema).map(
          ([name, definition]) => (
            <label key={name}>
              <span>
                Secret {name}
                {definition.required ? " · required" : ""}
              </span>
              <input
                onChange={(event) =>
                  setSecretEnvs((current) => ({
                    ...current,
                    [name]: event.currentTarget.value,
                  }))
                }
                placeholder="ENVIRONMENT_VARIABLE_NAME"
                value={secretEnvs[name] ?? ""}
              />
            </label>
          ),
        )}
      </div>
      <AgentCatalogStatus
        loading={runSettings.agentsLoading}
        error={runSettings.agentsError}
        warning={runSettings.agentsWarning}
        onRetry={runSettings.retryAgents}
      />
      <div className="flow-runtime-config-footer">
        <button
          disabled={pending !== null}
          onClick={() => void save()}
          type="button"
        >
          {pending === "save" ? "Saving…" : "Save configuration"}
        </button>
        <span>
          Secret values stay in the environment; only variable names are
          stored.
        </span>
        {message ? <span role="status">{message}</span> : null}
      </div>
    </div>
  );
}

function LiveView(props: {
  workflowId: string;
  projection: FlowV1DetailProjection;
  onRefresh: () => Promise<unknown>;
  onInspectCycle: (cycleId: string) => Promise<void>;
}) {
  return (
    <div className="flow-runtime-panel">
      <div className="flow-runtime-panel-title">
        <h3>Current execution</h3>
        <span>
          {props.projection.runtime.attentionCycleCount > 0
            ? "Needs attention"
            : "Healthy"}
        </span>
      </div>
      <FlowGraph mode="live" projection={props.projection} />
      <div className="flow-runtime-history-grid">
        <HistoryList
          title="Cycles"
          selectedId={props.projection.selectedCycle?.id}
          onSelect={(cycleId) => void props.onInspectCycle(cycleId)}
          rows={props.projection.cycles.map((cycle) => ({
            id: cycle.id,
            primary: `Cycle #${cycle.sequence}`,
            secondary: cycle.outcome
              ? `${cycle.status} · ${cycle.outcome}`
              : cycle.status,
            timestamp: cycle.createdAt,
          }))}
        />
        <HistoryList
          title="Ticks in selected Cycle"
          rows={props.projection.runs.map((run) => ({
            id: run.id,
            primary: `Tick #${run.tickSequence}`,
            secondary: run.stopReason ?? run.status,
            timestamp: run.startedAt,
          }))}
        />
      </div>
      <HumanTasks
        projection={props.projection}
        workflowId={props.workflowId}
        onRefresh={props.onRefresh}
      />
    </div>
  );
}

function FlowGraph(props: {
  projection: FlowV1DetailProjection;
  mode: "design" | "live";
}) {
  const elements = useMemo(
    () => buildFlowGraphElements(props.projection, props.mode),
    [props.projection, props.mode],
  );
  return (
    <div
      className="flow-runtime-graph"
      aria-label={
        props.mode === "design"
          ? "Flow design graph"
          : "Cycle execution graph"
      }
    >
      <ReactFlow
        nodes={elements.nodes}
        edges={elements.edges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.35}
        maxZoom={1.5}
        nodesConnectable={false}
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function buildFlowGraphElements(
  projection: FlowV1DetailProjection,
  mode: "design" | "live",
): { nodes: ReactFlowNode[]; edges: ReactFlowEdge[] } {
  const levels = layoutFlowGraph(projection);
  const groups = new Map<number, string[]>();
  for (const node of projection.graph.nodes) {
    const level = levels.get(node.id) ?? 0;
    groups.set(level, [...(groups.get(level) ?? []), node.id]);
  }
  const currentNodeId = projection.selectedCycle?.currentNodeId;
  const selectedEdges = new Set(
    projection.checkpoint?.selectedControlEdgeIds ?? [],
  );
  const notSelectedEdges = new Set(
    projection.checkpoint?.notSelectedControlEdgeIds ?? [],
  );
  const nodes = projection.graph.nodes.map((node) => {
    const level = levels.get(node.id) ?? 0;
    const row = groups.get(level)?.indexOf(node.id) ?? 0;
    const state = projection.checkpoint?.nodes[node.id];
    const status = mode === "live" ? state?.status ?? "idle" : "design";
    return {
      id: node.id,
      position: { x: level * 260, y: row * 125 },
      className: [
        "flow-graph-node",
        `flow-graph-node-${status}`,
        currentNodeId === node.id ? "is-current" : "",
      ]
        .filter(Boolean)
        .join(" "),
      data: {
        label: (
          <div className="flow-graph-node-content">
            <span>{node.kind}</span>
            <strong>{node.label}</strong>
            <small>
              {mode === "live"
                ? [
                    status,
                    state?.outcome
                      ? `outcome ${state.outcome}`
                      : undefined,
                    state?.attemptCount
                      ? `${state.attemptCount} attempt(s)`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : node.execution
                  ? `${node.execution.access} · ${node.execution.isolation}`
                  : Object.keys(node.inputs).length > 0
                    ? `${Object.keys(node.inputs).length} input(s)`
                    : "root"}
            </small>
          </div>
        ),
      },
      title: state?.waitingReason ?? state?.error?.message ?? node.label,
    };
  });
  const edges = projection.graph.edges.map((edge) => {
    const selected =
      edge.kind === "control" && selectedEdges.has(edge.id);
    const notSelected =
      edge.kind === "control" && notSelectedEdges.has(edge.id);
    return {
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      type: "smoothstep",
      label: edge.kind === "control" ? edge.outcome : undefined,
      className: [
        "flow-graph-edge",
        edge.kind === "control"
          ? "flow-graph-edge-control"
          : "flow-graph-edge-data",
        selected ? "is-selected" : "",
        notSelected ? "is-not-selected" : "",
      ]
        .filter(Boolean)
        .join(" "),
      animated:
        selected &&
        projection.selectedCycle?.currentNodeId === edge.targetNodeId,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
      },
    };
  });
  return { nodes, edges };
}

function layoutFlowGraph(
  projection: FlowV1DetailProjection,
): Map<string, number> {
  const levels = new Map(
    projection.graph.nodes.map((node) => [node.id, 0]),
  );
  for (let pass = 0; pass < projection.graph.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of projection.graph.edges) {
      const sourceLevel = levels.get(edge.sourceNodeId) ?? 0;
      const targetLevel = levels.get(edge.targetNodeId) ?? 0;
      if (targetLevel <= sourceLevel) {
        levels.set(edge.targetNodeId, sourceLevel + 1);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  const lastLevel = Math.max(0, ...levels.values());
  for (const node of projection.graph.nodes) {
    if (node.kind === "finally" && (levels.get(node.id) ?? 0) === 0) {
      levels.set(node.id, lastLevel + 1);
    }
  }
  return levels;
}

function HumanTasks(props: {
  workflowId: string;
  projection: FlowV1DetailProjection;
  onRefresh: () => Promise<unknown>;
}) {
  const tasks = props.projection.humanTasks.filter(
    (task) => task.status === "pending",
  );
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  if (tasks.length === 0) {
    return null;
  }

  async function respond(
    task: WorkflowHumanTask,
    action: WorkflowHumanAction,
  ) {
    const actionValues = Object.fromEntries(
      action.fields.map((field) => [
        field.id,
        values[humanFieldKey(task, action, field.id)] ??
          field.defaultValue ??
          "",
      ]),
    );
    const missing = action.fields.find(
      (field) =>
        field.required &&
        !String(actionValues[field.id] ?? "").trim(),
    );
    if (missing) {
      setMessage(`${missing.label} is required.`);
      return;
    }
    setPendingTaskId(task.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/workflows/${props.workflowId}/runs/${task.runId}/human-tasks/${task.id}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: action.id,
            values: actionValues,
            revision: task.revision,
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!response.ok) {
        throw new Error(readActionError(payload));
      }
      setMessage("Decision recorded; the next Tick has been queued.");
      await props.onRefresh();
      window.setTimeout(() => {
        void props.onRefresh();
      }, 750);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Human response failed.",
      );
    } finally {
      setPendingTaskId(null);
    }
  }

  return (
    <div className="flow-runtime-human-tasks">
      <div className="flow-runtime-panel-title">
        <h3>Human decisions</h3>
        <span>{tasks.length} pending</span>
      </div>
      {tasks.map((task) => (
        <article key={task.id}>
          <div>
            <strong>{task.spec.description ?? task.nodeId}</strong>
            {task.spec.context.map((item) => (
              <p key={item.label}>
                <span>{item.label}</span>
                {formatHumanValue(item.value)}
              </p>
            ))}
          </div>
          <div className="flow-runtime-human-actions">
            {task.spec.actions.map((action) => {
              return (
                <div
                  className="flow-runtime-human-action"
                  key={action.id}
                >
                  {action.fields.map((field) => {
                    const key = humanFieldKey(task, action, field.id);
                    const id = `${task.id}-${action.id}-${field.id}`;
                    const value =
                      values[key] ?? field.defaultValue ?? "";
                    return (
                      <label key={field.id} htmlFor={id}>
                        <span>
                          {field.label}
                          {field.required ? " *" : ""}
                        </span>
                        {field.type === "textarea" ? (
                          <textarea
                            disabled={pendingTaskId !== null}
                            id={id}
                            onChange={(event) =>
                              setValues((current) => ({
                                ...current,
                                [key]: event.currentTarget.value,
                              }))
                            }
                            placeholder={field.placeholder}
                            rows={3}
                            value={value}
                          />
                        ) : field.type === "select" ? (
                          <select
                            disabled={pendingTaskId !== null}
                            id={id}
                            onChange={(event) =>
                              setValues((current) => ({
                                ...current,
                                [key]: event.currentTarget.value,
                              }))
                            }
                            value={value}
                          >
                            <option value="">
                              Select {field.label}
                            </option>
                            {(field.options ?? []).map((option) => (
                              <option
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            disabled={pendingTaskId !== null}
                            id={id}
                            onChange={(event) =>
                              setValues((current) => ({
                                ...current,
                                [key]: event.currentTarget.value,
                              }))
                            }
                            placeholder={field.placeholder}
                            type="text"
                            value={value}
                          />
                        )}
                      </label>
                    );
                  })}
                  <button
                    disabled={pendingTaskId !== null}
                    onClick={() => void respond(task, action)}
                    type="button"
                  >
                    {pendingTaskId === task.id
                      ? "Submitting…"
                      : action.label}
                  </button>
                </div>
              );
            })}
          </div>
        </article>
      ))}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}

function humanFieldKey(
  task: WorkflowHumanTask,
  action: WorkflowHumanAction,
  fieldId: string,
) {
  return `${task.id}:${action.id}:${fieldId}`;
}

function ReviewView(props: {
  workflowId: string;
  projection: FlowV1DetailProjection;
  canResolve: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(
    props.projection.attempts.at(-1)?.id ?? null,
  );
  const selectedAttempt =
    props.projection.attempts.find(
      (attempt) => attempt.id === selectedAttemptId,
    ) ??
    props.projection.attempts.at(-1) ??
    null;
  return (
    <div className="flow-runtime-panel flow-runtime-review">
      <HistoryList
        title="Node Attempts"
        selectedId={selectedAttempt?.id}
        onSelect={setSelectedAttemptId}
        rows={props.projection.attempts.map((attempt) => ({
          id: attempt.id,
          primary: `${attempt.nodeId} · #${attempt.sequence}`,
          secondary:
            typeof attempt.error?.message === "string"
              ? attempt.error.message
              : attempt.status,
          timestamp: attempt.startedAt,
        }))}
      />
      <AttemptDetail attempt={selectedAttempt} />
      <HistoryList
        title="Effect ledger"
        rows={props.projection.effects.map((effect) => ({
          id: effect.id,
          primary: effect.nodeId,
          secondary: `${effect.status} · ${effect.externalRef ?? effect.idempotencyKey}`,
          timestamp: effect.updatedAt,
        }))}
      />
      <HistoryList
        title="Human decision history"
        rows={props.projection.humanTasks.map((task) => ({
          id: task.id,
          primary: task.nodeId,
          secondary: task.response?.action ?? task.status,
          timestamp: task.resolvedAt ?? task.createdAt,
        }))}
      />
      <div className="flow-runtime-memory">
        <div className="flow-runtime-panel-title">
          <h3>Markdown Memory</h3>
          <span>{props.projection.memory?.hash.slice(0, 10) ?? "disabled"}</span>
        </div>
        {props.projection.memory?.error ? (
          <p>{props.projection.memory.error}</p>
        ) : (
          <>
            <MemoryConflicts
              workflowId={props.workflowId}
              projection={props.projection}
              canResolve={props.canResolve}
              onRefresh={props.onRefresh}
            />
            {Object.entries(props.projection.memory?.sections ?? {}).map(
              ([section, content]) => (
                <article key={section}>
                  <strong>{section}</strong>
                  <pre>{content || "No entries yet."}</pre>
                </article>
              ),
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MemoryConflicts(props: {
  workflowId: string;
  projection: FlowV1DetailProjection;
  canResolve: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const conflicts = props.projection.memory?.conflicts ?? [];
  if (conflicts.length === 0) {
    return null;
  }
  const latestRun =
    props.projection.runtime.latestRun ??
    props.projection.runs.at(-1) ??
    null;

  async function resolveConflict(
    nodeId: string,
    resolution: "keep_current" | "apply_candidate",
  ) {
    if (!latestRun) {
      return;
    }
    setPending(`${nodeId}:${resolution}`);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/workflows/${props.workflowId}/runs/${latestRun.id}/memory/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeId, resolution }),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!response.ok) {
        throw new Error(readActionError(payload));
      }
      setMessage("Memory conflict resolved; the next Tick has been queued.");
      await props.onRefresh();
      window.setTimeout(() => {
        void props.onRefresh();
      }, 750);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Memory conflict could not be resolved.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flow-runtime-memory-conflicts">
      {conflicts.map((conflict) => (
        <article key={`${conflict.cycleId}:${conflict.nodeId}`}>
          <div className="flow-runtime-panel-title">
            <strong>Conflict at {conflict.nodeId}</strong>
            <span>{formatTimestamp(conflict.createdAt)}</span>
          </div>
          <div className="flow-runtime-memory-diff">
            <div>
              <strong>Keep current</strong>
              <pre>{props.projection.memory?.markdown}</pre>
            </div>
            <div>
              <strong>Apply candidate</strong>
              <pre>{conflict.candidateMarkdown}</pre>
            </div>
          </div>
          {props.canResolve ? (
            <div className="flow-runtime-memory-actions">
              <button
                disabled={pending !== null}
                onClick={() =>
                  void resolveConflict(conflict.nodeId, "keep_current")
                }
                type="button"
              >
                {pending === `${conflict.nodeId}:keep_current`
                  ? "Resolving…"
                  : "Keep current"}
              </button>
              <button
                disabled={pending !== null}
                onClick={() =>
                  void resolveConflict(conflict.nodeId, "apply_candidate")
                }
                type="button"
              >
                {pending === `${conflict.nodeId}:apply_candidate`
                  ? "Resolving…"
                  : "Apply candidate"}
              </button>
            </div>
          ) : null}
        </article>
      ))}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}

function AttemptDetail(props: {
  attempt: FlowV1NodeAttemptRecord | null;
}) {
  const [openingSession, setOpeningSession] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attempt = props.attempt;

  async function openSession() {
    if (!attempt?.agentSessionId) {
      return;
    }
    setOpeningSession(true);
    setMessage(null);
    try {
      const response = await fetch("/api/agent-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentSessionId: attempt.agentSessionId }),
      });
      const payload = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!response.ok) {
        throw new Error(readActionError(payload));
      }
      setMessage("Agent session opened.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Agent session could not be opened.",
      );
    } finally {
      setOpeningSession(false);
    }
  }

  return (
    <div className="flow-runtime-attempt-detail">
      <div className="flow-runtime-panel-title">
        <h3>Attempt detail</h3>
        <span>{attempt?.status ?? "not selected"}</span>
      </div>
      {!attempt ? <p>Select an attempt to inspect it.</p> : null}
      {attempt ? (
        <>
          <dl>
            <div>
              <dt>Node</dt>
              <dd>{attempt.nodeId}</dd>
            </div>
            <div>
              <dt>Attempt</dt>
              <dd>#{attempt.sequence}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{formatTimestamp(attempt.startedAt)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                {formatDuration(attempt.startedAt, attempt.finishedAt)}
              </dd>
            </div>
            {attempt.controlOutcome ? (
              <div>
                <dt>Outcome</dt>
                <dd>{attempt.controlOutcome}</dd>
              </div>
            ) : null}
          </dl>
          {attempt.agentSessionId ? (
            <div className="flow-runtime-attempt-session">
              <code>{attempt.agentSessionId}</code>
              <button
                disabled={openingSession}
                onClick={() => void openSession()}
                type="button"
              >
                {openingSession ? "Opening…" : "Open Agent session"}
              </button>
            </div>
          ) : null}
          <AttemptPayload label="Input" value={attempt.input} />
          <AttemptPayload label="Output" value={attempt.output} />
          {attempt.error ? (
            <AttemptPayload label="Error" value={attempt.error} />
          ) : null}
          {message ? <p role="status">{message}</p> : null}
        </>
      ) : null}
    </div>
  );
}

function AttemptPayload(props: {
  label: string;
  value: unknown;
}) {
  return (
    <div className="flow-runtime-attempt-payload">
      <strong>{props.label}</strong>
      <pre>{formatJsonValue(props.value)}</pre>
    </div>
  );
}

function HistoryList(props: {
  title: string;
  rows: Array<{
    id: string;
    primary: string;
    secondary: string;
    timestamp: string;
  }>;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="flow-runtime-history">
      <div className="flow-runtime-panel-title">
        <h3>{props.title}</h3>
        <span>{props.rows.length}</span>
      </div>
      {props.rows.length === 0 ? <p>No records yet.</p> : null}
      {props.rows.map((row) => (
        <div
          className={`flow-runtime-history-row${
            props.selectedId === row.id ? " is-selected" : ""
          }`}
          key={row.id}
        >
          <div>
            <strong>{row.primary}</strong>
            <span>{row.secondary}</span>
          </div>
          <time>{formatTimestamp(row.timestamp)}</time>
          {props.onSelect ? (
            <button onClick={() => props.onSelect?.(row.id)} type="button">
              Inspect
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RuntimeMetric(props: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="flow-runtime-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.detail ? <small>{props.detail}</small> : null}
    </div>
  );
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "not scheduled";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString();
}

function formatDuration(
  startedAt: string,
  finishedAt: string | null,
): string {
  const start = Date.parse(startedAt);
  const finish = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(finish)) {
    return "unknown";
  }
  const milliseconds = Math.max(0, finish - start);
  if (milliseconds < 1_000) {
    return `${milliseconds}ms`;
  }
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function formatJsonValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "No value captured.";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function resolveFlowAction(
  projection: FlowV1DetailProjection,
): FlowAction | null {
  const cycle = projection.runtime.activeCycle;
  if (!cycle) {
    return "start";
  }
  const latestRun =
    projection.runtime.latestRun ?? projection.runs.at(-1) ?? null;
  if (
    cycle.status === "running" &&
    (latestRun?.status === "pending" || latestRun?.status === "running")
  ) {
    return "cancel";
  }
  if (
    cycle.status === "paused_failed" ||
    cycle.status === "paused_uncertain"
  ) {
    return "retry";
  }
  if (
    cycle.status === "waiting_gate" ||
    cycle.status === "paused_budget" ||
    cycle.status === "runnable"
  ) {
    return "resume";
  }
  return null;
}

function flowActionLabel(action: FlowAction): string {
  switch (action) {
    case "start":
      return "Start Cycle";
    case "resume":
      return "Run next Tick";
    case "retry":
      return "Retry current node";
    case "cancel":
      return "Cancel Cycle";
  }
}

function readActionError(payload: Record<string, unknown> | null): string {
  const error = payload?.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "Flow action failed.";
}

function formatHumanValue(value: WorkflowValue): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function parseJsonObject(
  source: string,
  label: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function patchFlow(
  workflowId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`/api/workflows/${workflowId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    throw new Error(readActionError(payload));
  }
}
