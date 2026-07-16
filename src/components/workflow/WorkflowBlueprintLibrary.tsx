"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EyeIcon,
  FileCreateIcon,
  Input,
  LoadingIcon,
  MoreHorizontalIcon,
  SearchIcon,
  UnderlineTabs,
} from "@tutti-os/ui-system";
import {
  instantiateWorkflowBlueprint,
  listWorkflowBlueprints,
  loadWorkflowBlueprint,
  parseWorkflowScript,
  readApiJsonError,
  searchWorkflowBlueprints,
} from "@/components/workflow/workflowApiService";
import { useWorkflowFlowLayout } from "@/components/workflow/useWorkflowFlowLayout";
import { NODE_TYPES } from "@/components/workflow/WorkflowGraphNode";
import type {
  FlowNodeData,
  MainView,
} from "@/components/workflow/WorkflowWorkbench.types";
import type {
  WorkflowBlueprintDetail,
  WorkflowBlueprintSummary,
} from "@/lib/workflow/blueprint-types";
import type {
  ParsedWorkflow,
  WorkflowInputDefinition,
} from "@/lib/workflow/types";

export function WorkflowBlueprintLibrary() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [blueprints, setBlueprints] = useState<WorkflowBlueprintSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionBlueprintId, setActionBlueprintId] = useState<string | undefined>();
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<
    string | undefined
  >();
  const [selectedBlueprint, setSelectedBlueprint] = useState<
    WorkflowBlueprintDetail | undefined
  >();
  const [selectedParsed, setSelectedParsed] = useState<
    ParsedWorkflow | undefined
  >();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | undefined>();
  const [detailView, setDetailView] = useState<MainView>("graph");
  const [detailActionError, setDetailActionError] = useState<
    string | undefined
  >();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let mounted = true;

    async function loadBlueprints() {
      setLoading(true);
      setError(undefined);
      try {
        const trimmed = query.trim();
        const nextBlueprints = trimmed
          ? await searchWorkflowBlueprints({ query: trimmed, limit: 12 })
          : await listWorkflowBlueprints();
        if (mounted) {
          setBlueprints(nextBlueprints);
        }
      } catch (caught) {
        if (mounted) {
          setError(readApiJsonError(caught).message);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    void loadBlueprints();

    return () => {
      mounted = false;
    };
  }, [query]);

  useEffect(() => {
    if (!selectedBlueprintId) {
      setSelectedBlueprint(undefined);
      setSelectedParsed(undefined);
      setDetailError(undefined);
      setDetailActionError(undefined);
      setDetailView("graph");
      return;
    }

    const blueprintId = selectedBlueprintId;
    let mounted = true;

    async function loadDetail() {
      setDetailLoading(true);
      setDetailError(undefined);
      setDetailActionError(undefined);
      setSelectedBlueprint(undefined);
      setSelectedParsed(undefined);
      try {
        const blueprint = await loadWorkflowBlueprint(blueprintId);
        const parsed = await parseWorkflowScript(blueprint.script);
        if (mounted) {
          setSelectedBlueprint(blueprint);
          setSelectedParsed(parsed);
        }
      } catch (caught) {
        if (mounted) {
          setDetailError(readApiJsonError(caught).message);
        }
      } finally {
        if (mounted) {
          setDetailLoading(false);
        }
      }
    }

    void loadDetail();

    return () => {
      mounted = false;
    };
  }, [selectedBlueprintId]);

  async function useBlueprint(
    blueprintId: string,
    options: { surface: "list" | "detail" } = { surface: "list" },
  ) {
    setActionBlueprintId(blueprintId);
    if (options.surface === "detail") {
      setDetailActionError(undefined);
    } else {
      setError(undefined);
    }
    try {
      const detail = await instantiateWorkflowBlueprint(blueprintId);
      router.push(`/workflows/${detail.workflow.id}`);
    } catch (caught) {
      const message = readApiJsonError(
        caught,
        "WORKFLOW_IMPORT_FAILED",
      ).message;
      if (options.surface === "detail") {
        setDetailActionError(message);
      } else {
        setError(message);
      }
    } finally {
      setActionBlueprintId(undefined);
    }
  }

  return (
    <section
      className="blueprint-library"
      id="workflow-templates"
      aria-labelledby="blueprint-library-title"
    >
      <div className="section-heading">
        <div className="section-heading-main">
          <h2 id="blueprint-library-title">Templates</h2>
          <p>Start with a proven workflow pattern.</p>
        </div>
        <label className="blueprint-search">
          <SearchIcon size={16} />
          <Input
            value={query}
            aria-label="Search workflow blueprints"
            placeholder="Search blueprints"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {error ? <div className="diagnostic error">{error}</div> : null}

      <div className="blueprint-grid" aria-busy={loading}>
        {loading ? (
          <BlueprintSkeleton />
        ) : blueprints.length > 0 ? (
          blueprints.map((blueprint) => (
            <BlueprintCard
              key={blueprint.id}
              blueprint={blueprint}
              loading={actionBlueprintId === blueprint.id}
              onPreviewBlueprint={setSelectedBlueprintId}
              onUseBlueprint={(blueprintId) =>
                useBlueprint(blueprintId, { surface: "list" })
              }
            />
          ))
        ) : (
          <div className="blueprint-empty">No blueprints match this search.</div>
        )}
      </div>

      <BlueprintDetailDialog
        open={Boolean(selectedBlueprintId)}
        blueprint={selectedBlueprint}
        parsed={selectedParsed}
        loading={detailLoading}
        error={detailError}
        actionError={detailActionError}
        view={detailView}
        instantiating={Boolean(
          selectedBlueprintId && actionBlueprintId === selectedBlueprintId,
        )}
        onViewChange={setDetailView}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedBlueprintId(undefined);
          }
        }}
        onUseBlueprint={(blueprintId) =>
          useBlueprint(blueprintId, { surface: "detail" })
        }
      />
    </section>
  );
}

