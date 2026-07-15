import {
  readApiError,
  type ApiError,
  type ApiErrorCode,
} from "@/lib/api/errors";
import type {
  WorkflowDetail,
  WorkflowEditJobRecord,
  WorkflowListItem,
  WorkflowRunRecord,
  WorkflowVersionRecord,
} from "@/lib/db/workflows/types";
import type { RunDetail } from "@/lib/workflow/run-detail";
import type {
  ParsedWorkflow,
  WorkflowRunEvent,
} from "@/lib/workflow/types";
import type {
  WorkflowBlueprintDetail,
  WorkflowBlueprintSearchResult,
  WorkflowBlueprintSummary,
} from "@/lib/workflow/blueprint-types";
import type { AgentTargetCatalogResult } from "@/lib/agents/types";
import {
  delay,
  readEventStream,
} from "@/components/workflow/workflowClientUtils";

export class ApiJsonError extends Error {
  readonly apiError: ApiError;
  readonly status: number;
  readonly data: unknown;

  constructor(apiError: ApiError, status: number, data: unknown) {
    super(apiError.message);
    this.name = "ApiJsonError";
    this.apiError = apiError;
    this.status = status;
    this.data = data;
  }
}

export async function apiJson<T>(
  url: RequestInfo | URL,
  init?: RequestInit,
  fallbackCode: ApiErrorCode = "UNKNOWN_ERROR",
): Promise<T> {
  const response = await fetch(url, init);
  const data = await readResponseBody(response);
  if (!response.ok) {
    throw new ApiJsonError(readApiError(data, fallbackCode), response.status, data);
  }
  return data as T;
}

export function readApiJsonError(
  error: unknown,
  fallbackCode: ApiErrorCode = "UNKNOWN_ERROR",
): ApiError {
  if (error instanceof ApiJsonError) {
    return error.apiError;
  }
  if (error instanceof Error) {
    return {
      code: fallbackCode,
      message: error.message,
    };
  }
  return readApiError(undefined, fallbackCode);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

type WorkflowDetailResponse = {
  detail?: WorkflowDetail;
};

type WorkflowEditResponse = {
  edit?: WorkflowEditJobRecord;
};

type WorkflowEditStatusResponse = {
  edit?: WorkflowEditJobRecord;
  version?: WorkflowVersionRecord | null;
};

export type WorkflowRunStartResponse = {
  run: WorkflowRunRecord;
};

export type WorkflowEditTerminalResult = {
  edit: WorkflowEditJobRecord;
  version: WorkflowVersionRecord | null;
};

export async function listWorkflowSummaries(): Promise<WorkflowListItem[]> {
  const data = await apiJson<{ workflows?: WorkflowListItem[] }>(
    "/api/workflows",
  );
  return data.workflows ?? [];
}

export async function listWorkflowBlueprints(): Promise<
  WorkflowBlueprintSummary[]
> {
  const data = await apiJson<{ blueprints?: WorkflowBlueprintSummary[] }>(
    "/api/workflow-blueprints",
  );
  return data.blueprints ?? [];
}

export async function searchWorkflowBlueprints(input: {
  query?: string;
  includeScript?: boolean;
  limit?: number;
}): Promise<WorkflowBlueprintSearchResult[]> {
  const data = await apiJson<{ blueprints?: WorkflowBlueprintSearchResult[] }>(
    "/api/workflow-blueprints/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return data.blueprints ?? [];
}

export async function loadWorkflowBlueprint(
  blueprintId: string,
): Promise<WorkflowBlueprintDetail> {
  const data = await apiJson<{ blueprint?: WorkflowBlueprintDetail }>(
    `/api/workflow-blueprints/${blueprintId}`,
    undefined,
    "WORKFLOW_BLUEPRINT_NOT_FOUND",
  );
  if (!data.blueprint) {
    throw new Error("Workflow blueprint not found");
  }
  return data.blueprint;
}

export async function instantiateWorkflowBlueprint(
  blueprintId: string,
): Promise<WorkflowDetail> {
  const data = await apiJson<WorkflowDetail>(
    `/api/workflow-blueprints/${blueprintId}/instantiate`,
    { method: "POST" },
    "WORKFLOW_IMPORT_FAILED",
  );
  if (!data.workflow) {
    throw new Error("Workflow blueprint instantiation failed");
  }
  return data;
}

export async function createWorkflowFromPrompt(input: {
  prompt: string;
  agent: string;
  model?: string;
  cwd?: string;
}): Promise<WorkflowDetail> {
  const data = await apiJson<WorkflowDetail>(
    "/api/workflows",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    "WORKFLOW_GENERATION_FAILED",
  );
  if (!data.workflow) {
    throw new Error("Workflow creation failed");
  }
  return data;
}

export async function importWorkflowScriptFile(
  formData: FormData,
): Promise<WorkflowDetail> {
  const data = await apiJson<WorkflowDetail>(
    "/api/workflows/import",
    {
      method: "POST",
      body: formData,
    },
    "WORKFLOW_IMPORT_FAILED",
  );
  if (!data.workflow) {
    throw new Error("Workflow import failed");
  }
  return data;
}

export function parseWorkflowScript(script: string): Promise<ParsedWorkflow> {
  return apiJson<ParsedWorkflow>(
    "/api/workflows/parse",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script }),
    },
  );
}

