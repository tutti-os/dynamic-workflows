import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput, AgentRuntimeEvent } from "@/lib/agents/types";
import type {
  WorkflowHumanTask,
  WorkflowHumanTaskRequest,
  WorkflowRunEvent,
  WorkflowRunRequest,
} from "./types";

const runAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/runtime", () => ({
  runAgent: runAgentMock,
}));

import { runWorkflow } from "./executor";

// ---------------------------------------------------------------------------
// Harness helpers (mirrors src/lib/workflow/executor.test.ts idioms)
// ---------------------------------------------------------------------------

function humanTask(
  request: WorkflowHumanTaskRequest,
  status: WorkflowHumanTask["status"],
  response?: WorkflowHumanTask["response"],
): WorkflowHumanTask {
  return {
    id: request.executionKey,
    runId: request.runId,
    nodeId: request.nodeId,
    ...(request.parentNodeId ? { parentNodeId: request.parentNodeId } : {}),
    ...(request.iteration !== undefined ? { iteration: request.iteration } : {}),
    executionKey: request.executionKey,
    status,
    spec: request.spec,
    ...(response ? { response } : {}),
    revision: status === "pending" ? 1 : 2,
    createdAt: new Date(0).toISOString(),
  };
}

type AgentReply = { text: string; sessionId?: string };

/**
 * Installs a runAgent mock that routes replies off the fully rendered input
 * (the mock receives the RENDERED prompt, which is where the behavioral value
 * lives). Returns the array of received inputs for prompt-content assertions.
 */
function mockAgentRuntime(reply: (input: AgentRunInput) => AgentReply): AgentRunInput[] {
  const calls: AgentRunInput[] = [];
  runAgentMock.mockImplementation(async function* (
    input: AgentRunInput,
  ): AsyncGenerator<AgentRuntimeEvent> {
    const result = reply(input);
    calls.push(input);
    if (result.sessionId) {
      yield {
        type: "session_ref",
        session: {
          agentSessionId: input.resumeSessionId ?? result.sessionId,
          agent: input.agent,
          status: "running",
        },
      };
    }
    yield { type: "text_delta", text: result.text };
    yield { type: "done", status: "completed", reason: "completed" };
  });
  return calls;
}

async function collectRun(request: WorkflowRunRequest): Promise<WorkflowRunEvent[]> {
  const events: WorkflowRunEvent[] = [];
  for await (const event of runWorkflow(request)) {
    events.push(event);
  }
  return events;
}

function loadBlueprint(name: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), "src/lib/workflow/blueprints", name),
    "utf8",
  );
}

function callsWithTitle(calls: AgentRunInput[], title: string): AgentRunInput[] {
  return calls.filter((call) => call.title === title);
}

type LoopStepStateEvent = Extract<WorkflowRunEvent, { type: "loop_step_state" }>;

function loopStepStates(
  events: WorkflowRunEvent[],
  executionKey: string,
): LoopStepStateEvent[] {
  return events.filter(
    (event): event is LoopStepStateEvent =>
      event.type === "loop_step_state" &&
      event.loopStep.executionKey === executionKey,
  );
}

/**
 * The "running" loop_step_state event is the only one carrying promptMode /
 * agent / model — the "completed" event omits them.
 */
function loopStepRunning(
  events: WorkflowRunEvent[],
  executionKey: string,
): LoopStepStateEvent | undefined {
  return loopStepStates(events, executionKey).find(
    (event) => event.status === "running",
  );
}

const LAST = <T>(items: T[]): T | undefined => items.at(-1);

// ---------------------------------------------------------------------------

