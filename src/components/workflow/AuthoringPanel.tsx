import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  DirectoryIcon,
  LaunchIcon,
} from "@tutti-os/ui-system";
import {
  EmptyState,
  RunListSkeleton,
} from "@/components/workflow/WorkflowStates";
import {
  listWorkflowAuthoringSessions,
  runWorkflowAuthoringAction,
  type WorkflowAuthoringSessionItem,
} from "@/components/workflow/workflowApiService";
import { formatDate } from "@/components/workflow/runPanelUtils";
import type {
  AuthoringSubmitResult,
  AuthoringValidateResult,
} from "@/lib/workflow/authoring/submit";

type AuthoringPanelProps = {
  workflowId: string;
  active: boolean;
  onOpenAgentSession: (agentSessionId: string) => void;
};

function isSessionActive(status: string): boolean {
  return status === "pending" || status === "running";
}

function sessionStatusLabel(status: string): string {
  return isSessionActive(status) ? "authoring" : status;
}

function sessionStatusBadge(
  status: string,
): "success" | "destructive" | "pending" | "default" {
  if (isSessionActive(status)) {
    return "pending";
  }
  if (status === "completed") {
    return "success";
  }
  if (status === "failed" || status === "canceled") {
    return "destructive";
  }
  return "default";
}

export function AuthoringPanel(props: AuthoringPanelProps) {
  const { workflowId, active } = props;
  const [sessions, setSessions] = useState<WorkflowAuthoringSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingJobId, setActingJobId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [actionResult, setActionResult] = useState<{
    jobId: string;
    result: AuthoringSubmitResult | AuthoringValidateResult;
  }>();

  async function runAction(
    session: WorkflowAuthoringSessionItem,
    action: "check" | "review" | "submit" | "skip",
  ) {
    let reason: string | undefined;
    if (action === "skip") {
      reason = window.prompt("Why is semantic review unnecessary for this change?")?.trim();
      if (!reason) {
        return;
      }
    }
    setActingJobId(session.id);
    setActionError(undefined);
    setActionResult(undefined);
    try {
      const result = await runWorkflowAuthoringAction({
        workflowId,
        jobId: session.id,
        action,
        reason,
      });
      setActionResult({ jobId: session.id, result });
      setSessions(await listWorkflowAuthoringSessions(workflowId));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Authoring action failed.");
    } finally {
      setActingJobId(undefined);
    }
  }

  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;

    async function refresh() {
      try {
        const items = await listWorkflowAuthoringSessions(workflowId);
        if (!cancelled) {
          setSessions(items);
        }
      } catch {
        // History is informational; keep the panel usable if it fails.
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [active, workflowId]);

  if (loading && sessions.length === 0) {
    return (
      <div className="authoring-panel">
        <RunListSkeleton />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="authoring-panel">
        <EmptyState icon={<DirectoryIcon size={24} />} title="No authoring sessions">
          Creating or AI-editing this workflow launches an agent session. Sessions
          appear here so you can reopen them and follow the conversation.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="authoring-panel">
      <div className="run-list authoring-list">
        {actionError ? <p className="authoring-action-error">{actionError}</p> : null}
        {sessions.map((session) => {
          const running = isSessionActive(session.status);
          const review = session.semanticReview;
          const acting = actingJobId === session.id;
          const result =
            actionResult?.jobId === session.id ? actionResult.result : undefined;
          return (
            <div key={session.id} className="run-row authoring-row">
              <div className="authoring-row-main">
                <div className="authoring-row-badges">
                  <Badge variant="outline">{session.kind}</Badge>
                  <Badge
                    className={running ? "status-pulse" : undefined}
                    variant={sessionStatusBadge(session.status)}
                  >
                    {sessionStatusLabel(session.status)}
                  </Badge>
                  {review ? (
                    <Badge
                      variant={
                        review.status === "passed"
                          ? "success"
                          : review.status === "running"
                            ? "pending"
                            : review.status === "waived"
                              ? "default"
                              : "destructive"
                      }
                    >
                      review: {review.status}
                    </Badge>
                  ) : null}
                </div>
                <span
                  className="authoring-row-request"
                  title={session.errorMessage ?? session.request}
                >
                  {session.request}
                </span>
                {review && review.status !== "running" ? (
                  <details className="authoring-review-detail">
                    <summary>{review.summary}</summary>
                    {review.findings.map((finding, index) => (
                      <p key={`${review.reviewId}:${index}`}>
                        {finding.nodePath.length > 0
                          ? `${finding.nodePath.join(" → ")}: `
                          : ""}
                        {finding.reason} Suggestion: {finding.suggestion}
                      </p>
                    ))}
                    {review.waiverReason ? (
                      <p>Waiver reason: {review.waiverReason}</p>
                    ) : null}
                    {review.error ? <p>Error: {review.error}</p> : null}
                  </details>
                ) : null}
                {result ? <AuthoringActionResult result={result} /> : null}
                <time>{formatDate(session.createdAt)}</time>
              </div>
              <div className="authoring-row-actions">
                <Button size="sm" variant="outline" disabled={acting} onClick={() => void runAction(session, "check")}>Check script</Button>
                <Button size="sm" variant="outline" disabled={acting} onClick={() => void runAction(session, "review")}>Review design</Button>
                <Button size="sm" disabled={acting} onClick={() => void runAction(session, "submit")}>{session.kind === "create" ? "Create workflow" : "Create version"}</Button>
                <Button size="sm" variant="outline" disabled={acting} onClick={() => void runAction(session, "skip")}>Skip review</Button>
                {session.agentSessionId ? (
                  <Button
                    className="run-row-action"
                    size="sm"
                    variant="outline"
                    type="button"
                    aria-label="Open authoring session"
                    onClick={() => props.onOpenAgentSession(session.agentSessionId!)}
                  >
                    <LaunchIcon data-icon="inline-start" />
                    Open session
                  </Button>
                ) : null}
                {review?.reviewerSessionId ? (
                  <Button size="sm" variant="outline" onClick={() => props.onOpenAgentSession(review.reviewerSessionId!)}>
                    <LaunchIcon data-icon="inline-start" />
                    Open review
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AuthoringActionResult(props: {
  result: AuthoringSubmitResult | AuthoringValidateResult;
}) {
  const diagnostics =
    "diagnostics" in props.result ? props.result.diagnostics : [];
  const succeeded =
    "valid" in props.result ? props.result.valid : props.result.accepted;
  const summary =
    "valid" in props.result
      ? props.result.valid
        ? props.result.review?.status === "running"
          ? "DSL valid. Semantic review started."
          : "DSL validation passed."
        : "DSL validation failed."
      : props.result.accepted
        ? "Workflow version created."
        : "Workflow submission rejected."

  return (
    <div
      className={`authoring-action-result${succeeded ? "" : " failed"}`}
      role={succeeded ? "status" : "alert"}
    >
      <strong>{summary}</strong>
      {diagnostics.map((diagnostic, index) => (
        <p key={`${diagnostic.code}:${diagnostic.path ?? ""}:${index}`}>
          {diagnostic.path ? `${diagnostic.path}: ` : ""}
          {diagnostic.message}
        </p>
      ))}
    </div>
  );
}
