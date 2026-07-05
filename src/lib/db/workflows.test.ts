import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const INITIAL_SCRIPT = `
export const meta = { name: "official_workflow", description: "Official workflow" }
const first = await agent({ id: "first", prompt: "first" })
`;

const EDITED_SCRIPT = `
export const meta = { name: "edited_workflow", description: "Edited workflow" }
const first = await agent({ id: "first", prompt: "first edited" })
`;

let dataDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
});

function initTestDataDir() {
  dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
}

describe("workflow version publishing", () => {
  it("keeps unpublished versions separate from the official version", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const {
      createWorkflowFromScript,
      createWorkflowVersion,
      getWorkflowDetail,
      publishWorkflowVersion,
    } = await import("./workflows");

    const created = createWorkflowFromScript(INITIAL_SCRIPT);
    const officialVersionId = created.currentVersion?.id;
    expect(officialVersionId).toBeTruthy();

    const candidate = createWorkflowVersion({
      workflowId: created.workflow.id,
      script: EDITED_SCRIPT,
      publish: false,
      source: "agent_edit",
      baseVersionId: officialVersionId,
      note: "Edit with an agent",
    });

    const withCandidate = getWorkflowDetail(created.workflow.id);
    expect(withCandidate?.currentVersion?.id).toBe(officialVersionId);
    expect(candidate.source).toBe("agent_edit");
    expect(candidate.baseVersionId).toBe(officialVersionId);
    expect(candidate.note).toBe("Edit with an agent");

    const published = publishWorkflowVersion({
      workflowId: created.workflow.id,
      versionId: candidate.id,
    });

    expect(published.currentVersion?.id).toBe(candidate.id);
    expect(published.workflow.name).toBe("edited_workflow");
    expect(published.workflow.description).toBe("Edited workflow");
  });

  it("creates retry edit jobs without mutating the failed job", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const {
      createWorkflowEditJob,
      createWorkflowEditRetry,
      createWorkflowFromScript,
      failWorkflowEditJob,
      getWorkflowEditJob,
      updateWorkflowEditJobAgentSession,
    } = await import("./workflows");

    const created = createWorkflowFromScript(INITIAL_SCRIPT);
    const firstEdit = createWorkflowEditJob({
      workflowId: created.workflow.id,
      instruction: "Split the first step",
      agent: "local:codex",
      model: "default",
      cwd: "/tmp",
    });

    updateWorkflowEditJobAgentSession({
      editId: firstEdit.id,
      agentSessionId: "agent-session-1",
    });
    failWorkflowEditJob({
      editId: firstEdit.id,
      error: { message: "Agent failed" },
    });

    const retry = createWorkflowEditRetry(firstEdit.id);
    const failed = getWorkflowEditJob(firstEdit.id);

    expect(failed?.status).toBe("failed");
    expect(failed?.agentSessionId).toBe("agent-session-1");
    expect(retry.id).not.toBe(firstEdit.id);
    expect(retry.status).toBe("pending");
    expect(retry.workflowId).toBe(firstEdit.workflowId);
    expect(retry.baseVersionId).toBe(firstEdit.baseVersionId);
    expect(retry.instruction).toBe(firstEdit.instruction);
    expect(retry.agent).toBe(firstEdit.agent);
    expect(retry.model).toBe(firstEdit.model);
    expect(retry.cwd).toBe(firstEdit.cwd);
  });

  it("marks non-active running edit jobs stale for retry", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const {
      createWorkflowEditJob,
      createWorkflowFromScript,
      markWorkflowEditJobRunning,
    } = await import("./workflows");
    const { ensureWorkflowEditStarted } = await import("@/lib/workflow/edit-jobs");

    const created = createWorkflowFromScript(INITIAL_SCRIPT);
    const edit = createWorkflowEditJob({
      workflowId: created.workflow.id,
      instruction: "Split the first step",
      agent: "local:codex",
    });
    markWorkflowEditJobRunning(edit.id);

    const reconciled = ensureWorkflowEditStarted(edit.id);

    expect(reconciled?.status).toBe("failed");
    expect(reconciled?.error?.code).toBe("WORKFLOW_EDIT_STALE");
    expect(reconciled?.error?.message).toBe(
      "Workflow edit runner was interrupted. Retry this edit.",
    );
  });

  it("persists workflow run checkpoints by run and node", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const {
      createWorkflowFromScript,
      createWorkflowRun,
      listWorkflowRunCheckpoints,
      upsertWorkflowRunCheckpoint,
    } = await import("./workflows");

    const created = createWorkflowFromScript(INITIAL_SCRIPT);
    const version = created.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = createWorkflowRun({
      workflowId: created.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      agent: "mock",
      cwd: process.cwd(),
      request: { inputs: {} },
    });

    upsertWorkflowRunCheckpoint({
      runId: run.id,
      nodeId: "loop",
      checkpoint: {
        nextIteration: 1,
        currentIteration: 1,
        currentStepOutputs: { draft: "one" },
        previousStepOutputs: { draft: "one" },
        iterations: [],
      },
    });
    upsertWorkflowRunCheckpoint({
      runId: run.id,
      nodeId: "loop",
      checkpoint: {
        nextIteration: 2,
        previousStepOutputs: { draft: "one", review: "PASS" },
        iterations: [
          {
            index: 1,
            outputs: { draft: "one", review: "PASS" },
            untilOutput: "PASS",
            untilMatched: true,
          },
        ],
      },
    });

    expect(listWorkflowRunCheckpoints(run.id)).toEqual([
      expect.objectContaining({
        runId: run.id,
        nodeId: "loop",
        checkpoint: {
          nextIteration: 2,
          previousStepOutputs: { draft: "one", review: "PASS" },
          iterations: [
            {
              index: 1,
              outputs: { draft: "one", review: "PASS" },
              untilOutput: "PASS",
              untilMatched: true,
            },
          ],
        },
      }),
    ]);
  });
});

