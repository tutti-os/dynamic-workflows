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
import type {
  WorkflowListItem,
  WorkflowRunStatus,
} from "@/lib/db/workflows";

type WorkflowGridProps = {
  workflows: WorkflowListItem[];
  hasAnyWorkflow: boolean;
  duplicatingId?: string;
  deletingId?: string;
  onDuplicateWorkflow: (workflowId: string) => Promise<void>;
  onDeleteWorkflow: (workflowId: string, workflowName: string) => Promise<void>;
};

export function WorkflowGrid(props: WorkflowGridProps) {
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
        <div className="empty-state">
          <NewWorkspaceIcon size={24} />
          <p>{props.hasAnyWorkflow ? "No workflows match." : "No workflows yet."}</p>
        </div>
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
            </div>
          </CardHeader>
        </Link>
        <CardFooter className="workflow-card-footer">
          {item.currentVersion ? (
            <Badge variant="success">v{item.currentVersion.version}</Badge>
          ) : (
            <Badge
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
              <Badge variant={runStatusBadge(item.latestRun.status)}>
                {item.latestRun.status}
              </Badge>
            </>
          ) : null}
          <div className="workflow-card-actions">
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
