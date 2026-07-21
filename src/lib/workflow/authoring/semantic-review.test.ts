import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  conversation: [
    { role: "user" as const, text: "Build the requested workflow", version: 1 },
    { role: "assistant" as const, text: "I will draft it", version: 2 },
    { role: "user" as const, text: "The reviewer must be independent", version: 3 },
    { role: "assistant" as const, text: "uncommitted author progress", version: 4 },
  ],
  output: {
    verdict: "pass",
    summary: "The graph closes.",
    findings: [],
  } as unknown,
  runInputs: [] as Array<Record<string, unknown>>,
  reviewGate: undefined as Promise<void> | undefined,
}));

vi.mock("@/lib/agents/runtime", () => ({
  getAgentSessionConversation: vi.fn(async () => runtime.conversation),
  listAgentTargets: vi.fn(async () => [
    {
      id: "local:codex",
      name: "Codex",
      provider: "codex",
      supported: true,
      models: ["test-model"],
      permissionModes: [
        { id: "read-only", label: "Read only", semantic: "read-only" },
      ],
    },
  ]),
  cancelAgentRun: vi.fn(async () => undefined),
  runAgent: vi.fn((input: Record<string, unknown>) => {
    runtime.runInputs.push(input);
    return (async function* () {
      yield {
        type: "session_ref" as const,
        session: {
          agentSessionId: "reviewer-session",
          agent: "local:codex",
        },
      };
      if (runtime.reviewGate) {
        await runtime.reviewGate;
      }
      yield { type: "text_delta" as const, text: JSON.stringify(runtime.output) };
      yield { type: "done" as const, status: "completed" as const };
    })();
  }),
}));

const VALID_SCRIPT = `
export const meta = { name: "reviewed", description: "Reviewed workflow" }
const first = await agent({ id: "first", prompt: "Do the work" })
`;

const INVALID_SCRIPT = `
export const meta = { name: "broken", description: "Broken workflow" }
const first = await agent({ id: "first", prompt: "Uses {{missing}}" })
`;

let dataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-review-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  runtime.runInputs.length = 0;
  runtime.reviewGate = undefined;
  runtime.output = {
    verdict: "pass",
    summary: "The graph closes.",
    findings: [],
  };
  runtime.conversation = [
    { role: "user", text: "Build the requested workflow", version: 1 },
    { role: "assistant", text: "I will draft it", version: 2 },
    { role: "user", text: "The reviewer must be independent", version: 3 },
    { role: "assistant", text: "uncommitted author progress", version: 4 },
  ];
  vi.resetModules();
});

afterEach(() => {
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
});

async function createReviewJob() {
  const { createPendingWorkflowGeneration, updateWorkflowGenerationAgentSession } =
    await import("@/lib/db/workflows/generations");
  const { prepareAuthoringWorkspace } = await import("./workspace");
  const pending = createPendingWorkflowGeneration({
    prompt: "Build the requested workflow",
    agent: "local:codex",
    model: "test-model",
  });
  const jobId = pending.generation!.id;
  updateWorkflowGenerationAgentSession({
    generationId: jobId,
    agentSessionId: "author-session",
  });
  const workspace = prepareAuthoringWorkspace({ jobId });
  writeFileSync(path.join(workspace.dir, "draft.workflow.js"), VALID_SCRIPT);
  return { jobId, workspace };
}

