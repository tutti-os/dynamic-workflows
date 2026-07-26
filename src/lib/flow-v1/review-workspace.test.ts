import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFlowV1ReviewWorkspace } from "./review-workspace";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Flow v1 review workspace", () => {
  it("snapshots tracked and untracked changes without leaking reviewer writes", async () => {
    const repository = mkdtempSync(path.join(tmpdir(), "flow-review-source-"));
    temporaryDirectories.push(repository);
    git(repository, "init", "-q");
    git(repository, "config", "user.name", "Flow Test");
    git(repository, "config", "user.email", "flow@example.test");
    writeFileSync(path.join(repository, "tracked.txt"), "base\n");
    git(repository, "add", "tracked.txt");
    git(repository, "commit", "-qm", "base");

    writeFileSync(path.join(repository, "tracked.txt"), "changed\n");
    writeFileSync(path.join(repository, "untracked.txt"), "new\n");

    const review = await createFlowV1ReviewWorkspace(repository);
    const reviewRoot = path.dirname(path.join(review.cwd, ".git"));
    expect(readFileSync(path.join(review.cwd, "tracked.txt"), "utf8")).toBe(
      "changed\n",
    );
    expect(readFileSync(path.join(review.cwd, "untracked.txt"), "utf8")).toBe(
      "new\n",
    );

    writeFileSync(path.join(review.cwd, "tracked.txt"), "reviewer write\n");
    expect(readFileSync(path.join(repository, "tracked.txt"), "utf8")).toBe(
      "changed\n",
    );

    await review.cleanup();
    expect(existsSync(reviewRoot)).toBe(false);
  });

  it("snapshots a dirty linked worktree used by delivery Flows", async () => {
    const repository = mkdtempSync(path.join(tmpdir(), "flow-review-main-"));
    const worktree = `${repository}-worktree`;
    temporaryDirectories.push(repository, worktree);
    git(repository, "init", "-q");
    git(repository, "config", "user.name", "Flow Test");
    git(repository, "config", "user.email", "flow@example.test");
    writeFileSync(path.join(repository, "tracked.txt"), "base\n");
    git(repository, "add", "tracked.txt");
    git(repository, "commit", "-qm", "base");
    git(repository, "worktree", "add", "-qb", "flow-review", worktree);
    writeFileSync(path.join(worktree, "tracked.txt"), "worktree change\n");

    const review = await createFlowV1ReviewWorkspace(worktree);
    expect(readFileSync(path.join(review.cwd, "tracked.txt"), "utf8")).toBe(
      "worktree change\n",
    );
    await review.cleanup();
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
}
