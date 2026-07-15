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
      getWorkflowDetail,
    } = await import("./workflows/workflow-repository");
    const {
      createWorkflowVersion,
      publishWorkflowVersion,
    } = await import("./workflows/versions");

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

  it("records blueprint source metadata when creating from a script", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { createWorkflowFromScript } = await import(
      "./workflows/workflow-repository"
    );

    const created = createWorkflowFromScript(INITIAL_SCRIPT, {
      source: "blueprint",
      note: "loop-primitive-rd-acceptance-test-v1",
    });

    expect(created.currentVersion).toEqual(
      expect.objectContaining({
        source: "blueprint",
        note: "loop-primitive-rd-acceptance-test-v1",
      }),
    );
  });

  it("creates retry edit jobs without mutating the failed job", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { createWorkflowFromScript } = await import(
      "./workflows/workflow-repository"
    );
    const {
      createWorkflowEditJob,
      createWorkflowEditRetry,
      failWorkflowEditJob,
      getWorkflowEditJob,
      updateWorkflowEditJobAgentSession,
    } = await import("./workflows/edit-jobs");

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

  it("leaves running edit jobs with a live session untouched", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { createWorkflowFromScript } = await import(
      "./workflows/workflow-repository"
    );
    const {
      createWorkflowEditJob,
      markWorkflowEditJobRunning,
      updateWorkflowEditJobAgentSession,
    } = await import("./workflows/edit-jobs");
    const { ensureWorkflowEditStarted } = await import("@/lib/workflow/edit-jobs");

    const created = createWorkflowFromScript(INITIAL_SCRIPT);
    const edit = createWorkflowEditJob({
      workflowId: created.workflow.id,
      instruction: "Split the first step",
      agent: "local:codex",
    });
    markWorkflowEditJobRunning(edit.id);
    updateWorkflowEditJobAgentSession({
      editId: edit.id,
      agentSessionId: "agent-session-decoupled",
    });

    // Decoupled authoring: the session converses in AgentGUI and submits
    // whenever ready, so a running edit with a session is a healthy resting
    // state, not a stale job.
    const reconciled = ensureWorkflowEditStarted(edit.id);

    expect(reconciled?.status).toBe("running");
    expect(reconciled?.agentSessionId).toBe("agent-session-decoupled");
    expect(reconciled?.error).toBeNull();
  });

  it("persists workflow run checkpoints by run and node", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
    process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
    vi.resetModules();

    const { createWorkflowFromScript } = await import(
      "./workflows/workflow-repository"
    );
    const {
      createWorkflowRun,
      listWorkflowRunCheckpoints,
      upsertWorkflowRunCheckpoint,
    } = await import("./workflows/runs");

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
      listWorkflows,
    } = await import("./workflows/workflow-repository");
    const {
      createWorkflowRun,
      updateWorkflowRun,
    } = await import("./workflows/runs");
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

    const { createWorkflowFromScript } = await import(
      "./workflows/workflow-repository"
    );
    const {
      createWorkflowRun,
      getWorkflowRun,
      updateWorkflowRun,
    } = await import("./workflows/runs");

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

    const { createWorkflowFromScript } = await import(
      "./workflows/workflow-repository"
    );
    const {
      createWorkflowRun,
      markWorkflowRunInterrupted,
      markWorkflowRunRunning,
    } = await import("./workflows/runs");

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

    const { createWorkflowFromScript } = await import(
      "./workflows/workflow-repository"
    );
    const {
      claimWorkflowRunForResume,
      createWorkflowRun,
      markWorkflowRunInterrupted,
    } = await import("./workflows/runs");

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
    } = await import("./workflows/generations");

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

    const { createWorkflowFromScript } = await import(
      "./workflows/workflow-repository"
    );
    const {
      cancelWorkflowEditJob,
      createWorkflowEditJob,
      markWorkflowEditJobRunning,
    } = await import("./workflows/edit-jobs");

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
      createWorkflowFromScript,
      deleteWorkflow,
      getWorkflowDetail,
    } = await import("./workflows/workflow-repository");
    const { createWorkflowEditJob } = await import("./workflows/edit-jobs");
    const { createWorkflowVersion } = await import("./workflows/versions");
    const {
      createWorkflowRun,
      upsertWorkflowRunCheckpoint,
    } = await import("./workflows/runs");
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

