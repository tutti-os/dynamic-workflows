"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  ConfirmationDialog,
  CopyIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FailedLinedIcon,
  MoreHorizontalIcon,
} from "@tutti-os/ui-system";
import { WorkflowErrorBoundary } from "@/components/workflow/WorkflowErrorBoundary";
import {
  FlowRuntimeOverview,
  type FlowView,
} from "@/components/workflow/FlowRuntimeOverview";
import { FlowVersionReviewPanel } from "@/components/workflow/FlowVersionReview";
import {
  hasCurrentVersion,
  WorkflowGenerationState,
} from "@/components/workflow/WorkflowGenerationState";
import {
  ErrorState,
  LoadingState,
  WorkbenchSkeleton,
} from "@/components/workflow/WorkflowStates";
import type { WorkflowDetail } from "@/lib/db/workflows/types";
import type { FlowV1DetailProjection } from "@/lib/flow-v1/types";

type FlowWorkflowDetail = WorkflowDetail & {
  flowV1: FlowV1DetailProjection | null;
  draftReview: NonNullable<WorkflowDetail["draftReview"]> | null;
  versionReview: NonNullable<WorkflowDetail["versionReview"]> | null;
};

export function WorkflowWorkbench(props: { workflowId: string }) {
  return (
    <WorkflowErrorBoundary>
      <WorkflowWorkbenchContent workflowId={props.workflowId} />
    </WorkflowErrorBoundary>
  );
}

