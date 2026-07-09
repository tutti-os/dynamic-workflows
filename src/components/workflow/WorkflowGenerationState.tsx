import Link from "next/link";
import { useCallback, useState } from "react";
import {
  Badge,
  Button,
  DashboardIcon,
  FailedLinedIcon,
  LaunchIcon,
  LoadingIcon,
  Spinner,
} from "@tutti-os/ui-system";
import type {
  WorkflowDetail,
  WorkflowVersionRecord,
} from "@/lib/db/workflows/types";
import { openWorkflowAgentSession } from "./workflowApiService";

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
  const agentSessionId = generation?.agentSessionId ?? undefined;
  const errorMessage =
    props.generationError ?? generation?.error?.message ?? "Generation failed.";
  const [openingSession, setOpeningSession] = useState(false);

  const openSession = useCallback(() => {
    if (!agentSessionId) {
      return;
    }
    setOpeningSession(true);
    void openWorkflowAgentSession(agentSessionId).finally(() => {
      setOpeningSession(false);
    });
  }, [agentSessionId]);

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
              <Badge
                className={failed ? undefined : "status-pulse"}
                variant={failed ? "destructive" : "pending"}
              >
                {failed
                  ? "session launch failed"
                  : agentSessionId
                    ? "authoring session active"
                    : "launching session"}
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
              {failed
                ? "Authoring session failed to launch"
                : "Authoring session in progress"}
            </h2>
            <p>
              {failed
                ? errorMessage
                : agentSessionId
                  ? "The authoring agent is working in its own session. Open it to follow along or answer its questions; the workflow opens here as soon as the agent submits a script."
                  : "Launching the authoring agent session..."}
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
          ) : agentSessionId ? (
            <Button
              className="generation-retry-button"
              type="button"
              disabled={openingSession}
              onClick={openSession}
            >
              <LaunchIcon data-icon="inline-start" />
              Open session
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
