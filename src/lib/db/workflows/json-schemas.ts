import type {
  WorkflowDiagnostic,
  WorkflowMeta,
} from "@/lib/workflow/types";
import type {
  AuthoringSemanticReview,
  WorkflowGenerationError,
} from "./types";

export type JsonColumnContext = {
  table: string;
  column: string;
  id: string;
};

type JsonPrimitive = null | boolean | number | string;
interface JsonArray extends Array<JsonValue> {}
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonArray | JsonObject;

type Validator<T> = (value: unknown) => value is T;

export function parseWorkflowMetaColumn(
  value: string,
  context: JsonColumnContext,
): WorkflowMeta {
  return parseJsonColumn(value, context, isWorkflowMeta);
}

export function parseAuthoringSemanticReviewColumn(
  value: string,
  context: JsonColumnContext,
): AuthoringSemanticReview {
  return parseJsonColumn(value, context, isAuthoringSemanticReview);
}

export function parseJsonObjectColumn(
  value: string,
  context: JsonColumnContext,
): Record<string, JsonValue> {
  return parseJsonColumn(value, context, isJsonObject);
}

export function parseJsonValueColumn(
  value: string,
  context: JsonColumnContext,
): JsonValue {
  return parseJsonColumn(value, context, isJsonValue);
}

export function parseWorkflowGenerationErrorColumn(
  value: string,
  context: JsonColumnContext,
): WorkflowGenerationError {
  return parseJsonColumn(value, context, isWorkflowError);
}

export function stringifyWorkflowMetaColumn(
  value: unknown,
  context: JsonColumnContext,
): string {
  return stringifyJsonColumn(value, context, isWorkflowMeta);
}

export function stringifyAuthoringSemanticReviewColumn(
  value: unknown,
  context: JsonColumnContext,
): string {
  return stringifyJsonColumn(value, context, isAuthoringSemanticReview);
}

export function isAuthoringSemanticReview(
  value: unknown,
): value is AuthoringSemanticReview {
  if (!isJsonObject(value)) {
    return false;
  }
  const statuses = new Set([
    "running",
    "passed",
    "failed",
    "stale",
    "unavailable",
    "invalid_output",
    "canceled",
    "waived",
  ]);
  if (
    typeof value.reviewId !== "string" ||
    !statuses.has(String(value.status)) ||
    typeof value.intentHash !== "string" ||
    typeof value.scriptHash !== "string" ||
    (value.reviewerAgent !== null && typeof value.reviewerAgent !== "string") ||
    (value.reviewerModel !== null && typeof value.reviewerModel !== "string") ||
    (value.reviewerSessionId !== null &&
      typeof value.reviewerSessionId !== "string") ||
    typeof value.summary !== "string" ||
    typeof value.startedAt !== "string" ||
    (value.completedAt !== null && typeof value.completedAt !== "string")
  ) {
    return false;
  }
  if (
    (value.waiverReason !== undefined &&
      typeof value.waiverReason !== "string") ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    return false;
  }
  return (
    Array.isArray(value.findings) &&
    value.findings.every(
      (finding) =>
        isJsonObject(finding) &&
        typeof finding.reason === "string" &&
        Array.isArray(finding.nodePath) &&
        finding.nodePath.every((node) => typeof node === "string") &&
        typeof finding.suggestion === "string",
    )
  );
}

export function stringifyJsonObjectColumn(
  value: unknown,
  context: JsonColumnContext,
): string {
  return stringifyJsonColumn(value, context, isJsonObject);
}

export function stringifyJsonValueColumn(
  value: unknown,
  context: JsonColumnContext,
): string {
  return stringifyJsonColumn(value, context, isJsonValue);
}

export function stringifyWorkflowGenerationErrorColumn(
  value: unknown,
  context: JsonColumnContext,
): string {
  return stringifyJsonColumn(value, context, isWorkflowError);
}

export function isWorkflowMeta(value: unknown): value is WorkflowMeta {
  if (!isJsonObject(value)) {
    return false;
  }
  if (
    typeof value.name !== "string" ||
    typeof value.description !== "string"
  ) {
    return false;
  }
  return (
    value.requiresCwd === undefined ||
    typeof value.requiresCwd === "boolean"
  );
}

export function isWorkflowError(
  value: unknown,
): value is WorkflowGenerationError {
  if (!isJsonObject(value) || typeof value.message !== "string") {
    return false;
  }
  if (value.code !== undefined && typeof value.code !== "string") {
    return false;
  }
  if (value.diagnostics === undefined) {
    return true;
  }
  return Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isWorkflowDiagnostic);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isJsonObject(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonColumn<T>(
  value: string,
  context: JsonColumnContext,
  validate: Validator<T>,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw invalidJsonColumnError(context, "is not valid JSON", error);
  }
  if (!validate(parsed)) {
    throw invalidJsonColumnError(context, "has invalid shape");
  }
  return parsed;
}

function stringifyJsonColumn<T>(
  value: unknown,
  context: JsonColumnContext,
  validate: Validator<T>,
): string {
  if (!isJsonSerializableInput(value)) {
    throw invalidJsonColumnError(context, "is not JSON serializable");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw invalidJsonColumnError(context, "is not JSON serializable", error);
  }
  if (typeof serialized !== "string") {
    throw invalidJsonColumnError(context, "is not JSON serializable");
  }
  parseJsonColumn(serialized, context, validate);
  return serialized;
}

function isJsonSerializableInput(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonSerializableInput);
  }
  if (isJsonObject(value)) {
    return Object.values(value).every(isJsonSerializableInput);
  }
  return false;
}

function invalidJsonColumnError(
  context: JsonColumnContext,
  reason: string,
  cause?: unknown,
): Error {
  return new Error(
    `Invalid JSON column ${context.table}.${context.column} for ${context.id}: ${reason}.`,
    { cause },
  );
}

function isWorkflowDiagnostic(value: unknown): value is WorkflowDiagnostic {
  if (!isJsonObject(value)) {
    return false;
  }
  if (
    value.severity !== "info" &&
    value.severity !== "warning" &&
    value.severity !== "error"
  ) {
    return false;
  }
  if (typeof value.message !== "string") {
    return false;
  }
  if (value.code !== undefined && typeof value.code !== "string") {
    return false;
  }
  if (value.path !== undefined && typeof value.path !== "string") {
    return false;
  }
  if (value.hint !== undefined && typeof value.hint !== "string") {
    return false;
  }
  return value.range === undefined || isEditableRange(value.range);
}

function isEditableRange(value: unknown): boolean {
  return isJsonObject(value) &&
    Number.isFinite(value.start) &&
    Number.isFinite(value.end);
}