function BlueprintCard(props: {
  blueprint: WorkflowBlueprintSummary;
  loading: boolean;
  onPreviewBlueprint: (blueprintId: string) => void;
  onUseBlueprint: (blueprintId: string) => Promise<void>;
}) {
  const { blueprint } = props;

  return (
    <Card className="blueprint-card" size="sm">
      <button
        className="blueprint-card-main"
        type="button"
        onClick={() => props.onPreviewBlueprint(blueprint.id)}
      >
        <span className="blueprint-card-icon">
          <FileCreateIcon size={22} />
        </span>
        <span className="blueprint-card-copy">
          <span className="blueprint-card-title-row">
            <span className="blueprint-card-title">{blueprint.title}</span>
          </span>
          <span className="blueprint-card-description">{blueprint.description}</span>
          <span className="blueprint-card-meta">
            <Badge
              variant={blueprint.difficulty === "starter" ? "success" : "pending"}
            >
              {blueprint.difficulty}
            </Badge>
            {blueprint.requiresCwd ? (
              <Badge variant="warning">Project</Badge>
            ) : null}
          </span>
        </span>
      </button>
      <div className="blueprint-card-menu">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="card-overflow-trigger"
              variant="outline"
              size="icon-lg"
              type="button"
              aria-label={`More actions for ${blueprint.title}`}
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => props.onPreviewBlueprint(blueprint.id)}
            >
              <EyeIcon data-icon="inline-start" />
              Preview
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void props.onUseBlueprint(blueprint.id)}
              disabled={props.loading}
            >
              {props.loading ? (
                <LoadingIcon className="spin" data-icon="inline-start" />
              ) : (
                <FileCreateIcon data-icon="inline-start" />
              )}
              Create workflow
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
}

