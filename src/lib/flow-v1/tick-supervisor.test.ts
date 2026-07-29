import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "./bundle";

const runAgentMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/runtime", () => ({
  runAgent: runAgentMock,
}));

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-supervisor-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
  runAgentMock.mockReset();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 Tick supervisor", () => {
  it("executes an Agent with rendered Cycle context and records its session", async () => {
    runAgentMock.mockImplementation(async function* () {
      yield {
        type: "session_ref",
        session: {
          agentSessionId: "agent-session-1",
          agent: "codex",
        },
      };
      yield { type: "text_delta", text: '{"plan":"' };
      yield { type: "text_delta", text: 'split file"}' };
      yield { type: "done", status: "completed" };
    });
    const fixture = await createRunnableFlow(agentBundle(), {
      owner: "platform",
    });
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "agent-initial",
      inputSnapshot: { target: "src/large.ts" },
      paramsRevision: 2,
      paramsSnapshot: { owner: "platform" },
    });

    const result = await runFlowV1Tick({
      runId: started.run.id,
      projectCwd: dataDir,
      defaultAgent: "fallback",
    });

    expect(result.stopReason).toBe("cycle_completed");
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        model: "gpt-5",
        cwd: dataDir,
        prompt:
          "Plan src/large.ts (9000 lines) for platform in cycle 1.",
      }),
    );
    expect(attempts.listFlowV1NodeAttempts(started.cycle.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: "plan",
          status: "completed",
          output: { plan: "split file" },
          agentSessionId: "agent-session-1",
        }),
      ]),
    );
  });

  it("loads the persisted Agent execution profile for a later Tick", async () => {
    runAgentMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "implemented" };
      yield { type: "done", status: "completed" };
    });
    const { createFlowV1 } = await import("./flow-service");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const created = createFlowV1({
      bundle: createFlowV1Bundle([
        {
          path: "flow.js",
          content: `
            export const schemaVersion = "tutti.flow.v1";
            const implement = agent({
              id: "implement",
              prompt: "Implement the approved plan.",
            });
            completeCycle({ id: "done", inputs: { implement } });
          `,
        },
      ]),
      projectCwd: dataDir,
      defaultAgent: "local:codex",
      defaultModel: "gpt-5",
      defaultPermissionMode: "workspace-write",
    });
    const started = runtime.startFlowV1Cycle({
      flowId: created.flowId,
      flowVersionId: created.versionId,
      origin: {
        kind: "schedule",
        scheduleId: "schedule-1",
        scheduledAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "scheduled-agent-profile",
      inputSnapshot: {},
      paramsRevision: 1,
      paramsSnapshot: {},
    });

    expect((await runFlowV1Tick({ runId: started.run.id })).stopReason).toBe(
      "cycle_completed",
    );
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "local:codex",
        model: "gpt-5",
        permissionMode: "workspace-write",
        cwd: realpathSync(dataDir),
      }),
    );
  });

  it("retries invalid structured Agent output with deterministic validation feedback", async () => {
    let invocation = 0;
    runAgentMock.mockImplementation(async function* () {
      invocation += 1;
      yield {
        type: "text_delta",
        text:
          invocation === 1
            ? '{"status":"PASS","title":"","evidence":["proof"]}'
            : invocation === 2
              ? '{"status":"PASS","title":"Accepted","evidence":[]}'
              : '{"status":"PASS","title":"Accepted","evidence":["proof"]}',
      };
      yield { type: "done", status: "completed" };
    });
    const fixture = await createRunnableFlow(
      createFlowV1Bundle([
        {
          path: "flow.js",
          content: `
            export const schemaVersion = "tutti.flow.v1";
            const review = agent({
              id: "review",
              prompt: "Return the review result.",
              output: json({
                validationMaxAttempts: 3,
                schema: {
                  type: "object",
                  required: ["status", "title", "evidence"],
                  properties: {
                    status: { enum: ["PASS", "FAIL"] },
                    title: { type: "string", minLength: 1 },
                    evidence: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string", minLength: 1 },
                    },
                  },
                },
              }),
            });
            const done = completeCycle({
              id: "done",
              outcome: "accepted",
              inputs: { review },
            });
          `,
        },
      ]),
    );
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "structured-retry",
      inputSnapshot: {},
      paramsRevision: 1,
      paramsSnapshot: {},
    });

    const result = await runFlowV1Tick({
      runId: started.run.id,
      projectCwd: dataDir,
    });

    expect(result.stopReason).toBe("cycle_completed");
    expect(runAgentMock).toHaveBeenCalledTimes(3);
    expect(runAgentMock.mock.calls[1]?.[0].prompt).toContain(
      "failed schema validation",
    );
    expect(runAgentMock.mock.calls[2]?.[0].prompt).toContain(
      "failed schema validation",
    );
    expect(
      attempts
        .listFlowV1NodeAttempts(started.cycle.id)
        .filter((attempt) => attempt.nodeId === "review")
        .map((attempt) => attempt.status),
    ).toEqual(["failed", "failed", "completed"]);
  });

  it("reuses the RD session while starting every reviewer round independently", async () => {
    let reviewerRound = 0;
    runAgentMock.mockImplementation(async function* (input) {
      const isReviewer = input.title === "Independent QA";
      const isRepair = input.title === "RD repair";
      if (isReviewer) {
        reviewerRound += 1;
      }
      const sessionId = isReviewer
        ? `review-session-${reviewerRound}`
        : input.resumeSessionId ?? "rd-session-1";
      yield {
        type: "session_ref",
        session: {
          agentSessionId: sessionId,
          agent: input.agent,
        },
      };
      yield {
        type: "text_delta",
        text: isReviewer
          ? JSON.stringify({
              status: reviewerRound === 1 ? "FAIL" : "PASS",
              criteria: ["behavior preserved"],
              blockers:
                reviewerRound === 1 ? ["missing focused test"] : [],
            })
          : isRepair
            ? "repaired"
            : "implemented",
      };
      yield { type: "done", status: "completed" };
    });
    const fixture = await createRunnableFlow(
      createFlowV1Bundle([
        {
          path: "flow.js",
          content: `
            export const schemaVersion = "tutti.flow.v1";
            const implement = agent({
              id: "implement",
              label: "RD implement",
              prompt: "Implement the requirement.",
              session: { mode: "inherit", key: "rd_room" },
            });
            const acceptance = loop({
              id: "acceptance",
              inputs: { implement },
              maxIterations: 2,
              onMaxIterations: "fail",
              firstIteration: { startAt: "qa" },
              steps: [
                agent({
                  id: "repair",
                  label: "RD repair",
                  session: { mode: "inherit", key: "rd_room" },
                  prompt: "Repair from a fresh fallback context.",
                  appendPrompt: "Fix only {{previousIteration.outputs.qa.blockers}}.",
                }),
                agent({
                  id: "qa",
                  label: "Independent QA",
                  session: { mode: "independent" },
                  prompt: "Review independently. Previous criteria: {{previousStep.criteria}}.",
                  output: json({
                    schema: {
                      type: "object",
                      required: ["status", "criteria", "blockers"],
                      properties: {
                        status: { enum: ["PASS", "FAIL"] },
                        criteria: { type: "array", items: { type: "string" } },
                        blockers: { type: "array", items: { type: "string" } },
                      },
                    },
                  }),
                }),
              ],
              until: { source: "qa", finalStatus: "PASS" },
            });
            completeCycle({ id: "done", inputs: { acceptance } });
          `,
        },
      ]),
    );
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "session-aware-loop",
      inputSnapshot: {},
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const result = await runFlowV1Tick({
      runId: started.run.id,
      projectCwd: dataDir,
      defaultAgent: "local:codex",
    });

    expect(result.stopReason).toBe("cycle_completed");
    expect(runAgentMock).toHaveBeenCalledTimes(4);
    expect(
      runAgentMock.mock.calls.map(([input]) => ({
        title: input.title,
        prompt: input.prompt,
        resumeSessionId: input.resumeSessionId,
      })),
    ).toEqual([
      {
        title: "RD implement",
        prompt: "Implement the requirement.",
        resumeSessionId: undefined,
      },
      {
        title: "Independent QA",
        prompt: "Review independently. Previous criteria: null.",
        resumeSessionId: undefined,
      },
      {
        title: "RD repair",
        prompt: 'Fix only ["missing focused test"].',
        resumeSessionId: "rd-session-1",
      },
      {
        title: "Independent QA",
        prompt:
          'Review independently. Previous criteria: ["behavior preserved"].',
        resumeSessionId: undefined,
      },
    ]);
    expect(
      attempts
        .listFlowV1NodeAttempts(started.cycle.id)
        .filter((attempt) => attempt.agentSessionKey === "rd_room")
        .map((attempt) => attempt.agentSessionId),
    ).toEqual(["rd-session-1", "rd-session-1"]);
  });

  it("retries Script only for declared structural error codes and records every Attempt", async () => {
    const fixture = await createRunnableFlow(scriptRetryBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "script-retry",
      inputSnapshot: {},
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const result = await runFlowV1Tick({
      runId: started.run.id,
      projectCwd: dataDir,
    });

    expect(result.stopReason).toBe("cycle_completed");
    expect(
      attempts
        .listFlowV1NodeAttempts(started.cycle.id)
        .filter((attempt) => attempt.nodeId === "unstable")
        .map((attempt) => attempt.status),
    ).toEqual(["failed", "completed"]);
    expect(
      runtime.getFlowV1CycleCheckpoint(started.cycle.id)?.state,
    ).toEqual(
      expect.objectContaining({
        nodes: expect.objectContaining({
          unstable: expect.objectContaining({ attemptCount: 2 }),
        }),
      }),
    );
  });

  it("uses the default Script retry policy and preserves stderr in the final error", async () => {
    const fixture = await createRunnableFlow(failingScriptBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "default-script-retry",
      inputSnapshot: {},
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const result = await runFlowV1Tick({ runId: started.run.id });
    const scriptAttempts = attempts
      .listFlowV1NodeAttempts(started.cycle.id)
      .filter((attempt) => attempt.nodeId === "unstable");

    expect(result.stopReason).toBe("paused_failed");
    expect(scriptAttempts.map((attempt) => attempt.status)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(scriptAttempts.at(-1)?.error).toEqual(
      expect.objectContaining({
        code: "flow_runner_exit_nonzero",
        message: expect.stringContaining("transient command detail"),
      }),
    );
  });

  it("executes independent ready graph nodes in parallel before their join", async () => {
    let activeAgents = 0;
    let maxActiveAgents = 0;
    runAgentMock.mockImplementation(async function* (input) {
      activeAgents += 1;
      maxActiveAgents = Math.max(maxActiveAgents, activeAgents);
      await new Promise((resolve) => setTimeout(resolve, 15));
      try {
        yield {
          type: "text_delta",
          text: JSON.stringify({ branch: input.prompt }),
        };
        yield { type: "done", status: "completed" };
      } finally {
        activeAgents -= 1;
      }
    });
    const fixture = await createRunnableFlow(parallelBranchesBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "parallel-branches",
      inputSnapshot: {},
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const result = await runFlowV1Tick({ runId: started.run.id });

    expect(result.stopReason).toBe("cycle_completed");
    expect(maxActiveAgents).toBeGreaterThan(1);
    expect(result.executedNodeIds.slice(0, 2)).toEqual(["left", "right"]);
  });

  it("waits at a Gate and resumes only the Gate and downstream path in the next Tick", async () => {
    const fixture = await createRunnableFlow(waitingGateBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const first = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "initial",
      inputSnapshot: { target: "src/large.ts" },
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const waiting = await runFlowV1Tick({
      runId: first.run.id,
      environment: { FLOW_TEST_APPROVED: "false" },
    });
    expect(waiting.stopReason).toBe("waiting_gate");
    expect(waiting.executedNodeIds).toEqual([
      "scan",
      "create_issue",
      "approval",
    ]);
    expect(runtime.getFlowV1Cycle(first.cycle.id)?.status).toBe(
      "waiting_gate",
    );

    const second = runtime.startFlowV1Tick({
      cycleId: first.cycle.id,
      origin: {
        kind: "schedule",
        scheduleId: "main",
        scheduledAt: "2026-07-26T01:00:00.000Z",
      },
      idempotencyKey: "schedule:2026-07-26",
    });
    const completed = await runFlowV1Tick({
      runId: second.run.id,
      environment: { FLOW_TEST_APPROVED: "true" },
    });
    expect(completed.stopReason).toBe("cycle_completed");
    expect(completed.executedNodeIds).toEqual([
      "approval",
      "implement",
      "done",
    ]);
    expect(runtime.getFlowV1Cycle(first.cycle.id)?.status).toBe("completed");

    const history = attempts.listFlowV1NodeAttempts(first.cycle.id);
    expect(history.filter((entry) => entry.nodeId === "scan")).toHaveLength(1);
    expect(
      history.filter((entry) => entry.nodeId === "approval"),
    ).toHaveLength(2);
    expect(attempts.listFlowV1Effects(first.cycle.id)).toEqual([
      expect.objectContaining({
        nodeId: "create_issue",
        status: "completed",
        externalRef: "issue:42",
      }),
    ]);
  });

  it("persists a Human task across Ticks and resumes from its resolved action", async () => {
    const fixture = await createRunnableFlow(humanBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const humanTasks = await import("@/lib/db/workflows/human-tasks");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const first = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "human-initial",
      inputSnapshot: { target: "src/large.ts" },
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const waiting = await runFlowV1Tick({ runId: first.run.id });
    expect(waiting.stopReason).toBe("waiting_human");
    expect(runtime.getFlowV1Cycle(first.cycle.id)?.status).toBe(
      "waiting_human",
    );
    const [task] = humanTasks.listFlowV1HumanTasks(first.cycle.id);
    expect(task).toEqual(
      expect.objectContaining({
        runId: first.run.id,
        cycleId: first.cycle.id,
        nodeId: "review",
        status: "pending",
        spec: expect.objectContaining({
          context: [
            {
              label: "Proposal",
              display: "json",
              value: { path: "src/large.ts", lines: 9000 },
            },
          ],
        }),
      }),
    );

    humanTasks.resolveWorkflowHumanTask({
      runId: first.run.id,
      taskId: task!.id,
      action: "approve",
      values: { note: "Ship it" },
      revision: task!.revision,
      resolvedBy: "owner",
    });
    const second = runtime.startFlowV1Tick({
      cycleId: first.cycle.id,
      origin: { kind: "user" },
      idempotencyKey: `human:${task!.id}:2`,
    });
    const completed = await runFlowV1Tick({ runId: second.run.id });
    expect(completed.stopReason).toBe("cycle_completed");
    expect(completed.executedNodeIds).toEqual(["review", "done"]);
  });

  it("reconciles an uncertain Effect inside the same Tick", async () => {
    const fixture = await createRunnableFlow(uncertainEffectBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const markerPath = path.join(dataDir, "external-effect.marker");
    const first = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "effect-initial",
      inputSnapshot: { markerPath },
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const reconciled = await runFlowV1Tick({ runId: first.run.id });
    expect(reconciled.stopReason).toBe("cycle_completed");
    expect(reconciled.executedNodeIds).toEqual(["write_external", "done"]);
    expect(existsSync(markerPath)).toBe(true);
    expect(
      attempts
        .listFlowV1NodeAttempts(first.cycle.id)
        .filter((attempt) => attempt.nodeId === "write_external")
        .map((attempt) => attempt.status),
    ).toEqual(["uncertain", "completed"]);
    expect(attempts.listFlowV1Effects(first.cycle.id)).toEqual([
      expect.objectContaining({
        status: "completed",
        externalRef: "marker:created",
        result: { recovered: true },
      }),
    ]);
  });

  it("re-applies an Effect inside the same Tick after reconcile reports not_applied", async () => {
    const fixture = await createRunnableFlow(retryableEffectBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const markerPath = path.join(dataDir, "retryable-effect.marker");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "effect-not-applied",
      inputSnapshot: { markerPath },
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const result = await runFlowV1Tick({ runId: started.run.id });

    expect(result.stopReason).toBe("cycle_completed");
    expect(existsSync(markerPath)).toBe(true);
    expect(
      attempts
        .listFlowV1NodeAttempts(started.cycle.id)
        .filter((attempt) => attempt.nodeId === "write_external")
        .map((attempt) => attempt.status),
    ).toEqual(["uncertain", "completed"]);
    expect(attempts.listFlowV1Effects(started.cycle.id)).toEqual([
      expect.objectContaining({
        status: "completed",
        result: { applied: true },
      }),
    ]);
  });

  it("durably pauses the Cycle when supervision fails before a node Attempt starts", async () => {
    const fixture = await createRunnableFlow(agentBundle(), {
      owner: "platform",
    });
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "invalid-runtime-input",
      inputSnapshot: {},
      paramsRevision: 0,
      paramsSnapshot: { owner: "platform" },
    });

    await expect(runFlowV1Tick({ runId: started.run.id })).rejects.toMatchObject(
      { code: "flow_node_input_unresolved" },
    );
    expect(runtime.getFlowV1Run(started.run.id)).toEqual(
      expect.objectContaining({
        status: "failed",
        stopReason: "paused_failed",
      }),
    );
    expect(runtime.getFlowV1Cycle(started.cycle.id)?.status).toBe(
      "paused_failed",
    );
  });

  it("creates bounded, idempotent immediate continuation Cycles", async () => {
    const fixture = await createRunnableFlow(immediateContinuationBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const settings = await import("@/lib/db/workflows/flow-settings");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    settings.setFlowV1Lifecycle({
      flowId: fixture.flowId,
      lifecycle: "active",
    });
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "continuation-initial",
      inputSnapshot: {},
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const result = await runFlowV1Tick({ runId: started.run.id });
    expect(result.stopReason).toBe("cycle_completed");
    expect(result.continuationRunId).toEqual(expect.any(String));
    expect(runtime.listFlowV1Cycles(fixture.flowId)).toEqual([
      expect.objectContaining({ sequence: 3, status: "completed", outcome: "delivered" }),
      expect.objectContaining({ sequence: 2, status: "completed", outcome: "delivered" }),
      expect.objectContaining({ sequence: 1, status: "completed", outcome: "delivered" }),
    ]);
    expect(
      runtime.listFlowV1RunsForCycle(
        runtime.listFlowV1Cycles(fixture.flowId)[0]!.id,
      ),
    ).toHaveLength(1);
  });

  it("runs graph-visible Finally cleanup on completed and failed terminals", async () => {
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1Tick } = await import("./tick-supervisor");

    const completedFixture = await createRunnableFlow(
      finallyBundle({ failMain: false }),
    );
    const completedMarker = path.join(dataDir, "completed-cleanup.txt");
    const completedStart = runtime.startFlowV1Cycle({
      flowId: completedFixture.flowId,
      flowVersionId: completedFixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "finally-completed",
      inputSnapshot: { marker: completedMarker },
      paramsRevision: 0,
      paramsSnapshot: {},
    });
    const completed = await runFlowV1Tick({
      runId: completedStart.run.id,
    });
    expect(completed.stopReason).toBe("cycle_completed");
    expect(completed.executedNodeIds).toEqual([
      "main",
      "done",
      "cleanup_completed",
    ]);
    expect(existsSync(completedMarker)).toBe(true);

    const failedFixture = await createRunnableFlow(
      finallyBundle({ failMain: true }),
    );
    const failedMarker = path.join(dataDir, "failed-cleanup.txt");
    const failedStart = runtime.startFlowV1Cycle({
      flowId: failedFixture.flowId,
      flowVersionId: failedFixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "finally-failed",
      inputSnapshot: { marker: failedMarker },
      paramsRevision: 0,
      paramsSnapshot: {},
    });
    const failed = await runFlowV1Tick({ runId: failedStart.run.id });
    expect(failed.stopReason).toBe("paused_failed");
    expect(failed.executedNodeIds).toEqual(["main", "cleanup_failed"]);
    expect(existsSync(failedMarker)).toBe(true);
  });

  it("retains failed-cycle resources when a Finally node opts into retention", async () => {
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const fixture = await createRunnableFlow(
      finallyBundle({ failMain: true, retainOnFailure: true }),
    );
    const marker = path.join(dataDir, "retained-failure.txt");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "finally-retain-failed",
      inputSnapshot: { marker },
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const failed = await runFlowV1Tick({ runId: started.run.id });

    expect(failed.stopReason).toBe("paused_failed");
    expect(failed.executedNodeIds).toEqual(["main"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("runs canceled Finally cleanup and persists canceled Cycle and Tick state", async () => {
    const fixture = await createRunnableFlow(
      finallyBundle({ failMain: false }),
    );
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const {
      FlowV1TickSupervisorError,
      runFlowV1Tick,
    } = await import("./tick-supervisor");
    const marker = path.join(dataDir, "canceled-cleanup.txt");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "finally-canceled",
      inputSnapshot: { marker },
      paramsRevision: 0,
      paramsSnapshot: {},
    });
    const controller = new AbortController();
    controller.abort(
      new FlowV1TickSupervisorError(
        "flow_cycle_cancel_requested",
        "Cancel the fixture Cycle.",
      ),
    );

    const canceled = await runFlowV1Tick({
      runId: started.run.id,
      signal: controller.signal,
    });

    expect(canceled.stopReason).toBe("cycle_canceled");
    expect(canceled.executedNodeIds).toEqual(["cleanup_canceled"]);
    expect(runtime.getFlowV1Cycle(started.cycle.id)?.status).toBe(
      "canceled",
    );
    expect(runtime.getFlowV1Run(started.run.id)?.status).toBe("canceled");
    expect(existsSync(marker)).toBe(true);
  });

  it("checkpoints a Loop Human step across Ticks without rerunning prior Agent steps", async () => {
    runAgentMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "proposal" };
      yield { type: "done", status: "completed" };
    });
    const fixture = await createRunnableFlow(loopHumanBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const attempts = await import("@/lib/db/workflows/flow-attempts");
    const humanTasks = await import("@/lib/db/workflows/human-tasks");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const first = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "loop-human-1",
      inputSnapshot: {},
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const waiting = await runFlowV1Tick({ runId: first.run.id });
    expect(waiting.stopReason).toBe("waiting_human");
    const [task] = humanTasks.listFlowV1HumanTasks(first.cycle.id);
    expect(task?.nodeId).toBe("review.approve");
    humanTasks.resolveWorkflowHumanTask({
      runId: first.run.id,
      taskId: task!.id,
      action: "approve",
      values: {},
      revision: task!.revision,
    });

    const second = runtime.startFlowV1Tick({
      cycleId: first.cycle.id,
      origin: { kind: "user" },
      idempotencyKey: "loop-human-2",
    });
    const completed = await runFlowV1Tick({ runId: second.run.id });
    expect(completed.stopReason).toBe("cycle_completed");
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(
      attempts
        .listFlowV1NodeAttempts(first.cycle.id)
        .filter((attempt) => attempt.nodeId === "review.propose"),
    ).toHaveLength(1);
  });

  it("passes the previous iteration record explicitly into the next Loop round", async () => {
    runAgentMock.mockImplementation(async function* (input) {
      yield { type: "text_delta", text: input.prompt };
      yield { type: "done", status: "completed" };
    });
    const fixture = await createRunnableFlow(loopHumanBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const humanTasks = await import("@/lib/db/workflows/human-tasks");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const first = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "loop-history-1",
      inputSnapshot: {},
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    expect((await runFlowV1Tick({ runId: first.run.id })).stopReason).toBe(
      "waiting_human",
    );
    const firstTask = humanTasks
      .listFlowV1HumanTasks(first.cycle.id)
      .find((task) => task.status === "pending")!;
    humanTasks.resolveWorkflowHumanTask({
      runId: first.run.id,
      taskId: firstTask.id,
      action: "revise",
      values: { comment: "make the result smaller" },
      revision: firstTask.revision,
    });

    const second = runtime.startFlowV1Tick({
      cycleId: first.cycle.id,
      origin: { kind: "user" },
      idempotencyKey: "loop-history-2",
    });
    expect((await runFlowV1Tick({ runId: second.run.id })).stopReason).toBe(
      "waiting_human",
    );
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(runAgentMock.mock.calls[1]?.[0].prompt).toContain(
      '"comment":"make the result smaller"',
    );
    const secondTask = humanTasks
      .listFlowV1HumanTasks(first.cycle.id)
      .find((task) => task.status === "pending")!;
    humanTasks.resolveWorkflowHumanTask({
      runId: second.run.id,
      taskId: secondTask.id,
      action: "approve",
      values: {},
      revision: secondTask.revision,
    });

    const third = runtime.startFlowV1Tick({
      cycleId: first.cycle.id,
      origin: { kind: "user" },
      idempotencyKey: "loop-history-3",
    });
    expect((await runFlowV1Tick({ runId: third.run.id })).stopReason).toBe(
      "cycle_completed",
    );
  });

  it("runs bounded Map Agent pipelines and records skipped item failures", async () => {
    let activeAgents = 0;
    let maxActiveAgents = 0;
    runAgentMock.mockImplementation(async function* (input) {
      activeAgents += 1;
      maxActiveAgents = Math.max(maxActiveAgents, activeAgents);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        if (input.prompt.includes("bad")) {
          yield {
            type: "error",
            code: "fixture_item_failed",
            message: "bad item",
          };
          return;
        }
        yield {
          type: "text_delta",
          text: input.prompt.startsWith("Verify")
            ? JSON.stringify({
                status: input.prompt.includes("good-b")
                  ? "REJECTED"
                  : "VERIFIED",
              })
            : JSON.stringify({ migrated: input.prompt }),
        };
        yield { type: "done", status: "completed" };
      } finally {
        activeAgents -= 1;
      }
    });
    const fixture = await createRunnableFlow(mapBundle());
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "map-1",
      inputSnapshot: {},
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    const result = await runFlowV1Tick({ runId: started.run.id });
    expect(result.stopReason).toBe("cycle_completed");
    expect(maxActiveAgents).toBeGreaterThan(1);
    const checkpoint = runtime.getFlowV1CycleCheckpoint(started.cycle.id);
    expect(checkpoint?.state).toEqual(
      expect.objectContaining({
        nodes: expect.objectContaining({
          migrate: expect.objectContaining({
            status: "completed",
            output: expect.objectContaining({
              total: 3,
              succeeded: [
                expect.objectContaining({ index: 0, item: "good-a" }),
              ],
              rejected: [
                expect.objectContaining({ index: 2, item: "good-b" }),
              ],
              failed: [
                expect.objectContaining({
                  index: 1,
                  item: "bad",
                  stepId: "migrate_one",
                }),
              ],
            }),
          }),
        }),
      }),
    );
  });

  it("routes exhausted Loops to a completed business outcome", async () => {
    runAgentMock.mockImplementation(async function* () {
      yield {
        type: "text_delta",
        text: JSON.stringify({ status: "FAIL", blockers: ["still broken"] }),
      };
      yield { type: "done", status: "completed" };
    });
    const fixture = await createRunnableFlow(loopOutcomeBundle(), {
      maxRounds: 2,
    });
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "loop-outcome",
      inputSnapshot: {},
      paramsRevision: 1,
      paramsSnapshot: { maxRounds: 2 },
    });

    expect((await runFlowV1Tick({ runId: started.run.id })).stopReason).toBe(
      "cycle_completed",
    );
    expect(runtime.getFlowV1Cycle(started.cycle.id)).toEqual(
      expect.objectContaining({
        status: "completed",
        outcome: "not_accepted",
      }),
    );
    expect(runtime.getFlowV1CycleCheckpoint(started.cycle.id)?.state).toEqual(
      expect.objectContaining({
        nodes: expect.objectContaining({
          acceptance: expect.objectContaining({ outcome: "exhausted" }),
        }),
      }),
    );
  });

  it("safely serializes write Maps inside a host-provided Workspace", async () => {
    let activeAgents = 0;
    let maxActiveAgents = 0;
    runAgentMock.mockImplementation(async function* (input) {
      activeAgents += 1;
      maxActiveAgents = Math.max(maxActiveAgents, activeAgents);
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield {
        type: "text_delta",
        text: input.prompt.startsWith("Verify")
          ? JSON.stringify({ status: "VERIFIED" })
          : JSON.stringify({ migrated: true }),
      };
      yield { type: "done", status: "completed" };
      activeAgents -= 1;
    });
    const fixture = await createRunnableFlow(mapBundle(true));
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { runFlowV1Tick } = await import("./tick-supervisor");
    const started = runtime.startFlowV1Cycle({
      flowId: fixture.flowId,
      flowVersionId: fixture.versionId,
      origin: { kind: "user" },
      idempotencyKey: "isolated-map",
      inputSnapshot: {},
      paramsRevision: 0,
      paramsSnapshot: {},
    });

    expect((await runFlowV1Tick({ runId: started.run.id })).stopReason).toBe(
      "cycle_completed",
    );
    expect(maxActiveAgents).toBe(1);
  });
});

function agentBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const inputs = defineInputs({
          target: stringInput({ required: true }),
        });
        export const params = defineParams({
          owner: stringParam({ required: true }),
        });
        const scan = script({
          id: "scan",
          file: "scripts/scan.mjs",
          inputs: { target: ref("inputs.target") },
        });
        const plan = agent({
          id: "plan",
          agent: "codex",
          model: "gpt-5",
          inputs: { scan },
          prompt: "Plan {{scan.path}} ({{scan.lines}} lines) for {{params.owner}} in cycle {{cycle.sequence}}.",
          output: "json",
        });
        const done = completeCycle({
          id: "done",
          inputs: { plan },
        });
      `,
    },
    {
      path: "scripts/scan.mjs",
      content: `
        export async function run(ctx) {
          return { path: ctx.target, lines: 9000 };
        }
      `,
    },
  ]);
}

function humanBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const inputs = defineInputs({
          target: stringInput({ required: true }),
        });
        const scan = script({
          id: "scan",
          file: "scripts/scan.mjs",
          inputs: { target: ref("inputs.target") },
        });
        const review = human({
          id: "review",
          inputs: { proposal: scan },
          description: "Approve the proposed large-file refactor.",
          context: [
            { label: "Proposal", value: "{{proposal}}", display: "json" },
          ],
          actions: [
            {
              id: "approve",
              label: "Approve",
              intent: "primary",
              fields: [
                {
                  id: "note",
                  type: "textarea",
                  label: "Note",
                  required: false,
                },
              ],
            },
            {
              id: "reject",
              label: "Reject",
              intent: "danger",
              fields: [
                {
                  id: "reason",
                  type: "textarea",
                  label: "Reason",
                  required: true,
                },
              ],
            },
          ],
        });
        const done = completeCycle({
          id: "done",
          inputs: { review },
        });
        const canceled = cancelCycle({
          id: "canceled",
          inputs: { review },
        });
        route(review, { approve: done, reject: canceled });
      `,
    },
    {
      path: "scripts/scan.mjs",
      content: `
        export async function run(ctx) {
          return { path: ctx.target, lines: 9000 };
        }
      `,
    },
  ]);
}

function immediateContinuationBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = {
          name: "immediate-continuation",
          description: "Bounded continuation",
        };
        export const runtime = {
          maxNodeExecutionsPerTick: 10,
          maxImmediateContinuations: 2,
          maxParallelNodes: 1,
        };
        const done = completeCycle({
          id: "done",
          outcome: "delivered",
          continue: "immediate",
        });
      `,
    },
  ]);
}

function finallyBundle(input: {
  failMain: boolean;
  retainOnFailure?: boolean;
}) {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const inputs = defineInputs({
          marker: stringInput({ required: true }),
        });
        const main = script({
          id: "main",
          file: "scripts/main.mjs",
        });
        const done = completeCycle({ id: "done", inputs: { main } });
        finalize({
          id: "cleanup_completed",
          file: "scripts/cleanup.mjs",
          inputs: { marker: ref("inputs.marker") },
          runOn: ["completed"],
        });
        finalize({
          id: "cleanup_failed",
          file: "scripts/cleanup.mjs",
          inputs: { marker: ref("inputs.marker") },
          runOn: ["failed"],
          retainOnFailure: ${input.retainOnFailure ?? false},
        });
        finalize({
          id: "cleanup_canceled",
          file: "scripts/cleanup.mjs",
          inputs: { marker: ref("inputs.marker") },
          runOn: ["canceled"],
        });
      `,
    },
    {
      path: "scripts/main.mjs",
      content: input.failMain
        ? 'export async function run() { throw new Error("main failed"); }'
        : "export async function run() { return { ok: true }; }",
    },
    {
      path: "scripts/cleanup.mjs",
      content: `
        import fs from "node:fs";
        export async function run(ctx) {
          fs.writeFileSync(ctx.marker, ctx.terminal.status);
          return { cleaned: ctx.terminal.status };
        }
      `,
    },
  ]);
}

function scriptRetryBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        const unstable = script({
          id: "unstable",
          file: "scripts/unstable.mjs",
          retry: {
            maxAttempts: 3,
            errorCodes: ["flow_runner_exit_nonzero"],
            backoffMs: 0,
          },
        });
        const done = completeCycle({
          id: "done",
          inputs: { unstable },
        });
      `,
    },
    {
      path: "scripts/unstable.mjs",
      content: `
        import fs from "node:fs";
        import path from "node:path";
        export async function run() {
          const marker = path.join(process.cwd(), "retry-marker");
          if (!fs.existsSync(marker)) {
            fs.writeFileSync(marker, "first attempt", "utf8");
            throw new Error("transient fixture failure");
          }
          return { recovered: true };
        }
      `,
    },
  ]);
}

function failingScriptBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        const unstable = script({
          id: "unstable",
          file: "scripts/unstable.mjs",
        });
        completeCycle({
          id: "done",
          inputs: { unstable },
        });
      `,
    },
    {
      path: "scripts/unstable.mjs",
      content: `
        export async function run() {
          throw new Error("transient command detail");
        }
      `,
    },
  ]);
}

function parallelBranchesBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const runtime = {
          maxNodeExecutionsPerTick: 10,
          maxImmediateContinuations: 1,
          maxParallelNodes: 2,
        };
        const left = agent({
          id: "left",
          prompt: "Run left branch",
          output: "json",
        });
        const right = agent({
          id: "right",
          prompt: "Run right branch",
          output: "json",
        });
        const done = completeCycle({
          id: "done",
          inputs: { left, right },
        });
      `,
    },
  ]);
}

function loopHumanBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        const review = loop({
          id: "review",
          maxIterations: 2,
          onMaxIterations: "fail",
          steps: [
            agent({
              id: "propose",
              prompt: "Create proposal {{iteration}} from {{previousIteration}}",
            }),
            human({
              id: "approve",
              context: [
                {
                  label: "Proposal",
                  value: "{{previous}}",
                  display: "markdown",
                },
              ],
              actions: [
                {
                  id: "approve",
                  label: "Approve",
                  intent: "primary",
                  fields: [],
                },
                {
                  id: "revise",
                  label: "Revise",
                  intent: "default",
                  fields: [
                    {
                      id: "comment",
                      type: "textarea",
                      label: "Comment",
                      required: true,
                    },
                  ],
                },
              ],
            }),
          ],
          until: {
            source: "approve",
            equals: { action: "approve", values: {} },
          },
        });
        const done = completeCycle({ id: "done", inputs: { review } });
      `,
    },
  ]);
}

