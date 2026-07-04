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
import type { WorkflowRunRecord } from "@/lib/db/workflows";
import {
  canRetryRun,
  canResumeRun,
  formatDate,
  getRunVersionLabel,
  runStatusBadge,
  runStatusTone,
} from "@/components/workflow/runPanelUtils";

export function RunList(props: {
  runs: WorkflowRunRecord[];
  selectedRunId?: string;
  versionLabelById: Record<string, string>;
  isRunning: boolean;
  retryingRunId?: string;
  onSelectRun: (runId: string) => void;
  onRetryRun: (runId: string) => void;
  onResumeRun: (runId: string) => void;
}) {
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
        <div className="empty-state">
          <DirectoryIcon size={22} />
          <p>No runs yet.</p>
        </div>
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

  return (
    <div className={clsx("run-row", props.selected && "active")}>
      <button
        className="run-row-main"
        type="button"
        onClick={() => props.onSelectRun(run.id)}
      >
        <StatusDot
          tone={runStatusTone(run.status)}
          pulse={run.status === "running"}
        />
        <div>
          <strong>{run.id}</strong>
          <span>
            {run.provider ?? run.executorKind}
            {run.model ? ` · ${run.model}` : ""} · {props.versionLabel}
          </span>
        </div>
        <Badge variant={runStatusBadge(run.status)}>{run.status}</Badge>
        <time>{formatDate(run.startedAt)}</time>
      </button>
      {canResumeRun(run.status) ? (
        <Button
          className="run-row-action"
          size="sm"
          variant="outline"
          type="button"
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
          disabled={props.isRunning}
          onClick={() => props.onRetryRun(run.id)}
        >
          {props.retrying ? (
            <Spinner size={14} />
          ) : (
            <RefreshIcon data-icon="inline-start" />
          )}
          Retry
        </Button>
      ) : null}
    </div>
  );
}