function BlueprintDetailDialog(props: {
  open: boolean;
  blueprint?: WorkflowBlueprintDetail;
  parsed?: ParsedWorkflow;
  loading: boolean;
  error?: string;
  actionError?: string;
  view: MainView;
  instantiating: boolean;
  onViewChange: (view: MainView) => void;
  onOpenChange: (open: boolean) => void;
  onUseBlueprint: (blueprintId: string) => Promise<void>;
}) {
  const blueprint = props.blueprint;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="blueprint-detail-dialog">
        <DialogHeader>
          <DialogTitle>{blueprint?.title ?? "Blueprint preview"}</DialogTitle>
          <DialogDescription>
            {blueprint?.description ?? "Loading blueprint details."}
          </DialogDescription>
        </DialogHeader>

        {props.error ? (
          <div className="diagnostic error">{props.error}</div>
        ) : props.loading || !blueprint ? (
          <div className="blueprint-detail-loading">
            <LoadingIcon className="spin" />
            Loading blueprint
          </div>
        ) : (
          <div className="blueprint-detail-body">
            {props.actionError ? (
              <div className="diagnostic error">{props.actionError}</div>
            ) : null}

            <div className="blueprint-detail-meta">
              <Badge variant="outline">{blueprint.category}</Badge>
              <Badge
                variant={
                  blueprint.difficulty === "starter" ? "success" : "pending"
                }
              >
                {blueprint.difficulty}
              </Badge>
              {blueprint.requiresCwd ? (
                <Badge variant="warning">requires cwd</Badge>
              ) : null}
              {blueprint.tags.map((tag) => (
                <Badge key={tag} variant="muted">
                  {tag}
                </Badge>
              ))}
            </div>

            <div className="blueprint-detail-summary">
              <p>{blueprint.patternSummary}</p>
              <ul>
                {blueprint.useCases.map((useCase) => (
                  <li key={useCase}>{useCase}</li>
                ))}
              </ul>
            </div>

            {props.parsed ? (
              <BlueprintOverview parsed={props.parsed} />
            ) : null}

            <div className="blueprint-preview-header">
              <div>
                <h3>
                  {props.view === "graph" ? "DAG preview" : "Script preview"}
                </h3>
                <p>
                  {props.parsed
                    ? `${props.parsed.nodes.length} nodes, ${props.parsed.edges.length} edges across ${props.parsed.phases.length} phases`
                    : "Preview unavailable until parsing completes."}
                </p>
              </div>
              <UnderlineTabs
                ariaLabel="Blueprint preview view"
                value={props.view}
                onValueChange={(value) => {
                  if (value === "graph" || value === "script") {
                    props.onViewChange(value);
                  }
                }}
                tabs={[
                  { value: "graph", label: "DAG" },
                  { value: "script", label: "Code" },
                ]}
                className="blueprint-preview-tabs"
              />
            </div>

            {props.view === "graph" && props.parsed ? (
              <BlueprintGraphPreview parsed={props.parsed} />
            ) : (
              <pre className="blueprint-script-preview">
                <code>{blueprint.script}</code>
              </pre>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            size="dialog"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            type="button"
            size="dialog"
            onClick={() => {
              if (blueprint) {
                void props.onUseBlueprint(blueprint.id);
              }
            }}
            disabled={!blueprint || props.instantiating}
          >
            {props.instantiating ? (
              <LoadingIcon className="spin" data-icon="inline-start" />
            ) : (
              <FileCreateIcon data-icon="inline-start" />
            )}
            Create from blueprint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BlueprintOverview(props: { parsed: ParsedWorkflow }) {
  const inputEntries = Object.entries(props.parsed.inputSchema);
  const loopNodes = props.parsed.nodes.filter((node) => node.kind === "loop");
  const agentCount = props.parsed.nodes.filter(
    (node) => node.kind === "agent",
  ).length;
  const loopStepCount = loopNodes.reduce(
    (total, node) => total + (node.loop?.steps.length ?? 0),
    0,
  );

  return (
    <div className="blueprint-overview-grid">
      <div className="blueprint-overview-panel">
        <h4>Blueprint inputs</h4>
        {inputEntries.length > 0 ? (
          <div className="blueprint-overview-list">
            {inputEntries.map(([name, definition]) => (
              <div className="blueprint-overview-row" key={name}>
                <span>
                  {formatInputLabel(name, definition)}
                  {definition.required ? (
                    <Badge variant="warning">required</Badge>
                  ) : null}
                </span>
                <small>{formatInputDetails(definition)}</small>
              </div>
            ))}
          </div>
        ) : (
          <p>No run inputs declared.</p>
        )}
      </div>

      <div className="blueprint-overview-panel">
        <h4>Structure</h4>
        <div className="blueprint-overview-metrics">
          <Metric label="Phases" value={props.parsed.phases.length} />
          <Metric label="Nodes" value={props.parsed.nodes.length} />
          <Metric label="Agents" value={agentCount + loopStepCount} />
          <Metric label="Loops" value={loopNodes.length} />
        </div>
        <div className="blueprint-overview-chips">
          {props.parsed.meta.requiresCwd ? (
            <Badge variant="warning">requires project</Badge>
          ) : (
            <Badge variant="muted">no project required</Badge>
          )}
          {loopNodes.length > 0 ? (
            <Badge variant="pending">loop primitive</Badge>
          ) : null}
          {props.parsed.phases.map((phase) => (
            <Badge key={phase.id} variant="outline">
              {phase.title}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

function BlueprintGraphPreview(props: { parsed: ParsedWorkflow }) {
  const nodeStatuses = useMemo(() => ({}), []);
  const { flowNodes, flowEdges } = useWorkflowFlowLayout({
    parsed: props.parsed,
    nodeStatuses,
  });

  return (
    <div className="blueprint-graph-preview">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        fitView
        minZoom={0.25}
        maxZoom={1.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onInit={(instance: ReactFlowInstance<Node<FlowNodeData>, Edge>) => {
          window.requestAnimationFrame(() => {
            void instance.fitView({ padding: 0.26 });
          });
        }}
      >
        <Background color="var(--border-1)" gap={24} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function Metric(props: { label: string; value: number }) {
  return (
    <div className="blueprint-overview-metric">
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function formatInputLabel(
  name: string,
  definition: WorkflowInputDefinition,
): string {
  return definition.label ? `${definition.label} (${name})` : name;
}

function formatInputDetails(definition: WorkflowInputDefinition): string {
  const parts: string[] = [definition.type];
  if ("widget" in definition && definition.widget) {
    parts.push(definition.widget);
  }
  if ("options" in definition) {
    parts.push(`${definition.options.length} options`);
  }
  if (definition.default !== undefined) {
    parts.push("has default");
  }
  return parts.join(" · ");
}

function BlueprintSkeleton() {
  return (
    <Card className="blueprint-card" size="sm">
      <div className="blueprint-skeleton">
        <span className="skeleton" style={{ width: "62%", height: 18 }} />
        <span className="skeleton" style={{ width: "100%", height: 12 }} />
        <span className="skeleton" style={{ width: "88%", height: 12 }} />
        <span className="skeleton" style={{ width: "42%", height: 28 }} />
      </div>
    </Card>
  );
}
