import {
  readApiError,
  type ApiError,
  type ApiErrorCode,
} from "@/lib/api/errors";
import type {
  WorkflowDetail,
  WorkflowListItem,
} from "@/lib/db/workflows/types";
import type {
  WorkflowBlueprintDetail,
  WorkflowBlueprintSearchResult,
  WorkflowBlueprintSummary,
} from "@/lib/workflow/blueprint-types";
import type { AgentTargetCatalogResult } from "@/lib/agents/types";

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
  const text = await response.text();
  let data: unknown;
  try {
    data = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
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
    return { code: fallbackCode, message: error.message };
  }
  return readApiError(undefined, fallbackCode);
}

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
      headers: { "content-type": "application/json" },
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
    throw new Error("Flow Blueprint not found.");
  }
  return data.blueprint;
}

export async function instantiateWorkflowBlueprint(
  blueprintId: string,
): Promise<WorkflowDetail> {
  return apiJson<WorkflowDetail>(
    `/api/workflow-blueprints/${blueprintId}/instantiate`,
    { method: "POST" },
    "WORKFLOW_IMPORT_FAILED",
  );
}

export async function createWorkflowFromPrompt(input: {
  prompt: string;
  agent: string;
  model?: string;
  cwd?: string;
}): Promise<WorkflowDetail> {
  return apiJson<WorkflowDetail>(
    "/api/workflows",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    "WORKFLOW_GENERATION_FAILED",
  );
}

export async function listAgentTargets(
  signal?: AbortSignal,
): Promise<AgentTargetCatalogResult> {
  return apiJson<AgentTargetCatalogResult>(
    "/api/agents/targets",
    { signal },
    "UNKNOWN_ERROR",
  );
}

export async function duplicateWorkflow(input: {
  workflowId: string;
  versionId?: string;
  name?: string;
}): Promise<WorkflowDetail> {
  return apiJson<WorkflowDetail>(
    `/api/workflows/${input.workflowId}/duplicate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        versionId: input.versionId,
        name: input.name,
      }),
    },
    "WORKFLOW_DUPLICATE_FAILED",
  );
}

export function deleteWorkflow(
  workflowId: string,
): Promise<{ ok: boolean }> {
  return apiJson<{ ok: boolean }>(
    `/api/workflows/${workflowId}`,
    { method: "DELETE" },
    "WORKFLOW_DELETE_FAILED",
  );
}
