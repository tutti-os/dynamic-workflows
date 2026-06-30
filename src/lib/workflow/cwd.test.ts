import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveWorkflowCwd,
  resolveWorkflowCwdFrom,
  WorkflowCwdError,
} from "./cwd";

const previousRoot = process.env.DYNAMIC_WORKFLOWS_CWD_ROOT;
let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dw-cwd-"));
  fs.mkdirSync(path.join(tempRoot, "project", "packages"), {
    recursive: true,
  });
  process.env.DYNAMIC_WORKFLOWS_CWD_ROOT = tempRoot;
});

afterEach(() => {
  if (previousRoot === undefined) {
    delete process.env.DYNAMIC_WORKFLOWS_CWD_ROOT;
  } else {
    process.env.DYNAMIC_WORKFLOWS_CWD_ROOT = previousRoot;
  }
  fs.rmSync(tempRoot, { force: true, recursive: true });
});

describe("workflow cwd resolution", () => {
  it("resolves relative cwd from the configured root", () => {
    expect(resolveWorkflowCwd("project")).toBe(
      fs.realpathSync(path.join(tempRoot, "project")),
    );
  });

  it("resolves nested cwd relative to an effective base cwd", () => {
    const projectCwd = resolveWorkflowCwd("project");

    expect(resolveWorkflowCwdFrom(projectCwd, "packages")).toBe(
      fs.realpathSync(path.join(tempRoot, "project", "packages")),
    );
  });

  it("keeps cwd overrides inside the configured root", () => {
    const projectCwd = resolveWorkflowCwd("project");

    expect(() =>
      resolveWorkflowCwdFrom(projectCwd, path.dirname(tempRoot)),
    ).toThrow(WorkflowCwdError);
  });
});