describe("authoring semantic review", () => {
  it("starts one independent read-only review and submits its matching PASS", async () => {
    const { jobId } = await createReviewJob();
    const { validateAuthoringScript, submitAuthoringScript } = await import("./submit");
    const { waitForAuthoringSemanticReview } = await import("./semantic-review");
    const { getWorkflowDetail } = await import(
      "@/lib/db/workflows/workflow-repository"
    );

    const validation = await validateAuthoringScript({
      jobId,
      file: "draft.workflow.js",
      reviewMode: "agent",
    });
    expect(validation.valid).toBe(true);
    expect(validation.review?.status).toBe("running");

    const review = await waitForAuthoringSemanticReview(jobId);
    expect(review?.status).toBe("passed");
    expect(review?.reviewerSessionId).toBe("reviewer-session");
    expect(runtime.runInputs).toHaveLength(1);
    expect(runtime.runInputs[0]).toMatchObject({
      agent: "local:codex",
      permissionMode: "read-only",
    });
    expect(runtime.runInputs[0]).not.toHaveProperty("resumeSessionId");
    expect(String(runtime.runInputs[0].prompt)).toContain(
      "The reviewer must be independent",
    );
    expect(String(runtime.runInputs[0].prompt)).not.toContain(
      "uncommitted author progress",
    );

    const submitted = await submitAuthoringScript({
      jobId,
      file: "draft.workflow.js",
    });
    expect(submitted.accepted).toBe(true);
    if (submitted.accepted) {
      expect(
        getWorkflowDetail(submitted.workflowId)?.currentVersion?.semanticReview
          ?.status,
      ).toBe("passed");
    }
    expect(runtime.runInputs).toHaveLength(1);
  });

  it("does not start a reviewer when DSL validation fails", async () => {
    const { jobId, workspace } = await createReviewJob();
    writeFileSync(path.join(workspace.dir, "draft.workflow.js"), INVALID_SCRIPT);
    const { validateAuthoringScript } = await import("./submit");

    const result = await validateAuthoringScript({
      jobId,
      file: "draft.workflow.js",
      reviewMode: "agent",
    });

    expect(result.valid).toBe(false);
    expect(runtime.runInputs).toHaveLength(0);
  });

  it("stales a PASS on a new user message but not assistant progress", async () => {
    const { jobId } = await createReviewJob();
    const { validateAuthoringScript } = await import("./submit");
    const {
      refreshAuthoringSemanticReview,
      waitForAuthoringSemanticReview,
    } = await import("./semantic-review");

    await validateAuthoringScript({
      jobId,
      file: "draft.workflow.js",
      reviewMode: "agent",
    });
    await waitForAuthoringSemanticReview(jobId);

    runtime.conversation.push({
      role: "assistant",
      text: "more author progress",
      version: 5,
    });
    expect((await refreshAuthoringSemanticReview(jobId))?.status).toBe("passed");

    runtime.conversation.push({
      role: "user",
      text: "Also require a Human approval gate",
      version: 6,
    });
    expect((await refreshAuthoringSemanticReview(jobId))?.status).toBe("stale");
  });

  it("stales the prior review when the validated script changes", async () => {
    const { jobId, workspace } = await createReviewJob();
    const { validateAuthoringScript } = await import("./submit");
    const { waitForAuthoringSemanticReview } = await import("./semantic-review");
    await validateAuthoringScript({
      jobId,
      file: "draft.workflow.js",
      reviewMode: "agent",
    });
    await waitForAuthoringSemanticReview(jobId);

    writeFileSync(
      path.join(workspace.dir, "draft.workflow.js"),
      VALID_SCRIPT.replace("Do the work", "Do the revised work"),
    );
    const validation = await validateAuthoringScript({
      jobId,
      file: "draft.workflow.js",
      reviewMode: "none",
    });
    expect(validation.review?.status).toBe("stale");
    expect(runtime.runInputs).toHaveLength(1);
  });

  it("reuses one running reviewer for the same intent and script", async () => {
    const { jobId } = await createReviewJob();
    let releaseReview!: () => void;
    runtime.reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const { validateAuthoringScript } = await import("./submit");
    const { waitForAuthoringSemanticReview } = await import("./semantic-review");

    const first = await validateAuthoringScript({
      jobId,
      file: "draft.workflow.js",
      reviewMode: "agent",
    });
    const second = await validateAuthoringScript({
      jobId,
      file: "draft.workflow.js",
      reviewMode: "agent",
    });

    expect(first.review?.reviewId).toBe(second.review?.reviewId);
    expect(runtime.runInputs).toHaveLength(1);
    releaseReview();
    expect((await waitForAuthoringSemanticReview(jobId))?.status).toBe("passed");
  });

  it("turns an orphaned running review into unavailable instead of waiting forever", async () => {
    const { jobId } = await createReviewJob();
    let releaseReview!: () => void;
    runtime.reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const { validateAuthoringScript } = await import("./submit");
    const { waitForAuthoringSemanticReview: waitForOriginalReview } =
      await import("./semantic-review");
    await validateAuthoringScript({
      jobId,
      file: "draft.workflow.js",
      reviewMode: "agent",
    });

    // A fresh module instance models a coordinator restart: persisted state
    // remains, but the in-memory execution registry is gone.
    vi.resetModules();
    const { refreshAuthoringSemanticReview } = await import("./semantic-review");
    const review = await refreshAuthoringSemanticReview(jobId);

    expect(review?.status).toBe("unavailable");
    expect(review?.error).toContain("lost the reviewer execution handle");
    releaseReview();
    await waitForOriginalReview(jobId);
  });
});
