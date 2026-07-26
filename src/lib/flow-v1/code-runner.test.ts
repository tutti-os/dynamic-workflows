import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "./bundle";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-code-runner-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 CodeRunner", () => {
  it("runs a pinned JavaScript module with structured context and explicit Secrets", async () => {
    const runner = await import("./code-runner");
    const bundle = codeBundle([
      {
        path: "scripts/run.mjs",
        content: `
          export async function run(context) {
            console.log("running", context.path);
            console.error("token", process.env.FLOW_TEST_TOKEN);
            return {
              path: context.path,
              secretWasInjected: process.env.FLOW_TEST_TOKEN === "secret",
              inheritedNoise: process.env.UNRELATED_FLOW_TEST ?? null,
            };
          }
        `,
      },
    ]);
    process.env.UNRELATED_FLOW_TEST = "must-not-leak";

    const result = await runner.runFlowV1CodeModule({
      versionId: "version-js",
      bundle,
      file: "scripts/run.mjs",
      exportName: "run",
      context: { path: "src/large.ts" },
      secrets: { FLOW_TEST_TOKEN: "secret" },
    });

    expect(result.value).toEqual({
      path: "src/large.ts",
      secretWasInjected: true,
      inheritedNoise: null,
    });
    expect(result.stdout).toContain("running src/large.ts");
    expect(result.stderr).toContain("token [REDACTED]");
    expect(result.stderr).not.toContain("secret");
    delete process.env.UNRELATED_FLOW_TEST;
  });

  it("runs Bash through input/result file paths without shell interpolation", async () => {
    const runner = await import("./code-runner");
    const bundle = codeBundle([
      {
        path: "scripts/check.sh",
        content: `
          set -euo pipefail
          test -f "$TUTTI_FLOW_INPUT_PATH"
          printf '{"status":"waiting","reason":"not merged"}' > "$TUTTI_FLOW_RESULT_PATH"
          printf 'checked\\n'
        `,
      },
    ]);

    const result = await runner.runFlowV1CodeModule({
      versionId: "version-bash",
      bundle,
      file: "scripts/check.sh",
      exportName: "check",
      context: { pr: 42 },
    });
    expect(result.value).toEqual({
      status: "waiting",
      reason: "not merged",
    });
    expect(result.stdout).toBe("checked\n");
  });

  it("enforces timeout, cancellation, and combined output bounds", async () => {
    const runner = await import("./code-runner");
    const bundle = codeBundle([
      {
        path: "scripts/slow.mjs",
        content: `
          export async function run() {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            return {};
          }
        `,
      },
      {
        path: "scripts/noisy.sh",
        content: `
          yes x | head -c 10000
          printf '{}' > "$TUTTI_FLOW_RESULT_PATH"
        `,
      },
    ]);

    await expect(
      runner.runFlowV1CodeModule({
        versionId: "version-limits",
        bundle,
        file: "scripts/slow.mjs",
        exportName: "run",
        context: {},
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: "flow_runner_timeout" });

    const controller = new AbortController();
    const canceled = runner.runFlowV1CodeModule({
      versionId: "version-limits",
      bundle,
      file: "scripts/slow.mjs",
      exportName: "run",
      context: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(canceled).rejects.toMatchObject({
      code: "flow_runner_aborted",
    });

    await expect(
      runner.runFlowV1CodeModule({
        versionId: "version-limits",
        bundle,
        file: "scripts/noisy.sh",
        exportName: "run",
        context: {},
        maxOutputBytes: 128,
      }),
    ).rejects.toMatchObject({ code: "flow_runner_output_limit" });
  });

  it("rechecks a previously materialized Bundle before reusing it", async () => {
    const runner = await import("./code-runner");
    const bundle = codeBundle([
      {
        path: "scripts/run.mjs",
        content: "export async function run() { return {}; }",
      },
    ]);
    const directory = runner.prepareFlowV1ExecutionBundle({
      versionId: "version-corruption",
      bundle,
    });
    writeFileSync(
      path.join(directory, "scripts", "run.mjs"),
      "export async function run() { return { tampered: true }; }",
    );

    expect(() =>
      runner.prepareFlowV1ExecutionBundle({
        versionId: "version-corruption",
        bundle,
      }),
    ).toThrow(/does not match its immutable hash/u);
  });
});

function codeBundle(
  files: Array<{ path: string; content: string }>,
) {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: 'export const schemaVersion = "tutti.flow.v1";',
    },
    ...files,
  ]);
}
