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

describe("dynamic workflows CLI", () => {
  it("starts a run with inputs without persisting undefined metadata", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

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
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const detail = createWorkflowFromScript(`
export const meta = { name: "Requirement", description: "Requirement" }
const first = await agent({ id: "first", prompt: "Plan {{requirement}}" })
`);

    const response = await handleDynamicWorkflowsCliRequest(["run"], {
      input: {
        "workflow-id": detail.workflow.id,
        agent: "mock",
        inputs: JSON.stringify({ requirement: "rename sessions" }),
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      kind: "json",
      value: {
        run: {
          status: "running",
          input: {
            inputs: { requirement: "rename sessions" },
            agent: "mock",
          },
        },
      },
    });
    expect(body.value.run.input).not.toHaveProperty("model");
  });

  it("starts a run without inputs or model", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

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
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const detail = createWorkflowFromScript(`
export const meta = { name: "Simple", description: "Simple" }
const first = await agent({ id: "first", prompt: "Plan" })
`);

    const response = await handleDynamicWorkflowsCliRequest(["run"], {
      input: {
        "workflow-id": detail.workflow.id,
        agent: "mock",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.run.input).toEqual({
      inputs: {},
      agent: "mock",
      cwd: process.cwd(),
    });
  });
});
