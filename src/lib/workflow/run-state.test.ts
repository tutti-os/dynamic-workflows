import { describe, expect, it } from "vitest";
import { parseWorkflowScript } from "./parser";
import {
  applyWorkflowRunEvent,
  createInitialRunSummary,
  readNodeStatusesFromRunLog,
  readRunResult,
  serializeRunEvent,
  toWorkflowRunResult,
} from "./run-state";
import type { WorkflowRunEvent } from "./types";

const parsed = parseWorkflowScript(`
const scan = await agent({ id: "scan", prompt: "scan" })
log("done")
`);
const scanNode = parsed.nodes.find((node) => node.id === "scan");

describe("workflow run state", () => {
  it("queues only executable nodes in the initial summary", () => {
    const summary = createInitialRunSummary(parsed);

    expect(summary.nodeStatuses).toEqual({
      scan: "queued",
    });
  });

  it("reduces text deltas and completion events into outputs and statuses", () => {
    if (!scanNode) {
      throw new Error("scan node missing");
    }

    let summary = createInitialRunSummary(undefined, {
      queueExecutableNodes: false,
    });
    const events: WorkflowRunEvent[] = [
      { type: "run_started", runId: "run-1", parsed },
      {
        type: "node_started",
        runId: "run-1",
        nodeId: "scan",
        node: scanNode,
        agent: "mock",
      },
      {
        type: "node_event",
        runId: "run-1",
        nodeId: "scan",
        event: { type: "text_delta", text: "hello" },
      },
      {
        type: "node_event",
        runId: "run-1",
        nodeId: "scan",
        event: { type: "text_delta", text: " world" },
      },
      {
        type: "node_completed",
        runId: "run-1",
        nodeId: "scan",
        output: "final",
      },
      {
        type: "run_completed",
        runId: "run-1",
        status: "completed",
        outputs: { scan: "final" },
      },
    ];

    for (const event of events) {
      summary = applyWorkflowRunEvent(summary, event);
    }

    expect(summary.status).toBe("completed");
    expect(summary.outputs).toEqual({ scan: "final" });
    expect(summary.nodeStatuses).toEqual({ scan: "completed" });
    expect(toWorkflowRunResult(summary)).toEqual({
      outputs: { scan: "final" },
      nodeStatuses: { scan: "completed" },
      nodeSessions: {},
    });
  });

  it("stores compact node session refs and final text", () => {
    if (!scanNode) {
      throw new Error("scan node missing");
    }

    let summary = createInitialRunSummary(undefined, {
      queueExecutableNodes: false,
    });
    const events: WorkflowRunEvent[] = [
      { type: "run_started", runId: "run-1", parsed },
      {
        type: "node_started",
        runId: "run-1",
        nodeId: "scan",
        node: scanNode,
        agent: "local:codex",
        model: "gpt-5",
      },
      {
        type: "node_event",
        runId: "run-1",
        nodeId: "scan",
        event: {
          type: "session_ref",
          session: {
            agentSessionId: "session-1",
            agent: "local:codex",
            model: "gpt-5",
            status: "running",
            title: "Scan",
          },
        },
      },
      {
        type: "node_event",
        runId: "run-1",
        nodeId: "scan",
        event: { type: "text_delta", text: "final text" },
      },
      {
        type: "node_completed",
        runId: "run-1",
        nodeId: "scan",
        output: "final text",
      },
    ];

    for (const event of events) {
      summary = applyWorkflowRunEvent(summary, event);
    }

    expect(toWorkflowRunResult(summary).nodeSessions.scan).toEqual({
      nodeId: "scan",
      agentSessionId: "session-1",
      agent: "local:codex",
      model: "gpt-5",
      status: "completed",
      title: "Scan",
      lastText: "final text",
    });
  });

  it("upgrades legacy provider node sessions to agent target ids on read", () => {
    const result = readRunResult({
      outputs: { scan: "done" },
      nodeStatuses: { scan: "completed" },
      nodeSessions: {
        scan: {
          nodeId: "scan",
          agentSessionId: "session-1",
          provider: "codex",
          model: "gpt-5",
          status: "completed",
        },
        review: {
          nodeId: "review",
          agentSessionId: "session-2",
          provider: "mock",
          status: "completed",
        },
      },
    });

    expect(result.nodeSessions.scan).toEqual({
      nodeId: "scan",
      agentSessionId: "session-1",
      agent: "local:codex",
      model: "gpt-5",
      status: "completed",
    });
    expect(result.nodeSessions.review.agent).toBe("mock");
  });

  it("reads legacy session_ref events with provider fields from run logs", () => {
    let summary = createInitialRunSummary(undefined, {
      queueExecutableNodes: false,
    });
    summary = applyWorkflowRunEvent(summary, {
      type: "node_event",
      runId: "run-1",
      nodeId: "scan",
      event: {
        type: "session_ref",
        session: {
          agentSessionId: "session-1",
          provider: "claude-code",
          status: "running",
        },
      },
    });

    expect(summary.nodeSessions.scan).toMatchObject({
      agentSessionId: "session-1",
      agent: "local:claude-code",
    });
  });

  it("preserves node failure details until a canceled run completion arrives", () => {
    let summary = createInitialRunSummary(parsed);
    summary = applyWorkflowRunEvent(summary, {
      type: "node_failed",
      runId: "run-1",
      nodeId: "scan",
      error: "Agent failed",
    });

    expect(summary.status).toBe("failed");
    expect(summary.error).toBe("Agent failed");
    expect(summary.errorCode).toBe("WORKFLOW_RUN_FAILED");

    summary = applyWorkflowRunEvent(summary, {
      type: "run_completed",
      runId: "run-1",
      status: "canceled",
      outputs: {},
      error: "Run canceled.",
      errorCode: "WORKFLOW_RUN_FAILED",
    });

    expect(summary.status).toBe("canceled");
    expect(summary.error).toBe("Run canceled.");
    expect(summary.nodeStatuses.scan).toBe("failed");
  });

  it("can reconstruct node statuses from run log lines", () => {
    if (!scanNode) {
      throw new Error("scan node missing");
    }

    const log = [
      serializeRunEvent({ type: "run_started", runId: "run-1", parsed }),
      serializeRunEvent({
        type: "node_started",
        runId: "run-1",
        nodeId: "scan",
        node: scanNode,
        agent: "mock",
      }),
      serializeRunEvent({
        type: "node_completed",
        runId: "run-1",
        nodeId: "scan",
        output: "done",
      }),
    ].join("\n");

    expect(readNodeStatusesFromRunLog(log)).toEqual({ scan: "completed" });
  });
});