export async function listAgentTargets(
  signal?: AbortSignal,
): Promise<AgentTargetCatalogResult> {
  const data = await apiJson<Partial<AgentTargetCatalogResult>>(
    "/api/agents/targets",
    signal ? { signal } : undefined,
    "AGENT_TARGET_DETECTION_FAILED",
  );
  return {
    targets: data.targets ?? [],
    freshness: data.freshness === "stale" ? "stale" : "fresh",
    ...(typeof data.loadedAt === "number" ? { loadedAt: data.loadedAt } : {}),
    ...(typeof data.warning === "string" ? { warning: data.warning } : {}),
  };
}

export function loadWorkflowDetail(workflowId: string): Promise<WorkflowDetail> {
  return apiJson<WorkflowDetail>(
    `/api/workflows/${workflowId}`,
    undefined,
    "WORKFLOW_NOT_FOUND",
  );
}

export async function requestWorkflowGeneration(
  workflowId: string,
  retry: boolean,
): Promise<WorkflowDetail> {
  const data = await apiJson<WorkflowDetailResponse>(
    `/api/workflows/${workflowId}/generation`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retry }),
    },
    "WORKFLOW_GENERATION_FAILED",
  );
  if (!data.detail) {
    throw new Error("Workflow generation did not return detail");
  }
  return data.detail;
}

export async function watchWorkflowGeneration(input: {
  workflowId: string;
  isMounted: () => boolean;
  onDetail: (
    detail: WorkflowDetail,
    options?: { resetScript?: boolean },
  ) => void;
}): Promise<void> {
  const startedDetail = await requestWorkflowGeneration(input.workflowId, false);
  input.onDetail(startedDetail, { resetScript: true });
  if (
    !input.isMounted() ||
    startedDetail.currentVersion ||
    !isActiveWorkflowJobStatus(startedDetail.generation?.status)
  ) {
    return;
  }

  while (input.isMounted()) {
    await delay(1000);
    if (!input.isMounted()) {
      return;
    }
    const nextDetail = await loadWorkflowDetail(input.workflowId);
    input.onDetail(nextDetail, { resetScript: true });
    if (
      nextDetail.currentVersion ||
      !isActiveWorkflowJobStatus(nextDetail.generation?.status)
    ) {
      return;
    }
  }
}

export async function saveWorkflowVersion(input: {
  workflowId: string;
  script: string;
}): Promise<WorkflowDetail> {
  const data = await apiJson<WorkflowDetailResponse>(
    `/api/workflows/${input.workflowId}/versions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: input.script }),
    },
    "WORKFLOW_SAVE_FAILED",
  );
  if (!data.detail?.currentVersion) {
    throw new Error("Workflow save failed");
  }
  return data.detail;
}

export async function updateWorkflowMetadata(input: {
  workflowId: string;
  name: string;
  description: string;
}): Promise<WorkflowDetail> {
  const data = await apiJson<WorkflowDetail>(
    `/api/workflows/${input.workflowId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        description: input.description,
      }),
    },
    "WORKFLOW_UPDATE_FAILED",
  );
  if (!data.workflow) {
    throw new Error("Workflow update failed");
  }
  return data;
}

