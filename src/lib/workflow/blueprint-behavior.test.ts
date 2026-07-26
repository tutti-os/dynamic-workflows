import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runFlowV1CodeModule } from "@/lib/flow-v1/code-runner";
import { parseFlowV1Bundle } from "@/lib/flow-v1/parser";
import type { FlowV1JsonObject } from "@/lib/flow-v1/types";
import { getWorkflowBlueprint } from "./blueprint-catalog";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("official Blueprint behavior", () => {
  it("keeps delivery side effects and business terminal outcomes explicit", () => {
    for (const id of [
      "loop-primitive-rd-acceptance-test-v1",
      "rd-human-acceptance-delivery-v1",
      "repo-migration-sweep-v1",
    ]) {
      const blueprint = getWorkflowBlueprint(id);
      if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
        throw new Error(`Blueprint ${id} is unavailable.`);
      }
      const flow = parseFlowV1Bundle(blueprint.bundle);
      expect(flow.diagnostics, id).toEqual([]);
      expect(
        flow.nodes.filter((node) => node.kind === "effect").map((node) => node.id),
        id,
      ).toEqual(
        expect.arrayContaining([
          "prepare_workspace",
          "commit",
          "push",
          "create_pull_request",
        ]),
      );
      expect(
        flow.nodes
          .filter((node) => node.kind === "complete_cycle")
          .map((node) => node.terminalOutcome),
        id,
      ).toEqual(
        expect.arrayContaining([
          "accepted",
          "accepted_no_changes",
          "not_accepted",
        ]),
      );
    }
  });

  it("treats an empty large-file scan as a routable healthy outcome", async () => {
    const blueprint = getWorkflowBlueprint("large-file-governance-v1");
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("Large-file Blueprint is unavailable.");
    }
    const projectCwd = mkdtempSync(
      path.join(tmpdir(), "large-file-blueprint-"),
    );
    temporaryDirectories.push(projectCwd);
    git(["init"], projectCwd);
    git(["config", "user.name", "Flow Test"], projectCwd);
    git(["config", "user.email", "flow@example.test"], projectCwd);
    writeFileSync(path.join(projectCwd, "small.ts"), "export const ok = true;\n");
    writeFileSync(
      path.join(projectCwd, "at-threshold.ts"),
      `${Array.from(
        { length: 10 },
        (_, index) => `export const exact${index} = ${index};`,
      ).join("\n")}\n`,
    );
    git(["add", "small.ts", "at-threshold.ts"], projectCwd);
    git(["commit", "-m", "small"], projectCwd);
    const smallCommit = git(["rev-parse", "HEAD"], projectCwd);

    const empty = await runFlowV1CodeModule({
      versionId: "large-file-empty",
      bundle: blueprint.bundle,
      file: "scripts/find-large-file.mjs",
      exportName: "run",
      context: { threshold: 10, root: "", sync: { commit: smallCommit } },
      projectCwd,
    });
    expect(empty.value).toEqual({
      outcome: "empty",
      output: {
        reason: "No source file exceeds the configured threshold.",
      },
    });

    writeFileSync(
      path.join(projectCwd, "large.ts"),
      Array.from({ length: 12 }, (_, index) => `export const v${index} = ${index};`).join(
        "\n",
      ),
    );
    writeFileSync(
      path.join(projectCwd, "larger.test.ts"),
      Array.from(
        { length: 20 },
        (_, index) => `export const test${index} = ${index};`,
      ).join("\n"),
    );
    mkdirSync(path.join(projectCwd, "generated"));
    writeFileSync(
      path.join(projectCwd, "generated", "largest.ts"),
      Array.from(
        { length: 30 },
        (_, index) => `export const generated${index} = ${index};`,
      ).join("\n"),
    );
    git(
      ["add", "large.ts", "larger.test.ts", "generated/largest.ts"],
      projectCwd,
    );
    git(["commit", "-m", "large"], projectCwd);
    const largeCommit = git(["rev-parse", "HEAD"], projectCwd);
    const found = await runFlowV1CodeModule({
      versionId: "large-file-found",
      bundle: blueprint.bundle,
      file: "scripts/find-large-file.mjs",
      exportName: "run",
      context: { threshold: 10, root: "", sync: { commit: largeCommit } },
      projectCwd,
    });
    expect(found.value).toEqual({
      outcome: "found",
      output: { path: "large.ts", lines: 12 },
    });
  });

  it("reconciles commit and push delivery effects independently", async () => {
    const blueprint = getWorkflowBlueprint(
      "loop-primitive-rd-acceptance-test-v1",
    );
    expect(blueprint?.schemaVersion).toBe("tutti.flow.v1");
    if (!blueprint || blueprint.schemaVersion !== "tutti.flow.v1") {
      throw new Error("RD delivery Blueprint is unavailable.");
    }
    const root = mkdtempSync(path.join(tmpdir(), "delivery-effects-"));
    temporaryDirectories.push(root);
    const remote = path.join(root, "remote.git");
    const projectCwd = path.join(root, "project");
    git(["init", "--bare", remote], root);
    git(["init", projectCwd], root);
    git(["config", "user.name", "Flow Test"], projectCwd);
    git(["config", "user.email", "flow@example.test"], projectCwd);
    writeFileSync(path.join(projectCwd, "README.md"), "initial\n");
    git(["add", "README.md"], projectCwd);
    git(["commit", "-m", "initial"], projectCwd);
    git(["branch", "-M", "main"], projectCwd);
    git(["remote", "add", "origin", remote], projectCwd);
    git(["push", "-u", "origin", "main"], projectCwd);

    const cycle = { id: "cycle-delivery-test", sequence: 7 };
    const prepared = await runFlowV1CodeModule({
      versionId: "delivery-workspace",
      bundle: blueprint.bundle,
      file: "scripts/prepare-delivery-workspace.mjs",
      exportName: "apply",
      context: { cycle, targetBranch: "main" },
      projectCwd,
    });
    const workspace = readOutputObject(prepared.value);
    writeFileSync(path.join(String(workspace.path), "change.txt"), "changed\n");

    const committed = await runFlowV1CodeModule({
      versionId: "delivery-commit",
      bundle: blueprint.bundle,
      file: "scripts/commit-delivery.mjs",
      exportName: "apply",
      context: { cycle, title: "test: delivery", workspace },
      projectCwd: String(workspace.path),
    });
    const commit = readOutputObject(committed.value);
    const reconciledCommit = await runFlowV1CodeModule({
      versionId: "delivery-commit-reconcile",
      bundle: blueprint.bundle,
      file: "scripts/commit-delivery.mjs",
      exportName: "reconcile",
      context: { cycle, title: "test: delivery", workspace },
      projectCwd: String(workspace.path),
    });
    expect(reconciledCommit.value).toMatchObject({
      status: "completed",
      output: { sha: commit.sha },
    });

    const pushed = await runFlowV1CodeModule({
      versionId: "delivery-push",
      bundle: blueprint.bundle,
      file: "scripts/push-delivery.mjs",
      exportName: "apply",
      context: { cycle, commit, workspace },
      projectCwd: String(workspace.path),
    });
    const push = readOutputObject(pushed.value);
    const reconciledPush = await runFlowV1CodeModule({
      versionId: "delivery-push-reconcile",
      bundle: blueprint.bundle,
      file: "scripts/push-delivery.mjs",
      exportName: "reconcile",
      context: { cycle, commit, workspace },
      projectCwd: String(workspace.path),
    });
    expect(reconciledPush.value).toMatchObject({
      status: "completed",
      output: { branch: push.branch, sha: commit.sha },
    });
  });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readOutputObject(
  value: Awaited<ReturnType<typeof runFlowV1CodeModule>>["value"],
): FlowV1JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.output !== "object" ||
    value.output === null ||
    Array.isArray(value.output)
  ) {
    throw new Error("Expected a code-module result with an object output.");
  }
  return value.output;
}
