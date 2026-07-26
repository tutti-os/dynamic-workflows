import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-bundle-db-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 Bundle persistence", () => {
  it("stores and loads an immutable Bundle for a workflow version", async () => {
    const { createFlowV1 } = await import("@/lib/flow-v1/flow-service");
    const {
      getFlowV1BundleForVersion,
      saveFlowV1BundleForVersion,
    } = await import("./flow-bundles");
    const bundle = exampleBundle("one");
    const created = createFlowV1({ bundle });
    const versionId = created.versionId;

    expect(saveFlowV1BundleForVersion({ versionId, bundle })).toEqual(bundle);
    expect(saveFlowV1BundleForVersion({ versionId, bundle })).toEqual(bundle);
    expect(getFlowV1BundleForVersion(versionId)).toEqual(bundle);

    expect(() =>
      saveFlowV1BundleForVersion({
        versionId,
        bundle: exampleBundle("two"),
      }),
    ).toThrow(/different immutable Flow Bundle/u);
  });

  it("detects stored file corruption", async () => {
    const { createFlowV1 } = await import("@/lib/flow-v1/flow-service");
    const { getDb } = await import("../client");
    const {
      getFlowV1BundleForVersion,
      saveFlowV1BundleForVersion,
    } = await import("./flow-bundles");
    const bundle = exampleBundle("safe");
    const created = createFlowV1({ bundle });
    const versionId = created.versionId;

    getDb()
      .prepare(
        `
        UPDATE workflow_version_files
        SET content = ?
        WHERE version_id = ? AND path = ?
      `,
      )
      .run("tampered", versionId, "scripts/run.mjs");

    expect(() => getFlowV1BundleForVersion(versionId)).toThrow(
      /is corrupt/u,
    );
  });
});

function exampleBundle(label: string) {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        const run = script({ id: "run", file: "scripts/run.mjs" });
        const done = completeCycle({ id: "done", inputs: { run } });
      `,
    },
    {
      path: "scripts/run.mjs",
      content: `export async function run() { return { label: "${label}" }; }`,
    },
  ]);
}
