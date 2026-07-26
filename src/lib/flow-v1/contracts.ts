import {
  FLOW_V1_CYCLE_STATUSES,
  FLOW_V1_INVOCATION_STATUSES,
  FLOW_V1_LIFECYCLES,
  FLOW_V1_NODE_KINDS,
  FLOW_V1_NODE_STATUSES,
  FLOW_V1_RUN_STATUSES,
  FLOW_V1_RUN_STOP_REASONS,
  FLOW_V1_VERSION_STATUSES,
  type FlowV1EffectReconcileResult,
  type FlowV1JsonObject,
  type FlowV1JsonValue,
  type FlowV1NodeResult,
} from "./types";

export function isFlowV1JsonValue(value: unknown): value is FlowV1JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isFlowV1JsonValue);
  }
  return isRecord(value) && Object.values(value).every(isFlowV1JsonValue);
}

export function isFlowV1JsonObject(value: unknown): value is FlowV1JsonObject {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => isFlowV1JsonValue(entry))
  );
}

export function isFlowV1Lifecycle(value: unknown): boolean {
  return includes(FLOW_V1_LIFECYCLES, value);
}

export function isFlowV1VersionStatus(value: unknown): boolean {
  return includes(FLOW_V1_VERSION_STATUSES, value);
}

export function isFlowV1CycleStatus(value: unknown): boolean {
  return includes(FLOW_V1_CYCLE_STATUSES, value);
}

export function isFlowV1RunStatus(value: unknown): boolean {
  return includes(FLOW_V1_RUN_STATUSES, value);
}

export function isFlowV1RunStopReason(value: unknown): boolean {
  return includes(FLOW_V1_RUN_STOP_REASONS, value);
}

export function isFlowV1InvocationStatus(value: unknown): boolean {
  return includes(FLOW_V1_INVOCATION_STATUSES, value);
}

export function isFlowV1NodeKind(value: unknown): boolean {
  return includes(FLOW_V1_NODE_KINDS, value);
}

export function isFlowV1NodeStatus(value: unknown): boolean {
  return includes(FLOW_V1_NODE_STATUSES, value);
}

export function isFlowV1NodeResult(value: unknown): value is FlowV1NodeResult {
  if (!isRecord(value) || typeof value.status !== "string") {
    return false;
  }
  switch (value.status) {
    case "completed":
      return (
        (value.outcome === undefined || typeof value.outcome === "string") &&
        (value.output === undefined || isFlowV1JsonValue(value.output))
      );
    case "waiting":
    case "skipped":
      return typeof value.reason === "string" && value.reason.trim().length > 0;
    case "failed":
      return (
        isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string" &&
        (value.error.retryable === undefined ||
          typeof value.error.retryable === "boolean")
      );
    case "uncertain":
      return (
        isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string"
      );
    default:
      return false;
  }
}

export function isFlowV1EffectReconcileResult(
  value: unknown,
): value is FlowV1EffectReconcileResult {
  if (!isRecord(value) || typeof value.status !== "string") {
    return false;
  }
  if (value.status === "not_applied") {
    return true;
  }
  if (value.status === "unknown") {
    return typeof value.reason === "string" && value.reason.trim().length > 0;
  }
  return (
    value.status === "completed" &&
    (value.externalRef === undefined ||
      typeof value.externalRef === "string") &&
    (value.output === undefined || isFlowV1JsonValue(value.output))
  );
}

function includes(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
