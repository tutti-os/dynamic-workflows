import {
  isWorkflowBlueprintCategory,
  type WorkflowBlueprintCategory,
} from "@/lib/workflow/blueprint-contract";
import type {
  WorkflowBlueprintSearchInput,
} from "@/lib/workflow/blueprint-catalog";

export function readWorkflowBlueprintSearchRequest(
  value: unknown,
): WorkflowBlueprintSearchInput {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    query: readString(record.query),
    category: readCategory(record.category),
    tags: readStringArray(record.tags),
    requiresCwd: readBoolean(record.requiresCwd),
    includeScript: readBoolean(record.includeScript),
    limit: readNumber(record.limit),
  };
}

export function readWorkflowBlueprintSearchParams(
  params: URLSearchParams,
): WorkflowBlueprintSearchInput {
  return {
    query: params.get("query")?.trim() || undefined,
    category: readCategory(params.get("category")),
    tags: normalizeStringArray(params.getAll("tag")),
    requiresCwd: readBoolean(params.get("requiresCwd")),
    includeScript: readBoolean(params.get("includeScript")),
    limit: readNumber(params.get("limit")),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return normalizeStringArray(items);
}

function normalizeStringArray(value: string[]): string[] | undefined {
  const items = value.map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function readCategory(value: unknown): WorkflowBlueprintCategory | undefined {
  return isWorkflowBlueprintCategory(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === "1") {
    return true;
  }
  if (value === false || value === "false" || value === "0") {
    return false;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
