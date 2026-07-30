"use client";

import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge as ReactFlowEdge,
  type Node as ReactFlowNode,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Button,
  ConfirmationDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@tutti-os/ui-system";
import {
  Ban,
  Bot,
  Braces,
  Brain,
  CheckCircle2,
  CircleAlert,
  Code2,
  GitBranch,
  Layers3,
  Play,
  RefreshCw,
  Repeat2,
  Square,
  UserRound,
  Zap,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AgentCatalogStatus } from "@/components/workflow/AgentCatalogStatus";
import { SecretBindingField } from "@/components/workflow/SecretBindingField";
import {
  WorkflowAgentSelect,
  WorkflowModelSelect,
  WorkflowPermissionModeSelect,
} from "@/components/workflow/WorkflowRunSelectors";
import { useWorkflowRunSettings } from "@/components/workflow/useWorkflowRunSettings";
import {
  looksLikeSecretValue,
  type FlowV1SecretBinding,
} from "@/lib/flow-v1/secret-bindings";
import type {
  FlowV1DetailProjection,
  FlowV1Edge,
  FlowV1GraphCheckpoint,
  FlowV1Node,
  FlowV1NodeAttemptRecord,
  FlowV1SchemaEntry,
} from "@/lib/flow-v1/types";
import type {
  WorkflowHumanAction,
  WorkflowHumanTask,
  WorkflowValue,
} from "@/lib/workflow/types";

export type FlowView = "design" | "live" | "review";
type FlowAction = "start" | "resume" | "retry" | "cancel" | "restart";
type RuntimeConfigDraft = {
  params: Record<string, string>;
  projectCwd: string;
  secretBindings: Record<string, FlowV1SecretBinding>;
  agent: string;
  model: string;
  permissionMode: string;
};

