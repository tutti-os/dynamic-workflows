import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  it("returns structured diagnostics from validate", async () => {
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const response = await handleDynamicWorkflowsCliRequest(["validate"], {
      input: {
        script: `
export const inputs = {
  requirement: { required: true },
  unused: { type: "string" },
}
const first = await agent({ id: "first", prompt: "Plan {{requirement}}" })
`,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value).toMatchObject({
      valid: false,
      diagnosticSummary: {
        errorCount: 2,
        warningCount: 1,
        infoCount: 0,
      },
      diagnostics: [
        expect.objectContaining({
          severity: "error",
          code: "workflow.input.typeMissing",
          path: "inputs.requirement.type",
          hint: expect.stringContaining("Set type"),
        }),
        expect.objectContaining({
          severity: "error",
          code: "workflow.input.undeclared",
          path: "inputs.requirement",
        }),
        expect.objectContaining({
          severity: "warning",
          code: "workflow.input.unused",
          path: "inputs.unused",
        }),
      ],
    });
  });

  it("validates a file inside an authoring job workspace", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { createPendingWorkflowGeneration } = await import(
      "@/lib/db/workflows/generations"
    );
    const { prepareAuthoringWorkspace } = await import(
      "@/lib/workflow/authoring/workspace"
    );
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const pending = createPendingWorkflowGeneration({ prompt: "Make a workflow" });
    const jobId = pending.generation!.id;
    const workspace = prepareAuthoringWorkspace({ jobId });
    writeFileSync(
      path.join(workspace.dir, "draft.workflow.js"),
      'const first = agent({ id: "first", prompt: "Uses {{missing}}" })',
    );

    const response = await handleDynamicWorkflowsCliRequest(
      ["authoring", "validate"],
      {
        input: {
          "job-id": jobId,
          file: "draft.workflow.js",
        },
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value).toMatchObject({
      valid: false,
      jobType: "generation",
      diagnosticSummary: { errorCount: 1 },
    });
  });

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
export const inputs = {
  requirement: { type: "string", required: true, label: "Requirement" },
}
const first = await agent({ id: "first", prompt: "Plan {{requirement}}" })
`);

    const response = await handleDynamicWorkflowsCliRequest(["run"], {
      input: {
        "workflow-id": detail.workflow.id,
        agent: "mock",
        "permission-mode": "auto",
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
            permissionMode: "auto",
          },
        },
      },
    });
    expect(body.value.run.input).not.toHaveProperty("model");
  });

  it("reports the request-derived baseUrl in status", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");
    const request = new Request("http://127.0.0.1:4123/tutti/cli/status", {
      method: "POST",
      headers: { host: "127.0.0.1:4123" },
    });

    const response = await handleDynamicWorkflowsCliRequest(
      ["status"],
      {},
      request,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.app.baseUrl).toBe("http://127.0.0.1:4123");
    expect(typeof body.value.app.cwdRoot).toBe("string");
  });

  it("imports a workflow script string as a saved workflow", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");
    const response = await handleDynamicWorkflowsCliRequest(["import"], {
      input: {
        script: `
export const meta = { name: "Imported", description: "Imported workflow" }
const first = await agent({ id: "first", prompt: "Plan" })
`,
      },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.ok).toBe(true);
    expect(body.value.workflow.name).toBe("Imported");
    expect(body.value.currentVersion.version).toBe(1);
  });

  it("returns a domain envelope for an invalid import script", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");
    const response = await handleDynamicWorkflowsCliRequest(["import"], {
      input: { script: "this is not a workflow (((" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.ok).toBe(false);
    expect(body.value.error.code).toBe("workflow_script_invalid");
    expect(body.value.error.status).toBe(400);
  });

  it("instantiates a blueprint into a runnable workflow", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");
    const response = await handleDynamicWorkflowsCliRequest(
      ["blueprints", "instantiate"],
      {
        input: {
          "blueprint-id": "human-feedback-loop-v1",
          name: "My feedback loop",
        },
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.ok).toBe(true);
    expect(body.value.workflow.name).toBe("My feedback loop");
    expect(body.value.currentVersion.version).toBe(1);
  });

  it("returns a domain envelope for an unknown blueprint id", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");
    const response = await handleDynamicWorkflowsCliRequest(
      ["blueprints", "instantiate"],
      { input: { "blueprint-id": "does-not-exist" } },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.ok).toBe(false);
    expect(body.value.error.code).toBe("workflow_blueprint_not_found");
    expect(body.value.error.status).toBe(404);
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
    expect(body.value.run.input).not.toHaveProperty("permissionMode");
  });
});
