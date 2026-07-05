import Link from "next/link";
import {
  Badge,
  Button,
  DashboardIcon,
  FailedLinedIcon,
  LoadingIcon,
  Spinner,
} from "@tutti-os/ui-system";
import type {
  WorkflowDetail,
  WorkflowVersionRecord,
} from "@/lib/db/workflows/types";

export function hasCurrentVersion(
  detail: WorkflowDetail,
): detail is WorkflowDetail & { currentVersion: WorkflowVersionRecord } {
  return Boolean(detail.currentVersion);
}

export function WorkflowGenerationState(props: {
  detail: WorkflowDetail;
  isGenerating: boolean;
  retrying: boolean;
  generationError?: string;
  onRetry: () => void;
}) {
  const generation = props.detail.generation;
  const failed = generation?.status === "failed";
  const errorMessage =
    props.generationError ?? generation?.error?.message ?? "Generation failed.";

  return (
    <main className="app-shell">
      <header className="detail-topbar generation-topbar">
        <div className="detail-titlebar">
          <Button asChild variant="outline" size="icon-lg" aria-label="Home">
            <Link href="/">
              <DashboardIcon />
            </Link>
          </Button>
          <div className="detail-heading">
            <div className="detail-heading-title">
              <h1>{props.detail.workflow.name}</h1>
            </div>
            <div className="detail-meta">
              <Badge variant={failed ? "destructive" : "pending"}>
                {failed ? "generation failed" : "generating"}
              </Badge>
              <span className="detail-description">
                {props.detail.workflow.description}
              </span>
            </div>
          </div>
        </div>
      </header>

      <section className="workflow-generation-state">
        <div className="workflow-generation-status">
          {failed ? (
            <span className="generation-status-icon failed">
              <FailedLinedIcon size={24} />
            </span>
          ) : (
            <span className="generation-status-icon">
              {props.isGenerating ? (
                <LoadingIcon className="spin" size={24} />
              ) : (
                <Spinner />
              )}
            </span>
          )}
          <div className="generation-status-copy">
            <h2>
              {failed ? "Workflow generation failed" : "Generating workflow"}
            </h2>
            <p>
              {failed
                ? errorMessage
                : "The workflow detail is ready. The script is being generated and will open here when it finishes."}
            </p>
          </div>
          {failed ? (
            <Button
              className="generation-retry-button"
              type="button"
              disabled={props.retrying}
              onClick={props.onRetry}
            >
              {props.retrying ? (
                <LoadingIcon className="spin" data-icon="inline-start" />
              ) : null}
              Retry generation
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
