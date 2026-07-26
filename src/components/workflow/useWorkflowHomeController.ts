import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createWorkflowFromPrompt,
  deleteWorkflow as deleteWorkflowRequest,
  duplicateWorkflow as duplicateWorkflowRequest,
  listWorkflowSummaries,
  readApiJsonError,
} from "@/components/workflow/workflowApiService";
import type { WorkflowListItem } from "@/lib/db/workflows/types";
import type {
  FlowV1CycleStatus,
  FlowV1RunStatus,
} from "@/lib/flow-v1/types";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";

const DEFAULT_WORKFLOW_PROMPT =
  "Inspect a repository, run architecture and security review agents, then synthesize an implementation brief.";

type WorkflowHomeControllerInput = {
  effectiveAgent: string;
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
  statusFilter: FlowStatusFilter;
  setStatusFilter: (value: FlowStatusFilter) => void;
  isLoadingWorkflows: boolean;
  isCreating: boolean;
  createError: string | undefined;
  createDiagnostics: WorkflowDiagnostic[];
  createWorkflow: () => Promise<void>;
  duplicatingId: string | undefined;
  deletingId: string | undefined;
  actionError: string | undefined;
  duplicateWorkflow: (workflowId: string) => Promise<void>;
  deleteWorkflow: (workflowId: string, workflowName: string) => Promise<void>;
};

export type FlowStatusFilter =
  | "all"
  | FlowV1CycleStatus
  | FlowV1RunStatus;

export function useWorkflowHomeController(
  input: WorkflowHomeControllerInput,
): WorkflowHomeController {
  const router = useRouter();
  const [prompt, setPrompt] = useState(DEFAULT_WORKFLOW_PROMPT);
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<FlowStatusFilter>("all");
  const [isCreating, setIsCreating] = useState(false);
  const [isLoadingWorkflows, setIsLoadingWorkflows] = useState(true);
  const [duplicatingId, setDuplicatingId] = useState<string | undefined>();
  const [deletingId, setDeletingId] = useState<string | undefined>();
  const [createError, setCreateError] = useState<string | undefined>();
  const [createDiagnostics, setCreateDiagnostics] = useState<
    WorkflowDiagnostic[]
  >([]);
  const [actionError, setActionError] = useState<string | undefined>();

  const loadWorkflows = useCallback(async () => {
    setIsLoadingWorkflows(true);
    try {
      setWorkflows(await listWorkflowSummaries());
      setActionError(undefined);
    } catch (caught) {
      setActionError(readApiJsonError(caught, "UNKNOWN_ERROR").message);
    } finally {
      setIsLoadingWorkflows(false);
    }
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
        statusFilter === "all" ||
        item.flowV1Runtime?.activeCycle?.status === statusFilter ||
        item.flowV1Runtime?.latestRun?.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [query, statusFilter, workflows]);
  const runCount = useMemo(
    () =>
      workflows.reduce(
        (total, item) =>
          total + (item.flowV1Runtime?.runCount ?? 0),
        0,
      ),
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
      const data = await createWorkflowFromPrompt({
        prompt: trimmed,
        agent: input.effectiveAgent,
        model: input.model || undefined,
        cwd: input.cwd || undefined,
      });
      router.push(`/workflows/${data.workflow.id}`);
    } catch (caught) {
      const apiError = readApiJsonError(caught, "WORKFLOW_GENERATION_FAILED");
      setCreateDiagnostics(apiError.diagnostics ?? []);
      setCreateError(apiError.message);
    } finally {
      setIsCreating(false);
    }
  }

  async function duplicateWorkflow(workflowId: string) {
    setDuplicatingId(workflowId);
    setActionError(undefined);
    try {
      const data = await duplicateWorkflowRequest({ workflowId });
      router.push(`/workflows/${data.workflow.id}`);
    } catch (caught) {
      setActionError(
        readApiJsonError(caught, "WORKFLOW_DUPLICATE_FAILED").message,
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
      await deleteWorkflowRequest(workflowId);
      await loadWorkflows();
    } catch (caught) {
      setActionError(readApiJsonError(caught, "WORKFLOW_DELETE_FAILED").message);
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
    isLoadingWorkflows,
    isCreating,
    createError,
    createDiagnostics,
    createWorkflow,
    duplicatingId,
    deletingId,
    actionError,
    duplicateWorkflow,
    deleteWorkflow,
  };
}
