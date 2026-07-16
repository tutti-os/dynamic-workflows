import { describe, expect, it } from "vitest";
import { parseWorkflowScript } from "./parser";
import {
  applyWorkflowRunEvent,
  createInitialRunSummary,
  readNodeStatusesFromRunLog,
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
      loopStepRuns: {},
      mapItemRuns: {},
    });
  });

  it("tracks loop step attempts separately from top-level node status", () => {
    let summary = createInitialRunSummary(undefined, {
      queueExecutableNodes: false,
    });
    const loopStep = {
      executionKey: "loop:delivery:2:reviewer",
      parentNodeId: "delivery",
      stepId: "reviewer",
      iteration: 2,
    };
    const events: WorkflowRunEvent[] = [
      {
        type: "loop_step_state",
        runId: "run-1",
        loopStep,
        kind: "agent",
        label: "Reviewer",
        status: "running",
        agent: "local:codex",
        sessionKey: "reviewer_room",
        promptMode: "append",
        input: "Review again",
      },
      {
        type: "node_event",
        runId: "run-1",
        nodeId: "delivery.reviewer",
        loopStep,
        event: {
          type: "session_ref",
          session: {
            agentSessionId: "reviewer-session",
            agent: "local:codex",
            status: "running",
          },
        },
      },
      {
        type: "node_event",
        runId: "run-1",
        nodeId: "delivery",
        loopStep,
        event: { type: "text_delta", text: "PASS" },
      },
      {
        type: "loop_step_state",
        runId: "run-1",
        loopStep,
        kind: "agent",
        label: "Reviewer",
        status: "completed",
        output: "PASS",
      },
    ];

    for (const event of events) {
      summary = applyWorkflowRunEvent(summary, event);
    }

    expect(summary.nodeStatuses).toEqual({});
    expect(summary.loopStepRuns[loopStep.executionKey]).toEqual(
      expect.objectContaining({
        ...loopStep,
        status: "completed",
        promptMode: "append",
        input: "Review again",
        output: "PASS",
        session: expect.objectContaining({
          agentSessionId: "reviewer-session",
          status: "completed",
          lastText: "PASS",
        }),
      }),
    );
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
