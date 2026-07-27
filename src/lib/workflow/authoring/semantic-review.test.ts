import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  output: {
    verdict: "pass",
    summary: "The Flow graph closes.",
    findings: [],
  },
  runInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/agents/runtime", () => ({
  getAgentSessionConversation: vi.fn(async () => [
    { role: "user", text: "Build the requested Flow", version: 1 },
  ]),
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
      yield {
        type: "text_delta" as const,
        text: JSON.stringify(runtime.output),
      };
      yield { type: "done" as const, status: "completed" as const };
    })();
  }),
}));

let dataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-review-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  runtime.runInputs.length = 0;
  vi.resetModules();
});

afterEach(() => {
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
});

describe("Flow Bundle semantic review", () => {
  it("binds an independent PASS to the exact Bundle persisted on the Version", async () => {
    const {
      createPendingWorkflowGeneration,
      updateWorkflowGenerationAgentSession,
    } = await import("@/lib/db/workflows/generations");
    const { prepareAuthoringWorkspace } = await import("./workspace");
    const pending = createPendingWorkflowGeneration({
      prompt: "Build the requested Flow",
      agent: "local:codex",
      model: "test-model",
    });
    const jobId = pending.generation!.id;
    updateWorkflowGenerationAgentSession({
      generationId: jobId,
      agentSessionId: "author-session",
    });
    const workspace = prepareAuthoringWorkspace({ jobId });
    const bundleDir = path.join(workspace.dir, "draft.flow");
    mkdirSync(path.join(bundleDir, "scripts"), { recursive: true });
    writeFileSync(
      path.join(bundleDir, "flow.js"),
      `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = {
          name: "reviewed-flow",
          description: "Reviewed persistent Flow",
        };
        const inspect = script({
          id: "inspect",
          file: "scripts/inspect.mjs",
        });
        completeCycle({ id: "done", inputs: { inspect } });
      `,
    );
    writeFileSync(
      path.join(bundleDir, "scripts", "inspect.mjs"),
      "export async function run() { return { ok: true }; }",
    );
    const {
      submitAuthoringFlowBundle,
      validateAuthoringFlowBundleWithReview,
    } = await import("./flow-bundle");
    const { waitForAuthoringSemanticReview } = await import(
      "./semantic-review"
    );
    const { getWorkflowVersion } = await import(
      "@/lib/db/workflows/versions"
    );

    const validation = await validateAuthoringFlowBundleWithReview({
      jobId,
      reviewMode: "agent",
    });
    expect(validation.valid).toBe(true);
    expect(validation.review?.status).toBe("running");
    expect(runtime.runInputs[0]?.prompt).toContain("当前 FLOW BUNDLE：");
    expect(runtime.runInputs[0]?.prompt).toContain(
      "===== scripts/inspect.mjs =====",
    );
    expect((await waitForAuthoringSemanticReview(jobId))?.status).toBe(
      "passed",
    );

    const submitted = await submitAuthoringFlowBundle({ jobId });

    expect(submitted.accepted).toBe(true);
    expect(getWorkflowVersion(submitted.versionId!)?.semanticReview).toEqual(
      expect.objectContaining({ status: "passed" }),
    );
  });
});
