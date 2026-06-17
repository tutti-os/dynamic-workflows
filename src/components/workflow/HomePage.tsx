"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  Badge,
  BareIconButton,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CreateChatIcon,
  DirectoryIcon,
  FailedLinedIcon,
  FileCreateIcon,
  FolderIcon,
  Input,
  LoadingIcon,
  NewWorkspaceIcon,
  PlatformIcon,
  ProductDocIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Separator,
  SettingsIcon,
  Textarea,
  TuttiMark,
  UploadIcon,
} from "@tutti-os/ui-system";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getApiErrorMessage, readApiError } from "@/lib/api/errors";
import { DiagnosticsPanel } from "@/components/workflow/DiagnosticsPanel";
import type { AgentProviderOption } from "@/lib/agents/types";
import type {
  WorkflowDetail,
  WorkflowListItem,
  WorkflowRunStatus,
} from "@/lib/db/workflows";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";

const DEFAULT_MODEL_VALUE = "__default__";
const FALLBACK_PROVIDERS: AgentProviderOption[] = [
  {
    id: "mock",
    label: "Mock local agent",
    supported: true,
    models: ["mock"],
  },
];

export function HomePage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState(
    "Inspect a repository, run architecture and security review agents, then synthesize an implementation brief.",
  );
  const [providers, setProviders] =
    useState<AgentProviderOption[]>(FALLBACK_PROVIDERS);
  const [provider, setProvider] = useState("mock");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<WorkflowRunStatus | "all">("all");
  const [isCreating, setIsCreating] = useState(false);
  const [importScript, setImportScript] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | undefined>();
  const [deletingId, setDeletingId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [createDiagnostics, setCreateDiagnostics] = useState<WorkflowDiagnostic[]>([]);
  const [importError, setImportError] = useState<string | undefined>();
  const [importDiagnostics, setImportDiagnostics] = useState<WorkflowDiagnostic[]>([]);
  const [actionError, setActionError] = useState<string | undefined>();

  useEffect(() => {
    void loadWorkflows();
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
      .catch(() => setProviders(FALLBACK_PROVIDERS));
  }, []);

  const effectiveProvider = provider || FALLBACK_PROVIDERS[0].id;
  const selectedProvider =
    providers.find((item) => item.id === effectiveProvider) ?? providers[0];
  const modelOptions = selectedProvider?.models ?? [];
  const workflowCount = workflows.length;
  const filteredWorkflows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return workflows.filter((item) => {
      const matchesQuery =
        !normalizedQuery ||
        item.workflow.name.toLowerCase().includes(normalizedQuery) ||
        item.workflow.description.toLowerCase().includes(normalizedQuery);
      const matchesStatus =
        statusFilter === "all" || item.latestRun?.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [query, statusFilter, workflows]);
  const runCount = useMemo(
    () => workflows.reduce((total, item) => total + item.runCount, 0),
    [workflows],
  );

  async function loadWorkflows() {
    const response = await fetch("/api/workflows");
    const data = (await response.json()) as { workflows?: WorkflowListItem[] };
    setWorkflows(data.workflows ?? []);
  }

  async function createWorkflow() {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError("Prompt is required");
      return;
    }

    setIsCreating(true);
    setError(undefined);
    setCreateDiagnostics([]);
    try {
      const response = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          provider: effectiveProvider,
          model: model || undefined,
          cwd: cwd || undefined,
        }),
      });
      const data = (await response.json()) as WorkflowDetail;
      if (!response.ok || !data.workflow) {
        const apiError = readApiError(data, "WORKFLOW_GENERATION_FAILED");
        setCreateDiagnostics(apiError.diagnostics ?? []);
        throw new Error(apiError.message);
      }
      router.push(`/workflows/${data.workflow.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workflow creation failed");
    } finally {
      setIsCreating(false);
    }
  }

  async function importWorkflow() {
    const script = importScript.trim();
    if (!script) {
      setImportError("Paste a workflow script before importing.");
      setImportDiagnostics([]);
      return;
    }

    setIsImporting(true);
    setImportError(undefined);
    setImportDiagnostics([]);
    try {
      const response = await fetch("/api/workflows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      const data = (await response.json()) as WorkflowDetail;
      if (!response.ok || !data.workflow) {
        const apiError = readApiError(data, "WORKFLOW_IMPORT_FAILED");
        setImportDiagnostics(apiError.diagnostics ?? []);
        throw new Error(apiError.message);
      }
      router.push(`/workflows/${data.workflow.id}`);
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : "Workflow import failed");
    } finally {
      setIsImporting(false);
    }
  }

  async function duplicateWorkflow(workflowId: string) {
    setDuplicatingId(workflowId);
    setActionError(undefined);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/duplicate`, {
        method: "POST",
      });
      const data = (await response.json()) as WorkflowDetail;
      if (!response.ok || !data.workflow) {
        throw new Error(getApiErrorMessage(data, "WORKFLOW_DUPLICATE_FAILED"));
      }
      router.push(`/workflows/${data.workflow.id}`);
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "Workflow duplication failed",
      );
    } finally {
      setDuplicatingId(undefined);
    }
  }

  async function deleteWorkflow(workflowId: string, workflowName: string) {
    if (!window.confirm(`Delete workflow "${workflowName}" and all local runs?`)) {
      return;
    }

    setDeletingId(workflowId);
    setActionError(undefined);
    try {
      const response = await fetch(`/api/workflows/${workflowId}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(getApiErrorMessage(data, "WORKFLOW_DELETE_FAILED"));
      }
      await loadWorkflows();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "Workflow deletion failed",
      );
    } finally {
      setDeletingId(undefined);
    }
  }

  return (
    <main className="home-shell">
      <header className="home-topbar">
        <div className="app-brand">
          <span className="app-brand-mark">
            <TuttiMark size={28} />
          </span>
          <span className="app-brand-title">Dynamic Workflows</span>
        </div>
        <BareIconButton aria-label="Settings" className="home-settings">
          <SettingsIcon />
        </BareIconButton>
      </header>

      <section className="home-hero">
        <div className="hero-copy">
          <h1>Create a workflow from a prompt</h1>
          <p>
            Describe what you want to automate. We'll generate a workflow script
            and you can run it locally with your agents.
          </p>
        </div>

        <form
          className="create-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void createWorkflow();
          }}
        >
          <div className="prompt-composer">
            <CreateChatIcon className="prompt-composer-icon" size={20} />
            <Textarea
              value={prompt}
              rows={7}
              maxLength={2000}
              aria-label="Workflow prompt"
              className="prompt-textarea"
              placeholder="E.g., Scan a GitHub repository, summarize key files, and generate an implementation plan."
              onChange={(event) => setPrompt(event.target.value)}
            />
            <div className="prompt-actions">
              <BareIconButton aria-label="Attach context" disabled>
                <FolderIcon />
              </BareIconButton>
              <BareIconButton aria-label="Insert workflow primitive" disabled>
                <ProductDocIcon />
              </BareIconButton>
            </div>
            <span className="prompt-count">{prompt.length} / 2000</span>
          </div>

          <div className="create-controls">
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
                placeholder="server workspace"
                aria-label="Agent working directory"
                onChange={(event) => setCwd(event.target.value)}
              />
            </ControlField>
            <Button className="create-button" disabled={isCreating} type="submit">
              {isCreating ? (
                <LoadingIcon className="spin" data-icon="inline-start" />
              ) : (
                <NewWorkspaceIcon data-icon="inline-start" />
              )}
              Create
            </Button>
          </div>
          <DiagnosticsPanel message={error} diagnostics={createDiagnostics} />
        </form>
      </section>

      <section className="workflow-index">
        <div className="ornament-divider" aria-hidden="true">
          <Separator />
          <TuttiMark size={18} />
          <Separator />
        </div>
        <div className="section-heading">
          <h2>Recent workflows</h2>
          <p>
            {filteredWorkflows.length} of {workflowCount} workflows · {runCount} runs
          </p>
        </div>
        <section className="import-panel" aria-label="Import workflow script">
          <div className="import-panel-heading">
            <div>
              <h3>Import script</h3>
              <p>Paste a workflow script to create a local workflow.</p>
            </div>
            <Button
              variant="outline"
              type="button"
              onClick={() => void importWorkflow()}
              disabled={isImporting || !importScript.trim()}
            >
              {isImporting ? (
                <LoadingIcon className="spin" data-icon="inline-start" />
              ) : (
                <UploadIcon data-icon="inline-start" />
              )}
              Import
            </Button>
          </div>
          <Textarea
            className="import-textarea"
            value={importScript}
            rows={5}
            placeholder={'export const meta = { name: "...", description: "..." };'}
            aria-label="Workflow script import"
            onChange={(event) => setImportScript(event.target.value)}
          />
          <DiagnosticsPanel
            message={importError}
            diagnostics={importDiagnostics}
          />
        </section>
        <div className="workflow-tools">
          <Input
            className="workflow-search"
            value={query}
            placeholder="Search workflows"
            aria-label="Search workflows"
            onChange={(event) => setQuery(event.target.value)}
          />
          <RunStatusFilterSelect value={statusFilter} onValueChange={setStatusFilter} />
        </div>
        {actionError ? <div className="diagnostic error">{actionError}</div> : null}
        <div className="workflow-grid">
          {filteredWorkflows.length > 0 ? (
            filteredWorkflows.map((item) => (
              <article className="workflow-card-shell" key={item.workflow.id}>
                <Card className="workflow-card" size="sm">
                  <Link
                    className="workflow-card-body"
                    href={`/workflows/${item.workflow.id}`}
                  >
                    <CardHeader className="workflow-card-header">
                      <span className="workflow-card-icon">
                        <DirectoryIcon size={20} />
                      </span>
                      <div>
                        <CardTitle>{item.workflow.name}</CardTitle>
                        <p>{item.workflow.description}</p>
                      </div>
                    </CardHeader>
                  </Link>
                  <CardFooter className="workflow-card-footer">
                    <Badge variant="success">v{item.currentVersion?.version ?? 0}</Badge>
                    <span className="workflow-card-dot">·</span>
                    <span>{item.runCount} runs</span>
                    {item.latestRun ? (
                      <>
                        <span className="workflow-card-dot">·</span>
                        <Badge variant={runStatusBadge(item.latestRun.status)}>
                          {item.latestRun.status}
                        </Badge>
                      </>
                    ) : null}
                    <div className="workflow-card-actions">
                      <Button
                        asChild
                        size="sm"
                        variant="outline"
                        aria-label={`Open ${item.workflow.name}`}
                      >
                        <Link href={`/workflows/${item.workflow.id}`}>
                          <ArrowRightIcon data-icon="inline-start" />
                          Open
                        </Link>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => void duplicateWorkflow(item.workflow.id)}
                        disabled={duplicatingId === item.workflow.id}
                      >
                        {duplicatingId === item.workflow.id ? (
                          <LoadingIcon className="spin" data-icon="inline-start" />
                        ) : (
                          <FileCreateIcon data-icon="inline-start" />
                        )}
                        Duplicate
                      </Button>
                      <Button
                        className="delete-workflow-button"
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() =>
                          void deleteWorkflow(item.workflow.id, item.workflow.name)
                        }
                        disabled={deletingId === item.workflow.id}
                      >
                        {deletingId === item.workflow.id ? (
                          <LoadingIcon className="spin" data-icon="inline-start" />
                        ) : (
                          <FailedLinedIcon data-icon="inline-start" />
                        )}
                        Delete
                      </Button>
                    </div>
                  </CardFooter>
                </Card>
              </article>
            ))
          ) : (
            <div className="empty-state">
              <NewWorkspaceIcon size={24} />
              <p>{workflows.length > 0 ? "No workflows match." : "No workflows yet."}</p>
            </div>
          )}
        </div>
        <p className="local-note">Workflows are stored locally on your machine.</p>
      </section>
    </main>
  );
}

function RunStatusFilterSelect(props: {
  value: WorkflowRunStatus | "all";
  onValueChange: (value: WorkflowRunStatus | "all") => void;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(value) =>
        props.onValueChange(value as WorkflowRunStatus | "all")
      }
    >
      <SelectTrigger className="workflow-status-filter">
        <span className="select-display">
          {props.value === "all" ? "All statuses" : props.value}
        </span>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="all">All statuses</SelectItem>
        <SelectItem value="running">running</SelectItem>
        <SelectItem value="completed">completed</SelectItem>
        <SelectItem value="failed">failed</SelectItem>
        <SelectItem value="canceled">canceled</SelectItem>
      </SelectContent>
    </Select>
  );
}

function runStatusBadge(status: WorkflowRunStatus) {
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

function ControlField(props: { label: string; children: ReactNode }) {
  return (
    <label className="control-field">
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
