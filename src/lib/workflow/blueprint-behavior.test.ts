import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput } from "@/lib/agents/types";
import { installMockAgentRuntime } from "./test-support/mock-agent-runtime";
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
 *
 * Uses the shared realistic mock with "when-provided" session emission so a
 * session_ref is emitted only for session-ful agents (those returning a
 * `sessionId`), preserving the sessionless-agent promptMode assertions here.
 */
function mockAgentRuntime(reply: (input: AgentRunInput) => AgentReply): AgentRunInput[] {
  return installMockAgentRuntime(runAgentMock, reply, {
    sessionRef: "when-provided",
  });
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
        return {
          text: JSON.stringify({
            result: "mr_created",
            prUrl: "https://example.com/mr/1",
            branch: "feature/x",
            commit: "abc1234",
            checks: "focused tests passed",
            unverified: [],
            summary: "功能已交付并创建 MR",
          }),
        };
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

      // submit_mr enforces its output: "json" contract — the terminal report is
      // stored as parsed structured data, not raw text.
      const submitCompleted = events.find(
        (event) =>
          event.type === "node_completed" && event.nodeId === "submit_mr",
      );
      expect(submitCompleted).toEqual(
        expect.objectContaining({
          output: expect.objectContaining({
            result: "mr_created",
            prUrl: "https://example.com/mr/1",
            unverified: [],
          }),
        }),
      );

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
        return {
          text: JSON.stringify({
            result: "not_accepted",
            prUrl: null,
            branch: null,
            commit: null,
            checks: "未创建 MR，未运行提交检查",
            unverified: ["验收未通过：仍未满足"],
            summary: "打满轮次仍未通过验收",
          }),
        };
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
        return {
          text: JSON.stringify({
            result: "mr_created",
            prUrl: "https://example.com/mr/2",
            branch: "feature/y",
            commit: "def5678",
            checks: "focused tests passed",
            unverified: [],
            summary: "已创建 MR",
          }),
        };
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
        return {
          text: JSON.stringify({
            result: "mr_created",
            prUrl: "https://example.com/mr/3",
            branch: "feature/z",
            commit: "aaa1111",
            checks: "focused tests passed",
            unverified: [],
            summary: "已创建 MR",
          }),
        };
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

      // submit_mr's output: "json" contract stores the terminal report parsed.
      const submitCompleted = events.find(
        (event) =>
          event.type === "node_completed" && event.nodeId === "submit_mr",
      );
      expect(submitCompleted).toEqual(
        expect.objectContaining({
          output: expect.objectContaining({ result: "mr_created", unverified: [] }),
        }),
      );

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
      // The sessionless worker receives its own previous result through the
      // dataflow self-reference — it cannot revise what it cannot see.
      expect(workerCalls[1].prompt).toContain("deliverable round 1");

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

  describe("map-fan-out-demo-v1", () => {
    const SCRIPT = loadBlueprint("map-fan-out-demo-v1.workflow.js");

    const DISCOVERED = [
      { file: "src/a.ts", line: 1, summary: "fix a" },
      { file: "src/b.ts", line: 2, summary: "fix b" },
    ];

    it("fans out a per-item process→verify pipeline and synthesizes the record", async () => {
      const calls = mockAgentRuntime((input) => {
        if (input.title === "Discover work items") {
          return { text: JSON.stringify(DISCOVERED) };
        }
        if ((input.title ?? "").startsWith("Process ")) {
          return { text: `deliverable ${(input.title ?? "").slice("Process ".length)}` };
        }
        if ((input.title ?? "").startsWith("Verify ")) {
          return { text: `verdict ${(input.title ?? "").slice("Verify ".length)}\nVERIFIED` };
        }
        return { text: "MERGED REPORT" };
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "mock",
        cwd: process.cwd(),
        inputs: { discovery_focus: "TODO comments in src" },
      });

      // Each discovered item runs BOTH pipeline steps, in order.
      for (const file of ["src/a.ts", "src/b.ts"]) {
        expect(callsWithTitle(calls, `Process ${file}`)).toHaveLength(1);
        expect(callsWithTitle(calls, `Verify ${file}`)).toHaveLength(1);
      }

      // The verify step adversarially checks the SAME item's deliverable — its
      // prompt carries {{process_one}} for that item.
      const verifyA = callsWithTitle(calls, "Verify src/a.ts")[0];
      expect(verifyA.prompt).toContain("deliverable src/a.ts");
      expect(verifyA.prompt).toContain("VERIFIED");

      // The report receives the map record; item outputs are the verify verdicts.
      const report = callsWithTitle(calls, "Synthesize report")[0];
      expect(report.prompt).toContain('"total":2');
      expect(report.prompt).toContain("verdict src/a.ts");

      expect(LAST(events)).toEqual(
        expect.objectContaining({ type: "run_completed", status: "completed" }),
      );
    });
  });

  describe("repo-migration-sweep-v1", () => {
    const SCRIPT = loadBlueprint("repo-migration-sweep-v1.workflow.js");

    const SITES = [
      { file: "src/a.ts", line: 10, note: "migrate a" },
      { file: "src/b.ts", line: 20, note: "migrate b" },
    ];

    it("discovers sites, runs a per-item migrate→verify pipeline, then a whole-change acceptance loop that reaches PASS and submits", async () => {
      let reviewerRuns = 0;
      const calls = mockAgentRuntime((input) => {
        if (input.title === "发现调用点") {
          return { text: JSON.stringify(SITES) };
        }
        if ((input.title ?? "").startsWith("迁移 ")) {
          return { text: `migrated ${(input.title ?? "").slice("迁移 ".length)}` };
        }
        if ((input.title ?? "").startsWith("验收 ")) {
          return { text: `checked ${(input.title ?? "").slice("验收 ".length)}\nVERIFIED` };
        }
        if (input.title === "整体修复") {
          return { text: "whole-workspace repair done" };
        }
        if (input.title === "整体验收 Reviewer") {
          reviewerRuns += 1;
          return reviewerRuns === 1
            ? { text: "阻断：跨文件回归\nFAIL" }
            : { text: "整体通过\nPASS" };
        }
        return {
          text: JSON.stringify({
            result: "mr_created",
            prUrl: "https://example.com/mr/4",
            branch: "feature/migrate",
            commit: "bbb2222",
            checks: "focused checks passed",
            unverified: [],
            rejectedSites: [],
            summary: "迁移已交付并创建 MR",
          }),
        };
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "mock",
        cwd: process.cwd(),
        inputs: { migration_brief: "把旧 API 迁移到新 API" },
      });

      // Each discovered site runs BOTH pipeline steps in order.
      for (const file of ["src/a.ts", "src/b.ts"]) {
        expect(callsWithTitle(calls, `迁移 ${file}`)).toHaveLength(1);
        expect(callsWithTitle(calls, `验收 ${file}`)).toHaveLength(1);
      }
      // The per-item verify sees the SAME item's migration deliverable.
      const verifyA = callsWithTitle(calls, "验收 src/a.ts")[0];
      expect(verifyA.prompt).toContain("migrated src/a.ts");

      // Acceptance loop enters at the reviewer: fix is SKIPPED on iteration 1.
      const fixFirst = loopStepStates(events, "loop:acceptance_loop:1:fix");
      expect(fixFirst).toHaveLength(1);
      expect(fixFirst[0].status).toBe("skipped");

      // Reviewer runs independent each round (promptMode "full") and sees the map record.
      expect(
        loopStepRunning(events, "loop:acceptance_loop:1:reviewer")?.promptMode,
      ).toBe("full");
      const reviewerCalls = callsWithTitle(calls, "整体验收 Reviewer");
      expect(reviewerCalls[0].prompt).toContain('"total":2');

      // Reviewer FAIL → fix runs on iteration 2 (independent session, full prompt)
      // and receives the reviewer feedback.
      expect(
        loopStepRunning(events, "loop:acceptance_loop:2:fix")?.promptMode,
      ).toBe("full");
      const fixCalls = callsWithTitle(calls, "整体修复");
      expect(fixCalls).toHaveLength(1);
      expect(fixCalls[0].prompt).toContain("阻断：跨文件回归");

      // submit_mr gates on the until_matched stop reason.
      const submitCalls = callsWithTitle(calls, "提交 MR");
      expect(submitCalls).toHaveLength(1);
      expect(submitCalls[0].prompt).toContain("Stop reason: until_matched");

      // submit_mr's output: "json" contract stores the terminal report parsed,
      // including the migration-specific rejectedSites field.
      const submitCompleted = events.find(
        (event) =>
          event.type === "node_completed" && event.nodeId === "submit_mr",
      );
      expect(submitCompleted).toEqual(
        expect.objectContaining({
          output: expect.objectContaining({
            result: "mr_created",
            rejectedSites: [],
          }),
        }),
      );

      expect(LAST(events)).toEqual(
        expect.objectContaining({ type: "run_completed", status: "completed" }),
      );
    });
  });

  describe("research-fanout-report-v1", () => {
    const SCRIPT = loadBlueprint("research-fanout-report-v1.workflow.js");

    const PLAN = [
      { id: "q1", question: "What is X?", why: "core" },
      { id: "q2", question: "What is Y?", why: "context" },
    ];

    it("fans out a research→fact-check pipeline and synthesizes with confidence propagated", async () => {
      const calls = mockAgentRuntime((input) => {
        if (input.title === "Decompose the topic") {
          return { text: JSON.stringify(PLAN) };
        }
        if ((input.title ?? "").startsWith("Research q")) {
          const id = (input.title ?? "").slice("Research ".length);
          return { text: `answer for ${id}` };
        }
        if ((input.title ?? "").startsWith("Fact-check q")) {
          const id = (input.title ?? "").slice("Fact-check ".length);
          return { text: `survivors for ${id}\nConfidence: medium` };
        }
        return { text: "FINAL REPORT" };
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "mock",
        cwd: process.cwd(),
        inputs: { research_topic: "Explain X and Y for engineers" },
      });

      // Each sub-question runs both pipeline steps.
      for (const id of ["q1", "q2"]) {
        expect(callsWithTitle(calls, `Research ${id}`)).toHaveLength(1);
        expect(callsWithTitle(calls, `Fact-check ${id}`)).toHaveLength(1);
      }
      // The fact-check step adversarially checks the SAME sub-question's answer.
      const factCheckQ1 = callsWithTitle(calls, "Fact-check q1")[0];
      expect(factCheckQ1.prompt).toContain("answer for q1");

      // The report receives the map record with the fact-check verdicts.
      const report = callsWithTitle(calls, "Synthesize report")[0];
      expect(report.prompt).toContain('"total":2');
      expect(report.prompt).toContain("Confidence: medium");
      expect(report.prompt).toContain("survivors for q1");

      expect(LAST(events)).toEqual(
        expect.objectContaining({ type: "run_completed", status: "completed" }),
      );
    });
  });

  describe("release-readiness-check-v1", () => {
    const SCRIPT = loadBlueprint("release-readiness-check-v1.workflow.js");

    it("runs the five static checks, gates on a human no_go decision, and records the reason", async () => {
      const calls = mockAgentRuntime((input) => {
        if ((input.title ?? "").startsWith("Check ")) {
          const check = (input.title ?? "").slice("Check ".length);
          const verdict = check === "security" ? "blocked" : "ready";
          return {
            text: JSON.stringify({
              check,
              verdict,
              evidence: `evidence for ${check}`,
              notes: "",
            }),
          };
        }
        if (input.title === "Summarize readiness") {
          return { text: "NO-GO: security blocked" };
        }
        return { text: "AUDIT RECORD" };
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "mock",
        cwd: process.cwd(),
        inputs: { release_scope: "Cut v1.2 from release branch" },
        onHumanTask: (request) =>
          humanTask(request, "resolved", {
            action: "no_go",
            values: { reason: "security check is blocked" },
          }),
      });

      // All five fixed dimensions run exactly once.
      for (const check of ["changelog", "tests", "migrations", "docs", "security"]) {
        expect(callsWithTitle(calls, `Check ${check}`)).toHaveLength(1);
      }

      // Summary receives the map record with the per-check JSON verdicts.
      const summary = callsWithTitle(calls, "Summarize readiness")[0];
      expect(summary.prompt).toContain('"total":5');
      expect(summary.prompt).toContain('"verdict":"blocked"');

      // The human gate resolved to no_go on the go_no_go node.
      const humanResolved = events.filter(
        (event) => event.type === "human_task_resolved",
      );
      expect(humanResolved).toHaveLength(1);
      expect(
        humanResolved[0].type === "human_task_resolved" &&
          humanResolved[0].nodeId === "go_no_go",
      ).toBe(true);

      // record restates the decision action and the human's reason via dotted refs.
      const record = callsWithTitle(calls, "Record decision")[0];
      expect(record.prompt).toContain('chose "no_go"');
      expect(record.prompt).toContain("security check is blocked");

      expect(LAST(events)).toEqual(
        expect.objectContaining({ type: "run_completed", status: "completed" }),
      );
    });
  });

  describe("epic-breakdown-plan-v1", () => {
    const SCRIPT = loadBlueprint("epic-breakdown-plan-v1.workflow.js");

    const TASKS = [
      { id: "t1", title: "Set up", goal: "scaffold", dependencies: [] },
      { id: "t2", title: "Build", goal: "implement", dependencies: ["t1"] },
    ];

    it("iterates decompose with a revise round, extracts the approved tasks, then details each and assembles the plan", async () => {
      let decomposeRuns = 0;
      const calls = mockAgentRuntime((input) => {
        if (input.title === "Decompose the epic") {
          decomposeRuns += 1;
          return { text: JSON.stringify(TASKS), sessionId: "planner-session" };
        }
        if (input.title === "Extract approved tasks") {
          return { text: JSON.stringify(TASKS) };
        }
        if ((input.title ?? "").startsWith("Detail ")) {
          const title = (input.title ?? "").slice("Detail ".length);
          return { text: `spec for ${title}` };
        }
        return { text: "FINAL PLAN" };
      });

      const events = await collectRun({
        script: SCRIPT,
        agent: "mock",
        cwd: process.cwd(),
        inputs: { epic_brief: "Ship the onboarding epic" },
        onHumanTask: (request) =>
          humanTask(
            request,
            "resolved",
            request.iteration === 1
              ? { action: "revise", values: { comment: "split task t2" } }
              : { action: "approve", values: {} },
          ),
      });

      // Decompose runs twice: initial + one revise round before approval.
      const decomposeCalls = callsWithTitle(calls, "Decompose the epic");
      expect(decomposeCalls).toHaveLength(2);
      // Round 2 resumes the inherited planner session (append) with the comment.
      expect(
        loopStepRunning(events, "loop:breakdown:2:decompose")?.promptMode,
      ).toBe("append");
      expect(decomposeCalls[1].prompt).toContain("split task t2");

      // Extract reads the loop record and re-emits the approved array.
      const extract = callsWithTitle(calls, "Extract approved tasks")[0];
      expect(extract.prompt).toContain("[decompose]");

      // Map details each approved task exactly once.
      for (const title of ["Set up", "Build"]) {
        expect(callsWithTitle(calls, `Detail ${title}`)).toHaveLength(1);
      }

      // The final plan receives the map record with the per-task specs.
      const finalPlan = callsWithTitle(calls, "Assemble final plan")[0];
      expect(finalPlan.prompt).toContain('"total":2');
      expect(finalPlan.prompt).toContain("spec for Set up");

      expect(LAST(events)).toEqual(
        expect.objectContaining({ type: "run_completed", status: "completed" }),
      );
    });
  });
});
