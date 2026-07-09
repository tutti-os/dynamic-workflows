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
  type WorkflowAuthoringSessionItem,
} from "@/components/workflow/workflowApiService";
import { formatDate } from "@/components/workflow/runPanelUtils";

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
        {sessions.map((session) => {
          const running = isSessionActive(session.status);
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
                </div>
                <span
                  className="authoring-row-request"
                  title={session.errorMessage ?? session.request}
                >
                  {session.request}
                </span>
                <time>{formatDate(session.createdAt)}</time>
              </div>
              {session.agentSessionId ? (
                <Button
                  className="run-row-action"
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Open authoring session"
                  onClick={() =>
                    props.onOpenAgentSession(session.agentSessionId!)
                  }
                >
                  <LaunchIcon data-icon="inline-start" />
                  Open session
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
