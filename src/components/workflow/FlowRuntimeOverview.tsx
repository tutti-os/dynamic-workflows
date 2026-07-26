"use client";

import { useState } from "react";
import type { FlowV1DetailProjection } from "@/lib/flow-v1/types";
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
                ? `Cycle #${selectedCycle.sequence} is ${selectedCycle.status}.`
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
              ? `#${selectedCycle.sequence} · ${selectedCycle.status}`
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
        <ReviewView projection={projection} />
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
      <div className="flow-runtime-node-track" aria-label="Flow design nodes">
        {props.projection.graph.nodes.map((node) => (
          <div className="flow-runtime-node" key={node.id}>
            <span className="flow-runtime-node-kind">{node.kind}</span>
            <strong>{node.label}</strong>
            <small>
              {Object.values(node.inputs)
                .map((input) => input.expression)
                .join(", ") || "root"}
            </small>
          </div>
        ))}
      </div>
      <div className="flow-runtime-edge-list">
        {props.projection.graph.edges.map((edge) => (
          <code key={edge.id}>
            {edge.sourceNodeId} → {edge.targetNodeId}
            {edge.kind === "control" ? ` [${edge.outcome}]` : ""}
          </code>
        ))}
      </div>
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
  const { checkpoint } = props.projection;
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
      <div className="flow-runtime-node-track" aria-label="Cycle node progress">
        {props.projection.graph.nodes.map((node) => {
          const state = checkpoint?.nodes[node.id];
          return (
            <div
              className={`flow-runtime-node flow-runtime-node-${state?.status ?? "idle"}`}
              key={node.id}
              title={state?.waitingReason ?? state?.error?.message}
            >
              <span className="flow-runtime-node-kind">{node.kind}</span>
              <strong>{node.label}</strong>
              <span>{state?.status ?? "idle"}</span>
              {state?.attemptCount ? (
                <small>{state.attemptCount} attempt(s)</small>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flow-runtime-history-grid">
        <HistoryList
          title="Cycles"
          selectedId={props.projection.selectedCycle?.id}
          onSelect={(cycleId) => void props.onInspectCycle(cycleId)}
          rows={props.projection.cycles.map((cycle) => ({
            id: cycle.id,
            primary: `Cycle #${cycle.sequence}`,
            secondary: cycle.status,
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

function ReviewView(props: { projection: FlowV1DetailProjection }) {
  return (
    <div className="flow-runtime-panel flow-runtime-review">
      <HistoryList
        title="Node Attempts"
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
      <HistoryList
        title="Effect ledger"
        rows={props.projection.effects.map((effect) => ({
          id: effect.id,
          primary: effect.nodeId,
          secondary: `${effect.status} · ${effect.externalRef ?? effect.idempotencyKey}`,
          timestamp: effect.updatedAt,
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
          Object.entries(props.projection.memory?.sections ?? {}).map(
            ([section, content]) => (
              <article key={section}>
                <strong>{section}</strong>
                <pre>{content || "No entries yet."}</pre>
              </article>
            ),
          )
        )}
      </div>
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
    cycle.status === "paused_uncertain" ||
    cycle.status === "paused_conflict"
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
