import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-authoring-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 authoring validation", () => {
  it("validates a Bundle directory without executing its modules", async () => {
    const { prepareAuthoringWorkspace } = await import("./workspace");
    const { validateAuthoringFlowBundle } = await import("./flow-bundle");
    const workspace = prepareAuthoringWorkspace({ jobId: "job-1" });
    const bundleDir = path.join(workspace.dir, "draft.flow");
    mkdirSync(path.join(bundleDir, "scripts"), { recursive: true });
    writeFileSync(
      path.join(bundleDir, "flow.js"),
      `
        globalThis.__authoringFlowExecuted = true;
        export const schemaVersion = "tutti.flow.v1";
        const scan = script({ id: "scan", file: "scripts/scan.mjs" });
        const done = completeCycle({ id: "done", inputs: { scan } });
      `,
    );
    writeFileSync(
      path.join(bundleDir, "scripts", "scan.mjs"),
      `
        globalThis.__authoringFlowExecuted = true;
        export async function run() { return {}; }
      `,
    );

    const result = validateAuthoringFlowBundle({ jobId: "job-1" });
    expect(result.valid).toBe(true);
    expect(result.bundle?.files.map((file) => file.path)).toEqual([
      "flow.js",
      "scripts/scan.mjs",
    ]);
    expect(
      (globalThis as Record<string, unknown>).__authoringFlowExecuted,
    ).toBeUndefined();
  });

  it("returns Bundle diagnostics and rejects directory symlinks", async () => {
    const {
      prepareAuthoringWorkspace,
      resolveAuthoringBundleDirectory,
    } = await import("./workspace");
    const { validateAuthoringFlowBundle } = await import("./flow-bundle");
    const workspace = prepareAuthoringWorkspace({ jobId: "job-2" });
    const invalidDir = path.join(workspace.dir, "invalid.flow");
    mkdirSync(invalidDir);
    writeFileSync(path.join(invalidDir, "unexpected.txt"), "no entry");

    const invalid = validateAuthoringFlowBundle({
      jobId: "job-2",
      directory: "invalid.flow",
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "bundle.path_unsupported",
        "bundle.entry_missing",
      ]),
    );

    symlinkSync(invalidDir, path.join(workspace.dir, "draft.flow"));
    expect(() =>
      resolveAuthoringBundleDirectory({ jobId: "job-2" }),
    ).toThrow(/must not be a symlink/u);
  });

  it("submits a validated Bundle into the generation Flow as a standalone Version", async () => {
    const { createPendingWorkflowGeneration } = await import(
      "@/lib/db/workflows/generations"
    );
    const { prepareAuthoringWorkspace } = await import("./workspace");
    const {
      submitAuthoringFlowBundle,
    } = await import("./flow-bundle");
    const { getFlowV1BundleForVersion } = await import(
      "@/lib/db/workflows/flow-bundles"
    );
    const { getWorkflowDetail } = await import(
      "@/lib/db/workflows/workflow-repository"
    );
    const { getWorkflowVersion } = await import(
      "@/lib/db/workflows/versions"
    );
    const {
      getFlowV1VersionReview,
      getLatestFlowV1DraftReview,
    } = await import(
      "@/lib/flow-v1/version-projection"
    );
    const { publishFlowV1Version } = await import(
      "@/lib/flow-v1/flow-service"
    );
    const pending = createPendingWorkflowGeneration({
      prompt: "Create a persistent maintenance Flow",
    });
    const jobId = pending.generation!.id;
    const workspace = prepareAuthoringWorkspace({ jobId });
    const bundleDir = path.join(workspace.dir, "draft.flow");
    mkdirSync(path.join(bundleDir, "scripts"), { recursive: true });
    writeFileSync(
      path.join(bundleDir, "flow.js"),
      `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = {
          name: "generated-flow",
          description: "Generated persistent Flow",
        };
        const scan = script({ id: "scan", file: "scripts/scan.mjs" });
        const done = completeCycle({ id: "done", inputs: { scan } });
      `,
    );
    writeFileSync(
      path.join(bundleDir, "scripts", "scan.mjs"),
      "export async function run() { return {}; }",
    );

    const submitted = await submitAuthoringFlowBundle({
      jobId,
      skipSemanticReview: true,
      reason: "Static Flow v1 review fixture",
    });

    expect(submitted).toMatchObject({
      accepted: true,
      workflowId: pending.workflow.id,
      version: 1,
      versionStatus: "draft",
      bundleHash: expect.any(String),
    });
    expect(getWorkflowDetail(pending.workflow.id)?.currentVersion).toBeNull();
    expect(getWorkflowVersion(submitted.versionId!)).toEqual(
      expect.objectContaining({
        status: "draft",
        publishedAt: null,
      }),
    );
    expect(
      getFlowV1BundleForVersion(submitted.versionId!)?.hash,
    ).toBe(submitted.bundleHash);
    expect(getLatestFlowV1DraftReview(pending.workflow.id)).toEqual(
      expect.objectContaining({
        version: expect.objectContaining({
          id: submitted.versionId,
          status: "draft",
        }),
        graph: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: "scan" }),
          ]),
        }),
      }),
    );

    writeFileSync(
      path.join(bundleDir, "scripts", "scan.mjs"),
      "export async function run() { return { revised: true }; }",
    );
    const revised = await submitAuthoringFlowBundle({
      jobId,
      skipSemanticReview: true,
      reason: "Second immutable authoring Version",
    });
    expect(revised).toEqual(
      expect.objectContaining({
        accepted: true,
        version: 2,
        versionStatus: "draft",
      }),
    );
    expect(getLatestFlowV1DraftReview(pending.workflow.id)).toEqual(
      expect.objectContaining({
        version: expect.objectContaining({ id: revised.versionId }),
        comparison: expect.objectContaining({
          baseVersion: expect.objectContaining({
            id: submitted.versionId,
          }),
          files: expect.arrayContaining([
            expect.objectContaining({
              path: "scripts/scan.mjs",
              status: "modified",
              lines: expect.arrayContaining([
                expect.objectContaining({ kind: "removed" }),
                expect.objectContaining({ kind: "added" }),
              ]),
            }),
          ]),
        }),
      }),
    );
    expect(
      getFlowV1VersionReview(
        pending.workflow.id,
        submitted.versionId,
      )?.version.version,
    ).toBe(1);

    publishFlowV1Version({
      flowId: pending.workflow.id,
      versionId: revised.versionId!,
      params: {},
    });
    expect(getLatestFlowV1DraftReview(pending.workflow.id)).toBeNull();
    expect(getWorkflowDetail(pending.workflow.id)?.currentVersion).toEqual(
      expect.objectContaining({
        id: revised.versionId,
        status: "published",
      }),
    );
  });
});
