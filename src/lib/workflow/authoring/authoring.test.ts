import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const VALID_SCRIPT = `
export const meta = { name: "authored_workflow", description: "Authored workflow" }
const first = await agent({ id: "first", prompt: "first" })
`;

const INVALID_SCRIPT = `
export const meta = { name: "broken_workflow", description: "Broken workflow" }
const first = await agent({ id: "first", prompt: "uses {{undeclared_input}}" })
`;

const BASE_SCRIPT = `
export const meta = { name: "base_workflow", description: "Base workflow" }
const first = await agent({ id: "first", prompt: "first" })
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
  dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-authoring-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
}

describe("authoring workspace", () => {
  it("materializes the guide, skills, and current script", async () => {
    initTestDataDir();
    const { prepareAuthoringWorkspace, getAuthoringWorkspaceDir } = await import(
      "./workspace"
    );

    const workspace = prepareAuthoringWorkspace({
      jobId: "job-1",
      currentScript: BASE_SCRIPT,
    });

    expect(workspace.dir).toBe(getAuthoringWorkspaceDir("job-1"));
    expect(readFileSync(path.join(workspace.dir, "AGENTS.md"), "utf8")).toContain(
      "authoring submit",
    );
    expect(readFileSync(path.join(workspace.dir, "CLAUDE.md"), "utf8")).toContain(
      "Delivery protocol",
    );
    const expectedContents: Record<string, string> = {
      "SKILL.md": "name: workflow-authoring",
      "dsl-reference.md": "# Workflow Script DSL Reference",
      "patterns.md": "# Workflow Design Patterns",
      "blueprint-guide.md": "# Blueprint Guide",
    };
    for (const root of ["skills", ".claude/skills", ".codex/skills"]) {
      for (const [file, marker] of Object.entries(expectedContents)) {
        const filePath = path.join(
          workspace.dir,
          root,
          "workflow-authoring",
          file,
        );
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf8")).toContain(marker);
      }
      const materializedDsl = readFileSync(
        path.join(workspace.dir, root, "workflow-authoring", "dsl-reference.md"),
        "utf8",
      );
      expect(materializedDsl).toContain('firstIteration: { startAt: "<step id>" }');
      expect(materializedDsl).toContain(
        "its first execution is already a continuation and therefore uses `appendPrompt`",
      );
      expect(
        readFileSync(
          path.join(workspace.dir, root, "workflow-authoring", "patterns.md"),
          "utf8",
        ),
      ).toContain("## Semantic closure review");
      expect(
        readFileSync(
          path.join(workspace.dir, root, "workflow-authoring", "SKILL.md"),
          "utf8",
        ),
      ).toContain("Validate and start review");
    }
    expect(
      readFileSync(path.join(workspace.dir, "current.workflow.js"), "utf8"),
    ).toBe(BASE_SCRIPT);
  });

  it("rejects script files outside the workspace", async () => {
    initTestDataDir();
    const { prepareAuthoringWorkspace, resolveAuthoringScriptFile } = await import(
      "./workspace"
    );
    prepareAuthoringWorkspace({ jobId: "job-2" });

    const outside = path.join(dataDir!, "outside.workflow.js");
    writeFileSync(outside, VALID_SCRIPT);

    expect(() =>
      resolveAuthoringScriptFile({ jobId: "job-2", file: outside }),
    ).toThrowError(/inside the authoring workspace/);
    expect(() =>
      resolveAuthoringScriptFile({
        jobId: "job-2",
        file: "../../outside.workflow.js",
      }),
    ).toThrowError(/inside the authoring workspace/);
  });
});

describe("authoring submit", () => {
  it("completes a generation job with a valid script", async () => {
    initTestDataDir();
    const { createPendingWorkflowGeneration, getWorkflowGeneration } =
      await import("@/lib/db/workflows/generations");
    const { prepareAuthoringWorkspace } = await import("./workspace");
    const { submitAuthoringScript } = await import("./submit");
    const { getWorkflowDetail } = await import(
      "@/lib/db/workflows/workflow-repository"
    );

    const pending = createPendingWorkflowGeneration({ prompt: "Make a workflow" });
    const generationId = pending.generation!.id;
    const workspace = prepareAuthoringWorkspace({ jobId: generationId });
    writeFileSync(path.join(workspace.dir, "draft.workflow.js"), VALID_SCRIPT);

    const result = await submitAuthoringScript({
      jobId: generationId,
      file: "draft.workflow.js",
      skipSemanticReview: true,
      reason: "Small test fixture.",
    });

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.jobType).toBe("generation");
      expect(result.workflowId).toBe(pending.workflow.id);
      expect(result.workflowName).toBe("authored_workflow");
    }
    expect(getWorkflowGeneration(generationId)?.status).toBe("completed");
    const detail = getWorkflowDetail(pending.workflow.id);
    expect(detail?.currentVersion?.script).toBe(VALID_SCRIPT);
    expect(detail?.currentVersion?.semanticReview?.status).toBe("waived");
    expect(detail?.workflow.name).toBe("authored_workflow");
  });

  it("returns diagnostics without completing on an invalid script", async () => {
    initTestDataDir();
    const { createPendingWorkflowGeneration, getWorkflowGeneration } =
      await import("@/lib/db/workflows/generations");
    const { submitAuthoringScript } = await import("./submit");

    const pending = createPendingWorkflowGeneration({ prompt: "Make a workflow" });
    const generationId = pending.generation!.id;

    const result = await submitAuthoringScript({
      jobId: generationId,
      script: INVALID_SCRIPT,
    });

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
    expect(getWorkflowGeneration(generationId)?.status).toBe("pending");
  });

  it("creates a draft version for an edit job", async () => {
    initTestDataDir();
    const { createWorkflowFromScript, getWorkflowDetail } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { createWorkflowEditJob, getWorkflowEditJob } = await import(
      "@/lib/db/workflows/edit-jobs"
    );
    const { submitAuthoringScript } = await import("./submit");

    const created = createWorkflowFromScript(BASE_SCRIPT);
    const edit = createWorkflowEditJob({
      workflowId: created.workflow.id,
      instruction: "Rename the workflow",
      agent: "local:codex",
    });

    const result = await submitAuthoringScript({
      jobId: edit.id,
      script: VALID_SCRIPT,
      skipSemanticReview: true,
      reason: "Small test fixture.",
    });

    expect(result.accepted).toBe(true);
    const completed = getWorkflowEditJob(edit.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.createdVersionId).toBeTruthy();

    // Edit produces an unpublished draft; the official version stays put.
    const detail = getWorkflowDetail(created.workflow.id);
    expect(detail?.currentVersion?.id).toBe(created.currentVersion?.id);
  });

  it("completes a mock generation through the job runner", async () => {
    initTestDataDir();
    const { createPendingWorkflowGeneration } = await import(
      "@/lib/db/workflows/generations"
    );
    const { ensureWorkflowGenerationStarted, waitForWorkflowGenerationLaunch } =
      await import("@/lib/workflow/generation-jobs");
    const { getWorkflowDetail } = await import(
      "@/lib/db/workflows/workflow-repository"
    );

    const pending = createPendingWorkflowGeneration({
      prompt: "Inspect the repo",
      agent: "mock",
    });
    ensureWorkflowGenerationStarted(pending.workflow.id);
    const generation = await waitForWorkflowGenerationLaunch(pending.workflow.id);

    expect(generation?.status).toBe("completed");
    expect(generation?.generation).toEqual({ source: "sample" });
    const detail = getWorkflowDetail(pending.workflow.id);
    expect(detail?.currentVersion?.script).toContain("Inspect the repo");
  });

  it("accepts repeated submits and saves a new version each time", async () => {
    initTestDataDir();
    const { createPendingWorkflowGeneration } = await import(
      "@/lib/db/workflows/generations"
    );
    const { submitAuthoringScript } = await import("./submit");
    const { getWorkflowDetail } = await import(
      "@/lib/db/workflows/workflow-repository"
    );

    const pending = createPendingWorkflowGeneration({ prompt: "Make a workflow" });
    const generationId = pending.generation!.id;
    await submitAuthoringScript({
      jobId: generationId,
      script: VALID_SCRIPT,
      skipSemanticReview: true,
      reason: "First test fixture.",
    });

    const revised = VALID_SCRIPT.replace(
      "Authored workflow",
      "Authored workflow v2",
    );
    const second = await submitAuthoringScript({
      jobId: generationId,
      script: revised,
      skipSemanticReview: true,
      reason: "Second test fixture.",
    });

    expect(second.accepted).toBe(true);
    const detail = getWorkflowDetail(pending.workflow.id);
    expect(detail?.currentVersion?.version).toBe(2);
    expect(detail?.workflow.description).toBe("Authored workflow v2");
  });

  it("rejects submits for failed or unknown jobs", async () => {
    initTestDataDir();
    const { createPendingWorkflowGeneration, failWorkflowGeneration } =
      await import("@/lib/db/workflows/generations");
    const { submitAuthoringScript, AuthoringSubmitError } = await import(
      "./submit"
    );

    const pending = createPendingWorkflowGeneration({ prompt: "Make a workflow" });
    const generationId = pending.generation!.id;
    failWorkflowGeneration({
      generationId,
      error: { message: "launch failed" },
    });

    await expect(
      submitAuthoringScript({ jobId: generationId, script: VALID_SCRIPT }),
    ).rejects.toBeInstanceOf(AuthoringSubmitError);
    await expect(
      submitAuthoringScript({ jobId: "missing-job", script: VALID_SCRIPT }),
    ).rejects.toThrowError(/No authoring job found/);
  });

  it("requires review by default and a reason for an explicit waiver", async () => {
    initTestDataDir();
    const { createPendingWorkflowGeneration } = await import(
      "@/lib/db/workflows/generations"
    );
    const { submitAuthoringScript } = await import("./submit");

    const pending = createPendingWorkflowGeneration({ prompt: "Make a workflow" });
    const jobId = pending.generation!.id;

    await expect(
      submitAuthoringScript({ jobId, script: VALID_SCRIPT }),
    ).rejects.toMatchObject({ code: "semantic_review_required" });
    await expect(
      submitAuthoringScript({
        jobId,
        script: VALID_SCRIPT,
        skipSemanticReview: true,
      }),
    ).rejects.toMatchObject({
      code: "semantic_review_waiver_reason_required",
    });
  });
});
