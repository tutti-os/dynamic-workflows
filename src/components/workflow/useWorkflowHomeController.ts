import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getApiErrorMessage, readApiError } from "@/lib/api/errors";
import type {
  WorkflowDetail,
  WorkflowListItem,
  WorkflowRunStatus,
} from "@/lib/db/workflows";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";

const DEFAULT_WORKFLOW_PROMPT =
  "Inspect a repository, run architecture and security review agents, then synthesize an implementation brief.";

type WorkflowHomeControllerInput = {
  effectiveProvider: string;
  model: string;
  cwd: string;
};

type WorkflowHomeController = {
  prompt: string;
  setPrompt: (value: string) => void;
  workflows: WorkflowListItem[];
  filteredWorkflows: WorkflowListItem[];
  workflowCount: number;
  runCount: number;
  query: string;
  setQuery: (value: string) => void;
  statusFilter: WorkflowRunStatus | "all";
  setStatusFilter: (value: WorkflowRunStatus | "all") => void;
  isCreating: boolean;
  createError: string | undefined;
  createDiagnostics: WorkflowDiagnostic[];
  createWorkflow: () => Promise<void>;
  importScript: string;
  setImportScript: (value: string) => void;
  isImporting: boolean;
  importError: string | undefined;
  importDiagnostics: WorkflowDiagnostic[];
  importWorkflow: () => Promise<void>;
  duplicatingId: string | undefined;
  deletingId: string | undefined;
  actionError: string | undefined;
  duplicateWorkflow: (workflowId: string) => Promise<void>;
  deleteWorkflow: (workflowId: string, workflowName: string) => Promise<void>;
};

export function useWorkflowHomeController(
  input: WorkflowHomeControllerInput,
): WorkflowHomeController {
  const router = useRouter();
  const [prompt, setPrompt] = useState(DEFAULT_WORKFLOW_PROMPT);
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<WorkflowRunStatus | "all">(
    "all",
  );
  const [isCreating, setIsCreating] = useState(false);
  const [importScript, setImportScript] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | undefined>();
  const [deletingId, setDeletingId] = useState<string | undefined>();
  const [createError, setCreateError] = useState<string | undefined>();
  const [createDiagnostics, setCreateDiagnostics] = useState<
    WorkflowDiagnostic[]
  >([]);
  const [importError, setImportError] = useState<string | undefined>();
  const [importDiagnostics, setImportDiagnostics] = useState<
    WorkflowDiagnostic[]
  >([]);
  const [actionError, setActionError] = useState<string | undefined>();

  const loadWorkflows = useCallback(async () => {
    const response = await fetch("/api/workflows");
    const data = (await response.json()) as { workflows?: WorkflowListItem[] };
    setWorkflows(data.workflows ?? []);
  }, []);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

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

  async function createWorkflow() {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setCreateError("Prompt is required");
      return;
    }

    setIsCreating(true);
    setCreateError(undefined);
    setCreateDiagnostics([]);
    try {
      const response = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          provider: input.effectiveProvider,
          model: input.model || undefined,
          cwd: input.cwd || undefined,
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
      setCreateError(
        caught instanceof Error ? caught.message : "Workflow creation failed",
      );
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
      setImportError(
        caught instanceof Error ? caught.message : "Workflow import failed",
      );
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

  return {
    prompt,
    setPrompt,
    workflows,
    filteredWorkflows,
    workflowCount,
    runCount,
    query,
    setQuery,
    statusFilter,
    setStatusFilter,
    isCreating,
    createError,
    createDiagnostics,
    createWorkflow,
    importScript,
    setImportScript,
    isImporting,
    importError,
    importDiagnostics,
    importWorkflow,
    duplicatingId,
    deletingId,
    actionError,
    duplicateWorkflow,
    deleteWorkflow,
  };
}
