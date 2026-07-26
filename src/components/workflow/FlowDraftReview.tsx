"use client";

import { useMemo, useState } from "react";
import { FlowGraph } from "@/components/workflow/FlowRuntimeOverview";
import type {
  WorkflowDraftReview,
  WorkflowVersionRecord,
} from "@/lib/db/workflows/types";
import type { FlowV1JsonObject } from "@/lib/flow-v1/types";

export function FlowDraftReview(props: {
  workflowId: string;
  draft: WorkflowDraftReview;
  versions: WorkflowVersionRecord[];
  onRefresh: () => Promise<unknown>;
}) {
  const [paramsText, setParamsText] = useState(
    JSON.stringify(props.draft.configuration.suggestedParams, null, 2),
  );
  const [selectedPath, setSelectedPath] = useState(
    props.draft.bundle.files[0]?.path ?? "",
  );
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selectedFile = useMemo(
    () =>
      props.draft.bundle.files.find(
        (file) => file.path === selectedPath,
      ) ?? props.draft.bundle.files[0],
    [props.draft.bundle.files, selectedPath],
  );
  const review = props.draft.version.semanticReview;

  async function publish() {
    setPublishing(true);
    setMessage(null);
    try {
      const params = parseJsonObject(paramsText);
      const response = await fetch(
        `/api/workflows/${props.workflowId}/versions/${props.draft.version.id}/publish`,
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
            "Draft could not be published.",
        );
      }
      setMessage(
        "Version published. Review its runtime configuration, then Activate when ready.",
      );
      await props.onRefresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Draft could not be published.",
      );
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section className="flow-draft-review" aria-label="Draft review">
      <div className="flow-runtime-heading">
        <div>
          <span className="flow-runtime-eyebrow">Authoring draft</span>
          <h2>Review Version {props.draft.version.version}</h2>
          <p>
            Publishing makes this immutable Bundle the current Version. It
            does not Activate the Flow.
          </p>
        </div>
        <span className="flow-draft-status">
          {review?.status ?? "static validation passed"}
        </span>
      </div>

      <div className="flow-draft-version-strip">
        {props.versions.map((version) => (
          <span
            className={
              version.id === props.draft.version.id ? "is-current" : undefined
            }
            key={version.id}
          >
            v{version.version} · {version.status}
          </span>
        ))}
      </div>

      {review ? (
        <div className="flow-draft-review-summary">
          <strong>Semantic review</strong>
          <p>{review.summary}</p>
          {review.findings.length > 0 ? (
            <ul>
              {review.findings.map((finding, index) => (
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

      <div className="flow-runtime-panel">
        <div className="flow-runtime-panel-title">
          <h3>Flow design</h3>
          <span>
            {props.draft.graph.nodes.length} nodes ·{" "}
            {props.draft.graph.edges.length} edges
          </span>
        </div>
        <FlowGraph graph={props.draft.graph} mode="design" />
      </div>

      <div className="flow-draft-grid">
        <div className="flow-runtime-panel">
          <div className="flow-runtime-panel-title">
            <h3>Bundle files</h3>
            <span>{props.draft.bundle.files.length} immutable files</span>
          </div>
          <select
            aria-label="Bundle file"
            onChange={(event) => setSelectedPath(event.currentTarget.value)}
            value={selectedFile?.path ?? ""}
          >
            {props.draft.bundle.files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}
              </option>
            ))}
          </select>
          <pre className="flow-draft-source">
            <code>{selectedFile?.content ?? ""}</code>
          </pre>
        </div>

        <div className="flow-runtime-panel">
          <div className="flow-runtime-panel-title">
            <h3>Publish configuration</h3>
            <span>
              {Object.keys(props.draft.configuration.paramsSchema).length}{" "}
              Params
            </span>
          </div>
          <label className="flow-runtime-inputs">
            <span>Initial Params (JSON)</span>
            <textarea
              onChange={(event) => setParamsText(event.currentTarget.value)}
              rows={12}
              value={paramsText}
            />
          </label>
          <dl className="flow-draft-runtime-config">
            <div>
              <dt>Project cwd</dt>
              <dd>{props.draft.configuration.projectCwd ?? "not set"}</dd>
            </div>
            <div>
              <dt>Default Agent</dt>
              <dd>{props.draft.configuration.defaultAgent ?? "not set"}</dd>
            </div>
            <div>
              <dt>Default Model</dt>
              <dd>{props.draft.configuration.defaultModel ?? "agent default"}</dd>
            </div>
          </dl>
          <button
            className="flow-runtime-action-primary"
            disabled={publishing}
            onClick={() => void publish()}
            type="button"
          >
            {publishing ? "Publishing…" : "Publish Version"}
          </button>
          {message ? <p role="status">{message}</p> : null}
        </div>
      </div>
    </section>
  );
}

function parseJsonObject(value: string): FlowV1JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Initial Params must be a JSON object.");
  }
  return parsed as FlowV1JsonObject;
}
