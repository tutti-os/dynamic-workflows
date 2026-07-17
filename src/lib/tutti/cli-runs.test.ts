import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunRequest } from "@/lib/workflow/types";

const runWorkflowMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workflow/executor", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workflow/executor")>(
    "@/lib/workflow/executor",
  );
  return {
    ...actual,
    runWorkflow: runWorkflowMock,
  };
});

// Two nodes where `second` consumes `first` via a template ref, so `second` is
// the sole terminal node (no dependents) the report should surface.
const TWO_NODE_SCRIPT = `
export const meta = { name: "Two", description: "Two node" }
const first = await agent({ id: "first", prompt: "Plan" })
const second = await agent({ id: "second", prompt: "Do {{first}}" })
`;

const HUMAN_SCRIPT = `
export const meta = { name: "recoverable", description: "Recoverable workflow" }
const first = await agent({ id: "first", prompt: "first" })
`;

let dataDir: string | undefined;

function useDataDir(): void {
  dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
}

afterEach(() => {
  vi.resetModules();
  runWorkflowMock.mockReset();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for workflow job.");
}

describe("dynamic workflows CLI runs get", () => {
  it("returns the record, result, report, and tasks for a known run", async () => {
    useDataDir();

    const { assertWorkflowScriptValid } = await import("@/lib/workflow/parser");
    const parsed = assertWorkflowScriptValid(TWO_NODE_SCRIPT);
    runWorkflowMock.mockImplementation(async function* (
      request: WorkflowRunRequest,
    ) {
      const runId = request.runId ?? "run";
      yield { type: "run_started", runId, parsed };
      yield { type: "node_completed", runId, nodeId: "first", output: "plan" };
      yield {
        type: "node_completed",
        runId,
        nodeId: "second",
        output: "final report",
      };
      yield { type: "run_completed", runId, status: "completed", outputs: {} };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { startWorkflowRunJob, isWorkflowRunJobActive } = await import(
      "@/lib/workflow/run-jobs"
    );
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const detail = createWorkflowFromScript(TWO_NODE_SCRIPT);
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

    const response = await handleDynamicWorkflowsCliRequest(["runs", "get"], {
      input: { "run-id": run.id },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.run).toMatchObject({ id: run.id, status: "completed" });
    expect(body.value.result.outputs).toMatchObject({
      first: "plan",
      second: "final report",
    });
    expect(body.value.result.nodeStatuses.second).toBe("completed");
    // The report surfaces only the terminal node (`second`), not `first`.
    expect(body.value.report.nodeIds).toEqual(["second"]);
    expect(body.value.report.outputs).toEqual({ second: "final report" });
    expect(body.value.report.text).toBe("final report");
    expect(body.value.humanTasks).toEqual([]);
  });

  it("returns the not-found error shape for an unknown run", async () => {
    useDataDir();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");
    const response = await handleDynamicWorkflowsCliRequest(["runs", "get"], {
      input: { "run-id": "does-not-exist" },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("run_not_found");
  });

  it("reports a stale running run as interrupted", async () => {
    useDataDir();

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { createWorkflowRun } = await import("@/lib/db/workflows/runs");
    const { appendRunLogEvent, ensureRunLogDirectory } = await import(
      "@/lib/workflow/run-log"
    );
    const { assertWorkflowScriptValid } = await import("@/lib/workflow/parser");
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const detail = createWorkflowFromScript(HUMAN_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const parsed = assertWorkflowScriptValid(version.script);
    // A "running" run with no in-process job and no fresh claim, whose log has
    // no terminal event — a crash zombie.
    const run = createWorkflowRun({
      workflowId: detail.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      cwd: process.cwd(),
      request: { inputs: {} },
    });
    ensureRunLogDirectory(run.logPath);
    appendRunLogEvent(run.logPath, { type: "run_started", runId: run.id, parsed });

    const response = await handleDynamicWorkflowsCliRequest(["runs", "get"], {
      input: { "run-id": run.id },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.run.status).toBe("interrupted");
  });
});

describe("dynamic workflows CLI runs wait", () => {
  it("returns immediately with the terminal reason for a finished run", async () => {
    useDataDir();

    runWorkflowMock.mockImplementation(async function* (
      request: WorkflowRunRequest,
    ) {
      yield {
        type: "run_completed",
        runId: request.runId ?? "run",
        status: "completed",
        outputs: {},
      };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { startWorkflowRunJob, isWorkflowRunJobActive } = await import(
      "@/lib/workflow/run-jobs"
    );
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const detail = createWorkflowFromScript(HUMAN_SCRIPT);
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

    const response = await handleDynamicWorkflowsCliRequest(["runs", "wait"], {
      input: { "run-id": run.id, "timeout-ms": 5000 },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.reason).toBe("completed");
    expect(body.value.timedOut).toBe(false);
    expect(body.value.run.id).toBe(run.id);
  });

  it("returns timeout with timedOut true while a run keeps running", async () => {
    useDataDir();

    let releaseRun: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const { assertWorkflowScriptValid } = await import("@/lib/workflow/parser");
    const parsed = assertWorkflowScriptValid(HUMAN_SCRIPT);
    runWorkflowMock.mockImplementation(async function* (
      request: WorkflowRunRequest,
    ) {
      const runId = request.runId ?? "run";
      yield { type: "run_started", runId, parsed };
      await blocked;
      yield { type: "run_completed", runId, status: "completed", outputs: {} };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { startWorkflowRunJob, isWorkflowRunJobActive } = await import(
      "@/lib/workflow/run-jobs"
    );
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const detail = createWorkflowFromScript(HUMAN_SCRIPT);
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

    const response = await handleDynamicWorkflowsCliRequest(["runs", "wait"], {
      input: { "run-id": run.id, "timeout-ms": 40 },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.reason).toBe("timeout");
    expect(body.value.timedOut).toBe(true);
    expect(body.value.run.status).toBe("running");

    releaseRun?.();
    await waitUntil(() => !isWorkflowRunJobActive(run.id));
  });

  it("returns waiting_human with pending tasks for a run blocked on a human", async () => {
    useDataDir();

    const { assertWorkflowScriptValid } = await import("@/lib/workflow/parser");
    const parsed = assertWorkflowScriptValid(HUMAN_SCRIPT);
    runWorkflowMock.mockImplementation(async function* (
      request: WorkflowRunRequest,
    ) {
      const runId = request.runId ?? "run";
      yield { type: "run_started", runId, parsed };
      const task = await request.onHumanTask?.({
        runId,
        nodeId: "first",
        executionKey: "human:first",
        spec: {
          context: [],
          actions: [{ id: "pass", label: "Pass", intent: "primary", fields: [] }],
        },
      });
      if (!task) {
        throw new Error("task missing");
      }
      yield { type: "human_task_requested", runId, nodeId: "first", task };
      yield {
        type: "run_waiting",
        runId,
        pendingTaskIds: [task.id],
        outputs: {},
      };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { startWorkflowRunJob, isWorkflowRunJobActive } = await import(
      "@/lib/workflow/run-jobs"
    );
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const detail = createWorkflowFromScript(HUMAN_SCRIPT);
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

    const response = await handleDynamicWorkflowsCliRequest(["runs", "wait"], {
      input: { "run-id": run.id, "timeout-ms": 5000 },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.reason).toBe("waiting_human");
    expect(body.value.timedOut).toBe(false);
    expect(body.value.run.status).toBe("waiting_for_human");
    expect(body.value.humanTasks).toHaveLength(1);
    expect(body.value.humanTasks[0].nodeId).toBe("first");
  });
});

// A human-gated workflow that blocks on one task, then completes on resume.
// Follows the run-jobs harness contract: the generator returns after
// `run_waiting` (invocation 1) so the job ends and the run persists as
// waiting_for_human; `resumeWorkflowRunAfterHumanTask` re-runs the generator
// (invocation 2), which completes. The CLI respond command drives exactly that
// resolve + resume pair internally.
const HUMAN_GATE_SCRIPT = `
export const meta = { name: "gate", description: "Human gated workflow" }
const first = await agent({ id: "first", prompt: "first" })
`;

describe("dynamic workflows CLI runs respond", () => {
  async function startGatedRun() {
    const { assertWorkflowScriptValid } = await import("@/lib/workflow/parser");
    const parsed = assertWorkflowScriptValid(HUMAN_GATE_SCRIPT);
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
          nodeId: "first",
          executionKey: "human:first",
          spec: {
            description: "Approve the plan?",
            context: [
              { label: "Plan", value: "Ship it", display: "text" as const },
            ],
            actions: [
              {
                id: "approve",
                label: "Approve",
                intent: "primary" as const,
                fields: [
                  {
                    id: "notes",
                    type: "text" as const,
                    label: "Notes",
                    required: false,
                  },
                ],
              },
            ],
          },
        });
        if (!task) {
          throw new Error("task missing");
        }
        yield { type: "human_task_requested", runId, nodeId: "first", task };
        yield {
          type: "run_waiting",
          runId,
          pendingTaskIds: [task.id],
          outputs: {},
        };
        return;
      }
      yield { type: "node_completed", runId, nodeId: "first", output: "done" };
      yield { type: "run_completed", runId, status: "completed", outputs: {} };
    });

    const { createWorkflowFromScript } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { startWorkflowRunJob, isWorkflowRunJobActive } = await import(
      "@/lib/workflow/run-jobs"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");
    const { listWorkflowHumanTasks } = await import(
      "@/lib/db/workflows/human-tasks"
    );

    const detail = createWorkflowFromScript(HUMAN_GATE_SCRIPT);
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
    // The gate job ends after run_waiting; the run persists as waiting_for_human.
    await waitUntil(() => !isWorkflowRunJobActive(run.id));
    expect(getWorkflowRun(run.id)?.status).toBe("waiting_for_human");
    const task = listWorkflowHumanTasks(run.id, "pending")[0];
    return { runId: run.id, task };
  }

  it("resolves a pending task, resumes the run, and returns the refreshed detail", async () => {
    useDataDir();
    const { runId, task } = await startGatedRun();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");
    const { isWorkflowRunJobActive } = await import("@/lib/workflow/run-jobs");
    const { getWorkflowHumanTask } = await import(
      "@/lib/db/workflows/human-tasks"
    );
    const { getWorkflowRun } = await import("@/lib/db/workflows/runs");

    const response = await handleDynamicWorkflowsCliRequest(["runs", "respond"], {
      input: {
        "run-id": runId,
        "task-id": task.id,
        action: "approve",
        values: JSON.stringify({ notes: "ship it" }),
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    // The service recorded the response and bumped the revision.
    expect(body.value.task.status).toBe("resolved");
    expect(body.value.task.response).toEqual({
      action: "approve",
      values: { notes: "ship it" },
    });
    expect(getWorkflowHumanTask(task.id)?.status).toBe("resolved");
    // The payload is the refreshed runs get detail: same shape, no pending tasks.
    expect(body.value.run.id).toBe(runId);
    expect(body.value.humanTasks).toEqual([]);
    expect(body.value).toHaveProperty("result");
    expect(body.value).toHaveProperty("report");

    // The resume kicked off invocation 2, which drives the run to completion.
    await waitUntil(() => !isWorkflowRunJobActive(runId));
    expect(getWorkflowRun(runId)?.status).toBe("completed");
  });

  it("rejects an unknown action for a pending task", async () => {
    useDataDir();
    const { runId, task } = await startGatedRun();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const response = await handleDynamicWorkflowsCliRequest(["runs", "respond"], {
      input: { "run-id": runId, "task-id": task.id, action: "nope" },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("human_task_invalid");
  });

  it("rejects an unknown task id", async () => {
    useDataDir();
    const { runId } = await startGatedRun();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const response = await handleDynamicWorkflowsCliRequest(["runs", "respond"], {
      input: {
        "run-id": runId,
        "task-id": "does-not-exist",
        action: "approve",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("human_task_not_found");
  });

  it("rejects a stale revision as a conflict", async () => {
    useDataDir();
    const { runId, task } = await startGatedRun();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const response = await handleDynamicWorkflowsCliRequest(["runs", "respond"], {
      input: {
        "run-id": runId,
        "task-id": task.id,
        action: "approve",
        revision: task.revision + 5,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("human_task_conflict");
  });

  it("returns run_not_found for an unknown run", async () => {
    useDataDir();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");
    const response = await handleDynamicWorkflowsCliRequest(["runs", "respond"], {
      input: {
        "run-id": "does-not-exist",
        "task-id": "task",
        action: "approve",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("run_not_found");
  });
});
