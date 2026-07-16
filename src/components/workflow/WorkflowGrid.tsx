"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CheckIcon,
  CopyIcon,
  DirectoryIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FailedLinedIcon,
  FileCreateIcon,
  LoadingIcon,
  MoreHorizontalIcon,
  NewWorkspaceIcon,
} from "@tutti-os/ui-system";
import {
  EmptyState,
  WorkflowGridSkeleton,
} from "@/components/workflow/WorkflowStates";
import { writeClipboardText } from "@/components/workflow/workflowClientUtils";
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
  const [copyNotice, setCopyNotice] = useState<string>();

  useEffect(() => {
    if (!copyNotice) {
      return;
    }
    const timeout = window.setTimeout(() => setCopyNotice(undefined), 1800);
    return () => window.clearTimeout(timeout);
  }, [copyNotice]);

  async function copyWorkflowId(workflowId: string, workflowName: string) {
    await writeClipboardText(workflowId);
    setCopyNotice(`${workflowName} ID copied.`);
  }

  if (props.loading) {
    return <WorkflowGridSkeleton />;
  }

  return (
    <>
      <div className="workflow-grid">
        {props.workflows.length > 0 ? (
          props.workflows.map((item) => (
            <WorkflowCard
              key={item.workflow.id}
              item={item}
              duplicating={props.duplicatingId === item.workflow.id}
              deleting={props.deletingId === item.workflow.id}
              onCopyWorkflowId={copyWorkflowId}
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
      {copyNotice ? (
        <div className="copy-notice" role="status" aria-live="polite">
          <CheckIcon size={16} />
          {copyNotice}
        </div>
      ) : null}
    </>
  );
}

function WorkflowCard(props: {
  item: WorkflowListItem;
  duplicating: boolean;
  deleting: boolean;
  onCopyWorkflowId: (
    workflowId: string,
    workflowName: string,
  ) => Promise<void>;
  onDuplicateWorkflow: (workflowId: string) => Promise<void>;
  onDeleteWorkflow: (workflowId: string, workflowName: string) => Promise<void>;
}) {
  const { item } = props;
  const workflowUrl = `/workflows/${item.workflow.id}`;
  const generationStatus = item.generation?.status;
  const latestRunStatus = item.latestRun?.status;

  return (
    <article className="workflow-card-shell">
      <Card className="workflow-card" size="sm">
        <Link
          className="workflow-card-main"
          href={workflowUrl}
          aria-label={`Open ${item.workflow.name}`}
        >
          <span className="workflow-card-icon">
            <DirectoryIcon size={20} />
          </span>
          <span className="workflow-card-summary">
            <span className="workflow-card-copy">
              <span className="workflow-card-title">{item.workflow.name}</span>
              <span className="workflow-card-description">
                {item.workflow.description}
              </span>
            </span>
            <span className="workflow-card-submeta">
              <span>
                {item.currentVersion
                  ? `Version ${item.currentVersion.version}`
                  : "Draft"}
              </span>
              <span>
                {item.runCount} {item.runCount === 1 ? "run" : "runs"}
              </span>
            </span>
          </span>
          <span className="workflow-card-state">
            {latestRunStatus ? (
              <Badge
                className={latestRunStatus === "running" ? "status-pulse" : undefined}
                variant={runStatusBadge(latestRunStatus)}
              >
                {formatStatusLabel(latestRunStatus)}
              </Badge>
            ) : item.currentVersion ? (
              <Badge variant="success">Ready</Badge>
            ) : (
              <Badge
                className={generationStatus === "running" ? "status-pulse" : undefined}
                variant={generationStatus === "failed" ? "destructive" : "pending"}
              >
                {generationStatus === "failed" ? "Authoring failed" : "Authoring"}
              </Badge>
            )}
            <time dateTime={item.workflow.updatedAt}>
              {formatShortDate(item.workflow.updatedAt)}
            </time>
          </span>
        </Link>
        <div className="workflow-card-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="card-overflow-trigger"
                variant="outline"
                size="icon-lg"
                type="button"
                aria-label={`More actions for ${item.workflow.name}`}
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  void props.onCopyWorkflowId(
                    item.workflow.id,
                    item.workflow.name,
                  )
                }
              >
                <CopyIcon data-icon="inline-start" />
                Copy workflow ID
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void props.onDuplicateWorkflow(item.workflow.id)}
                disabled={props.duplicating || !item.currentVersion}
              >
                {props.duplicating ? (
                  <LoadingIcon className="spin" data-icon="inline-start" />
                ) : (
                  <FileCreateIcon data-icon="inline-start" />
                )}
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
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
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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
  if (status === "waiting_for_human") {
    return "warning" as const;
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

function formatStatusLabel(status: WorkflowRunStatus): string {
  return status.replaceAll("_", " ");
}