function WorkflowWorkbenchContent(props: { workflowId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<FlowWorkflowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null,
  );
  const [surface, setSurface] = useState<FlowView | "versions">("live");
  const initialSurfaceResolved = useRef(false);
  const [mutating, setMutating] = useState<"duplicate" | "delete" | null>(
    null,
  );
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const query = selectedVersionId
      ? `?versionId=${encodeURIComponent(selectedVersionId)}`
      : "";
    const response = await fetch(`/api/workflows/${props.workflowId}${query}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? "Flow not found."
          : "Flow could not be loaded.",
      );
    }
    const next = (await response.json()) as FlowWorkflowDetail;
    setDetail(next);
    if (!next.flowV1 && next.versionReview) {
      setSurface("versions");
      initialSurfaceResolved.current = true;
    } else if (!initialSurfaceResolved.current) {
      setSurface("live");
      initialSurfaceResolved.current = true;
    }
    setError(null);
    return next;
  }, [props.workflowId, selectedVersionId]);

  useEffect(() => {
    let active = true;
    void load()
      .catch((loadError) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Flow could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    if (!detail || detail.generation?.status === "failed") {
      return;
    }
    const delay = detail.generation?.agentSessionId ? 3_000 : 2_000;
    if (
      !detail.generation?.agentSessionId &&
      (detail.currentVersion || detail.versionReview)
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      void load().catch(() => undefined);
    }, delay);
    return () => window.clearInterval(interval);
  }, [detail, load]);

  useEffect(() => {
    const latestRun = detail?.flowV1?.runtime.latestRun;
    const activeCycle = detail?.flowV1?.runtime.activeCycle;
    const shouldTrack =
      latestRun?.status === "pending" ||
      latestRun?.status === "running" ||
      activeCycle?.status === "running";
    if (!shouldTrack) {
      return;
    }
    const interval = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(interval);
  }, [
    detail?.flowV1?.runtime.activeCycle?.status,
    detail?.flowV1?.runtime.latestRun?.status,
    load,
  ]);

  async function retryGeneration() {
    setRetrying(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/workflows/${props.workflowId}/generation`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ retry: true }),
        },
      );
      if (!response.ok) {
        throw new Error("Flow authoring session could not be retried.");
      }
      await load();
    } catch (retryError) {
      setError(
        retryError instanceof Error
          ? retryError.message
          : "Flow authoring session could not be retried.",
      );
    } finally {
      setRetrying(false);
    }
  }

  async function duplicateFlow() {
    setMutating("duplicate");
    setError(null);
    try {
      const response = await fetch(
        `/api/workflows/${props.workflowId}/duplicate`,
        { method: "POST" },
      );
      const duplicated = (await response.json()) as WorkflowDetail;
      if (!response.ok || !duplicated.workflow?.id) {
        throw new Error("Flow could not be duplicated.");
      }
      router.push(`/workflows/${duplicated.workflow.id}`);
    } catch (duplicateError) {
      setError(
        duplicateError instanceof Error
          ? duplicateError.message
          : "Flow could not be duplicated.",
      );
    } finally {
      setMutating(null);
    }
  }

  async function deleteFlow() {
    setMutating("delete");
    setError(null);
    try {
      const response = await fetch(`/api/workflows/${props.workflowId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Flow could not be deleted.");
      }
      setDeleteConfirmOpen(false);
      router.push("/");
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Flow could not be deleted.",
      );
      setMutating(null);
    }
  }

  if (loading) {
    return (
      <main className="app-shell">
        <LoadingState fullPage skeleton={<WorkbenchSkeleton />}>
          Loading Flow…
        </LoadingState>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="app-shell">
        <ErrorState
          fullPage
          title="Flow unavailable"
          message={error ?? "The Flow could not be loaded."}
        />
      </main>
    );
  }

  if (!hasCurrentVersion(detail) && !detail.versionReview) {
    return (
      <WorkflowGenerationState
        detail={detail}
        isGenerating={detail.generation?.status !== "failed"}
        retrying={retrying}
        generationError={error ?? undefined}
        onRetry={() => void retryGeneration()}
      />
    );
  }

  if (detail.currentVersion && !detail.flowV1) {
    return (
      <main className="app-shell">
        <ErrorState
          fullPage
          title="Unsupported workflow format"
          message="This installation now supports only tutti.flow.v1 Bundles. Recreate this workflow as a Flow."
          action={
            <Link href="/">Return home</Link>
          }
        />
      </main>
    );
  }
  const displayName =
    surface === "versions"
      ? detail.versionReview?.version.meta.name ?? detail.workflow.name
      : detail.workflow.name;
  const displayDescription =
    surface === "versions"
      ? detail.versionReview?.version.meta.description ??
        detail.workflow.description
      : detail.workflow.description;
  const detailStatus =
    surface === "versions"
      ? detail.versionReview?.version.status ?? "version"
      : detail.flowV1?.selectedCycle?.status ??
        detail.flowV1?.runtime.lifecycle ??
        "ready";

  return (
    <main className="app-shell detail-shell">
      <header className="detail-topbar">
        <div className="detail-titlebar">
          <Link href="/" className="flow-back-link">
            <span aria-hidden="true">←</span>
            <span>Workflows</span>
          </Link>
          <div className="detail-heading">
            <div className="detail-heading-title">
              <h1>{displayName}</h1>
              <span
                className="detail-status"
                data-tone={detailStatusTone(detailStatus)}
              >
                {detailStatusLabel(detailStatus)}
              </span>
            </div>
            <div className="detail-meta">
              <span className="detail-description">
                {displayDescription}
              </span>
            </div>
          </div>
        </div>
        <div className="flow-detail-actions">
          <div
            className="detail-surface-tabs"
            role="tablist"
            aria-label="Workflow detail section"
          >
            {(
              [
                ["design", "Flow"],
                ["live", "Activity"],
                ["review", "History"],
                ["versions", "Versions"],
              ] as const
            ).map(([value, label]) => (
              <button
                aria-selected={surface === value}
                className={surface === value ? "is-active" : undefined}
                disabled={
                  value === "versions"
                    ? !detail.versionReview
                    : !detail.flowV1
                }
                key={value}
                onClick={() => setSurface(value)}
                role="tab"
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="detail-more-button"
                variant="outline"
                size="icon-lg"
                aria-label="More workflow actions"
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={mutating !== null || !detail.currentVersion}
                onSelect={() => void duplicateFlow()}
              >
                <CopyIcon data-icon="inline-start" />
                {mutating === "duplicate" ? "Duplicating…" : "Duplicate"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={mutating !== null}
                onSelect={() => setDeleteConfirmOpen(true)}
              >
                <FailedLinedIcon data-icon="inline-start" />
                {mutating === "delete" ? "Deleting…" : "Delete"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {error ? <p className="flow-detail-error">{error}</p> : null}
      {surface === "versions" && detail.versionReview ? (
        <FlowVersionReviewPanel
          authoringSessionId={detail.generation?.agentSessionId}
          onRefresh={load}
          onSelectVersion={setSelectedVersionId}
          review={detail.versionReview}
          versions={detail.versions}
          workflowId={props.workflowId}
        />
      ) : null}
      {surface !== "versions" && detail.flowV1 ? (
        <FlowRuntimeOverview
          workflowId={props.workflowId}
          projection={detail.flowV1}
          view={surface}
          onViewChange={setSurface}
          onRefresh={load}
        />
      ) : null}
      <ConfirmationDialog
        cancelLabel="Keep workflow"
        confirmBusy={mutating === "delete"}
        confirmLabel={mutating === "delete" ? "Deleting…" : "Delete workflow"}
        description="This permanently deletes the workflow and its complete run history."
        disableCloseWhileBusy
        onConfirm={() => void deleteFlow()}
        onOpenChange={setDeleteConfirmOpen}
        open={deleteConfirmOpen}
        title={`Delete “${detail.workflow.name}”?`}
        tone="destructive"
      />
    </main>
  );
}

function detailStatusTone(
  status: string,
): "neutral" | "success" | "warning" | "danger" | "active" {
  if (status === "running" || status === "runnable" || status === "active") {
    return "active";
  }
  if (status === "completed" || status === "published") {
    return "success";
  }
  if (status.startsWith("waiting") || status === "draft") {
    return "warning";
  }
  if (status.startsWith("paused") || status === "failed") {
    return "danger";
  }
  return "neutral";
}

function detailStatusLabel(status: string): string {
  switch (status) {
    case "runnable":
      return "ready";
    case "waiting_human":
      return "needs review";
    case "waiting_gate":
      return "waiting";
    case "paused_failed":
    case "paused_uncertain":
    case "paused_conflict":
    case "paused_budget":
      return "needs attention";
    default:
      return status.replaceAll("_", " ");
  }
}