describe("workflow repositories", () => {
  it("lists workflows with batched related data queries", async () => {
    initTestDataDir();

    const {
      createWorkflowFromScript,
      createWorkflowRun,
      listWorkflows,
      updateWorkflowRun,
    } = await import("./workflows");
    const { getDb } = await import("./client");

    for (const suffix of ["one", "two", "three"]) {
      const detail = createWorkflowFromScript(`
export const meta = { name: "workflow_${suffix}", description: "Workflow ${suffix}" }
const first = await agent({ id: "first", prompt: "first" })
`);
      const version = detail.currentVersion;
      if (!version) {
        throw new Error("version missing");
      }
      const olderRun = createWorkflowRun({
        workflowId: detail.workflow.id,
        workflowVersionId: version.id,
        executorKind: "mock",
        request: { inputs: {} },
      });
      updateWorkflowRun({ runId: olderRun.id, status: "completed" });
      createWorkflowRun({
        workflowId: detail.workflow.id,
        workflowVersionId: version.id,
        executorKind: "mock",
        request: { inputs: { suffix } },
      });
    }

    const database = getDb();
    const prepareSpy = vi.spyOn(database, "prepare");

    const items = listWorkflows();

    expect(items).toHaveLength(3);
    expect(items.every((item) => item.currentVersion)).toBe(true);
    expect(items.every((item) => item.runCount === 2)).toBe(true);
    expect(items.every((item) => item.latestRun?.status === "running")).toBe(
      true,
    );
    expect(prepareSpy).toHaveBeenCalledTimes(5);
  });

  it("updates workflow runs and returns the persisted record", async () => {
    initTestDataDir();

    const {
      createWorkflowFromScript,
      createWorkflowRun,
      getWorkflowRun,
      updateWorkflowRun,
    } = await import("./workflows");

    const detail = createWorkflowFromScript(INITIAL_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = createWorkflowRun({
      workflowId: detail.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      request: { inputs: {} },
    });

    const updated = updateWorkflowRun({
      runId: run.id,
      status: "completed",
      result: { outputs: { first: "done" } },
      finishedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(updated).toEqual(
      expect.objectContaining({
        id: run.id,
        status: "completed",
        result: { outputs: { first: "done" } },
        finishedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(getWorkflowRun(run.id)?.status).toBe("completed");
  });

  it("marks workflow runs running and interrupted", async () => {
    initTestDataDir();

    const {
      createWorkflowFromScript,
      createWorkflowRun,
      markWorkflowRunInterrupted,
      markWorkflowRunRunning,
    } = await import("./workflows");

    const detail = createWorkflowFromScript(INITIAL_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = createWorkflowRun({
      workflowId: detail.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      request: { inputs: {} },
    });

    const interrupted = markWorkflowRunInterrupted({
      runId: run.id,
      result: { error: "stale" },
    });
    expect(interrupted).toEqual(
      expect.objectContaining({
        status: "interrupted",
        result: { error: "stale" },
      }),
    );
    expect(interrupted?.finishedAt).toBeTruthy();

    const running = markWorkflowRunRunning({
      runId: run.id,
      result: { outputs: {} },
    });
    expect(running).toEqual(
      expect.objectContaining({
        status: "running",
        result: { outputs: {} },
        finishedAt: null,
      }),
    );
  });

  it("allows only one resume claim for a workflow run", async () => {
    initTestDataDir();

    const {
      claimWorkflowRunForResume,
      createWorkflowFromScript,
      createWorkflowRun,
      markWorkflowRunInterrupted,
    } = await import("./workflows");

    const detail = createWorkflowFromScript(INITIAL_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = createWorkflowRun({
      workflowId: detail.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      request: { inputs: {} },
    });
    markWorkflowRunInterrupted({ runId: run.id });

    const claims = await Promise.all([
      Promise.resolve(
        claimWorkflowRunForResume({
          workflowId: detail.workflow.id,
          runId: run.id,
        }),
      ),
      Promise.resolve(
        claimWorkflowRunForResume({
          workflowId: detail.workflow.id,
          runId: run.id,
        }),
      ),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter(Boolean)[0]?.run.status).toBe("running");
  });

  it("fails and resets workflow generations for retry", async () => {
    initTestDataDir();

    const {
      createPendingWorkflowGeneration,
      failWorkflowGeneration,
      markWorkflowGenerationRunning,
      resetWorkflowGenerationForRetry,
    } = await import("./workflows");

    const detail = createPendingWorkflowGeneration({
      prompt: "Build a workflow",
      agent: "local:codex",
    });
    const generation = detail.generation;
    if (!generation) {
      throw new Error("generation missing");
    }

    const running = markWorkflowGenerationRunning(generation.id);
    expect(running?.status).toBe("running");
    expect(running?.startedAt).toBeTruthy();

    const failed = failWorkflowGeneration({
      generationId: generation.id,
      error: { code: "GENERATION_FAILED", message: "Agent failed" },
    });
    expect(failed).toEqual(
      expect.objectContaining({
        status: "failed",
        error: { code: "GENERATION_FAILED", message: "Agent failed" },
      }),
    );
    expect(failed?.finishedAt).toBeTruthy();

    const reset = resetWorkflowGenerationForRetry(detail.workflow.id);
    expect(reset).toEqual(
      expect.objectContaining({
        status: "pending",
        generation: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      }),
    );
  });

  it("cancels workflow edit jobs", async () => {
    initTestDataDir();

    const {
      cancelWorkflowEditJob,
      createWorkflowEditJob,
      createWorkflowFromScript,
      markWorkflowEditJobRunning,
    } = await import("./workflows");

    const detail = createWorkflowFromScript(INITIAL_SCRIPT);
    const edit = createWorkflowEditJob({
      workflowId: detail.workflow.id,
      instruction: "Improve the first step",
    });
    markWorkflowEditJobRunning(edit.id);

    const canceled = cancelWorkflowEditJob({
      editId: edit.id,
      error: { code: "USER_CANCELED", message: "Stopped by user" },
    });

    expect(canceled).toEqual(
      expect.objectContaining({
        status: "canceled",
        error: { code: "USER_CANCELED", message: "Stopped by user" },
      }),
    );
    expect(canceled?.finishedAt).toBeTruthy();
  });

  it("deletes workflows and cascades database children", async () => {
    initTestDataDir();

    const {
      createWorkflowEditJob,
      createWorkflowFromScript,
      createWorkflowRun,
      createWorkflowVersion,
      deleteWorkflow,
      getWorkflowDetail,
      upsertWorkflowRunCheckpoint,
    } = await import("./workflows");
    const { getDb } = await import("./client");

    const detail = createWorkflowFromScript(INITIAL_SCRIPT);
    const version = detail.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    createWorkflowVersion({
      workflowId: detail.workflow.id,
      script: EDITED_SCRIPT,
      publish: false,
    });
    createWorkflowEditJob({
      workflowId: detail.workflow.id,
      instruction: "Improve the first step",
    });
    const run = createWorkflowRun({
      workflowId: detail.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      request: { inputs: {} },
    });
    upsertWorkflowRunCheckpoint({
      runId: run.id,
      nodeId: "loop",
      checkpoint: {
        nextIteration: 1,
        previousStepOutputs: {},
        iterations: [],
      },
    });

    expect(deleteWorkflow(detail.workflow.id)).toBe(true);
    expect(getWorkflowDetail(detail.workflow.id)).toBeNull();

    const database = getDb();
    for (const table of [
      "workflow_versions",
      "workflow_runs",
      "workflow_edit_jobs",
    ]) {
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workflow_id = ?`)
          .get(detail.workflow.id),
      ).toEqual({ count: 0 });
    }
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_run_checkpoints WHERE run_id = ?",
        )
        .get(run.id),
    ).toEqual({ count: 0 });
  });
});
