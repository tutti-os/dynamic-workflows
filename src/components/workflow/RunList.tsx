import clsx from "clsx";
import {
  Badge,
  Button,
  DirectoryIcon,
  PlayIcon,
  RefreshIcon,
  Spinner,
  StatusDot,
} from "@tutti-os/ui-system";
import {
  EmptyState,
  RunListSkeleton,
} from "@/components/workflow/WorkflowStates";
import type {
  WorkflowRunRecord,
} from "@/lib/db/workflows/types";
import {
  canRetryRun,
  canResumeRun,
  formatDate,
  getRunVersionLabel,
  runStatusBadge,
  runStatusTone,
} from "@/components/workflow/runPanelUtils";
import { hasNotAcceptedDelivery } from "@/lib/workflow/run-detail";

export function RunList(props: {
  runs: WorkflowRunRecord[];
  selectedRunId?: string;
  versionLabelById: Record<string, string>;
  isRunning: boolean;
  loading?: boolean;
  retryingRunId?: string;
  onSelectRun: (runId: string) => void;
  onRetryRun: (runId: string) => void;
  onResumeRun: (runId: string) => void;
}) {
  if (props.loading) {
    return <RunListSkeleton />;
  }

  return (
    <div className="run-list">
      {props.runs.length > 0 ? (
        props.runs.map((run) => (
          <RunListItem
            key={run.id}
            run={run}
            selected={props.selectedRunId === run.id}
            versionLabel={getRunVersionLabel(run, props.versionLabelById)}
            isRunning={props.isRunning}
            retrying={props.retryingRunId === run.id}
            onSelectRun={props.onSelectRun}
            onRetryRun={props.onRetryRun}
            onResumeRun={props.onResumeRun}
          />
        ))
      ) : (
        <EmptyState
          icon={<DirectoryIcon size={24} />}
          title="No runs yet"
        >
          Run this workflow to inspect node output, checkpoints, and logs.
        </EmptyState>
      )}
    </div>
  );
}

function RunListItem(props: {
  run: WorkflowRunRecord;
  selected: boolean;
  versionLabel: string;
  isRunning: boolean;
  retrying: boolean;
  onSelectRun: (runId: string) => void;
  onRetryRun: (runId: string) => void;
  onResumeRun: (runId: string) => void;
}) {
  const { run } = props;
  const continuesDelivery =
    run.status === "completed" && hasNotAcceptedDelivery(run.result);

  return (
    <div className={clsx("run-row", props.selected && "active")}>
      <button
        className="run-row-main"
        type="button"
        aria-label={`Select run ${run.id}`}
        onClick={() => props.onSelectRun(run.id)}
      >
        <StatusDot
          tone={runStatusTone(run.status)}
          pulse={run.status === "running"}
        />
        <div>
          <strong>{run.id}</strong>
          <span>
            {run.agent ?? run.executorKind}
            {run.model ? ` · ${run.model}` : ""} · {props.versionLabel}
          </span>
        </div>
        <Badge
          className={run.status === "running" ? "status-pulse" : undefined}
          variant={runStatusBadge(run.status)}
        >
          {run.status === "waiting_for_human" && run.pendingHumanTaskCount
            ? `needs input · ${run.pendingHumanTaskCount}`
            : run.status}
        </Badge>
        <time>{formatDate(run.startedAt)}</time>
      </button>
      {canResumeRun(run.status) ? (
        <Button
          className="run-row-action"
          size="sm"
          variant="outline"
          type="button"
          aria-label={`Resume run ${run.id}`}
          disabled={props.isRunning}
          onClick={() => props.onResumeRun(run.id)}
        >
          {props.retrying ? (
            <Spinner size={14} />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          Resume
        </Button>
      ) : canRetryRun(run.status) ? (
        <Button
          className="run-row-action"
          size="sm"
          variant="outline"
          type="button"
          aria-label={
            continuesDelivery
              ? `Continue delivery from run ${run.id}`
              : `Retry run ${run.id}`
          }
          disabled={props.isRunning}
          title={
            continuesDelivery
              ? "This run ended not_accepted after exhausting its round budget. The workspace keeps all progress, so a new run with the same inputs and working directory continues the delivery loop from the current state."
              : undefined
          }
          onClick={() => props.onRetryRun(run.id)}
        >
          {props.retrying ? (
            <Spinner size={14} />
          ) : continuesDelivery ? (
            <PlayIcon data-icon="inline-start" />
          ) : (
            <RefreshIcon data-icon="inline-start" />
          )}
          {continuesDelivery ? "Continue delivery" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}
