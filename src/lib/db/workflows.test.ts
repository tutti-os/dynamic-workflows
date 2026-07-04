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
  vi.resetModules();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
});

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
