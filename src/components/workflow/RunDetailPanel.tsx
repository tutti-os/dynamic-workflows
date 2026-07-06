import {
  Badge,
  Button,
  LaunchIcon,
  PlayIcon,
  RefreshIcon,
  Spinner,
  WarningLinedIcon,
} from "@tutti-os/ui-system";
import type {
  WorkflowRunRecord,
} from "@/lib/db/workflows/types";
import type { RunDetail, RunNodeDetail } from "@/lib/workflow/run-detail";
import {
  canRetryRun,
  canResumeRun,
  formatDate,
  formatJson,
  getRunError,
  getRunVersionLabel,
  nodeStatusBadge,
  runStatusBadge,
} from "@/components/workflow/runPanelUtils";
import { CopyToClipboardButton } from "@/components/workflow/CopyToClipboardButton";

export function RunDetailPanel(props: {
  detail: RunDetail;
  selectedNodeRun: RunNodeDetail | null;
  versionLabelById: Record<string, string>;
  isRunning: boolean;
  retryingRunId?: string;
  copiedRunField?: string;
  onRetryRun: (runId: string) => void;
  onResumeRun: (runId: string) => void;
  onCopyRunText: (key: string, text: string) => void;
  onOpenAgentSession: (agentSessionId: string) => void;
}) {
  const { detail } = props;
  const { run } = detail;
  const selectedRunError = getRunError(run.result);

  return (
    <>
      <RunDetailHeader
        run={run}
        versionLabel={getRunVersionLabel(run, props.versionLabelById)}
        isRunning={props.isRunning}
        retrying={props.retryingRunId === run.id}
        copied={props.copiedRunField === `id:${run.id}`}
        onRetryRun={props.onRetryRun}
        onResumeRun={props.onResumeRun}
        onCopyRunText={props.onCopyRunText}
      />

      {run.status === "interrupted" ? <InterruptedRunNotice /> : null}

      <div className="run-facts">
        <RunFact label="Run ID" value={run.id} />
        <RunFact label="Started" value={formatDate(run.startedAt)} />
        <RunFact
          label="Finished"
          value={run.finishedAt ? formatDate(run.finishedAt) : "Running"}
        />
        <RunFact label="CWD" value={run.cwd ?? "server workspace"} />
        <RunFact label="Log path" value={run.logPath ?? "No log path"} />
      </div>

      {selectedRunError ? (
        <div className="diagnostic error">
          <WarningLinedIcon size={14} />
          {selectedRunError}
        </div>
      ) : null}

      {props.selectedNodeRun ? (
        <RunNodeDetailSection
          runId={run.id}
          nodeRun={props.selectedNodeRun}
          copiedRunField={props.copiedRunField}
          onCopyRunText={props.onCopyRunText}
          onOpenAgentSession={props.onOpenAgentSession}
        />
      ) : null}

      <RunTextBlock
        label="Input"
        text={formatJson(run.input)}
        copyKey={`input:${run.id}`}
        copiedRunField={props.copiedRunField}
        onCopy={props.onCopyRunText}
      />
      <RunTextBlock
        label="Result"
        text={formatJson(run.result)}
        copyKey={`result:${run.id}`}
        copiedRunField={props.copiedRunField}
        onCopy={props.onCopyRunText}
      />
    </>
  );
}

