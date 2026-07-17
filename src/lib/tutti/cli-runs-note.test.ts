import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCRIPT = `
export const meta = { name: "notes", description: "Notes workflow" }
const first = await agent({ id: "first", prompt: "first" })
`;

let dataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
});

async function createRunningRun() {
  const { createWorkflowFromScript } = await import(
    "@/lib/db/workflows/workflow-repository"
  );
  const { createWorkflowRun } = await import("@/lib/db/workflows/runs");
  const detail = createWorkflowFromScript(SCRIPT);
  const version = detail.currentVersion;
  if (!version) {
    throw new Error("version missing");
  }
  return createWorkflowRun({
    workflowId: detail.workflow.id,
    workflowVersionId: version.id,
    executorKind: "mock",
    cwd: process.cwd(),
    request: { inputs: {} },
  });
}

describe("dynamic workflows CLI runs note", () => {
  it("records a next-step note and returns it", async () => {
    const run = await createRunningRun();
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");
    const { listWorkflowRunNotes } = await import(
      "@/lib/db/workflows/run-notes"
    );

    const response = await handleDynamicWorkflowsCliRequest(["runs", "note"], {
      input: { "run-id": run.id, message: "Prioritize the failing test" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.note).toMatchObject({
      runId: run.id,
      message: "Prioritize the failing test",
      target: "next-step",
      status: "pending",
    });
    expect(body.value.delivery).toBeUndefined();

    // The note is persisted so runs get / the timeline can surface it.
    const persisted = listWorkflowRunNotes(run.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].message).toBe("Prioritize the failing test");
  });

  it("rejects an unknown run", async () => {
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");
    const response = await handleDynamicWorkflowsCliRequest(["runs", "note"], {
      input: { "run-id": "does-not-exist", message: "steer" },
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("run_not_found");
  });

  it("rejects a current-target note when no live session exists", async () => {
    const run = await createRunningRun();
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const response = await handleDynamicWorkflowsCliRequest(["runs", "note"], {
      input: { "run-id": run.id, message: "steer now", target: "current" },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("run_note_no_live_session");
    expect(body.error.message).toMatch(/next-step/);
  });

  it("rejects an invalid target", async () => {
    const run = await createRunningRun();
    const { handleDynamicWorkflowsCliRequest } = await import("@/lib/tutti/cli");

    const response = await handleDynamicWorkflowsCliRequest(["runs", "note"], {
      input: { "run-id": run.id, message: "steer", target: "sideways" },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_input");
  });
});
