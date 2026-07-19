import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveWorkflowCwd,
  resolveWorkflowCwdFrom,
  WorkflowCwdError,
} from "./cwd";

const previousDataDir = process.env.TUTTI_APP_DATA_DIR;
const previousRuntimeDir = process.env.TUTTI_APP_RUNTIME_DIR;
let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dw-cwd-"));
  fs.mkdirSync(path.join(tempRoot, "data", "project", "packages"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tempRoot, "runtime", "project"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "external"), { recursive: true });
  process.env.TUTTI_APP_DATA_DIR = path.join(tempRoot, "data");
  process.env.TUTTI_APP_RUNTIME_DIR = path.join(tempRoot, "runtime");
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.TUTTI_APP_DATA_DIR;
  else process.env.TUTTI_APP_DATA_DIR = previousDataDir;
  if (previousRuntimeDir === undefined) delete process.env.TUTTI_APP_RUNTIME_DIR;
  else process.env.TUTTI_APP_RUNTIME_DIR = previousRuntimeDir;
  fs.rmSync(tempRoot, { force: true, recursive: true });
});

describe("workflow cwd resolution", () => {
  it("accepts app data/runtime directories and defaults to runtime", () => {
    expect(resolveWorkflowCwd(path.join(tempRoot, "data", "project"))).toBe(
      fs.realpathSync(path.join(tempRoot, "data", "project")),
    );
    expect(resolveWorkflowCwd(path.join(tempRoot, "runtime", "project"))).toBe(
      fs.realpathSync(path.join(tempRoot, "runtime", "project")),
    );
    expect(resolveWorkflowCwd()).toBe(fs.realpathSync(path.join(tempRoot, "runtime")));
  });

  it("resolves nested cwd relative to an effective base cwd", () => {
    const projectCwd = resolveWorkflowCwd(
      path.join(tempRoot, "data", "project"),
    );

    expect(resolveWorkflowCwdFrom(projectCwd, "packages")).toBe(
      fs.realpathSync(path.join(tempRoot, "data", "project", "packages")),
    );
  });

  it("rejects top-level and nested cwd escapes", () => {
    const projectCwd = path.join(tempRoot, "data", "project");

    expect(() => resolveWorkflowCwd(path.join(tempRoot, "external"))).toThrow(
      WorkflowCwdError,
    );
    expect(() =>
      resolveWorkflowCwdFrom(projectCwd, path.join(tempRoot, "external")),
    ).toThrow(WorkflowCwdError);
    expect(() => resolveWorkflowCwdFrom(projectCwd, "../../external")).toThrow(
      WorkflowCwdError,
    );
    expect(() => resolveWorkflowCwd("../external")).toThrow(WorkflowCwdError);
  });

  it("resolves a top-level relative cwd from the managed runtime directory", () => {
    expect(resolveWorkflowCwd("project")).toBe(
      fs.realpathSync(path.join(tempRoot, "runtime", "project")),
    );
  });

  it("rejects symlinks that resolve outside app data/runtime directories", () => {
    const link = path.join(tempRoot, "runtime", "external-link");
    fs.symlinkSync(path.join(tempRoot, "external"), link, "dir");

    expect(() => resolveWorkflowCwd(link)).toThrow(WorkflowCwdError);
    expect(() =>
      resolveWorkflowCwdFrom(path.join(tempRoot, "runtime"), "external-link"),
    ).toThrow(WorkflowCwdError);
  });

  it("fails closed when the managed app directory contract is incomplete", () => {
    delete process.env.TUTTI_APP_RUNTIME_DIR;

    expect(() => resolveWorkflowCwd()).toThrow(
      /TUTTI_APP_DATA_DIR and TUTTI_APP_RUNTIME_DIR are both required/,
    );
  });

  it("uses the process cwd only outside the managed app runtime", () => {
    delete process.env.TUTTI_APP_DATA_DIR;
    delete process.env.TUTTI_APP_RUNTIME_DIR;

    expect(resolveWorkflowCwd()).toBe(fs.realpathSync(process.cwd()));
    expect(() => resolveWorkflowCwd(path.dirname(process.cwd()))).toThrow(
      WorkflowCwdError,
    );
  });
});