function RunDetailHeader(props: {
  run: WorkflowRunRecord;
  versionLabel: string;
  isRunning: boolean;
  retrying: boolean;
  copied: boolean;
  onRetryRun: (runId: string) => void;
  onResumeRun: (runId: string) => void;
  onCopyRunText: (key: string, text: string) => void;
}) {
  const { run } = props;

  return (
    <div className="run-detail-header">
      <div className="run-detail-meta">
        <Badge
          className={run.status === "running" ? "status-pulse" : undefined}
          variant={runStatusBadge(run.status)}
        >
          {run.status}
        </Badge>
        <Badge variant="default">{props.versionLabel}</Badge>
        <span>
          {run.agent ?? run.executorKind}
          {run.model ? ` · ${run.model}` : ""}
        </span>
      </div>
      <div className="run-detail-actions">
        <CopyToClipboardButton
          className="copy-text-button"
          size="sm"
          variant="outline"
          copied={props.copied}
          label="Copy ID"
          onCopyText={() => props.onCopyRunText(`id:${run.id}`, run.id)}
        />
        {canResumeRun(run.status) ? (
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={props.isRunning}
            title="Continue from the last saved checkpoint and reconnect existing downstream agent sessions when available."
            onClick={() => props.onResumeRun(run.id)}
          >
            {props.retrying ? (
              <Spinner size={14} />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            Resume
          </Button>
        ) : null}
        {canRetryRun(run.status) ? (
          <Button
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
    </div>
  );
}

function InterruptedRunNotice() {
  return (
    <div className="diagnostic warning run-resume-notice">
      <WarningLinedIcon size={14} />
      <span>
        This run stopped before the workflow runner finished. Resume continues from
        the latest checkpoint and reuses existing downstream agent sessions when
        available.
      </span>
    </div>
  );
}

function RunNodeDetailSection(props: {
  runId: string;
  nodeRun: RunNodeDetail;
  copiedRunField?: string;
  onCopyRunText: (key: string, text: string) => void;
  onOpenAgentSession: (agentSessionId: string) => void;
}) {
  const { nodeRun } = props;
  const session = nodeRun.session;

  return (
    <section className="run-node-detail">
      <div className="field-heading">
        <label>Node execution</label>
        <Badge variant={nodeStatusBadge(nodeRun.status)}>{nodeRun.status}</Badge>
      </div>
      <div className="run-facts run-node-facts">
        <RunFact label="Node ID" value={nodeRun.node.id} />
        <RunFact label="Label" value={nodeRun.node.label} />
        {session ? (
          <>
            <RunFact label="Agent Session" value={session.agentSessionId} />
            <RunFact
              label="Agent"
              value={`${session.agent}${session.model ? ` · ${session.model}` : ""}`}
            />
          </>
        ) : null}
      </div>
      {session ? (
        <div className="agent-session-actions">
          <Badge
            className={session.status === "running" ? "status-pulse" : undefined}
            variant={nodeStatusBadge(sessionStatusToNodeStatus(session.status))}
          >
            {session.status}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() => props.onOpenAgentSession(session.agentSessionId)}
          >
            <LaunchIcon data-icon="inline-start" />
            Open in Tutti
          </Button>
        </div>
      ) : null}
      <RunTextBlock
        label="Node Input"
        text={nodeRun.input}
        copyKey={`node-input:${props.runId}:${nodeRun.node.id}`}
        copiedRunField={props.copiedRunField}
        onCopy={props.onCopyRunText}
      />
      <RunTextBlock
        label="Node Output"
        text={nodeRun.output}
        copyKey={`node-output:${props.runId}:${nodeRun.node.id}`}
        copiedRunField={props.copiedRunField}
        onCopy={props.onCopyRunText}
      />
      <RunTextBlock
        label="Node Timeline"
        text={nodeRun.log}
        variant="event"
        copyKey={`node-log:${props.runId}:${nodeRun.node.id}`}
        copiedRunField={props.copiedRunField}
        onCopy={props.onCopyRunText}
      />
    </section>
  );
}

function sessionStatusToNodeStatus(status: string) {
  if (status === "completed" || status === "failed") {
    return status;
  }
  if (status === "canceled") {
    return "skipped";
  }
  return "running";
}

function RunTextBlock(props: {
  label: string;
  text: string;
  note?: string;
  variant?: "event" | "text";
  copyKey: string;
  copiedRunField?: string;
  onCopy: (key: string, text: string) => void;
}) {
  return (
    <div className="field">
      <div className="field-heading">
        <label>{props.label}</label>
        <CopyToClipboardButton
          className="copy-text-button"
          size="sm"
          variant="outline"
          copied={props.copiedRunField === props.copyKey}
          label="Copy"
          onCopyText={() => props.onCopy(props.copyKey, props.text)}
        />
      </div>
      {props.note ? <span className="run-text-note">{props.note}</span> : null}
      <pre className={props.variant === "event" ? "event-log" : "output-box"}>
        {props.text}
      </pre>
    </div>
  );
}

function RunFact(props: { label: string; value: string }) {
  return (
    <div className="run-fact">
      <span>{props.label}</span>
      <strong title={props.value}>{props.value}</strong>
    </div>
  );
}
