import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunRequest } from "./types";

const runWorkflowMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workflow/executor", async () => {
  const actual = await vi.importActual<typeof import("./executor")>(
    "@/lib/workflow/executor",
  );
  return {
    ...actual,
    runWorkflow: runWorkflowMock,
  };
});

const SCRIPT = `
export const meta = { name: "recoverable", description: "Recoverable workflow" }
const first = await agent({ id: "first", prompt: "first" })
`;

let dataDir: string | undefined;

afterEach(() => {
  vi.resetModules();
  runWorkflowMock.mockReset();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
});

describe("workflow run jobs recovery", () => {
  it("stops publishing as soon as another runner owns the execution token", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { assertWorkflowScriptValid } = await import("@/lib/workflow/parser");
    const parsed = assertWorkflowScriptValid(SCRIPT);
    const node = parsed.nodes.find((item) => item.id === "first");
    if (!node) {
      throw new Error("node missing");
    }
    let releaseStart: (() => void) | undefined;
    const allowStart = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let release: (() => void) | undefined;
    const continueRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markPublished: (() => void) | undefined;
    const published = new Promise<void>((resolve) => {
      markPublished = resolve;
    });
    runWorkflowMock.mockImplementation(async function* (
      request: WorkflowRunRequest,
    ) {
      const runId = request.runId ?? "run";
      await allowStart;
      yield { type: "run_started", runId, parsed };
      await continueRun;
      yield {
        type: "node_started",
        runId,
        nodeId: node.id,
        node,
        agent: "mock",
      };
      yield {
        type: "run_completed",
        runId,
        status: "completed",
        outputs: {},
      };
    });

    const { getDb } = await import("@/lib/db/client");
    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { readRunLog } = await import("@/lib/workflow/run-log");
    const { parseRunLogEvents } = await import("@/lib/workflow/run-state");
    const {
      isWorkflowRunJobActive,
      startWorkflowRunJob,
      subscribeWorkflowRunJob,
    } = await import(
      "@/lib/workflow/run-jobs"
    );
    const detail = createWorkflowFromScript(SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = startWorkflowRunJob({
      workflowId: detail.workflow.id,
      version,
      cwd: process.cwd(),
      executorKind: "mock",
      inputs: {},
      input: { inputs: {} },
    });

    subscribeWorkflowRunJob(run.id, (event) => {
      if (event.type === "run_started") {
        markPublished?.();
      }
    });
    releaseStart?.();
    await published;
    getDb().prepare(`
      UPDATE workflow_runs
      SET resume_token = 'replacement-owner'
      WHERE id = ?
    `).run(run.id);
    release?.();
    await waitUntil(() => !isWorkflowRunJobActive(run.id));

    const eventTypes = parseRunLogEvents(await readRunLog(run.logPath)).map(
      (event) => event.type,
    );
    expect(eventTypes).toEqual(["run_started"]);
  });

  it("persists a waiting run and resumes after a human response", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { assertWorkflowScriptValid } = await import("@/lib/workflow/parser");
    const parsed = assertWorkflowScriptValid(SCRIPT);
    let invocation = 0;
    runWorkflowMock.mockImplementation(async function* (
      request: WorkflowRunRequest,
    ) {
      invocation += 1;
      const runId = request.runId ?? "run";
      yield { type: "run_started", runId, parsed };
      if (invocation === 1) {
        const task = await request.onHumanTask?.({
          runId,
          nodeId: "approval",
          executionKey: "human:approval",
          spec: {
            context: [],
            actions: [{
              id: "pass",
              label: "Pass",
              intent: "primary",
              fields: [],
            }],
          },
        });
        if (!task) {
          throw new Error("task missing");
        }
        yield {
          type: "human_task_requested",
          runId,
          nodeId: "first",
          task,
        };
        yield {
          type: "run_waiting",
          runId,
          pendingTaskIds: [task.id],
          outputs: {},
        };
        return;
      }
      yield {
        type: "run_completed",
        runId,
        status: "completed",
        outputs: {},
      };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const {
      getWorkflowHumanTask,
      listWorkflowHumanTasks,
      resolveWorkflowHumanTask,
    } = await import("@/lib/db/workflows/human-tasks");
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const {
      isWorkflowRunJobActive,
      resumeWorkflowRunAfterHumanTask,
      startWorkflowRunJob,
      subscribeWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");
    const detail = createWorkflowFromScript(SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = startWorkflowRunJob({
      workflowId: detail.workflow.id,
      version,
      cwd: process.cwd(),
      executorKind: "mock",
      inputs: {},
      input: { inputs: {} },
    });
    const waitingStatuses: string[] = [];
    subscribeWorkflowRunJob(run.id, (event) => {
      if (event.type === "run_waiting") {
        waitingStatuses.push(getWorkflowRun(run.id)?.status ?? "missing");
      }
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));

    expect(getWorkflowRun(run.id)?.status).toBe("waiting_for_human");
    expect(waitingStatuses).toEqual(["waiting_for_human"]);
    const [task] = listWorkflowHumanTasks(run.id, "pending");
    expect(getWorkflowHumanTask(task.id)?.status).toBe("pending");
    resolveWorkflowHumanTask({
      runId: run.id,
      taskId: task.id,
      action: "pass",
      values: {},
      revision: task.revision,
    });
    await resumeWorkflowRunAfterHumanTask({
      workflowId: detail.workflow.id,
      runId: run.id,
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));

    expect(getWorkflowRun(run.id)?.status).toBe("completed");
    expect(listWorkflowHumanTasks(run.id, "pending")).toEqual([]);
  });

  it("keeps completed nodes in recovery when another human task wakes an active run", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const script = `
export const meta = { name: "multi-human", description: "Multi human" }
const first = await human({ id: "first", actions: [{ id: "pass", label: "Pass" }] })
const second = await human({ id: "second", actions: [{ id: "pass", label: "Pass" }] })
const afterFirst = await agent({ id: "after-first", prompt: "{{first.action}}" })
`;
    const { assertWorkflowScriptValid } = await import("@/lib/workflow/parser");
    const parsed = assertWorkflowScriptValid(script);
    const afterFirstNode = parsed.nodes.find((node) => node.id === "after-first");
    if (!afterFirstNode) {
      throw new Error("after-first node missing");
    }
    let invocation = 0;
    let releaseSecondWait: (() => void) | undefined;
    const secondWaitAllowed = new Promise<void>((resolve) => {
      releaseSecondWait = resolve;
    });
    let markAfterFirstCompleted: (() => void) | undefined;
    const afterFirstCompleted = new Promise<void>((resolve) => {
      markAfterFirstCompleted = resolve;
    });
    let finalRecovery: WorkflowRunRequest["recovery"];

    runWorkflowMock.mockImplementation(async function* (
      request: WorkflowRunRequest,
    ) {
      invocation += 1;
      const runId = request.runId ?? "run";
      yield { type: "run_started", runId, parsed };
      if (invocation === 1) {
        const tasks = [];
        for (const nodeId of ["first", "second"]) {
          const task = await request.onHumanTask?.({
            runId,
            nodeId,
            executionKey: `human:${nodeId}`,
            spec: {
              context: [],
              actions: [{ id: "pass", label: "Pass", intent: "primary", fields: [] }],
            },
          });
          if (!task) {
            throw new Error("task missing");
          }
          tasks.push(task);
          yield { type: "human_task_requested", runId, nodeId, task };
        }
        yield {
          type: "run_waiting",
          runId,
          pendingTaskIds: tasks.map((task) => task.id),
          outputs: {},
        };
        return;
      }
      if (invocation === 2) {
        yield {
          type: "human_task_resolved",
          runId,
          nodeId: "first",
          taskId: "first-task",
          response: { action: "pass", values: {} },
        };
        yield {
          type: "node_completed",
          runId,
          nodeId: "first",
          output: { action: "pass", values: {} },
        };
        yield {
          type: "node_started",
          runId,
          nodeId: "after-first",
          node: afterFirstNode,
          agent: "mock",
        };
        yield {
          type: "node_completed",
          runId,
          nodeId: "after-first",
          output: "side effect completed once",
        };
        markAfterFirstCompleted?.();
        await secondWaitAllowed;
        const pending = request.onHumanTask
          ? await request.onHumanTask({
              runId,
              nodeId: "second",
              executionKey: "human:second",
              spec: {
                context: [],
                actions: [{ id: "pass", label: "Pass", intent: "primary", fields: [] }],
              },
            })
          : undefined;
        if (!pending) {
          throw new Error("second task missing");
        }
        yield {
          type: "run_waiting",
          runId,
          pendingTaskIds: [pending.id],
          outputs: { "after-first": "side effect completed once" },
        };
        return;
      }
      finalRecovery = request.recovery;
      yield {
        type: "human_task_resolved",
        runId,
        nodeId: "second",
        taskId: "second-task",
        response: { action: "pass", values: {} },
      };
      yield {
        type: "node_completed",
        runId,
        nodeId: "second",
        output: { action: "pass", values: {} },
      };
      yield {
        type: "run_completed",
        runId,
        status: "completed",
        outputs: { "after-first": "side effect completed once" },
      };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { listWorkflowHumanTasks, resolveWorkflowHumanTask } = await import(
      "@/lib/db/workflows/human-tasks"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const {
      isWorkflowRunJobActive,
      resumeWorkflowRunAfterHumanTask,
      startWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");
    const detail = createWorkflowFromScript(script);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = startWorkflowRunJob({
      workflowId: detail.workflow.id,
      version,
      cwd: process.cwd(),
      executorKind: "mock",
      inputs: {},
      input: { inputs: {} },
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));
    const tasks = listWorkflowHumanTasks(run.id);
    const first = tasks.find((task) => task.nodeId === "first");
    const second = tasks.find((task) => task.nodeId === "second");
    if (!first || !second) {
      throw new Error("human tasks missing");
    }
    resolveWorkflowHumanTask({
      runId: run.id,
      taskId: first.id,
      action: "pass",
      values: {},
      revision: first.revision,
    });
    await resumeWorkflowRunAfterHumanTask({
      workflowId: detail.workflow.id,
      runId: run.id,
    });
    await afterFirstCompleted;
    resolveWorkflowHumanTask({
      runId: run.id,
      taskId: second.id,
      action: "pass",
      values: {},
      revision: second.revision,
    });
    await resumeWorkflowRunAfterHumanTask({
      workflowId: detail.workflow.id,
      runId: run.id,
    });
    releaseSecondWait?.();
    await waitUntil(() => !isWorkflowRunJobActive(run.id));

    expect(invocation).toBe(3);
    expect(finalRecovery?.completedNodeIds).toEqual(
      expect.arrayContaining(["first", "after-first"]),
    );
    expect(getWorkflowRun(run.id)?.status).toBe("completed");
  });

  it("persists a map checkpoint and resumes only unfinished items", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { assertWorkflowScriptValid } = await import("@/lib/workflow/parser");
    const parsed = assertWorkflowScriptValid(SCRIPT);
    const mapState = {
      items: [{ file: "a.ts" }, { file: "b.ts" }, { file: "c.ts" }],
      completions: [
        { index: 1, status: "completed" as const, output: "migrated a.ts" },
      ],
    };
    let invocation = 0;
    let resumedRecovery: WorkflowRunRequest["recovery"];
    runWorkflowMock.mockImplementation(async function* (
      request: WorkflowRunRequest,
    ) {
      invocation += 1;
      const runId = request.runId ?? "run";
      yield { type: "run_started", runId, parsed };
      if (invocation === 1) {
        await request.onCheckpoint?.({
          runId,
          nodeId: "migrate_all",
          kind: "map",
          state: mapState,
        });
        const task = await request.onHumanTask?.({
          runId,
          nodeId: "gate",
          executionKey: "human:gate",
          spec: {
            context: [],
            actions: [
              { id: "pass", label: "Pass", intent: "primary", fields: [] },
            ],
          },
        });
        if (!task) {
          throw new Error("task missing");
        }
        yield { type: "human_task_requested", runId, nodeId: "gate", task };
        yield {
          type: "run_waiting",
          runId,
          pendingTaskIds: [task.id],
          outputs: {},
        };
        return;
      }
      resumedRecovery = request.recovery;
      yield {
        type: "run_completed",
        runId,
        status: "completed",
        outputs: {},
      };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { listWorkflowHumanTasks, resolveWorkflowHumanTask } = await import(
      "@/lib/db/workflows/human-tasks"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const {
      isWorkflowRunJobActive,
      resumeWorkflowRunAfterHumanTask,
      startWorkflowRunJob,
    } = await import("@/lib/workflow/run-jobs");
    const detail = createWorkflowFromScript(SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = startWorkflowRunJob({
      workflowId: detail.workflow.id,
      version,
      cwd: process.cwd(),
      executorKind: "mock",
      inputs: {},
      input: { inputs: {} },
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));

    expect(getWorkflowRun(run.id)?.status).toBe("waiting_for_human");
    const [task] = listWorkflowHumanTasks(run.id, "pending");
    resolveWorkflowHumanTask({
      runId: run.id,
      taskId: task.id,
      action: "pass",
      values: {},
      revision: task.revision,
    });
    await resumeWorkflowRunAfterHumanTask({
      workflowId: detail.workflow.id,
      runId: run.id,
    });
    await waitUntil(() => !isWorkflowRunJobActive(run.id));

    expect(invocation).toBe(2);
    // The map checkpoint crossed the DB persistence boundary and was reloaded
    // into recovery.mapStates so only the two unfinished items re-run.
    expect(resumedRecovery?.mapStates?.migrate_all).toEqual(mapState);
    expect(
      resumedRecovery?.mapStates?.migrate_all?.completions.map(
        (completion) => completion.index,
      ),
    ).toEqual([1]);
    expect(getWorkflowRun(run.id)?.status).toBe("completed");
  });

  it("reconciles a stale running run from a terminal log event", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { createWorkflowRun } = await import("@/lib/db/workflows/runs");
    const { appendRunLogEvent, ensureRunLogDirectory } = await import(
      "@/lib/workflow/run-log"
    );
    const { assertWorkflowScriptValid } = await import("@/lib/workflow/parser");
    const { markWorkflowRunInterruptedIfStale } = await import(
      "@/lib/workflow/run-jobs"
    );

    const detail = createWorkflowFromScript(SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const parsed = assertWorkflowScriptValid(version.script);
    const node = parsed.nodes.find((item) => item.id === "first");
    if (!node) {
      throw new Error("node missing");
    }
    const run = createWorkflowRun({
      workflowId: detail.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      agent: "mock",
      cwd: process.cwd(),
      request: { inputs: {} },
    });
    ensureRunLogDirectory(run.logPath);
    appendRunLogEvent(run.logPath, {
      type: "run_started",
      runId: run.id,
      parsed,
    });
    appendRunLogEvent(run.logPath, {
      type: "node_started",
      runId: run.id,
      nodeId: "first",
      node,
      agent: "mock",
    });
    appendRunLogEvent(run.logPath, {
      type: "node_completed",
      runId: run.id,
      nodeId: "first",
      output: "done",
    });
    appendRunLogEvent(run.logPath, {
      type: "run_completed",
      runId: run.id,
      status: "completed",
      outputs: { first: "done" },
    });

    const reconciled = await markWorkflowRunInterruptedIfStale(run);

    expect(reconciled.status).toBe("completed");
    expect(reconciled.result).toEqual(
      expect.objectContaining({
        outputs: { first: "done" },
        nodeStatuses: { first: "completed" },
      }),
    );
  });

  it("reserves a resume job before async recovery work", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    let releaseRun: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      runWorkflowMock.mockImplementation(async function* (
        request: WorkflowRunRequest,
      ) {
        resolve();
        await new Promise<void>((release) => {
          releaseRun = release;
        });
        yield {
          type: "run_completed",
          runId: request.runId ?? "run",
          status: "completed",
          outputs: {},
        };
      });
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { createWorkflowRun } = await import("@/lib/db/workflows/runs");
    const { resumeWorkflowRunJob } = await import("@/lib/workflow/run-jobs");

    const detail = createWorkflowFromScript(SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = createWorkflowRun({
      workflowId: detail.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      agent: "mock",
      cwd: process.cwd(),
      request: { inputs: {} },
    });

    const [first, second] = await Promise.all([
      resumeWorkflowRunJob({ workflowId: detail.workflow.id, runId: run.id }),
      resumeWorkflowRunJob({ workflowId: detail.workflow.id, runId: run.id }),
    ]);
    await runStarted;

    expect(first.id).toBe(run.id);
    expect(second.id).toBe(run.id);
    expect(runWorkflowMock).toHaveBeenCalledTimes(1);

    releaseRun?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for workflow job.");
}
