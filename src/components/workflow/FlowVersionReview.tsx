"use client";

import { useEffect, useMemo, useState } from "react";
import { FlowGraph } from "@/components/workflow/FlowRuntimeOverview";
import type {
  WorkflowVersionRecord,
  WorkflowVersionReview,
} from "@/lib/db/workflows/types";
import type { FlowV1JsonObject } from "@/lib/flow-v1/types";

type VersionView = "design" | "changes" | "bundle";

export function FlowVersionReviewPanel(props: {
  workflowId: string;
  review: WorkflowVersionReview;
  versions: WorkflowVersionRecord[];
  authoringSessionId?: string | null;
  onRefresh: () => Promise<unknown>;
  onSelectVersion: (versionId: string) => void;
}) {
  const [view, setView] = useState<VersionView>("design");
  const [paramsText, setParamsText] = useState(
    JSON.stringify(props.review.configuration.suggestedParams, null, 2),
  );
  const [selectedPath, setSelectedPath] = useState(
    props.review.bundle.files[0]?.path ?? "",
  );
  const [selectedDiffPath, setSelectedDiffPath] = useState(
    firstChangedPath(props.review),
  );
  const [publishing, setPublishing] = useState(false);
  const [openingSession, setOpeningSession] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selectedFile = useMemo(
    () =>
      props.review.bundle.files.find(
        (file) => file.path === selectedPath,
      ) ?? props.review.bundle.files[0],
    [props.review.bundle.files, selectedPath],
  );
  const selectedDiff =
    props.review.comparison?.files.find(
      (file) => file.path === selectedDiffPath,
    ) ?? props.review.comparison?.files.find((file) => file.status !== "unchanged");
  const semanticReview = props.review.version.semanticReview;
  const canPublish = props.review.version.status === "draft";

  useEffect(() => {
    setParamsText(
      JSON.stringify(props.review.configuration.suggestedParams, null, 2),
    );
    setSelectedPath(props.review.bundle.files[0]?.path ?? "");
    setSelectedDiffPath(firstChangedPath(props.review));
    setMessage(null);
  }, [props.review.version.id]);

  async function publish() {
    setPublishing(true);
    setMessage(null);
    try {
      const params = parseJsonObject(paramsText);
      const response = await fetch(
        `/api/workflows/${props.workflowId}/versions/${props.review.version.id}/publish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ params }),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;
      if (!response.ok) {
        throw new Error(
          payload?.error?.message ??
            payload?.error?.code ??
            "Version could not be published.",
        );
      }
      setMessage(
        "Version published. Review runtime configuration, then Activate when ready.",
      );
      await props.onRefresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Version could not be published.",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function openAuthoringSession() {
    if (!props.authoringSessionId) {
      return;
    }
    setOpeningSession(true);
    setMessage(null);
    try {
      const response = await fetch("/api/agent-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentSessionId: props.authoringSessionId,
        }),
      });
      if (!response.ok) {
        throw new Error("Authoring session could not be opened.");
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Authoring session could not be opened.",
      );
    } finally {
      setOpeningSession(false);
    }
  }

  return (
    <section className="flow-draft-review" aria-label="Version review">
      <div className="flow-runtime-heading">
        <div>
          <span className="flow-runtime-eyebrow">Flow versions</span>
          <h2>
            Version {props.review.version.version} ·{" "}
            {props.review.version.status}
          </h2>
          <p>
            Each Agent submission is an immutable Version. Continue the
            conversation in AgentGUI to produce another Version.
          </p>
        </div>
        <div className="flow-version-heading-actions">
          {props.authoringSessionId ? (
            <button
              disabled={openingSession}
              onClick={() => void openAuthoringSession()}
              type="button"
            >
              {openingSession ? "Opening…" : "Open Authoring Session"}
            </button>
          ) : null}
          <span className="flow-draft-status">
            {semanticReview?.status ?? "static validation passed"}
          </span>
        </div>
      </div>

      <div className="flow-draft-version-strip">
        {props.versions.map((version) => (
          <button
            className={
              version.id === props.review.version.id
                ? "is-current"
                : undefined
            }
            key={version.id}
            onClick={() => props.onSelectVersion(version.id)}
            type="button"
          >
            v{version.version} · {version.status}
          </button>
        ))}
      </div>

      <div className="flow-runtime-tabs" role="tablist">
        {(["design", "changes", "bundle"] as const).map((item) => (
          <button
            aria-selected={view === item}
            className={view === item ? "is-active" : undefined}
            key={item}
            onClick={() => setView(item)}
            role="tab"
            type="button"
          >
            {capitalize(item)}
          </button>
        ))}
      </div>

      {semanticReview ? (
        <div className="flow-draft-review-summary">
          <strong>Semantic review</strong>
          <p>{semanticReview.summary}</p>
          {semanticReview.findings.length > 0 ? (
            <ul>
              {semanticReview.findings.map((finding, index) => (
                <li key={`${finding.reason}-${index}`}>
                  {finding.reason}
                  {finding.suggestion
                    ? ` — ${finding.suggestion}`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {view === "design" ? (
        <div className="flow-runtime-panel">
          <div className="flow-runtime-panel-title">
            <h3>Flow design</h3>
            <span>
              {props.review.graph.nodes.length} nodes ·{" "}
              {props.review.graph.edges.length} edges
            </span>
          </div>
          <FlowGraph
            graph={props.review.graph}
            mode="design"
            sourceFiles={props.review.bundle.files}
          />
        </div>
      ) : null}

      {view === "changes" ? (
        <VersionChanges
          review={props.review}
          selectedDiffPath={selectedDiff?.path ?? ""}
          onSelectDiffPath={setSelectedDiffPath}
        />
      ) : null}

      {view === "bundle" ? (
        <div className="flow-runtime-panel">
          <div className="flow-runtime-panel-title">
            <h3>Bundle files</h3>
            <span>{props.review.bundle.files.length} immutable files</span>
          </div>
          <select
            aria-label="Bundle file"
            onChange={(event) => setSelectedPath(event.currentTarget.value)}
            value={selectedFile?.path ?? ""}
          >
            {props.review.bundle.files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}
              </option>
            ))}
          </select>
          <pre className="flow-draft-source">
            <code>{selectedFile?.content ?? ""}</code>
          </pre>
        </div>
      ) : null}

      <div className="flow-runtime-panel flow-version-footer">
        <dl className="flow-draft-runtime-config">
          <div>
            <dt>Project cwd</dt>
            <dd>{props.review.configuration.projectCwd ?? "not set"}</dd>
          </div>
          <div>
            <dt>Default Agent</dt>
            <dd>{props.review.configuration.defaultAgent ?? "not set"}</dd>
          </div>
          <div>
            <dt>Default Model</dt>
            <dd>
              {props.review.configuration.defaultModel ?? "agent default"}
            </dd>
          </div>
          <div>
            <dt>Thinking depth</dt>
            <dd>
              {props.review.configuration.defaultReasoningEffort ??
                "agent default"}
            </dd>
          </div>
        </dl>
        {canPublish ? (
          <div className="flow-version-publish">
            <label className="flow-runtime-inputs">
              <span>Initial Params (JSON)</span>
              <textarea
                onChange={(event) =>
                  setParamsText(event.currentTarget.value)
                }
                rows={6}
                value={paramsText}
              />
            </label>
            <button
              className="flow-runtime-action-primary"
              disabled={publishing}
              onClick={() => void publish()}
              type="button"
            >
              {publishing ? "Publishing…" : "Publish Version"}
            </button>
          </div>
        ) : (
          <p>
            This immutable Version is {props.review.version.status}. Select a
            Draft Version to publish it.
          </p>
        )}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </section>
  );
}

function VersionChanges(props: {
  review: WorkflowVersionReview;
  selectedDiffPath: string;
  onSelectDiffPath: (path: string) => void;
}) {
  const comparison = props.review.comparison;
  if (!comparison) {
    return (
      <div className="flow-version-empty-diff">
        This is the first Version; there is no earlier Bundle to compare.
      </div>
    );
  }
  const changedFiles = comparison.files.filter(
    (file) => file.status !== "unchanged",
  );
  const selected =
    changedFiles.find((file) => file.path === props.selectedDiffPath) ??
    changedFiles[0];
  const graph = comparison.graph;
  return (
    <div className="flow-version-changes">
      <div className="flow-runtime-panel-title">
        <h3>
          Changes from Version {comparison.baseVersion.version}
        </h3>
        <span>{changedFiles.length} changed files</span>
      </div>
      <div className="flow-version-graph-diff">
        <DiffMetric label="Nodes added" values={graph.addedNodeIds} />
        <DiffMetric label="Nodes removed" values={graph.removedNodeIds} />
        <DiffMetric label="Nodes changed" values={graph.changedNodeIds} />
        <DiffMetric label="Edges added" values={graph.addedEdgeIds} />
        <DiffMetric label="Edges removed" values={graph.removedEdgeIds} />
        <DiffMetric label="Edges changed" values={graph.changedEdgeIds} />
      </div>
      {selected ? (
        <>
          <select
            aria-label="Changed Bundle file"
            onChange={(event) =>
              props.onSelectDiffPath(event.currentTarget.value)
            }
            value={selected.path}
          >
            {changedFiles.map((file) => (
              <option key={file.path} value={file.path}>
                {file.status} · {file.path}
              </option>
            ))}
          </select>
          <div className="flow-version-diff">
            {selected.lines.map((line, index) => (
              <div
                className={`flow-version-diff-line is-${line.kind}`}
                key={`${line.kind}-${line.beforeLine}-${line.afterLine}-${index}`}
              >
                <span>{line.beforeLine ?? ""}</span>
                <span>{line.afterLine ?? ""}</span>
                <code>
                  {line.kind === "added"
                    ? "+"
                    : line.kind === "removed"
                      ? "-"
                      : " "}
                  {line.content}
                </code>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="flow-version-empty-diff">
          Bundle files are unchanged.
        </div>
      )}
    </div>
  );
}

function DiffMetric(props: { label: string; values: string[] }) {
  return (
    <div>
      <span>{props.label}</span>
      <strong>{props.values.length}</strong>
      <small>{props.values.join(", ") || "—"}</small>
    </div>
  );
}

function firstChangedPath(review: WorkflowVersionReview): string {
  return (
    review.comparison?.files.find((file) => file.status !== "unchanged")
      ?.path ?? ""
  );
}

function parseJsonObject(value: string): FlowV1JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Initial Params must be a JSON object.");
  }
  return parsed as FlowV1JsonObject;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
