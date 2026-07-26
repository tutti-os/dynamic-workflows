import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlowV1BundleError,
  createFlowV1Bundle,
  materializeFlowV1Bundle,
  readFlowV1BundleDirectory,
  validateFlowV1BundleFiles,
} from "./bundle";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("flow v1 bundle", () => {
  it("computes a deterministic content hash independent of input order", () => {
    const first = createFlowV1Bundle([
      { path: "flow.js", content: 'export const schemaVersion = "tutti.flow.v1";' },
      { path: "scripts/check.mjs", content: "export async function run() {}" },
    ]);
    const second = createFlowV1Bundle([...first.files].reverse());

    expect(second.hash).toBe(first.hash);
    expect(second.files.map((file) => file.path)).toEqual([
      "flow.js",
      "scripts/check.mjs",
    ]);
  });

  it("rejects missing entries, path escapes, duplicates, and package files", () => {
    const diagnostics = validateFlowV1BundleFiles([
      { path: "../flow.js", content: "" },
      { path: "scripts/a.mjs", content: "" },
      { path: "scripts/a.mjs", content: "" },
      { path: "scripts/package.json", content: "{}" },
    ]);

    expect(diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "bundle.path_escape",
        "bundle.path_duplicate",
        "bundle.path_unsupported",
        "bundle.entry_missing",
      ]),
    );
  });

  it("round-trips a directory and materializes immutable files", () => {
    const source = tempDir("flow-bundle-source-");
    mkdirSync(path.join(source, "scripts"), { recursive: true });
    writeFileSync(
      path.join(source, "flow.js"),
      'export const schemaVersion = "tutti.flow.v1";',
    );
    writeFileSync(
      path.join(source, "scripts", "scan.mjs"),
      "export async function run() { return {}; }",
    );

    const bundle = readFlowV1BundleDirectory(source);
    const destination = tempDir("flow-bundle-output-");
    materializeFlowV1Bundle(bundle, destination);

    expect(readFileSync(path.join(destination, "flow.js"), "utf8")).toContain(
      "tutti.flow.v1",
    );
    expect(
      readFileSync(path.join(destination, "scripts", "scan.mjs"), "utf8"),
    ).toContain("function run");
    expect(() => materializeFlowV1Bundle(bundle, destination)).toThrow();
  });

  it("does not materialize through a pre-existing directory symlink", () => {
    const outside = tempDir("flow-bundle-materialize-outside-");
    const destination = tempDir("flow-bundle-materialize-target-");
    symlinkSync(outside, path.join(destination, "scripts"));
    const bundle = createFlowV1Bundle([
      {
        path: "flow.js",
        content: 'export const schemaVersion = "tutti.flow.v1";',
      },
      {
        path: "scripts/run.mjs",
        content: "export async function run() {}",
      },
    ]);

    expect(() => materializeFlowV1Bundle(bundle, destination)).toThrow(
      FlowV1BundleError,
    );
    expect(() =>
      readFileSync(path.join(outside, "run.mjs"), "utf8"),
    ).toThrow();
  });

  it("rejects symlinks while reading an authoring directory", () => {
    const source = tempDir("flow-bundle-symlink-");
    const outside = tempDir("flow-bundle-outside-");
    writeFileSync(
      path.join(source, "flow.js"),
      'export const schemaVersion = "tutti.flow.v1";',
    );
    writeFileSync(path.join(outside, "secret.mjs"), "secret");
    mkdirSync(path.join(source, "scripts"));
    symlinkSync(
      path.join(outside, "secret.mjs"),
      path.join(source, "scripts", "secret.mjs"),
    );

    expect(() => readFlowV1BundleDirectory(source)).toThrow(
      FlowV1BundleError,
    );
  });
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
