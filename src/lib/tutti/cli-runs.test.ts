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