describe("builtin blueprint behavior", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
  });

  describe("loop-primitive-rd-acceptance-test-v1", () => {
    const SCRIPT = loadBlueprint(
      "loop-primitive-rd-acceptance-test-v1.workflow.js",
    );

    it("iterates RD/acceptance until PASS, then submits the MR", async () => {
      let acceptanceRuns = 0;
      const calls = mockAgentRuntime((input) => {
        if (input.title === "RD 工程师") {
          return { text: "implementation delivered", sessionId: "rd-session" };
        }
        if (input.title === "验收 Reviewer") {
          acceptanceRuns += 1;
          return acceptanceRuns === 1
            ? { text: "阻断：缺少测试\nFAIL" }
            : { text: "验收通过\nPASS" };
        }
        return { text: "MR opened" };
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "mock",
        cwd: process.cwd(),
        inputs: { requirement: "交付并验收一个功能" },
      });

      const rdCalls = callsWithTitle(calls, "RD 工程师");
      const acceptanceCalls = callsWithTitle(calls, "验收 Reviewer");
      const submitCalls = callsWithTitle(calls, "提交 MR");

      // Two RD rounds, two acceptance rounds, one submission.
      expect(rdCalls).toHaveLength(2);
      expect(acceptanceCalls).toHaveLength(2);
      expect(submitCalls).toHaveLength(1);

      // acceptance is session-independent: promptMode "full" on both rounds.
      expect(
        loopStepRunning(events, "loop:delivery_loop:1:acceptance")?.promptMode,
      ).toBe("full");
      expect(
        loopStepRunning(events, "loop:delivery_loop:2:acceptance")?.promptMode,
      ).toBe("full");

      // Round 1 acceptance: the {{acceptance}} self-reference renders EMPTY, so
      // the "previous review" label is the final content of the prompt.
      expect(acceptanceCalls[0].prompt).toContain("上一轮验收记录（首轮为空）：");
      expect(acceptanceCalls[0].prompt.trimEnd()).toMatch(
        /上一轮验收记录（首轮为空）：$/,
      );
      // Round 2 acceptance carries round 1's FAIL feedback.
      expect(acceptanceCalls[1].prompt).toContain("阻断：缺少测试");

      // RD round 2 resumes its session (appendPrompt mode) and sees the feedback.
      expect(
        loopStepRunning(events, "loop:delivery_loop:1:rd")?.promptMode,
      ).toBe("full");
      expect(
        loopStepRunning(events, "loop:delivery_loop:2:rd")?.promptMode,
      ).toBe("append");
      expect(rdCalls[1].prompt).toContain("阻断：缺少测试");

      // submit_mr sees the until_matched stop reason from the loop output.
      expect(submitCalls[0].prompt).toContain("Stop reason: until_matched");

      expect(LAST(events)).toEqual(
        expect.objectContaining({ type: "run_completed", status: "completed" }),
      );
    });

    it("completes on exhaustion (onMaxIterations complete) and submit sees max_iterations_reached", async () => {
      const calls = mockAgentRuntime((input) => {
        if (input.title === "RD 工程师") {
          return { text: "implementation delivered", sessionId: "rd-session" };
        }
        if (input.title === "验收 Reviewer") {
          return { text: "阻断：仍未满足\nFAIL" };
        }
        return { text: "status report" };
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "mock",
        cwd: process.cwd(),
        inputs: { requirement: "永远无法通过验收的需求" },
      });

      // maxIterations is 3: RD and acceptance each run three times.
      expect(callsWithTitle(calls, "验收 Reviewer")).toHaveLength(3);
      const submitCalls = callsWithTitle(calls, "提交 MR");
      expect(submitCalls).toHaveLength(1);
      expect(submitCalls[0].prompt).toContain("Stop reason: max_iterations_reached");

      expect(LAST(events)).toEqual(
        expect.objectContaining({ type: "run_completed", status: "completed" }),
      );
    });

    it("falls back to the run-level agent/model when reviewer_agent/reviewer_model are unset", async () => {
      let acceptanceRuns = 0;
      mockAgentRuntime((input) => {
        if (input.title === "RD 工程师") {
          return { text: "implementation delivered", sessionId: "rd-session" };
        }
        if (input.title === "验收 Reviewer") {
          acceptanceRuns += 1;
          return acceptanceRuns === 1
            ? { text: "阻断：缺少测试\nFAIL" }
            : { text: "验收通过\nPASS" };
        }
        return { text: "MR opened" };
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "local:codex",
        model: "gpt-5",
        cwd: process.cwd(),
        inputs: { requirement: "交付并验收一个功能" },
        // reviewer_agent / reviewer_model intentionally left unset.
      });

      const acceptanceRunning = loopStepRunning(
        events,
        "loop:delivery_loop:1:acceptance",
      );
      expect(acceptanceRunning?.agent).toBe("local:codex");
      expect(acceptanceRunning?.model).toBe("gpt-5");
    });
  });

  describe("rd-human-acceptance-delivery-v1", () => {
    const SCRIPT = loadBlueprint("rd-human-acceptance-delivery-v1.workflow.js");

    it("aligns with a human, enters acceptance at the reviewer, repairs on the same RD session, and submits", async () => {
      let reviewerRuns = 0;
      const calls = mockAgentRuntime((input) => {
        if (input.title === "RD 工程师") {
          return { text: "对齐版交付摘要", sessionId: "rd-session" };
        }
        if (input.title === "RD 修复") {
          return { text: "修复完成", sessionId: "rd-session" };
        }
        if (input.title === "验收 Reviewer") {
          reviewerRuns += 1;
          return reviewerRuns === 1
            ? { text: "阻断：缺少边界测试\nFAIL", sessionId: "reviewer-session" }
            : { text: "验收通过\nPASS", sessionId: "reviewer-session" };
        }
        return { text: "MR opened" };
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "mock",
        cwd: process.cwd(),
        inputs: { requirement: "实现 Human gate 研发流程" },
        onHumanTask: (request) =>
          humanTask(
            request,
            "resolved",
            request.iteration === 1
              ? { action: "revise", values: { comment: "请补充边界测试" } }
              : { action: "approve", values: {} },
          ),
      });

      // Full execution order across both loops plus submission.
      expect(calls.map((call) => call.title)).toEqual([
        "RD 工程师",
        "RD 工程师",
        "验收 Reviewer",
        "RD 修复",
        "验收 Reviewer",
        "提交 MR",
      ]);

      // RD round 2 in the alignment loop resumes its session and sees the human
      // comment via appendPrompt.
      expect(
        loopStepRunning(events, "loop:human_alignment:2:rd")?.promptMode,
      ).toBe("append");
      const rdCalls = callsWithTitle(calls, "RD 工程师");
      expect(rdCalls[1].prompt).toContain("请补充边界测试");

      // firstIteration.startAt: rd_fix is SKIPPED on the acceptance loop's first
      // iteration — the reviewer runs before any fix.
      const rdFixFirst = loopStepStates(events, "loop:acceptance_loop:1:rd_fix");
      expect(rdFixFirst).toHaveLength(1);
      expect(rdFixFirst[0].status).toBe("skipped");
      const firstReviewer = loopStepStates(
        events,
        "loop:acceptance_loop:1:reviewer",
      );
      expect(firstReviewer.some((event) => event.status === "running")).toBe(true);

      // reviewer FAILs → rd_fix runs on iteration 2 using the SAME rd_room
      // session (established in the alignment loop) → promptMode "append", with
      // the reviewer feedback rendered into its prompt.
      expect(
        loopStepRunning(events, "loop:acceptance_loop:2:rd_fix")?.promptMode,
      ).toBe("append");
      const rdFixCalls = callsWithTitle(calls, "RD 修复");
      expect(rdFixCalls).toHaveLength(1);
      expect(rdFixCalls[0].prompt).toContain("阻断：缺少边界测试");
      expect(rdFixCalls[0].resumeSessionId).toBe("rd-session");

      // submit_mr runs after reviewer PASS with the until_matched stop reason.
      const submitCalls = callsWithTitle(calls, "提交 MR");
      expect(submitCalls[0].prompt).toContain("Stop reason: until_matched");

      // Invariant: no human gate runs during the acceptance loop — every human
      // task resolution belongs to the alignment loop (nodeId "human_alignment").
      const humanResolved = events.filter(
        (event) => event.type === "human_task_resolved",
      );
      expect(humanResolved).toHaveLength(2);
      expect(
        humanResolved.every(
          (event) =>
            event.type === "human_task_resolved" &&
            event.nodeId === "human_alignment",
        ),
      ).toBe(true);

      expect(LAST(events)).toEqual(
        expect.objectContaining({ type: "run_completed", status: "completed" }),
      );
    });
  });

  describe("human-feedback-loop-v1", () => {
    const SCRIPT = loadBlueprint("human-feedback-loop-v1.workflow.js");

    it("revises on human feedback, passes, and summarizes the delivery record", async () => {
      let workerRuns = 0;
      const calls = mockAgentRuntime((input) => {
        if (input.title === "Produce result") {
          workerRuns += 1;
          return { text: `deliverable round ${workerRuns}` };
        }
        return { text: "final summary" };
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "mock",
        cwd: process.cwd(),
        inputs: { requirement: "Write the onboarding guide" },
        onHumanTask: (request) =>
          humanTask(
            request,
            "resolved",
            request.iteration === 1
              ? { action: "revise", values: { comment: "add error handling" } }
              : { action: "pass", values: {} },
          ),
      });

      const workerCalls = callsWithTitle(calls, "Produce result");
      expect(workerCalls).toHaveLength(2);

      // worker is sessionless → promptMode "full" on both rounds.
      expect(loopStepRunning(events, "loop:delivery:1:worker")?.promptMode).toBe(
        "full",
      );
      expect(loopStepRunning(events, "loop:delivery:2:worker")?.promptMode).toBe(
        "full",
      );

      // worker round 2 renders the human comment and iteration 2.
      expect(workerCalls[1].prompt).toContain("add error handling");
      expect(workerCalls[1].prompt).toContain("Iteration: 2");

      // summary sees the delivery loop record (worker outputs + stop reason).
      const summaryCalls = callsWithTitle(calls, "Summarize delivery");
      expect(summaryCalls).toHaveLength(1);
      expect(summaryCalls[0].prompt).toContain("[worker]");
      expect(summaryCalls[0].prompt).toContain("Stop reason: until_matched");

      expect(LAST(events)).toEqual(
        expect.objectContaining({ type: "run_completed", status: "completed" }),
      );
    });
  });

  describe("parallel-review-synthesis-v1", () => {
    const SCRIPT = loadBlueprint("parallel-review-synthesis-v1.workflow.js");

    it("fans out three lens reviewers over the inventory and synthesizes them", async () => {
      const calls = mockAgentRuntime((input) => {
        switch (input.title) {
          case "Repository inventory":
            return { text: "INVENTORY-DATA" };
          case "Architecture review":
            return { text: "ARCH-FINDING" };
          case "Security review":
            return { text: "SEC-FINDING" };
          case "Correctness and tests review":
            return { text: "QUAL-FINDING" };
          default:
            return { text: "SYNTHESIS-REPORT" };
        }
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "local:codex",
        model: "run-model",
        cwd: process.cwd(),
        inputs: { review_focus: "Review the executor for correctness" },
        // review_model intentionally unset.
      });

      const lensTitles = [
        "Architecture review",
        "Security review",
        "Correctness and tests review",
      ];

      // Each lens reviewer executes exactly once and sees the inventory output.
      for (const title of lensTitles) {
        const lensCalls = callsWithTitle(calls, title);
        expect(lensCalls).toHaveLength(1);
        expect(lensCalls[0].prompt).toContain("INVENTORY-DATA");
        // review_model unset → lenses resolve to the run-level model.
        expect(lensCalls[0].model).toBe("run-model");
      }

      // synthesis merges all three lens outputs.
      const synthesisCalls = callsWithTitle(calls, "Synthesize findings");
      expect(synthesisCalls).toHaveLength(1);
      expect(synthesisCalls[0].prompt).toContain("ARCH-FINDING");
      expect(synthesisCalls[0].prompt).toContain("SEC-FINDING");
      expect(synthesisCalls[0].prompt).toContain("QUAL-FINDING");

      expect(LAST(events)).toEqual(
        expect.objectContaining({ type: "run_completed", status: "completed" }),
      );
    });
  });
});