function mapBundle(requireIsolation = false) {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        const discover = script({
          id: "discover",
          file: "scripts/discover.mjs",
        });
        ${
          requireIsolation
            ? `const workspace = script({
          id: "workspace",
          file: "scripts/workspace.mjs",
        });`
            : ""
        }
        const migrate = map({
          id: "migrate",
          source: ref("discover.items"),
          maxItems: 10,
          ${
            requireIsolation
              ? `inputs: { workspace },
          workspace,
          execution: { access: "write", isolation: "required" },`
              : ""
          }
          onItemFailure: "skip",
          onItemRejected: "collect",
          itemOutcome: {
            source: "verify_one.status",
            success: ["VERIFIED"],
            rejected: ["REJECTED"],
          },
          steps: [
            agent({
              id: "migrate_one",
              prompt: "Migrate {{item}}",
              output: "json",
            }),
            agent({
              id: "verify_one",
              prompt: "Verify {{item}} from {{previous}}",
              output: "json",
            }),
          ],
        });
        const done = completeCycle({ id: "done", inputs: { migrate } });
      `,
    },
    {
      path: "scripts/discover.mjs",
      content: `
        export async function run() {
          return { items: ["good-a", "bad", "good-b"] };
        }
      `,
    },
    {
      path: "scripts/workspace.mjs",
      content: `
        import fs from "node:fs";
        import path from "node:path";
        export async function run() {
          const workspace = path.join(process.cwd(), "isolated");
          fs.mkdirSync(workspace, { recursive: true });
          return { path: workspace };
        }
      `,
    },
  ]);
}

function loopOutcomeBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const params = defineParams({
          maxRounds: numberParam({ default: 2, min: 1, max: 10 }),
        });
        const acceptance = loop({
          id: "acceptance",
          maxIterations: ref("params.maxRounds"),
          onMaxIterations: "complete",
          steps: [
            agent({
              id: "review",
              prompt: "Review",
              output: json({ schema: {
                type: "object",
                required: ["status", "blockers"],
                properties: {
                  status: { enum: ["PASS", "FAIL"] },
                  blockers: { type: "array" },
                },
              } }),
            }),
          ],
          until: { source: "review", finalStatus: "PASS" },
        });
        const accepted = completeCycle({
          id: "accepted",
          outcome: "accepted",
          inputs: { acceptance },
        });
        const notAccepted = completeCycle({
          id: "not_accepted",
          outcome: "not_accepted",
          inputs: { acceptance },
        });
        route(acceptance, {
          matched: accepted,
          exhausted: notAccepted,
        });
      `,
    },
  ]);
}

