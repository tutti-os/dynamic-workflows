import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let bundleDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-cli-test-"));
  bundleDir = path.join(dataDir, "fixture.flow");
  mkdirSync(path.join(bundleDir, "scripts"), { recursive: true });
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  writeFileSync(
    path.join(bundleDir, "flow.js"),
    `
      export const schemaVersion = "tutti.flow.v1";
      export const meta = {
        name: "CLI Flow",
        description: "Flow-only CLI fixture",
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
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

async function invoke(pathname: string, input: Record<string, unknown>) {
  const { handleDynamicWorkflowsCliRequest } = await import("./cli");
  const response = await handleDynamicWorkflowsCliRequest(
    pathname.split("/"),
    { input },
  );
  return response.json() as Promise<{
    kind: "json";
    value: Record<string, unknown>;
  }>;
}

describe("Flow-only dynamic workflows CLI", () => {
  it("validates, imports, shows, and starts a standalone Bundle", async () => {
    const validated = await invoke("validate", { directory: bundleDir });
    expect(validated.value).toEqual(
      expect.objectContaining({
        ok: true,
        valid: true,
        schemaVersion: "tutti.flow.v1",
      }),
    );

    const imported = await invoke("import", {
      directory: bundleDir,
      activate: true,
    });
    const flowId = (
      imported.value.flow as { flowId: string }
    ).flowId;
    expect(flowId).toEqual(expect.any(String));

    const shown = await invoke("show", {
      workflowId: flowId,
      includeScript: true,
    });
    expect(
      (
        shown.value.currentVersion as {
          bundle: { schemaVersion: string };
        }
      ).bundle.schemaVersion,
    ).toBe("tutti.flow.v1");

    const started = await invoke("run", { workflowId: flowId });
    expect(started.value.ok).toBe(true);
    expect(started.value.run).toEqual(
      expect.objectContaining({ status: "pending", tickSequence: 1 }),
    );
  });

  it("rejects single-script validate and import inputs", async () => {
    const validated = await invoke("validate", {
      script: "export const meta = {}",
    });
    expect(validated.value).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "invalid_input" }),
      }),
    );

    const imported = await invoke("import", {
      script: "export const meta = {}",
    });
    expect(imported.value).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "invalid_input" }),
      }),
    );
  });
});