export async function duplicateWorkflow(input: {
  workflowId: string;
  versionId?: string;
}): Promise<WorkflowDetail> {
  const hasVersion = input.versionId !== undefined;
  const data = await apiJson<WorkflowDetail>(
    `/api/workflows/${input.workflowId}/duplicate`,
    {
      method: "POST",
      headers: hasVersion ? { "Content-Type": "application/json" } : undefined,
      body: hasVersion
        ? JSON.stringify({
            versionId: input.versionId,
          })
        : undefined,
    },
    "WORKFLOW_DUPLICATE_FAILED",
  );
  if (!data.workflow) {
    throw new Error("Workflow duplication failed");
  }
  return data;
}

export function deleteWorkflow(workflowId: string): Promise<{ ok: boolean }> {
  return apiJson<{ ok: boolean }>(
    `/api/workflows/${workflowId}`,
    { method: "DELETE" },
    "WORKFLOW_DELETE_FAILED",
  );
}

export async function publishWorkflowVersion(input: {
  workflowId: string;
  versionId: string;
}): Promise<WorkflowDetail> {
  const data = await apiJson<WorkflowDetailResponse>(
    `/api/workflows/${input.workflowId}/versions/${input.versionId}/publish`,
    { method: "POST" },
    "WORKFLOW_SAVE_FAILED",
  );
  if (!data.detail?.currentVersion) {
    throw new Error("Workflow publish failed");
  }
  return data.detail;
}

export type WorkflowAuthoringSessionItem = {
  id: string;
  kind: "create" | "edit";
  status: string;
  agentSessionId: string | null;
  agent: string | null;
  model: string | null;
  request: string;
  createdVersionId: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export async function listWorkflowAuthoringSessions(
  workflowId: string,
): Promise<WorkflowAuthoringSessionItem[]> {
  const data = await apiJson<{ sessions?: WorkflowAuthoringSessionItem[] }>(
    `/api/workflows/${workflowId}/authoring-sessions`,
    undefined,
    "WORKFLOW_EDIT_FAILED",
  );
  return data.sessions ?? [];
}

export async function listWorkflowAgentEdits(
  workflowId: string,
): Promise<WorkflowEditJobRecord[]> {
  const data = await apiJson<{ edits?: WorkflowEditJobRecord[] }>(
    `/api/workflows/${workflowId}/agent-edits`,
    undefined,
    "WORKFLOW_EDIT_FAILED",
  );
  return data.edits ?? [];
}

export async function startWorkflowAgentEdit(input: {
  workflowId: string;
  instruction: string;
  baseVersionId?: string;
  agent?: string;
  model?: string;
  cwd?: string;
}): Promise<WorkflowEditJobRecord> {
  const data = await apiJson<WorkflowEditResponse>(
    `/api/workflows/${input.workflowId}/agent-edits`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: input.instruction,
        baseVersionId: input.baseVersionId,
        agent: input.agent,
        model: input.model,
        cwd: input.cwd,
      }),
    },
    "WORKFLOW_EDIT_FAILED",
  );
  if (!data.edit) {
    throw new Error("Workflow edit did not return a job");
  }
  return data.edit;
}

export async function loadWorkflowAgentEdit(input: {
  workflowId: string;
  editId: string;
}): Promise<WorkflowEditStatusResponse> {
  const data = await apiJson<WorkflowEditStatusResponse>(
    `/api/workflows/${input.workflowId}/agent-edits/${input.editId}`,
    undefined,
    "WORKFLOW_EDIT_FAILED",
  );
  if (!data.edit) {
    throw new Error("Workflow edit status did not return a job");
  }
  return data;
}

