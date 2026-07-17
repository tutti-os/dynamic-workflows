import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Badge,
  Button,
  Input,
  LaunchIcon,
  PlayIcon,
  RefreshIcon,
  Spinner,
  Textarea,
  WarningLinedIcon,
} from "@tutti-os/ui-system";
import type {
  WorkflowRunRecord,
} from "@/lib/db/workflows/types";
import type {
  RunDetail,
  RunLoopStepAttemptDetail,
  RunMapItemAttemptDetail,
  RunNodeDetail,
} from "@/lib/workflow/run-detail";
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
import type {
  WorkflowHumanAction,
  WorkflowHumanTask,
  WorkflowValue,
} from "@/lib/workflow/types";

export function RunDetailPanel(props: {
  detail: RunDetail;
  selectedNodeRun: RunNodeDetail | null;
  versionLabelById: Record<string, string>;
  isRunning: boolean;
  retryingRunId?: string;
  copiedRunField?: string;
  onRetryRun: (runId: string) => void;
  onRetryMapItems: (runId: string, mapNodeId: string) => void;
  onResumeRun: (runId: string) => void;
  onCancelRun: (runId: string) => void;
  onCopyRunText: (key: string, text: string) => void;
  onOpenAgentSession: (agentSessionId: string) => void;
  onRespondHumanTask: (input: {
    taskId: string;
    action: string;
    values: Record<string, WorkflowValue>;
    revision: number;
  }) => Promise<void>;
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
        onCancelRun={props.onCancelRun}
        onCopyRunText={props.onCopyRunText}
      />

      {run.status === "interrupted" ? <InterruptedRunNotice /> : null}

      <HumanTasksSection
        tasks={detail.humanTasks ?? []}
        onRespond={props.onRespondHumanTask}
      />

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
          run={run}
          nodeRun={props.selectedNodeRun}
          retryPending={props.isRunning || props.retryingRunId === run.id}
          copiedRunField={props.copiedRunField}
          onRetryMapItems={props.onRetryMapItems}
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

function HumanTasksSection(props: {
  tasks: WorkflowHumanTask[];
  onRespond: (input: {
    taskId: string;
    action: string;
    values: Record<string, WorkflowValue>;
    revision: number;
  }) => Promise<void>;
}) {
  if (props.tasks.length === 0) {
    return null;
  }
  const pending = props.tasks.filter((task) => task.status === "pending");
  const history = props.tasks.filter((task) => task.status !== "pending");
  return (
    <section className="human-task-section">
      <div className="field-heading">
        <label>Human tasks</label>
        <Badge variant={pending.length > 0 ? "warning" : "success"}>
          {pending.length > 0 ? `${pending.length} needs input` : "complete"}
        </Badge>
      </div>
      {pending.map((task) => (
        <HumanTaskCard
          key={task.id}
          task={task}
          onRespond={props.onRespond}
        />
      ))}
      {history.length > 0 ? (
        <div className="human-task-history">
          <label>History</label>
          {history.map((task) => (
            <div className="human-task-history-item" key={task.id}>
              <span>{task.nodeId}{task.iteration ? ` · iteration ${task.iteration}` : ""}</span>
              <Badge variant={task.status === "resolved" ? "success" : "warning"}>
                {task.response?.action ?? task.status}
              </Badge>
              {task.response && Object.keys(task.response.values).length > 0 ? (
                <pre className="output-box">{formatJson(task.response.values)}</pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function HumanTaskCard(props: {
  task: WorkflowHumanTask;
  onRespond: (input: {
    taskId: string;
    action: string;
    values: Record<string, WorkflowValue>;
    revision: number;
  }) => Promise<void>;
}) {
  const initialValues = useMemo(
    () => Object.fromEntries(
      props.task.spec.actions.flatMap((action) =>
        action.fields.map((field) => [
          `${action.id}:${field.id}`,
          field.defaultValue ?? "",
        ]),
      ),
    ),
    [props.task],
  );
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (action: WorkflowHumanAction) => {
    const actionValues = Object.fromEntries(
      action.fields.map((field) => [field.id, values[`${action.id}:${field.id}`] ?? ""]),
    );
    const missing = action.fields.find(
      (field) => field.required && !String(actionValues[field.id] ?? "").trim(),
    );
    if (missing) {
      setError(`${missing.label} is required.`);
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      await props.onRespond({
        taskId: props.task.id,
        action: action.id,
        values: actionValues,
        revision: props.task.revision,
      });
    } catch (submitError) {
      setSubmitting(false);
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Human task response failed.",
      );
    }
  };

  return (
    <div className="human-task-card">
      <div className="human-task-card-heading">
        <div>
          <strong>{props.task.nodeId}</strong>
          {props.task.iteration ? <span>Iteration {props.task.iteration}</span> : null}
        </div>
        <Badge variant="warning">waiting</Badge>
      </div>
      {props.task.spec.description ? <p>{props.task.spec.description}</p> : null}
      {props.task.spec.context.map((item, index) => (
        <div className="human-task-context" key={`${item.label}:${index}`}>
          <label>{item.label}</label>
          {item.display === "markdown" ? (
            <div className="output-box human-task-markdown">
              <ReactMarkdown>{String(item.value ?? "")}</ReactMarkdown>
            </div>
          ) : (
            <pre className="output-box">
              {item.display === "json" ? formatJson(item.value) : String(item.value ?? "")}
            </pre>
          )}
        </div>
      ))}
      <div className="human-task-actions">
        {props.task.spec.actions.map((action) => (
          <div className="human-task-action" key={action.id}>
            {action.fields.map((field) => {
              const key = `${action.id}:${field.id}`;
              return (
                <div className="field" key={field.id}>
                  <label htmlFor={`${props.task.id}-${key}`}>{field.label}</label>
                  {field.type === "textarea" ? (
                    <Textarea
                      id={`${props.task.id}-${key}`}
                      rows={4}
                      value={values[key] ?? ""}
                      placeholder={field.placeholder}
                      disabled={submitting}
                      onChange={(event) => setValues((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))}
                    />
                  ) : field.type === "select" ? (
                    <select
                      id={`${props.task.id}-${key}`}
                      className="control-select"
                      value={values[key] ?? ""}
                      disabled={submitting}
                      onChange={(event) => setValues((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))}
                    >
                      <option value="">Select {field.label}</option>
                      {(field.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={`${props.task.id}-${key}`}
                      value={values[key] ?? ""}
                      placeholder={field.placeholder}
                      disabled={submitting}
                      onChange={(event) => setValues((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))}
                    />
                  )}
                </div>
              );
            })}
            <Button
              type="button"
              size="sm"
              variant={
                action.intent === "danger"
                  ? "destructive"
                  : action.intent === "default"
                    ? "outline"
                    : undefined
              }
              disabled={submitting}
              onClick={() => void submit(action)}
            >
              {submitting ? <Spinner size={14} /> : null}
              {action.label}
            </Button>
          </div>
        ))}
      </div>
      {error ? <div className="diagnostic error">{error}</div> : null}
    </div>
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
  onCancelRun: (runId: string) => void;
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
        {run.status === "waiting_for_human" ? (
          <Button
            size="sm"
            variant="destructive"
            type="button"
            disabled={props.isRunning}
            onClick={() => props.onCancelRun(run.id)}
          >
            Cancel
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
  run: WorkflowRunRecord;
  nodeRun: RunNodeDetail;
  retryPending: boolean;
  copiedRunField?: string;
  onRetryMapItems: (runId: string, mapNodeId: string) => void;
  onCopyRunText: (key: string, text: string) => void;
  onOpenAgentSession: (agentSessionId: string) => void;
}) {
  const { nodeRun } = props;
  if (nodeRun.loopStep) {
    return (
      <RunLoopStepDetailSection
        runId={props.runId}
        nodeRun={nodeRun}
        copiedRunField={props.copiedRunField}
        onCopyRunText={props.onCopyRunText}
        onOpenAgentSession={props.onOpenAgentSession}
      />
    );
  }
  if (nodeRun.mapItem) {
    return (
      <RunMapItemDetailSection
        runId={props.runId}
        run={props.run}
        nodeRun={nodeRun}
        retryPending={props.retryPending}
        copiedRunField={props.copiedRunField}
        onRetryMapItems={props.onRetryMapItems}
        onCopyRunText={props.onCopyRunText}
        onOpenAgentSession={props.onOpenAgentSession}
      />
    );
  }
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

function RunLoopStepDetailSection(props: {
  runId: string;
  nodeRun: RunNodeDetail;
  copiedRunField?: string;
  onCopyRunText: (key: string, text: string) => void;
  onOpenAgentSession: (agentSessionId: string) => void;
}) {
  const loopStep = props.nodeRun.loopStep;
  if (!loopStep) {
    return null;
  }
  return (
    <section className="run-node-detail loop-step-run-detail">
      <div className="field-heading">
        <label>Loop step execution</label>
        <Badge variant="muted">{loopStep.attempts.length} iterations</Badge>
      </div>
      <div className="run-facts run-node-facts">
        <RunFact label="Loop" value={props.nodeRun.node.id} />
        <RunFact label="Step" value={loopStep.step.id} />
        <RunFact label="Label" value={loopStep.step.label} />
      </div>
      {loopStep.attempts.length === 0 ? (
        <div className="field-hint">
          This run predates structured loop-step telemetry, so only the aggregate loop result is available.
        </div>
      ) : (
        <div className="loop-step-attempt-list">
          {loopStep.attempts.map((attempt) => (
            <RunExecutionAttempt
              key={attempt.executionKey}
              runId={props.runId}
              attempt={attempt}
              heading={`Iteration ${attempt.iteration}`}
              copyPrefix="loop"
              copiedRunField={props.copiedRunField}
              onCopyRunText={props.onCopyRunText}
              onOpenAgentSession={props.onOpenAgentSession}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RunMapItemDetailSection(props: {
  runId: string;
  run: WorkflowRunRecord;
  nodeRun: RunNodeDetail;
  retryPending: boolean;
  copiedRunField?: string;
  onRetryMapItems: (runId: string, mapNodeId: string) => void;
  onCopyRunText: (key: string, text: string) => void;
  onOpenAgentSession: (agentSessionId: string) => void;
}) {
  const mapItem = props.nodeRun.mapItem;
  if (!mapItem) {
    return null;
  }
  const failedItemCount = new Set(
    mapItem.items
      .filter((attempt) => attempt.status === "failed")
      .map((attempt) => attempt.index),
  ).size;
  // Map-item retry rides run recovery, so it needs a terminal run (matching the
  // server precondition) — not the resumable "interrupted" state canRetryRun
  // also allows for a full re-run.
  const runIsTerminal =
    props.run.status === "completed" ||
    props.run.status === "failed" ||
    props.run.status === "canceled";
  const canRetryFailedItems = runIsTerminal && failedItemCount > 0;
  return (
    <section className="run-node-detail loop-step-run-detail map-item-run-detail">
      <div className="field-heading">
        <label>Map item executions</label>
        <Badge variant="muted">
          {new Set(mapItem.items.map((attempt) => attempt.index)).size} items
          {mapItem.steps.length > 1 ? ` · ${mapItem.items.length} executions` : ""}
        </Badge>
      </div>
      {canRetryFailedItems ? (
        <div className="agent-session-actions">
          <Badge variant="warning">
            {failedItemCount} failed item{failedItemCount === 1 ? "" : "s"}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={props.retryPending}
            onClick={() =>
              props.onRetryMapItems(props.run.id, props.nodeRun.node.id)
            }
          >
            {props.retryPending ? (
              <Spinner data-icon="inline-start" size={14} />
            ) : (
              <RefreshIcon data-icon="inline-start" />
            )}
            Retry failed items
          </Button>
        </div>
      ) : null}
      <div className="run-facts run-node-facts">
        <RunFact label="Map" value={props.nodeRun.node.id} />
        <RunFact
          label={mapItem.steps.length > 1 ? "Pipeline" : "Step"}
          value={mapItem.steps.map((step) => step.id).join(" → ")}
        />
      </div>
      {mapItem.items.length === 0 ? (
        <div className="field-hint">
          No map items have executed yet, so only the aggregate map result is
          available.
        </div>
      ) : (
        <div className="loop-step-attempt-list">
          {mapItem.items.map((item) => (
            <RunExecutionAttempt
              key={item.executionKey}
              runId={props.runId}
              attempt={item}
              heading={
                mapItem.steps.length > 1
                  ? `#${item.index} · ${item.stepId} · ${item.label}`
                  : `#${item.index} · ${item.label}`
              }
              copyPrefix="map"
              copiedRunField={props.copiedRunField}
              onCopyRunText={props.onCopyRunText}
              onOpenAgentSession={props.onOpenAgentSession}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RunExecutionAttempt(props: {
  runId: string;
  attempt: RunLoopStepAttemptDetail | RunMapItemAttemptDetail;
  heading: string;
  copyPrefix: string;
  copiedRunField?: string;
  onCopyRunText: (key: string, text: string) => void;
  onOpenAgentSession: (agentSessionId: string) => void;
}) {
  const { attempt, copyPrefix } = props;
  const sessionKey = "sessionKey" in attempt ? attempt.sessionKey : undefined;
  const output = attempt.output === undefined
    ? "No output captured."
    : typeof attempt.output === "string"
      ? attempt.output
      : formatJson(attempt.output);
  return (
    <div className="loop-step-attempt">
      <div className="field-heading">
        <label>{props.heading}</label>
        <Badge variant={nodeStatusBadge(attempt.status)}>{attempt.status}</Badge>
      </div>
      <div className="run-facts run-node-facts">
        <RunFact label="Execution" value={attempt.executionKey} />
        {attempt.promptMode ? <RunFact label="Prompt mode" value={attempt.promptMode} /> : null}
        {sessionKey ? <RunFact label="Session key" value={sessionKey} /> : null}
        {attempt.agent ? (
          <RunFact
            label="Agent"
            value={`${attempt.agent}${attempt.model ? ` · ${attempt.model}` : ""}`}
          />
        ) : null}
      </div>
      {attempt.session ? (
        <div className="agent-session-actions">
          <Badge variant={nodeStatusBadge(sessionStatusToNodeStatus(attempt.session.status))}>
            {attempt.session.status}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() => props.onOpenAgentSession(attempt.session!.agentSessionId)}
          >
            <LaunchIcon data-icon="inline-start" />
            Open session
          </Button>
        </div>
      ) : null}
      {attempt.input ? (
        <RunTextBlock
          label="Input"
          text={attempt.input}
          copyKey={`${copyPrefix}-input:${props.runId}:${attempt.executionKey}`}
          copiedRunField={props.copiedRunField}
          onCopy={props.onCopyRunText}
        />
      ) : null}
      <RunTextBlock
        label="Output"
        text={attempt.error ? `${output}\n\nError: ${attempt.error}` : output}
        copyKey={`${copyPrefix}-output:${props.runId}:${attempt.executionKey}`}
        copiedRunField={props.copiedRunField}
        onCopy={props.onCopyRunText}
      />
      <RunTextBlock
        label="Timeline"
        text={attempt.log}
        variant="event"
        copyKey={`${copyPrefix}-log:${props.runId}:${attempt.executionKey}`}
        copiedRunField={props.copiedRunField}
        onCopy={props.onCopyRunText}
      />
    </div>
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
