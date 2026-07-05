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
