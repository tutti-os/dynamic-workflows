import Link from "next/link";
import {
  ArrowRightIcon,
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardTitle,
  DirectoryIcon,
  FailedLinedIcon,
  FileCreateIcon,
  LoadingIcon,
  NewWorkspaceIcon,
} from "@tutti-os/ui-system";
import {
  EmptyState,
  WorkflowGridSkeleton,
} from "@/components/workflow/WorkflowStates";
import { CopyToClipboardButton } from "@/components/workflow/CopyToClipboardButton";
import type {
  WorkflowListItem,
  WorkflowRunStatus,
} from "@/lib/db/workflows/types";

type WorkflowGridProps = {
  workflows: WorkflowListItem[];
  hasAnyWorkflow: boolean;
  loading: boolean;
  duplicatingId?: string;
  deletingId?: string;
  onCreateWorkflowFocus: () => void;
  onDuplicateWorkflow: (workflowId: string) => Promise<void>;
  onDeleteWorkflow: (workflowId: string, workflowName: string) => Promise<void>;
};

export function WorkflowGrid(props: WorkflowGridProps) {
  if (props.loading) {
    return <WorkflowGridSkeleton />;
  }

  return (
    <div className="workflow-grid">
      {props.workflows.length > 0 ? (
        props.workflows.map((item) => (
          <WorkflowCard
            key={item.workflow.id}
            item={item}
            duplicating={props.duplicatingId === item.workflow.id}
            deleting={props.deletingId === item.workflow.id}
            onDuplicateWorkflow={props.onDuplicateWorkflow}
            onDeleteWorkflow={props.onDeleteWorkflow}
          />
        ))
      ) : (
        <EmptyState
          icon={<NewWorkspaceIcon size={26} />}
          title={props.hasAnyWorkflow ? "No workflows match" : "No workflows yet"}
          action={
            props.hasAnyWorkflow
              ? undefined
              : {
                  label: "Write a prompt",
                  onClick: props.onCreateWorkflowFocus,
                }
          }
        >
          {props.hasAnyWorkflow
            ? "Try a different search or status filter."
            : "Create your first local workflow from a prompt, or import an existing script."}
        </EmptyState>
      )}
    </div>
  );
}

function WorkflowCard(props: {
  item: WorkflowListItem;
  duplicating: boolean;
  deleting: boolean;
  onDuplicateWorkflow: (workflowId: string) => Promise<void>;
  onDeleteWorkflow: (workflowId: string, workflowName: string) => Promise<void>;
}) {
  const { item } = props;
  const workflowUrl = `/workflows/${item.workflow.id}`;
  const generationStatus = item.generation?.status;

  return (
    <article className="workflow-card-shell">
      <Card className="workflow-card" size="sm">
        <Link className="workflow-card-body" href={workflowUrl}>
          <CardHeader className="workflow-card-header">
            <span className="workflow-card-icon">
              <DirectoryIcon size={20} />
            </span>
            <div>
              <CardTitle>{item.workflow.name}</CardTitle>
              <p>{item.workflow.description}</p>
              <div className="workflow-card-submeta">
                <span>{item.currentVersion ? `v${item.currentVersion.version}` : "Draft"}</span>
                <span>Updated {formatShortDate(item.workflow.updatedAt)}</span>
              </div>
            </div>
          </CardHeader>
        </Link>
        <CardFooter className="workflow-card-footer">
          {item.currentVersion ? (
            <Badge variant="success">v{item.currentVersion.version}</Badge>
          ) : (
            <Badge
              className={generationStatus === "running" ? "status-pulse" : undefined}
              variant={generationStatus === "failed" ? "destructive" : "pending"}
            >
              {generationStatus === "failed"
                ? "generation failed"
                : "generating"}
            </Badge>
          )}
          <span className="workflow-card-dot">·</span>
          <span>{item.runCount} runs</span>
          {item.latestRun ? (
            <>
              <span className="workflow-card-dot">·</span>
              <Badge
                className={item.latestRun.status === "running" ? "status-pulse" : undefined}
                variant={runStatusBadge(item.latestRun.status)}
              >
                {item.latestRun.status}
              </Badge>
              <span>{formatShortDate(item.latestRun.startedAt)}</span>
            </>
          ) : null}
          <div className="workflow-card-actions">
            <CopyToClipboardButton
              size="sm"
              variant="outline"
              text={item.workflow.id}
              label="Copy ID"
              title="Copy workflow ID for CLI usage"
              aria-label={`Copy ID for ${item.workflow.name}`}
            />
            <Button
              asChild
              size="sm"
              variant="outline"
              aria-label={`Open ${item.workflow.name}`}
            >
              <Link href={workflowUrl}>
                <ArrowRightIcon data-icon="inline-start" />
                Open
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => void props.onDuplicateWorkflow(item.workflow.id)}
              disabled={props.duplicating || !item.currentVersion}
            >
              {props.duplicating ? (
                <LoadingIcon className="spin" data-icon="inline-start" />
              ) : (
                <FileCreateIcon data-icon="inline-start" />
              )}
              Duplicate
            </Button>
            <Button
              className="delete-workflow-button"
              size="sm"
              variant="outline"
              type="button"
              onClick={() =>
                void props.onDeleteWorkflow(item.workflow.id, item.workflow.name)
              }
              disabled={props.deleting}
            >
              {props.deleting ? (
                <LoadingIcon className="spin" data-icon="inline-start" />
              ) : (
                <FailedLinedIcon data-icon="inline-start" />
              )}
              Delete
            </Button>
          </div>
        </CardFooter>
      </Card>
    </article>
  );
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function runStatusBadge(status: WorkflowRunStatus) {
  if (status === "completed") {
    return "success" as const;
  }
  if (status === "running") {
    return "pending" as const;
  }
  if (status === "interrupted") {
    return "warning" as const;
  }
  if (status === "failed") {
    return "destructive" as const;
  }
  if (status === "canceled") {
    return "warning" as const;
  }
  return "default" as const;
}