export async function cancelWorkflowAgentEdit(input: {
  workflowId: string;
  editId: string;
}): Promise<WorkflowEditStatusResponse> {
  return apiJson<WorkflowEditStatusResponse>(
    `/api/workflows/${input.workflowId}/agent-edits/${input.editId}/cancel`,
    { method: "POST" },
    "WORKFLOW_EDIT_FAILED",
  );
}

export async function retryWorkflowAgentEdit(input: {
  workflowId: string;
  editId: string;
}): Promise<WorkflowEditJobRecord> {
  const data = await apiJson<WorkflowEditResponse>(
    `/api/workflows/${input.workflowId}/agent-edits/${input.editId}/retry`,
    { method: "POST" },
    "WORKFLOW_EDIT_FAILED",
  );
  if (!data.edit) {
    throw new Error("Workflow edit retry did not return a job");
  }
  return data.edit;
}

export async function watchWorkflowAgentEdit(input: {
  workflowId: string;
  editId: string;
  isMounted: () => boolean;
  onStatus?: (result: WorkflowEditStatusResponse) => Promise<void> | void;
}): Promise<WorkflowEditTerminalResult | null> {
  while (input.isMounted()) {
    const result = await loadWorkflowAgentEdit({
      workflowId: input.workflowId,
      editId: input.editId,
    });
    if (!input.isMounted()) {
      return null;
    }
    await input.onStatus?.(result);

    const edit = result.edit;
    if (!edit) {
      throw new Error("Workflow edit status did not return a job");
    }
    if (edit.status === "failed") {
      throw new Error(edit.error?.message ?? "Workflow edit failed");
    }
    if (edit.status === "canceled") {
      return { edit, version: result.version ?? null };
    }
    if (edit.status === "completed") {
      return { edit, version: result.version ?? null };
    }

    await delay(1000);
  }

  return null;
}

export async function startWorkflowRun(input: {
  endpoint: string;
  body?: unknown;
}): Promise<WorkflowRunStartResponse> {
  return apiJson<WorkflowRunStartResponse>(
    input.endpoint,
    {
      method: "POST",
      headers: input.body ? { "Content-Type": "application/json" } : undefined,
      body: input.body ? JSON.stringify(input.body) : undefined,
    },
    "WORKFLOW_RUN_FAILED",
  );
}

export async function streamWorkflowRunEvents(input: {
  workflowId: string;
  runId: string;
  signal?: AbortSignal;
  onEvent: (event: WorkflowRunEvent) => void;
}): Promise<void> {
  const response = await fetch(
    `/api/workflows/${input.workflowId}/runs/${input.runId}/events`,
    { signal: input.signal },
  );

  if (!response.ok) {
    const data = await response.json().catch(() => undefined);
    const apiError = readApiError(data, "WORKFLOW_RUN_FAILED");
    throw new Error(apiError.message);
  }
  if (!response.body) {
    throw new Error("Run event stream did not start");
  }

  await readEventStream(response.body, input.onEvent);
}

export function cancelWorkflowRun(input: {
  workflowId: string;
  runId: string;
}): Promise<{ ok: boolean; canceled: boolean }> {
  return apiJson<{ ok: boolean; canceled: boolean }>(
    `/api/workflows/${input.workflowId}/runs/${input.runId}/cancel`,
    { method: "POST" },
    "WORKFLOW_RUN_FAILED",
  );
}

export function loadWorkflowRun(input: {
  workflowId: string;
  runId: string;
}): Promise<RunDetail> {
  return apiJson<RunDetail>(
    `/api/workflows/${input.workflowId}/runs/${input.runId}`,
    undefined,
    "RUN_NOT_FOUND",
  );
}

export function openWorkflowAgentSession(
  agentSessionId: string,
): Promise<{ ok: boolean }> {
  return apiJson<{ ok: boolean }>(
    "/api/agent-sessions/open",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentSessionId }),
    },
    "WORKFLOW_RUN_FAILED",
  );
}

export function isActiveWorkflowJobStatus(status: string | undefined): boolean {
  return status === "pending" || status === "running";
}