describe("workflow human tasks", () => {
  it("persists multiple tasks, resolves atomically, and cancels remaining tasks", async () => {
    initTestDataDir();
    const { createWorkflowFromScript } = await import(
      "./workflows/workflow-repository"
    );
    const { createWorkflowRun, getWorkflowRun } = await import("./workflows/runs");
    const {
      HumanTaskConflictError,
      cancelPendingWorkflowHumanTasks,
      countPendingWorkflowHumanTasks,
      createOrGetWorkflowHumanTask,
      listWorkflowHumanTasks,
      resolveWorkflowHumanTask,
    } = await import("./workflows/human-tasks");
    const created = createWorkflowFromScript(INITIAL_SCRIPT);
    const version = created.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = createWorkflowRun({
      workflowId: created.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      request: { inputs: {} },
    });
    const request = (nodeId: string) => ({
      runId: run.id,
      nodeId,
      executionKey: `human:${nodeId}`,
      spec: {
        context: [{ label: "Draft", value: "text", display: "text" as const }],
        actions: [
          { id: "pass", label: "Pass", intent: "primary" as const, fields: [] },
          {
            id: "revise",
            label: "Revise",
            intent: "default" as const,
            fields: [{
              id: "comment",
              type: "textarea" as const,
              label: "Comment",
              required: true,
            }],
          },
        ],
      },
    });

    const first = createOrGetWorkflowHumanTask(request("first"));
    expect(createOrGetWorkflowHumanTask(request("first")).id).toBe(first.id);
    const second = createOrGetWorkflowHumanTask(request("second"));
    expect(countPendingWorkflowHumanTasks(run.id)).toBe(2);
    expect(getWorkflowRun(run.id)?.pendingHumanTaskCount).toBe(2);

    const resolved = resolveWorkflowHumanTask({
      runId: run.id,
      taskId: first.id,
      action: "revise",
      values: { comment: "fix it" },
      revision: first.revision,
    });
    expect(resolved).toEqual(expect.objectContaining({
      status: "resolved",
      response: { action: "revise", values: { comment: "fix it" } },
      revision: 2,
    }));
    expect(() => resolveWorkflowHumanTask({
      runId: run.id,
      taskId: first.id,
      action: "pass",
      values: {},
      revision: first.revision,
    })).toThrow(HumanTaskConflictError);
    expect(cancelPendingWorkflowHumanTasks(run.id)).toBe(1);
    expect(listWorkflowHumanTasks(run.id).map((task) => [task.id, task.status])).toEqual([
      [first.id, "resolved"],
      [second.id, "canceled"],
    ]);
  });

  it("does not commit waiting over a resolved task and rejects responses after cancel", async () => {
    initTestDataDir();
    const { createWorkflowFromScript } = await import(
      "./workflows/workflow-repository"
    );
    const {
      cancelWorkflowRunAndHumanTasks,
      createWorkflowRun,
      getWorkflowRun,
      markWorkflowRunWaitingOwned,
    } = await import("./workflows/runs");
    const {
      HumanTaskConflictError,
      createOrGetWorkflowHumanTask,
      getWorkflowHumanTask,
      resolveWorkflowHumanTask,
    } = await import("./workflows/human-tasks");
    const created = createWorkflowFromScript(INITIAL_SCRIPT);
    const version = created.currentVersion;
    if (!version) {
      throw new Error("version missing");
    }
    const run = createWorkflowRun({
      workflowId: created.workflow.id,
      workflowVersionId: version.id,
      executorKind: "mock",
      request: { inputs: {} },
      executionToken: "owner-token",
    });
    const createTask = (nodeId: string) => createOrGetWorkflowHumanTask({
      runId: run.id,
      nodeId,
      executionKey: `human:${nodeId}`,
      spec: {
        context: [],
        actions: [{ id: "pass", label: "Pass", intent: "primary", fields: [] }],
      },
    });
    const first = createTask("first");
    const second = createTask("second");
    resolveWorkflowHumanTask({
      runId: run.id,
      taskId: first.id,
      action: "pass",
      values: {},
      revision: first.revision,
    });

    const waiting = markWorkflowRunWaitingOwned({
      runId: run.id,
      executionToken: "owner-token",
      result: { outputs: {}, nodeStatuses: {}, nodeSessions: {} },
      pendingTaskIds: [first.id, second.id],
    });
    expect(waiting.transitioned).toBe(false);
    expect(getWorkflowRun(run.id)?.status).toBe("running");

    const canceled = cancelWorkflowRunAndHumanTasks({
      runId: run.id,
      result: { outputs: {}, nodeStatuses: {}, nodeSessions: {} },
    });
    expect(canceled.transitioned).toBe(true);
    expect(canceled.run?.status).toBe("canceled");
    expect(getWorkflowHumanTask(second.id)?.status).toBe("canceled");
    expect(() => resolveWorkflowHumanTask({
      runId: run.id,
      taskId: second.id,
      action: "pass",
      values: {},
      revision: second.revision,
    })).toThrow(HumanTaskConflictError);
  });
});
