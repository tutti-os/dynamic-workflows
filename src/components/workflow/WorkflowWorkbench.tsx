"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { WorkflowErrorBoundary } from "@/components/workflow/WorkflowErrorBoundary";
import { FlowRuntimeOverview } from "@/components/workflow/FlowRuntimeOverview";
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
  const [mutating, setMutating] = useState<"duplicate" | "delete" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/workflows/${props.workflowId}`, {
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
    setError(null);
    return next;
  }, [props.workflowId]);

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
    if (
      !detail ||
      detail.currentVersion ||
      detail.generation?.status === "failed"
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [detail, load]);

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
    if (!window.confirm("Delete this Flow and all of its Cycle history?")) {
      return;
    }
    setMutating("delete");
    setError(null);
    try {
      const response = await fetch(`/api/workflows/${props.workflowId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Flow could not be deleted.");
      }
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

  if (!hasCurrentVersion(detail)) {
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

  if (!detail.flowV1) {
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

  return (
    <main className="app-shell">
      <header className="detail-topbar">
        <div className="detail-titlebar">
          <Link href="/" className="flow-back-link">
            Flows
          </Link>
          <div className="detail-heading">
            <div className="detail-heading-title">
              <h1>{detail.workflow.name}</h1>
            </div>
            <div className="detail-meta">
              <span className="detail-description">
                {detail.workflow.description}
              </span>
            </div>
          </div>
        </div>
        <div className="flow-detail-actions">
          <button
            disabled={mutating !== null}
            onClick={() => void duplicateFlow()}
            type="button"
          >
            {mutating === "duplicate" ? "Duplicating…" : "Duplicate"}
          </button>
          <button
            className="flow-runtime-action-danger"
            disabled={mutating !== null}
            onClick={() => void deleteFlow()}
            type="button"
          >
            {mutating === "delete" ? "Deleting…" : "Delete"}
          </button>
        </div>
      </header>
      {error ? <p className="flow-detail-error">{error}</p> : null}
      <FlowRuntimeOverview
        workflowId={props.workflowId}
        projection={detail.flowV1}
        onRefresh={load}
      />
    </main>
  );
}