async function createRunnableFlow(
  bundle: ReturnType<typeof createFlowV1Bundle>,
  params?: Record<string, string | number>,
) {
  const { createFlowV1 } = await import("./flow-service");
  const created = createFlowV1({ bundle, params });
  return { flowId: created.flowId, versionId: created.versionId };
}

function waitingGateBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const inputs = defineInputs({
          target: stringInput({ required: true }),
        });
        const scan = script({
          id: "scan",
          file: "scripts/scan.mjs",
          inputs: { target: ref("inputs.target") },
        });
        const issue = effect({
          id: "create_issue",
          file: "scripts/issue.mjs",
          inputs: { candidate: scan },
          idempotencyKey: template("{{cycle.id}}:create_issue"),
        });
        const approval = gate({
          id: "approval",
          file: "scripts/approval.mjs",
          inputs: { issue },
          outcomes: ["approved", "rejected"],
        });
        const implement = script({
          id: "implement",
          file: "scripts/implement.mjs",
          inputs: { approval, issue },
        });
        const rejected = cancelCycle({
          id: "rejected",
          inputs: { approval },
        });
        const done = completeCycle({
          id: "done",
          inputs: { implement },
        });
        route(approval, { approved: implement, rejected });
      `,
    },
    {
      path: "scripts/scan.mjs",
      content: `
        export async function run(ctx) {
          return { path: ctx.target, lines: 9000 };
        }
      `,
    },
    {
      path: "scripts/issue.mjs",
      content: `
        export async function apply(ctx) {
          return {
            externalRef: "issue:42",
            output: { number: 42, candidate: ctx.candidate.path },
          };
        }
        export async function reconcile() {
          return { status: "unknown", reason: "fixture should not reconcile" };
        }
      `,
    },
    {
      path: "scripts/approval.mjs",
      content: `
        export async function check() {
          if (process.env.FLOW_TEST_APPROVED === "true") {
            return {
              status: "completed",
              outcome: "approved",
              output: { approvedBy: "owner" },
            };
          }
          return { status: "waiting", reason: "Issue is not approved" };
        }
      `,
    },
    {
      path: "scripts/implement.mjs",
      content: `
        export async function run(ctx) {
          return { implemented: true, issue: ctx.issue.number };
        }
      `,
    },
  ]);
}

function uncertainEffectBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const inputs = defineInputs({
          markerPath: stringInput({ required: true }),
        });
        const write = effect({
          id: "write_external",
          file: "scripts/write.mjs",
          inputs: { markerPath: ref("inputs.markerPath") },
          idempotencyKey: template("{{cycle.id}}:write_external"),
        });
        const done = completeCycle({
          id: "done",
          inputs: { write },
        });
      `,
    },
    {
      path: "scripts/write.mjs",
      content: `
        import fs from "node:fs";
        export async function apply(ctx) {
          fs.writeFileSync(ctx.markerPath, "created", "utf8");
          throw new Error("connection dropped after external write");
        }
        export async function reconcile(ctx) {
          if (fs.existsSync(ctx.markerPath)) {
            return {
              status: "completed",
              externalRef: "marker:created",
              output: { recovered: true },
            };
          }
          return { status: "not_applied" };
        }
      `,
    },
  ]);
}

function retryableEffectBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const inputs = defineInputs({
          markerPath: stringInput({ required: true }),
        });
        const write = effect({
          id: "write_external",
          file: "scripts/write.mjs",
          inputs: { markerPath: ref("inputs.markerPath") },
          idempotencyKey: template("{{cycle.id}}:write_external"),
        });
        completeCycle({
          id: "done",
          inputs: { write },
        });
      `,
    },
    {
      path: "scripts/write.mjs",
      content: `
        import fs from "node:fs";
        export async function apply(ctx) {
          const attemptPath = ctx.markerPath + ".attempt";
          if (!fs.existsSync(attemptPath)) {
            fs.writeFileSync(attemptPath, "failed-before-apply", "utf8");
            throw new Error("connection failed before external write");
          }
          fs.writeFileSync(ctx.markerPath, "created", "utf8");
          return {
            externalRef: "marker:created",
            output: { applied: true },
          };
        }
        export async function reconcile(ctx) {
          return fs.existsSync(ctx.markerPath)
            ? {
                status: "completed",
                externalRef: "marker:created",
                output: { applied: true },
              }
            : { status: "not_applied" };
        }
      `,
    },
  ]);
}