export function FlowRuntimeOverview(props: {
  workflowId: string;
  projection: FlowV1DetailProjection;
  sourceFiles?: Array<{ path: string; content: string }>;
  view: FlowView;
  onViewChange: (view: FlowView) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const [historicalProjection, setHistoricalProjection] =
    useState<FlowV1DetailProjection | null>(null);
  const [pendingAction, setPendingAction] = useState<FlowAction | null>(
    null,
  );
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [startDiscardOpen, setStartDiscardOpen] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [startFieldErrors, setStartFieldErrors] = useState<
    Record<string, string>
  >({});
  const [humanDialogOpen, setHumanDialogOpen] = useState(false);
  const [invocationInputs, setInvocationInputs] = useState<
    Record<string, string>
  >(() =>
    createSchemaValueDraft(props.projection.configuration.inputsSchema),
  );
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
  const latestRun =
    runtime.latestRun ?? projection.runs.at(-1) ?? null;
  const canRestart =
    !historicalProjection &&
    Boolean(
      runtime.activeCycle &&
        selectedCycle?.id === runtime.activeCycle.id &&
        latestRun,
    );

  async function runAction(next: FlowAction) {
    let endpoint = `/api/workflows/${props.workflowId}/run`;
    let body: Record<string, unknown> | undefined;
    setPendingAction(next);
    setActionMessage(null);
    if (next === "start") {
      setStartFieldErrors({});
    }
    try {
      if (next === "start") {
        body = {
          inputs: parseSchemaValues(
            projection.configuration.inputsSchema,
            invocationInputs,
          ),
        };
      } else if (next === "resume" && latestRun) {
        endpoint = `/api/workflows/${props.workflowId}/runs/${latestRun.id}/resume`;
      } else if (next === "retry" && latestRun) {
        endpoint = `/api/workflows/${props.workflowId}/runs/${latestRun.id}/retry`;
        body = selectedCycle?.currentNodeId
          ? { fromNodeId: selectedCycle.currentNodeId }
          : undefined;
      } else if (next === "cancel" && latestRun) {
        endpoint = `/api/workflows/${props.workflowId}/runs/${latestRun.id}/cancel`;
      } else if (next === "restart" && latestRun) {
        endpoint = `/api/workflows/${props.workflowId}/runs/${latestRun.id}/restart`;
      }
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
      setActionMessage(flowActionSuccessMessage(next));
      if (next === "start") {
        setInvocationInputs(
          createSchemaValueDraft(projection.configuration.inputsSchema),
        );
        setStartDialogOpen(false);
      }
      await props.onRefresh();
      window.setTimeout(() => {
        void props.onRefresh();
      }, 750);
    } catch (error) {
      if (next === "start" && error instanceof SchemaFieldError) {
        setStartFieldErrors({ [error.field]: error.message });
        window.setTimeout(() => {
          document
            .getElementById(`invocation-input-${error.field}`)
            ?.focus();
        });
      }
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
      props.onViewChange("review");
    } catch (error) {
      setActionMessage(
          error instanceof Error
            ? error.message
            : "Run history could not be loaded.",
      );
    }
  }

  const inputEntries = Object.entries(projection.configuration.inputsSchema);
  const defaultInvocationInputs = createSchemaValueDraft(
    projection.configuration.inputsSchema,
  );
  const startFormDirty =
    JSON.stringify(invocationInputs) !== JSON.stringify(defaultInvocationInputs);
  const pendingHumanTaskCount = projection.humanTasks.filter(
    (task) => task.status === "pending",
  ).length;
  const guidance = flowGuidance(projection, action);

  function requestStartDialogClose() {
    if (pendingAction !== null) {
      return;
    }
    if (startFormDirty) {
      setStartDiscardOpen(true);
      return;
    }
    setStartDialogOpen(false);
  }

  return (
    <section
      className="flow-runtime-overview"
      data-view={props.view}
      aria-label="Workflow activity"
    >
      <div className="flow-runtime-heading">
        <div>
          <span className="flow-runtime-eyebrow">Workflow status</span>
          <h2>{currentNode?.label ?? "Ready to start"}</h2>
          <p>
            {currentState?.waitingReason ??
              currentState?.error?.message ??
              (selectedCycle
                ? `Run #${selectedCycle.sequence} is ${formatStatus(selectedCycle.status)}${selectedCycle.outcome ? ` with outcome ${selectedCycle.outcome}` : ""}.`
                : "This workflow has not run yet.")}
          </p>
        </div>
      </div>

      <div
        className="flow-next-step"
        data-action={action ?? selectedCycle?.status ?? "idle"}
      >
        <div className="flow-next-step-icon" aria-hidden="true">
          {flowGuidanceIcon(action, selectedCycle?.status)}
        </div>
        <div className="flow-next-step-copy">
          <span>Next step</span>
          <h3>{guidance.title}</h3>
          <p>{guidance.description}</p>
        </div>
        <div className="flow-next-step-actions">
          {action ? (
            <button
              className={
                action === "cancel"
                  ? "flow-next-step-button flow-next-step-button-danger"
                  : "flow-next-step-button flow-next-step-button-primary"
              }
              disabled={pendingAction !== null}
              onClick={() => {
                if (action === "start" && inputEntries.length > 0) {
                  setActionMessage(null);
                  setStartFieldErrors({});
                  setInvocationInputs(
                    createSchemaValueDraft(
                      projection.configuration.inputsSchema,
                    ),
                  );
                  setStartDialogOpen(true);
                  return;
                }
                void runAction(action);
              }}
              type="button"
            >
              {pendingAction !== action ? flowActionIcon(action) : null}
              {pendingAction === action
                ? "Working…"
                : flowActionLabel(action)}
            </button>
          ) : selectedCycle?.status === "waiting_human" ? (
            <button
              className="flow-next-step-button flow-next-step-button-primary"
              onClick={() => {
                setHumanDialogOpen(true);
              }}
              type="button"
            >
              Review decision
            </button>
          ) : selectedCycle?.status === "paused_conflict" ? (
            <button
              className="flow-next-step-button flow-next-step-button-primary"
              onClick={() => props.onViewChange("review")}
              type="button"
            >
              Review conflict
            </button>
          ) : null}
          {canRestart ? (
            <button
              className="flow-next-step-button flow-next-step-button-secondary"
              disabled={pendingAction !== null}
              onClick={() => setRestartConfirmOpen(true)}
              type="button"
            >
              {pendingAction === "restart" ? null : (
                <Repeat2 aria-hidden="true" size={15} />
              )}
              {pendingAction === "restart"
                ? "Restarting…"
                : "Restart from beginning"}
            </button>
          ) : null}
          {historicalProjection ? (
            <button
              className="flow-next-step-button flow-next-step-button-secondary"
              onClick={() => {
                setHistoricalProjection(null);
                props.onViewChange("live");
              }}
              type="button"
            >
              Back to current run
            </button>
          ) : null}
        </div>
        {actionMessage ? (
          <p className="flow-next-step-message" role="status">
            {actionMessage}
          </p>
        ) : null}
      </div>

      <Dialog
        open={startDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setStartDialogOpen(open);
          } else {
            requestStartDialogClose();
          }
        }}
      >
        <DialogContent className="flow-start-dialog">
          <DialogHeader>
            <DialogTitle>Start workflow</DialogTitle>
            <DialogDescription>
              Add the inputs for this run. Defaults are already filled in.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flow-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void runAction("start");
            }}
          >
            <div className="flow-invocation-input-grid">
              {inputEntries.map(([name, definition]) => (
                <SchemaField
                  definition={definition}
                  error={startFieldErrors[name]}
                  idPrefix="invocation-input"
                  key={name}
                  name={name}
                  onChange={(value) => {
                    setInvocationInputs((current) => ({
                      ...current,
                      [name]: value,
                    }));
                    setStartFieldErrors((current) => {
                      if (!current[name]) {
                        return current;
                      }
                      const next = { ...current };
                      delete next[name];
                      return next;
                    });
                  }}
                  value={invocationInputs[name] ?? ""}
                />
              ))}
            </div>
            {actionMessage ? (
              <p className="flow-dialog-message" role="status">
                {actionMessage}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                disabled={pendingAction !== null}
                onClick={requestStartDialogClose}
                size="dialog"
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={pendingAction !== null}
                size="dialog"
                type="submit"
              >
                {pendingAction === "start" ? "Starting…" : "Start workflow"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmationDialog
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        description="Your input changes will not be saved."
        onConfirm={() => {
          setInvocationInputs(defaultInvocationInputs);
          setStartFieldErrors({});
          setStartDiscardOpen(false);
          setStartDialogOpen(false);
        }}
        onOpenChange={setStartDiscardOpen}
        open={startDiscardOpen}
        title="Discard run inputs?"
        tone="destructive"
      />
      <ConfirmationDialog
        cancelLabel="Keep current run"
        confirmLabel="Restart workflow"
        description="The current run will stop and its progress will be discarded. A new run will start from the first step with the same inputs."
        onConfirm={() => {
          setRestartConfirmOpen(false);
          void runAction("restart");
        }}
        onOpenChange={setRestartConfirmOpen}
        open={restartConfirmOpen}
        title="Restart from the beginning?"
        tone="destructive"
      />

      <Dialog open={humanDialogOpen} onOpenChange={setHumanDialogOpen}>
        <DialogContent className="flow-human-dialog">
          <DialogHeader>
            <DialogTitle>Review decision</DialogTitle>
            <DialogDescription>
              {pendingHumanTaskCount === 1
                ? "This workflow needs your response before it can continue."
                : `${pendingHumanTaskCount} decisions need your response before this workflow can continue.`}
            </DialogDescription>
          </DialogHeader>
          <HumanTasks
            projection={projection}
            workflowId={props.workflowId}
            onRefresh={props.onRefresh}
            onResolved={() => setHumanDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <div className="flow-runtime-summary">
        <RuntimeMetric label="Workflow" value={runtime.lifecycle} />
        <RuntimeMetric
          label="Current run"
          value={
            selectedCycle
              ? `#${selectedCycle.sequence} · ${formatStatus(selectedCycle.status)}${selectedCycle.outcome ? ` · ${selectedCycle.outcome}` : ""}`
              : "not started"
          }
        />
        <RuntimeMetric
          label="Next scheduled"
          value={formatTimestamp(runtime.schedule?.nextFireAt)}
        />
      </div>

      {props.view === "design" ? (
        <DesignView
          projection={projection}
          sourceFiles={props.sourceFiles}
          workflowId={props.workflowId}
          onRefresh={props.onRefresh}
        />
      ) : null}
      {props.view === "live" ? (
        <LiveView
          projection={projection}
          sourceFiles={props.sourceFiles}
          workflowId={props.workflowId}
          onRefresh={props.onRefresh}
          onInspectCycle={inspectCycle}
        />
      ) : null}
      {props.view === "review" ? (
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
  sourceFiles?: Array<{ path: string; content: string }>;
  onRefresh: () => Promise<unknown>;
}) {
  return (
    <div className="flow-runtime-panel flow-design-workspace">
      <div className="flow-runtime-panel-title">
        <h3>Workflow map</h3>
        <span>
          {props.projection.graph.nodes.length} nodes ·{" "}
          {props.projection.graph.edges.length} edges
        </span>
      </div>
      <FlowGraph
        graph={props.projection.graph}
        mode="design"
        sourceFiles={props.sourceFiles}
      />
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
  const [paramsDraft, setParamsDraft] = useState<Record<string, string>>(() =>
    createSchemaValueDraft(
      configuration.paramsSchema,
      configuration.params?.values,
    ),
  );
  const [projectCwd, setProjectCwd] = useState(
    configuration.projectCwd ?? "",
  );
  const [secretBindings, setSecretBindings] = useState<
    Record<string, FlowV1SecretBinding>
  >(() => ({ ...configuration.secretBindings }));
  const [pending, setPending] = useState<"save" | "lifecycle" | null>(
    null,
  );
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [configDiscardOpen, setConfigDiscardOpen] = useState(false);
  const [configBaseline, setConfigBaseline] =
    useState<RuntimeConfigDraft | null>(null);
  const [configFieldErrors, setConfigFieldErrors] = useState<
    Record<string, string>
  >({});
  const [message, setMessage] = useState<string | null>(null);
  const currentConfigDraft: RuntimeConfigDraft = {
    params: paramsDraft,
    projectCwd,
    secretBindings,
    agent: runSettings.effectiveAgent,
    model: runSettings.model,
    permissionMode: runSettings.permissionMode,
  };
  const configDirty =
    configBaseline !== null &&
    JSON.stringify(currentConfigDraft) !== JSON.stringify(configBaseline);

  function openConfigDialog() {
    setConfigBaseline(currentConfigDraft);
    setConfigFieldErrors({});
    setMessage(null);
    setConfigDialogOpen(true);
  }

  function restoreConfigDraft(snapshot: RuntimeConfigDraft) {
    setParamsDraft(snapshot.params);
    setProjectCwd(snapshot.projectCwd);
    setSecretBindings(snapshot.secretBindings);
    runSettings.setAgent(snapshot.agent);
    runSettings.setModel(snapshot.model);
    runSettings.setPermissionMode(snapshot.permissionMode);
  }

  function requestConfigDialogClose() {
    if (pending !== null) {
      return;
    }
    if (configDirty) {
      setConfigDiscardOpen(true);
      return;
    }
    setConfigBaseline(null);
    setConfigFieldErrors({});
    setConfigDialogOpen(false);
  }

  async function save() {
    setPending("save");
    setMessage(null);
    setConfigFieldErrors({});
    try {
      const params = parseSchemaValues(
        configuration.paramsSchema,
        paramsDraft,
      );
      const savedSecretBindings = prepareSecretBindings(secretBindings);
      await patchFlow(props.workflowId, {
        params,
        expectedParamsRevision: configuration.params?.revision ?? 0,
        projectCwd: projectCwd.trim() || null,
        defaultAgent: runSettings.effectiveAgent,
        defaultModel: runSettings.model.trim() || null,
        defaultPermissionMode:
          runSettings.permissionMode.trim() || null,
        secretBindings: savedSecretBindings,
      });
      await props.onRefresh();
      setMessage("Configuration saved.");
      setConfigBaseline(null);
      setConfigDialogOpen(false);
    } catch (error) {
      if (error instanceof SchemaFieldError) {
        setConfigFieldErrors({ [error.field]: error.message });
        window.setTimeout(() => {
          const field =
            document.getElementById(`runtime-param-${error.field}`) ??
            document.getElementById(`runtime-secret-${error.field}`);
          field?.focus();
        });
      }
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
          : "Schedule status could not be changed.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flow-runtime-configuration">
      <div className="flow-runtime-panel-title">
        <div>
          <h3>Runtime setup</h3>
          <p>Defaults used by every run.</p>
        </div>
        <div className="flow-runtime-config-actions">
          <Button
            disabled={pending !== null || runSettings.agentsLoading}
            onClick={openConfigDialog}
            size="sm"
            type="button"
            variant="outline"
          >
            Edit configuration
          </Button>
          {props.projection.runtime.schedule ? (
            <Button
              disabled={pending !== null}
              onClick={() => void toggleLifecycle()}
              size="sm"
              type="button"
              variant="outline"
            >
              {pending === "lifecycle"
                ? "Updating…"
                : props.projection.runtime.lifecycle === "active"
                  ? "Pause schedule"
                  : "Activate schedule"}
            </Button>
          ) : null}
        </div>
      </div>
      <dl className="flow-runtime-config-summary">
        <div>
          <dt>Project folder</dt>
          <dd>{configuration.projectCwd || "Not set"}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{configuration.defaultAgent || "Default"}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{configuration.defaultModel || "Default"}</dd>
        </div>
        <div>
          <dt>Parameters</dt>
          <dd>
            {Object.keys(configuration.params?.values ?? {}).length} configured
          </dd>
        </div>
      </dl>
      {message ? (
        <p
          className="flow-runtime-config-message"
          data-tone={message === "Configuration saved." ? "success" : "danger"}
          role="status"
        >
          {message}
        </p>
      ) : null}

      <Dialog
        open={configDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setConfigDialogOpen(true);
          } else {
            requestConfigDialogClose();
          }
        }}
      >
        <DialogContent className="flow-config-dialog">
          <DialogHeader>
            <DialogTitle>Runtime configuration</DialogTitle>
            <DialogDescription>
              Set the project, Agent, model, parameters, and secret bindings
              used by this workflow.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flow-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="flow-runtime-config-grid">
              <label>
                <span>Project folder</span>
                <input
                  onChange={(event) =>
                    setProjectCwd(event.currentTarget.value)
                  }
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
                  <SecretBindingField
                    binding={secretBindings[name]}
                    definition={definition}
                    key={name}
                    name={name}
                    onChange={(binding) =>
                      setSecretBindings((current) => {
                        const next = { ...current };
                        if (binding) {
                          next[name] = binding;
                        } else {
                          delete next[name];
                        }
                        return next;
                      })
                    }
                  />
                ),
              )}
            </div>
            {Object.keys(configuration.paramsSchema).length > 0 ? (
              <fieldset className="flow-runtime-param-fields">
                <legend>
                  Parameters · revision {configuration.params?.revision ?? 0}
                </legend>
                <div className="flow-invocation-input-grid">
                  {Object.entries(configuration.paramsSchema).map(
                    ([name, definition]) => (
                      <SchemaField
                        definition={definition}
                        error={configFieldErrors[name]}
                        idPrefix="runtime-param"
                        key={name}
                        name={name}
                        onChange={(value) => {
                          setParamsDraft((current) => ({
                            ...current,
                            [name]: value,
                          }));
                          setConfigFieldErrors((current) => {
                            if (!current[name]) {
                              return current;
                            }
                            const next = { ...current };
                            delete next[name];
                            return next;
                          });
                        }}
                        value={paramsDraft[name] ?? ""}
                      />
                    ),
                  )}
                </div>
              </fieldset>
            ) : null}
            <AgentCatalogStatus
              loading={runSettings.agentsLoading}
              error={runSettings.agentsError}
              warning={runSettings.agentsWarning}
              onRetry={runSettings.retryAgents}
            />
            <p className="flow-dialog-hint">
              Connection selections store only account references. Tokens stay
              in the provider credential store. Environment variables remain
              available as an advanced fallback.
            </p>
            {message ? (
              <p className="flow-dialog-message" role="status">
                {message}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                disabled={pending !== null}
                onClick={requestConfigDialogClose}
                size="dialog"
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={pending !== null || !configDirty}
                size="dialog"
                type="submit"
              >
                {pending === "save" ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmationDialog
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        description="Your runtime configuration changes will not be saved."
        onConfirm={() => {
          if (configBaseline) {
            restoreConfigDraft(configBaseline);
          }
          setConfigFieldErrors({});
          setConfigDiscardOpen(false);
          setConfigDialogOpen(false);
          setConfigBaseline(null);
        }}
        onOpenChange={setConfigDiscardOpen}
        open={configDiscardOpen}
        title="Discard configuration changes?"
        tone="destructive"
      />
    </div>
  );
}

function LiveView(props: {
  workflowId: string;
  projection: FlowV1DetailProjection;
  sourceFiles?: Array<{ path: string; content: string }>;
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
      <FlowGraph
        checkpoint={props.projection.checkpoint}
        currentNodeId={props.projection.selectedCycle?.currentNodeId}
        graph={props.projection.graph}
        mode="live"
        sourceFiles={props.sourceFiles}
      />
      <div className="flow-runtime-history-grid">
        <HistoryList
          title="Runs"
          selectedId={props.projection.selectedCycle?.id}
          onSelect={(cycleId) => void props.onInspectCycle(cycleId)}
          rows={props.projection.cycles.map((cycle) => ({
            id: cycle.id,
            primary: `Run #${cycle.sequence}`,
            secondary: cycle.outcome
              ? `${formatStatus(cycle.status)} · ${cycle.outcome}`
              : formatStatus(cycle.status),
            timestamp: cycle.createdAt,
          }))}
        />
        <HistoryList
          title="Step executions in selected run"
          rows={props.projection.runs.map((run) => ({
            id: run.id,
            primary: `Execution #${run.tickSequence}`,
            secondary: formatStatus(run.stopReason ?? run.status),
            timestamp: run.startedAt,
          }))}
        />
      </div>
    </div>
  );
}

export function FlowGraph(props: {
  graph: {
    nodes: FlowV1Node[];
    edges: FlowV1Edge[];
  };
  mode: "design" | "live";
  checkpoint?: FlowV1GraphCheckpoint | null;
  currentNodeId?: string | null;
  sourceFiles?: Array<{ path: string; content: string }>;
}) {
  const preferredNodeId =
    props.graph.nodes.find((node) => node.id === props.currentNodeId)?.id ??
    props.graph.nodes[0]?.id ??
    null;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    preferredNodeId,
  );
  const [followCurrentNode, setFollowCurrentNode] = useState(
    props.mode === "live",
  );
  const [inspectorWidth, setInspectorWidth] = useState(400);
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance | null>(null);
  useEffect(() => {
    setSelectedNodeId((current) =>
      props.graph.nodes.some((node) => node.id === current)
        ? current
        : preferredNodeId,
    );
  }, [preferredNodeId, props.graph.nodes]);
  useEffect(() => {
    if (!followCurrentNode || !props.currentNodeId) {
      return;
    }
    setSelectedNodeId(props.currentNodeId);
    const node = flowInstance?.getNode(props.currentNodeId);
    if (flowInstance && node) {
      void flowInstance.fitView({
        nodes: [node],
        duration: 240,
        padding: 1.2,
        maxZoom: 1,
      });
    }
  }, [
    flowInstance,
    followCurrentNode,
    props.currentNodeId,
    props.graph.nodes,
  ]);
  const elements = useMemo(
    () => buildFlowGraphElements({ ...props, selectedNodeId }),
    [
      props.checkpoint,
      props.currentNodeId,
      props.graph,
      props.mode,
      selectedNodeId,
    ],
  );
  const selectedNode =
    props.graph.nodes.find((node) => node.id === selectedNodeId) ??
    props.graph.nodes[0];

  function resizeInspector(delta: number) {
    setInspectorWidth((current) => {
      const viewportLimit =
        typeof window === "undefined" ? 640 : window.innerWidth * 0.48;
      return Math.round(
        Math.min(Math.min(640, viewportLimit), Math.max(300, current + delta)),
      );
    });
  }

  function startInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || window.matchMedia("(max-width: 900px)").matches) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const maxWidth = Math.min(640, window.innerWidth * 0.48);
    const onPointerMove = (moveEvent: PointerEvent) => {
      setInspectorWidth(
        Math.round(
          Math.min(
            maxWidth,
            Math.max(300, startWidth + startX - moveEvent.clientX),
          ),
        ),
      );
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("is-resizing-flow-inspector");
    };
    document.body.classList.add("is-resizing-flow-inspector");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeInspector(24);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeInspector(-24);
    } else if (event.key === "Home") {
      event.preventDefault();
      setInspectorWidth(400);
    }
  }

  return (
    <div
      className="flow-graph-workbench"
      style={
        {
          "--flow-inspector-width": `${inspectorWidth}px`,
        } as CSSProperties
      }
    >
      <div
        className="flow-runtime-graph"
        aria-label={
          props.mode === "design"
            ? "Workflow design graph"
            : "Run execution graph"
        }
      >
        <ReactFlow
          nodes={elements.nodes}
          edges={elements.edges}
          fitView
          fitViewOptions={{ padding: 0.24 }}
          minZoom={0.3}
          maxZoom={1.5}
          nodesConnectable={false}
          nodesDraggable={false}
          onInit={setFlowInstance}
          onNodeClick={(_event, node) => {
            setSelectedNodeId(node.id);
            setFollowCurrentNode(false);
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div
        aria-label="Resize node details"
        aria-orientation="vertical"
        aria-valuemax={640}
        aria-valuemin={300}
        aria-valuenow={inspectorWidth}
        className="flow-inspector-resizer"
        onDoubleClick={() => setInspectorWidth(400)}
        onKeyDown={handleResizeKeyDown}
        onPointerDown={startInspectorResize}
        role="separator"
        tabIndex={0}
        title="Drag to resize node details"
      />
      <FlowNodeInspector
        checkpoint={props.checkpoint}
        edges={props.graph.edges}
        mode={props.mode}
        node={selectedNode}
        sourceFiles={props.sourceFiles}
      />
    </div>
  );
}

function buildFlowGraphElements(
  projection: {
    graph: { nodes: FlowV1Node[]; edges: FlowV1Edge[] };
    mode: "design" | "live";
    checkpoint?: FlowV1GraphCheckpoint | null;
    currentNodeId?: string | null;
    selectedNodeId?: string | null;
  },
): { nodes: ReactFlowNode[]; edges: ReactFlowEdge[] } {
  const levels = layoutFlowGraph(projection);
  const groups = new Map<number, string[]>();
  for (const node of projection.graph.nodes) {
    const level = levels.get(node.id) ?? 0;
    groups.set(level, [...(groups.get(level) ?? []), node.id]);
  }
  orderFlowGraphGroups(groups, projection.graph.edges, levels);
  const currentNodeId = projection.currentNodeId;
  const selectedEdges = new Set(
    projection.checkpoint?.selectedControlEdgeIds ?? [],
  );
  const notSelectedEdges = new Set(
    projection.checkpoint?.notSelectedControlEdgeIds ?? [],
  );
  const nodes = projection.graph.nodes.map((node) => {
    const level = levels.get(node.id) ?? 0;
    const levelNodes = groups.get(level) ?? [];
    const row = levelNodes.indexOf(node.id);
    const centeredRow = row - (levelNodes.length - 1) / 2;
    const state = projection.checkpoint?.nodes[node.id];
    const status =
      projection.mode === "live" ? state?.status ?? "idle" : "design";
    const summary =
      projection.mode === "live"
        ? [
            status,
            state?.outcome ? `outcome ${state.outcome}` : undefined,
            state?.attemptCount
              ? `${state.attemptCount} attempt(s)`
              : undefined,
          ]
            .filter(Boolean)
            .join(" · ")
        : flowNodeDesignSummary(node);
    return {
      id: node.id,
      position: { x: level * 300, y: centeredRow * 134 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      className: [
        "flow-graph-node",
        `flow-graph-node-kind-${node.kind}`,
        `flow-graph-node-${status}`,
        currentNodeId === node.id ? "is-current" : "",
        projection.selectedNodeId === node.id ? "is-inspected" : "",
      ]
        .filter(Boolean)
        .join(" "),
      data: {
        label: (
          <div className="flow-graph-node-content">
            <div className="flow-graph-node-kind-row">
              <span className="flow-graph-node-icon" aria-hidden="true">
                <FlowNodeKindIcon kind={node.kind} />
              </span>
              <span className="flow-graph-node-kind-label">
                {flowNodeKindLabel(node.kind)}
              </span>
              {node.kind === "agent" ? (
                <span className="flow-graph-agent-badge">Reasoning</span>
              ) : null}
            </div>
            <strong className="flow-graph-node-title">{node.label}</strong>
            <small className="flow-graph-node-summary">{summary}</small>
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
        projection.currentNodeId === edge.targetNodeId,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
      },
    };
  });
  return { nodes, edges };
}

function FlowNodeInspector(props: {
  node?: FlowV1Node;
  edges: FlowV1Edge[];
  mode: "design" | "live";
  checkpoint?: FlowV1GraphCheckpoint | null;
  sourceFiles?: Array<{ path: string; content: string }>;
}) {
  if (!props.node) {
    return (
      <aside className="flow-node-inspector flow-node-inspector-empty">
        <CircleAlert size={20} />
        <p>This workflow does not contain any nodes.</p>
      </aside>
    );
  }
  const node = props.node;
  const state = props.checkpoint?.nodes[node.id];
  const incoming = props.edges.filter((edge) => edge.targetNodeId === node.id);
  const outgoing = props.edges.filter((edge) => edge.sourceNodeId === node.id);
  const sourceFile = findNodeSourceFile(node, props.sourceFiles);
  return (
    <aside
      className={`flow-node-inspector flow-node-inspector-kind-${node.kind}`}
      aria-label={`${node.label} details`}
    >
      <div className="flow-node-inspector-header">
        <span className="flow-node-inspector-icon" aria-hidden="true">
          <FlowNodeKindIcon kind={node.kind} />
        </span>
        <div>
          <span>{flowNodeKindLabel(node.kind)} node</span>
          <h4>{node.label}</h4>
          <code>{node.id}</code>
        </div>
      </div>

      {props.mode === "live" ? (
        <NodeDetailSection title="Execution">
          <dl className="flow-node-detail-list">
            <NodeDetailRow label="Status" value={state?.status ?? "idle"} />
            <NodeDetailRow
              label="Attempts"
              value={String(state?.attemptCount ?? 0)}
            />
            {state?.outcome ? (
              <NodeDetailRow label="Outcome" value={state.outcome} />
            ) : null}
          </dl>
          {state?.waitingReason ? (
            <p className="flow-node-detail-notice">{state.waitingReason}</p>
          ) : null}
          {state?.error?.message ? (
            <p className="flow-node-detail-notice" data-tone="danger">
              {state.error.message}
            </p>
          ) : null}
        </NodeDetailSection>
      ) : null}

      <NodeLogicDetails node={node} sourceAvailable={Boolean(sourceFile)} />

      {sourceFile ? (
        <NodeDetailSection title="Source logic" primary={!node.prompt}>
          <div className="flow-node-source-heading">
            <code>{sourceFile.path}</code>
            <span>{sourceFile.content.split("\n").length} lines</span>
          </div>
          <pre className="flow-node-source">
            <code>{sourceFile.content}</code>
          </pre>
        </NodeDetailSection>
      ) : null}

      {Object.keys(node.inputs).length > 0 ? (
        <NodeDetailSection title="Inputs">
          <dl className="flow-node-reference-list">
            {Object.entries(node.inputs).map(([name, reference]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{reference.expression}</dd>
              </div>
            ))}
          </dl>
        </NodeDetailSection>
      ) : null}

      <NodeDetailSection
        title="Routing"
        primary={
          node.kind === "gate" ||
          node.kind === "complete_cycle" ||
          node.kind === "cancel_cycle"
        }
      >
        {node.outcomes.length > 0 ? (
          <div className="flow-node-outcomes">
            {node.outcomes.map((outcome) => (
              <span key={outcome}>{outcome}</span>
            ))}
          </div>
        ) : (
          <p className="flow-node-detail-muted">No declared outcomes.</p>
        )}
        <div className="flow-node-route-summary">
          <span>{incoming.length} incoming</span>
          <span>{outgoing.length} outgoing</span>
        </div>
        {outgoing.length > 0 ? (
          <ul className="flow-node-route-list">
            {outgoing.map((edge) => (
              <li key={edge.id}>
                <code>
                  {edge.kind === "control"
                    ? edge.outcome
                    : edge.sourcePath.join(".") || "data"}
                </code>
                <span aria-hidden="true">→</span>
                <strong>{edge.targetNodeId}</strong>
              </li>
            ))}
          </ul>
        ) : null}
      </NodeDetailSection>

      <details className="flow-node-raw">
        <summary>Complete node definition</summary>
        <pre>
          <code>{JSON.stringify(node, null, 2)}</code>
        </pre>
      </details>
    </aside>
  );
}

function NodeLogicDetails(props: {
  node: FlowV1Node;
  sourceAvailable: boolean;
}) {
  const node = props.node;
  const agent = formatResolvable(node.agent);
  const model = formatResolvable(node.model);
  const permissionMode = formatResolvable(node.permissionMode);
  const hasRuntimeDetails =
    agent ||
    model ||
    permissionMode ||
    node.cwd ||
    node.execution ||
    node.session ||
    node.file;
  return (
    <>
      {node.prompt ? (
        <NodeDetailSection title="Prompt" primary>
          <pre className="flow-node-prompt">{node.prompt}</pre>
        </NodeDetailSection>
      ) : null}

      {node.human ? (
        <NodeDetailSection title="Human review" primary>
          {node.human.description ? <p>{node.human.description}</p> : null}
          <dl className="flow-node-detail-list">
            <NodeDetailRow
              label="Context"
              value={`${node.human.context.length} item(s)`}
            />
            <NodeDetailRow
              label="Actions"
              value={node.human.actions.map((action) => action.label).join(", ")}
            />
          </dl>
        </NodeDetailSection>
      ) : null}

      {node.loop ? (
        <NodeDetailSection title="Loop logic" primary>
          <dl className="flow-node-detail-list">
            <NodeDetailRow
              label="Max iterations"
              value={formatResolvable(node.loop.maxIterations) ?? "—"}
            />
            <NodeDetailRow
              label="On limit"
              value={node.loop.onMaxIterations}
            />
            <NodeDetailRow
              label="Until"
              value={formatCompactJson(node.loop.until)}
            />
          </dl>
          <CompositeSteps steps={node.loop.steps} />
        </NodeDetailSection>
      ) : null}

      {node.map ? (
        <NodeDetailSection title="Map logic" primary>
          <dl className="flow-node-detail-list">
            <NodeDetailRow label="Source" value={node.map.source.expression} />
            <NodeDetailRow label="Max items" value={String(node.map.maxItems)} />
            <NodeDetailRow
              label="Item failure"
              value={node.map.onItemFailure}
            />
            <NodeDetailRow
              label="Rejected item"
              value={node.map.onItemRejected}
            />
          </dl>
          <CompositeSteps steps={node.map.steps} />
        </NodeDetailSection>
      ) : null}

      {node.memorySections || node.memoryUpdates ? (
        <NodeDetailSection title="Memory logic" primary>
          <dl className="flow-node-detail-list">
            {node.memorySections ? (
              <NodeDetailRow
                label="Reads"
                value={node.memorySections.join(", ")}
              />
            ) : null}
            {node.memoryUpdates ? (
              <NodeDetailRow
                label="Updates"
                value={Object.keys(node.memoryUpdates).join(", ")}
              />
            ) : null}
          </dl>
        </NodeDetailSection>
      ) : null}

      {node.terminalOutcome || node.continueMode ? (
        <NodeDetailSection title="Completion" primary>
          <dl className="flow-node-detail-list">
            {node.terminalOutcome ? (
              <NodeDetailRow
                label="Outcome"
                value={node.terminalOutcome}
              />
            ) : null}
            {node.continueMode ? (
              <NodeDetailRow label="Continue" value={node.continueMode} />
            ) : null}
          </dl>
        </NodeDetailSection>
      ) : null}

      {hasRuntimeDetails ? (
        <NodeDetailSection
          title="Implementation"
          primary={
            !node.prompt &&
            !node.human &&
            !node.loop &&
            !node.map &&
            !node.memorySections &&
            !node.memoryUpdates &&
            !node.terminalOutcome &&
            !props.sourceAvailable
          }
        >
          <dl className="flow-node-detail-list">
            {node.file ? <NodeDetailRow label="File" value={node.file} /> : null}
            {agent ? <NodeDetailRow label="Agent" value={agent} /> : null}
            {model ? <NodeDetailRow label="Model" value={model} /> : null}
            {permissionMode ? (
              <NodeDetailRow label="Permissions" value={permissionMode} />
            ) : null}
            {node.cwd ? <NodeDetailRow label="Working dir" value={node.cwd} /> : null}
            {node.execution ? (
              <NodeDetailRow
                label="Execution"
                value={`${node.execution.access} · ${node.execution.isolation}`}
              />
            ) : null}
            {node.session ? (
              <NodeDetailRow
                label="Session"
                value={
                  node.session.mode === "inherit"
                    ? `inherit · ${node.session.key}`
                    : "independent"
                }
              />
            ) : null}
          </dl>
        </NodeDetailSection>
      ) : null}

      {node.retry ? (
        <NodeDetailSection title="Retry policy">
          <dl className="flow-node-detail-list">
            <NodeDetailRow
              label="Max attempts"
              value={String(node.retry.maxAttempts)}
            />
            <NodeDetailRow
              label="Backoff"
              value={`${node.retry.backoffMs} ms`}
            />
            <NodeDetailRow
              label="Error codes"
              value={node.retry.errorCodes.join(", ") || "Any"}
            />
          </dl>
        </NodeDetailSection>
      ) : null}
    </>
  );
}

function NodeDetailSection(props: {
  title: string;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <section
      className={`flow-node-detail-section${props.primary ? " is-primary" : ""}`}
    >
      <h5>{props.title}</h5>
      {props.children}
    </section>
  );
}

function NodeDetailRow(props: { label: string; value: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function CompositeSteps(props: {
  steps: Array<
    NonNullable<FlowV1Node["loop"]>["steps"][number] |
    NonNullable<FlowV1Node["map"]>["steps"][number]
  >;
}) {
  return (
    <ol className="flow-node-step-list">
      {props.steps.map((step) => (
        <li key={step.id}>
          <span>{step.kind}</span>
          <strong>{step.label}</strong>
          {"prompt" in step && step.prompt ? <p>{step.prompt}</p> : null}
        </li>
      ))}
    </ol>
  );
}

function formatResolvable(
  value:
    | FlowV1Node["agent"]
    | FlowV1Node["model"]
    | FlowV1Node["permissionMode"]
    | NonNullable<FlowV1Node["loop"]>["maxIterations"],
): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return value.expression;
}

function formatCompactJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('"', "");
}

function findNodeSourceFile(
  node: FlowV1Node,
  files?: Array<{ path: string; content: string }>,
): { path: string; content: string } | null {
  if (!node.file || !files) {
    return null;
  }
  const normalizedPath = node.file.replace(/^\.\//, "");
  const file =
    files.find((candidate) => candidate.path === node.file) ??
    files.find(
      (candidate) => candidate.path.replace(/^\.\//, "") === normalizedPath,
    );
  return file ? { path: file.path, content: file.content } : null;
}

function FlowNodeKindIcon(props: { kind: FlowV1Node["kind"] }) {
  switch (props.kind) {
    case "agent":
      return <Bot size={15} />;
    case "human":
      return <UserRound size={15} />;
    case "script":
      return <Code2 size={15} />;
    case "transform":
      return <Braces size={15} />;
    case "gate":
      return <GitBranch size={15} />;
    case "effect":
      return <Zap size={15} />;
    case "finally":
      return <CheckCircle2 size={15} />;
    case "loop":
      return <Repeat2 size={15} />;
    case "map":
      return <Layers3 size={15} />;
    case "remember":
      return <Brain size={15} />;
    case "complete_cycle":
      return <CheckCircle2 size={15} />;
    case "cancel_cycle":
      return <Ban size={15} />;
  }
}

function flowNodeKindLabel(kind: FlowV1Node["kind"]): string {
  switch (kind) {
    case "complete_cycle":
      return "Complete";
    case "cancel_cycle":
      return "Cancel";
    default:
      return capitalize(kind);
  }
}

function flowNodeDesignSummary(node: FlowV1Node): string {
  if (node.kind === "agent") {
    const agent = typeof node.agent === "string" ? node.agent : "Agent";
    const model = typeof node.model === "string" ? node.model : null;
    return [agent, model, node.execution?.access]
      .filter(Boolean)
      .join(" · ");
  }
  if (node.kind === "human") {
    return "Human decision checkpoint";
  }
  if (node.kind === "effect") {
    return node.file ? `External effect · ${node.file}` : "External effect";
  }
  if (
    node.kind === "script" ||
    node.kind === "transform" ||
    node.kind === "finally"
  ) {
    return node.file
      ? `${flowNodeKindLabel(node.kind)} · ${node.file}`
      : "Code execution";
  }
  if (node.kind === "gate") {
    return `${node.outcomes.length} routed outcome(s)`;
  }
  if (node.kind === "loop") {
    return `${node.loop?.steps.length ?? 0} step loop`;
  }
  if (node.kind === "map") {
    return `${node.map?.steps.length ?? 0} step map`;
  }
  if (node.kind === "remember") {
    return "Persist workflow memory";
  }
  if (node.kind === "complete_cycle" || node.kind === "cancel_cycle") {
    return "Terminal node";
  }
  if (node.execution) {
    return `${node.execution.access} · ${node.execution.isolation}`;
  }
  const inputCount = Object.keys(node.inputs).length;
  return inputCount > 0 ? `${inputCount} input(s)` : "Entry node";
}

function layoutFlowGraph(
  projection: {
    graph: { nodes: FlowV1Node[]; edges: FlowV1Edge[] };
  },
): Map<string, number> {
  const nodeIds = new Set(projection.graph.nodes.map((node) => node.id));
  const levels = new Map(projection.graph.nodes.map((node) => [node.id, 0]));
  const incomingCount = new Map(
    projection.graph.nodes.map((node) => [node.id, 0]),
  );
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of projection.graph.edges) {
    if (
      !nodeIds.has(edge.sourceNodeId) ||
      !nodeIds.has(edge.targetNodeId) ||
      edge.sourceNodeId === edge.targetNodeId
    ) {
      continue;
    }
    outgoing.set(edge.sourceNodeId, [
      ...(outgoing.get(edge.sourceNodeId) ?? []),
      edge.targetNodeId,
    ]);
    incoming.set(edge.targetNodeId, [
      ...(incoming.get(edge.targetNodeId) ?? []),
      edge.sourceNodeId,
    ]);
    incomingCount.set(
      edge.targetNodeId,
      (incomingCount.get(edge.targetNodeId) ?? 0) + 1,
    );
  }
  const queue = projection.graph.nodes
    .filter((node) => (incomingCount.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const sourceId = queue.shift();
    if (!sourceId) {
      continue;
    }
    visited.add(sourceId);
    for (const targetId of outgoing.get(sourceId) ?? []) {
      levels.set(
        targetId,
        Math.max(
          levels.get(targetId) ?? 0,
          (levels.get(sourceId) ?? 0) + 1,
        ),
      );
      const remaining = (incomingCount.get(targetId) ?? 1) - 1;
      incomingCount.set(targetId, remaining);
      if (remaining === 0) {
        queue.push(targetId);
      }
    }
  }
  for (const node of projection.graph.nodes) {
    if (visited.has(node.id)) {
      continue;
    }
    const resolvedPredecessorLevels = (incoming.get(node.id) ?? [])
      .filter((sourceId) => visited.has(sourceId))
      .map((sourceId) => levels.get(sourceId) ?? 0);
    levels.set(
      node.id,
      resolvedPredecessorLevels.length > 0
        ? Math.max(...resolvedPredecessorLevels) + 1
        : levels.get(node.id) ?? 0,
    );
    visited.add(node.id);
  }
  const lastLevel = Math.max(0, ...levels.values());
  for (const node of projection.graph.nodes) {
    if (node.kind === "finally" && (levels.get(node.id) ?? 0) === 0) {
      levels.set(node.id, lastLevel + 1);
    }
  }
  return levels;
}

function orderFlowGraphGroups(
  groups: Map<number, string[]>,
  edges: FlowV1Edge[],
  levels: Map<string, number>,
) {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    incoming.set(edge.targetNodeId, [
      ...(incoming.get(edge.targetNodeId) ?? []),
      edge.sourceNodeId,
    ]);
    outgoing.set(edge.sourceNodeId, [
      ...(outgoing.get(edge.sourceNodeId) ?? []),
      edge.targetNodeId,
    ]);
  }
  const lastLevel = Math.max(0, ...groups.keys());
  for (let pass = 0; pass < 3; pass += 1) {
    for (let level = 1; level <= lastLevel; level += 1) {
      sortFlowGraphLevel(groups, level, incoming, levels);
    }
    for (let level = lastLevel - 1; level >= 0; level -= 1) {
      sortFlowGraphLevel(groups, level, outgoing, levels);
    }
  }
}

function sortFlowGraphLevel(
  groups: Map<number, string[]>,
  level: number,
  neighbors: Map<string, string[]>,
  levels: Map<string, number>,
) {
  const nodes = groups.get(level);
  if (!nodes || nodes.length < 2) {
    return;
  }
  const previousOrder = new Map(nodes.map((nodeId, index) => [nodeId, index]));
  const rowByNodeId = new Map<string, number>();
  for (const [groupLevel, groupNodes] of groups) {
    for (const [index, nodeId] of groupNodes.entries()) {
      rowByNodeId.set(
        nodeId,
        index - (groupNodes.length - 1) / 2 + groupLevel * 0.0001,
      );
    }
  }
  nodes.sort((left, right) => {
    const leftScore = flowGraphBarycenter(
      left,
      level,
      neighbors,
      levels,
      rowByNodeId,
    );
    const rightScore = flowGraphBarycenter(
      right,
      level,
      neighbors,
      levels,
      rowByNodeId,
    );
    return (
      leftScore - rightScore ||
      (previousOrder.get(left) ?? 0) - (previousOrder.get(right) ?? 0)
    );
  });
}

function flowGraphBarycenter(
  nodeId: string,
  level: number,
  neighbors: Map<string, string[]>,
  levels: Map<string, number>,
  rowByNodeId: Map<string, number>,
): number {
  const relevantRows = (neighbors.get(nodeId) ?? [])
    .filter((neighborId) => (levels.get(neighborId) ?? level) !== level)
    .map((neighborId) => rowByNodeId.get(neighborId))
    .filter((row): row is number => row !== undefined);
  if (relevantRows.length === 0) {
    return rowByNodeId.get(nodeId) ?? 0;
  }
  return (
    relevantRows.reduce((total, row) => total + row, 0) /
    relevantRows.length
  );
}

function HumanTasks(props: {
  workflowId: string;
  projection: FlowV1DetailProjection;
  onRefresh: () => Promise<unknown>;
  onResolved: () => void;
}) {
  const tasks = props.projection.humanTasks.filter(
    (task) => task.status === "pending",
  );
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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
      const key = humanFieldKey(task, action, missing.id);
      setFieldErrors({ [key]: `${missing.label} is required.` });
      setMessage(null);
      window.setTimeout(() => {
        document.getElementById(`${task.id}-${action.id}-${missing.id}`)?.focus();
      });
      return;
    }
    setPendingTaskId(task.id);
    setMessage(null);
    setFieldErrors({});
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
      setMessage("Decision recorded. The workflow will continue.");
      await props.onRefresh();
      props.onResolved();
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

  function updateFieldValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!current[key]) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  return (
    <div className="flow-runtime-human-tasks">
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
                    const errorId = `${id}-error`;
                    const fieldError = fieldErrors[key];
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
                            aria-describedby={fieldError ? errorId : undefined}
                            aria-invalid={Boolean(fieldError)}
                            disabled={pendingTaskId !== null}
                            id={id}
                            onChange={(event) =>
                              updateFieldValue(
                                key,
                                event.currentTarget.value,
                              )
                            }
                            placeholder={field.placeholder}
                            rows={3}
                            value={value}
                          />
                        ) : field.type === "select" ? (
                          <select
                            aria-describedby={fieldError ? errorId : undefined}
                            aria-invalid={Boolean(fieldError)}
                            disabled={pendingTaskId !== null}
                            id={id}
                            onChange={(event) =>
                              updateFieldValue(
                                key,
                                event.currentTarget.value,
                              )
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
                            aria-describedby={fieldError ? errorId : undefined}
                            aria-invalid={Boolean(fieldError)}
                            disabled={pendingTaskId !== null}
                            id={id}
                            onChange={(event) =>
                              updateFieldValue(
                                key,
                                event.currentTarget.value,
                              )
                            }
                            placeholder={field.placeholder}
                            type="text"
                            value={value}
                          />
                        )}
                        {fieldError ? (
                          <small className="flow-field-error" id={errorId}>
                            {fieldError}
                          </small>
                        ) : null}
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
        title="Step attempts"
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
      setMessage("Memory conflict resolved. The workflow will continue.");
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
              <dt>Step</dt>
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

function SchemaField(props: {
  name: string;
  idPrefix: string;
  definition: FlowV1SchemaEntry;
  error?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `${props.idPrefix}-${props.name}`;
  const errorId = `${id}-error`;
  const constraints = inputConstraintLabel(props.definition);
  const isBoolean = schemaHelperKind(props.definition.helper) === "boolean";
  const isJson = schemaHelperKind(props.definition.helper) === "json";
  const isNumber = schemaHelperKind(props.definition.helper) === "number";
  return (
    <label
      className={
        isJson
          ? "flow-invocation-input flow-invocation-input-wide"
          : "flow-invocation-input"
      }
      htmlFor={id}
    >
      <span>
        <strong>{humanizeIdentifier(props.name)}</strong>
        {props.definition.required ? <em>Required</em> : <small>Optional</small>}
      </span>
      {isBoolean ? (
        <select
          aria-describedby={props.error ? errorId : undefined}
          aria-invalid={Boolean(props.error)}
          id={id}
          onChange={(event) => props.onChange(event.currentTarget.value)}
          value={props.value}
        >
          <option value="">Choose a value…</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : isJson ? (
        <textarea
          aria-describedby={props.error ? errorId : undefined}
          aria-invalid={Boolean(props.error)}
          id={id}
          onChange={(event) => props.onChange(event.currentTarget.value)}
          placeholder={props.definition.required ? "Enter valid JSON" : "Optional JSON value"}
          rows={4}
          value={props.value}
        />
      ) : (
        <input
          aria-describedby={props.error ? errorId : undefined}
          aria-invalid={Boolean(props.error)}
          id={id}
          inputMode={isNumber ? "decimal" : undefined}
          max={
            typeof props.definition.config.max === "number"
              ? props.definition.config.max
              : undefined
          }
          min={
            typeof props.definition.config.min === "number"
              ? props.definition.config.min
              : undefined
          }
          onChange={(event) => props.onChange(event.currentTarget.value)}
          placeholder={
            props.definition.required ? "Enter a value" : "Optional"
          }
          step={
            props.definition.config.integer === true
              ? 1
              : isNumber
                ? "any"
                : undefined
          }
          type={isNumber ? "number" : "text"}
          value={props.value}
        />
      )}
      {props.error ? (
        <small className="flow-field-error" id={errorId}>
          {props.error}
        </small>
      ) : null}
      {constraints ? <small>{constraints}</small> : null}
    </label>
  );
}

function RuntimeMetric(props: {
  label: string;
  value: string;
}) {
  return (
    <div className="flow-runtime-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
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

function formatStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function flowGuidance(
  projection: FlowV1DetailProjection,
  action: FlowAction | null,
): { title: string; description: string } {
  const inputCount = Object.keys(projection.configuration.inputsSchema).length;
  if (action === "start") {
    return {
      title: "Start this workflow",
      description:
        inputCount > 0
          ? `Add ${inputCount} input${inputCount === 1 ? "" : "s"}, then start the first run.`
          : "Start the first run now. Progress will appear in Activity below.",
    };
  }
  if (action === "resume") {
    return {
      title: "Continue from where it paused",
      description:
        "Run the next step using the workflow's saved state and latest results.",
    };
  }
  if (action === "retry") {
    return {
      title: "This step needs another try",
      description:
        "Retry the current step. Earlier completed work will stay intact.",
    };
  }
  if (action === "cancel") {
    return {
      title: "The workflow is running",
      description:
        "You can follow its progress below. Stop it only if you do not want the current run to continue.",
    };
  }
  if (action === "restart") {
    return {
      title: "Restart from the beginning",
      description:
        "Stop the current run and start a new one from the first step with the same inputs.",
    };
  }
  if (projection.selectedCycle?.status === "waiting_human") {
    return {
      title: "Your decision is needed",
      description:
        "Review the pending decision and respond before the workflow can continue.",
    };
  }
  if (projection.selectedCycle?.status === "paused_conflict") {
    return {
      title: "Resolve the saved-memory conflict",
      description:
        "Choose which memory version to keep before this workflow can continue.",
    };
  }
  return {
    title: "No action is needed right now",
    description:
      "Review the current activity below. This page will update as the workflow progresses.",
  };
}

function flowGuidanceIcon(
  action: FlowAction | null,
  status: string | undefined,
) {
  if (action === "start") {
    return <Play size={20} />;
  }
  if (
    action === "resume" ||
    action === "retry" ||
    action === "restart"
  ) {
    return <RefreshCw size={19} />;
  }
  if (action === "cancel") {
    return <Zap size={19} />;
  }
  if (status === "waiting_human" || status === "paused_conflict") {
    return <CircleAlert size={20} />;
  }
  return <CheckCircle2 size={20} />;
}

function flowActionIcon(action: FlowAction) {
  switch (action) {
    case "start":
      return <Play aria-hidden="true" size={15} />;
    case "resume":
    case "retry":
      return <RefreshCw aria-hidden="true" size={14} />;
    case "restart":
      return <Repeat2 aria-hidden="true" size={14} />;
    case "cancel":
      return <Square aria-hidden="true" size={13} />;
  }
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
      return "Start workflow";
    case "resume":
      return "Continue workflow";
    case "retry":
      return "Retry step";
    case "cancel":
      return "Stop current run";
    case "restart":
      return "Restart from beginning";
  }
}

function flowActionSuccessMessage(action: FlowAction): string {
  switch (action) {
    case "start":
      return "Workflow started. This page will update automatically.";
    case "resume":
      return "Workflow continued. This page will update automatically.";
    case "retry":
      return "Retry started. This page will update automatically.";
    case "cancel":
      return "Stop requested.";
    case "restart":
      return "Workflow restarted from the beginning.";
  }
}

function createSchemaValueDraft(
  schema: Record<string, FlowV1SchemaEntry>,
  currentValues: Record<string, unknown> = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(schema).map(([name, definition]) => {
      const hasCurrentValue = Object.hasOwn(currentValues, name);
      const value = hasCurrentValue
        ? currentValues[name]
        : definition.config.default;
      if (!hasCurrentValue && !definition.hasDefault) {
        return [name, ""];
      }
      if (schemaHelperKind(definition.helper) === "json") {
        return [name, JSON.stringify(value, null, 2)];
      }
      return [name, String(value)];
    }),
  );
}

class SchemaFieldError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "SchemaFieldError";
    this.field = field;
  }
}

function prepareSecretBindings(
  bindings: Record<string, FlowV1SecretBinding>,
): Record<string, FlowV1SecretBinding> {
  const prepared: Record<string, FlowV1SecretBinding> = {};
  for (const [name, binding] of Object.entries(bindings)) {
    if (binding.kind === "environment") {
      const env = binding.env.trim();
      if (!env) {
        continue;
      }
      if (looksLikeSecretValue(env)) {
        throw new SchemaFieldError(
          name,
          `${humanizeIdentifier(name)} looks like a token value. Select a connection or enter only an environment variable name.`,
        );
      }
      prepared[name] = { kind: "environment", env };
      continue;
    }
    prepared[name] = binding;
  }
  return prepared;
}

function parseSchemaValues(
  schema: Record<string, FlowV1SchemaEntry>,
  draft: Record<string, string>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(schema)) {
    const source = draft[name]?.trim() ?? "";
    if (!source) {
      if (definition.required && !definition.hasDefault) {
        throw new SchemaFieldError(
          name,
          `${humanizeIdentifier(name)} is required.`,
        );
      }
      if (definition.hasDefault) {
        values[name] = definition.config.default;
      }
      continue;
    }
    const kind = schemaHelperKind(definition.helper);
    if (kind === "number") {
      const numberValue = Number(source);
      if (!Number.isFinite(numberValue)) {
        throw new SchemaFieldError(
          name,
          `${humanizeIdentifier(name)} must be a number.`,
        );
      }
      if (
        definition.config.integer === true &&
        !Number.isInteger(numberValue)
      ) {
        throw new SchemaFieldError(
          name,
          `${humanizeIdentifier(name)} must be a whole number.`,
        );
      }
      if (
        typeof definition.config.min === "number" &&
        numberValue < definition.config.min
      ) {
        throw new SchemaFieldError(
          name,
          `${humanizeIdentifier(name)} must be at least ${definition.config.min}.`,
        );
      }
      if (
        typeof definition.config.max === "number" &&
        numberValue > definition.config.max
      ) {
        throw new SchemaFieldError(
          name,
          `${humanizeIdentifier(name)} must be at most ${definition.config.max}.`,
        );
      }
      values[name] = numberValue;
      continue;
    }
    if (kind === "boolean") {
      if (source !== "true" && source !== "false") {
        throw new SchemaFieldError(
          name,
          `${humanizeIdentifier(name)} must be true or false.`,
        );
      }
      values[name] = source === "true";
      continue;
    }
    if (kind === "json") {
      try {
        values[name] = JSON.parse(source);
      } catch (error) {
        throw new SchemaFieldError(
          name,
          `${humanizeIdentifier(name)} must be valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      continue;
    }
    if (
      typeof definition.config.minLength === "number" &&
      source.length < definition.config.minLength
    ) {
      throw new SchemaFieldError(
        name,
        `${humanizeIdentifier(name)} must be at least ${definition.config.minLength} characters.`,
      );
    }
    if (
      typeof definition.config.maxLength === "number" &&
      source.length > definition.config.maxLength
    ) {
      throw new SchemaFieldError(
        name,
        `${humanizeIdentifier(name)} must be at most ${definition.config.maxLength} characters.`,
      );
    }
    values[name] = source;
  }
  return values;
}

function schemaHelperKind(
  helper: string,
): "string" | "number" | "boolean" | "json" {
  if (helper.startsWith("number")) {
    return "number";
  }
  if (helper.startsWith("boolean")) {
    return "boolean";
  }
  if (helper.startsWith("json")) {
    return "json";
  }
  return "string";
}

function humanizeIdentifier(value: string): string {
  const words = value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

function inputConstraintLabel(definition: FlowV1SchemaEntry): string | null {
  const labels: string[] = [];
  if (definition.hasDefault) {
    labels.push("A default is already filled in");
  }
  if (typeof definition.config.minLength === "number") {
    labels.push(`Minimum ${definition.config.minLength} characters`);
  }
  if (typeof definition.config.maxLength === "number") {
    labels.push(`Maximum ${definition.config.maxLength} characters`);
  }
  if (typeof definition.config.min === "number") {
    labels.push(`Minimum ${definition.config.min}`);
  }
  if (typeof definition.config.max === "number") {
    labels.push(`Maximum ${definition.config.max}`);
  }
  return labels.length > 0 ? labels.join(" · ") : null;
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
