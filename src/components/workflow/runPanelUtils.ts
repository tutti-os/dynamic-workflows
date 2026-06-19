import type { WorkflowRunRecord } from "@/lib/db/workflows";
import {
  limitRunText,
  RUN_TEXT_PREVIEW_CHARS,
  type RunDetail,
} from "@/lib/workflow/run-detail";
import type { WorkflowNodeStatus } from "@/lib/workflow/types";

export function getRunVersionLabel(
  run: WorkflowRunRecord,
  versionLabelById: Record<string, string>,
): string {
  return versionLabelById[run.workflowVersionId] ?? run.workflowVersionId.slice(0, 8);
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function nodeStatusBadge(status: WorkflowNodeStatus) {
  if (status === "completed") {
    return "success" as const;
  }
  if (status === "running") {
    return "pending" as const;
  }
  if (status === "failed") {
    return "destructive" as const;
  }
  if (status === "queued" || status === "skipped") {
    return "warning" as const;
  }
  return "default" as const;
}

export function runStatusTone(status: WorkflowRunRecord["status"]) {
  if (status === "completed") {
    return "green" as const;
  }
  if (status === "running") {
    return "blue" as const;
  }
  if (status === "failed") {
    return "red" as const;
  }
  if (status === "canceled") {
    return "amber" as const;
  }
  return "neutral" as const;
}

export function runStatusBadge(status: WorkflowRunRecord["status"]) {
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

export function canRetryRun(status: WorkflowRunRecord["status"]): boolean {
  return status === "completed" || status === "failed";
}

export function formatJson(value: unknown): string {
  return limitRunText(JSON.stringify(value ?? null, null, 2));
}

export function getRunError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : undefined;
}

export function formatRunLogPreviewNote(detail: RunDetail): string {
  if (
    typeof detail.logSizeBytes === "number" &&
    detail.logSizeBytes > 0 &&
    typeof detail.logReturnedBytes === "number" &&
    detail.logReturnedBytes > 0
  ) {
    return `Showing last ${formatBytes(detail.logReturnedBytes)} of ${formatBytes(
      detail.logSizeBytes,
    )}.`;
  }
  return `Showing latest ${formatBytes(RUN_TEXT_PREVIEW_CHARS)} log preview.`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}
