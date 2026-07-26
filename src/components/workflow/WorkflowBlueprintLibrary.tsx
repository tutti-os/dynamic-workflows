"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
  readApiJsonError,
  searchWorkflowBlueprints,
} from "@/components/workflow/workflowApiService";
import type {
  WorkflowBlueprintDetail,
  WorkflowBlueprintSummary,
} from "@/lib/workflow/blueprint-types";

type BlueprintView = "graph" | "script";

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
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | undefined>();
  const [detailView, setDetailView] = useState<BlueprintView>("graph");
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
      try {
        const blueprint = await loadWorkflowBlueprint(blueprintId);
        if (mounted) {
          setSelectedBlueprint(blueprint);
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
  loading: boolean;
  error?: string;
  actionError?: string;
  view: BlueprintView;
  instantiating: boolean;
  onViewChange: (view: BlueprintView) => void;
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

            {blueprint.preview ? (
              <BlueprintFlowOverview blueprint={blueprint} />
            ) : null}

            <div className="blueprint-preview-header">
              <div>
                <h3>
                  {props.view === "graph"
                    ? "Flow preview"
                    : "Bundle source"}
                </h3>
                <p>
                  {blueprint.preview
                    ? `${blueprint.preview.nodes.length} nodes · ${blueprint.preview.edges.length} edges · ${blueprint.bundle.files.length} files`
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

            {props.view === "graph" && blueprint.preview ? (
              <BlueprintFlowPreview blueprint={blueprint} />
            ) : (
              <pre className="blueprint-script-preview">
                <code>
                  {blueprint.bundle.files
                    .map(
                      (file) =>
                        `===== ${file.path} =====\n${file.content}`,
                    )
                    .join("\n\n")}
                </code>
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

function BlueprintFlowOverview(props: {
  blueprint: Extract<
    WorkflowBlueprintDetail,
    { schemaVersion: "tutti.flow.v1" }
  >;
}) {
  const preview = props.blueprint.preview!;
  return (
    <div className="blueprint-overview-grid">
      <div>
        <strong>Params</strong>
        <span>{Object.keys(preview.params).join(", ") || "none"}</span>
      </div>
      <div>
        <strong>Inputs</strong>
        <span>{Object.keys(preview.inputs).join(", ") || "none"}</span>
      </div>
      <div>
        <strong>Secrets</strong>
        <span>{Object.keys(preview.secrets).join(", ") || "none"}</span>
      </div>
      <div>
        <strong>Capabilities</strong>
        <span>{props.blueprint.capabilities?.join(", ") || "standard"}</span>
      </div>
    </div>
  );
}

function BlueprintFlowPreview(props: {
  blueprint: Extract<
    WorkflowBlueprintDetail,
    { schemaVersion: "tutti.flow.v1" }
  >;
}) {
  const preview = props.blueprint.preview!;
  return (
    <div className="flow-runtime-panel">
      <div className="flow-runtime-node-track">
        {preview.nodes.map((node) => (
          <div className="flow-runtime-node" key={node.id}>
            <span className="flow-runtime-node-kind">{node.kind}</span>
            <strong>{node.label}</strong>
            <small>{node.id}</small>
          </div>
        ))}
      </div>
      <div className="flow-runtime-edge-list">
        {preview.edges.map((edge) => (
          <code key={edge.id}>
            {edge.sourceNodeId} → {edge.targetNodeId}
            {edge.kind === "control" ? ` [${edge.outcome}]` : ""}
          </code>
        ))}
      </div>
    </div>
  );
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
