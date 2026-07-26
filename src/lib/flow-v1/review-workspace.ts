import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export type FlowV1ReviewWorkspace = {
  cwd: string;
  cleanup: () => Promise<void>;
};

export async function createFlowV1ReviewWorkspace(
  sourceCwd: string,
): Promise<FlowV1ReviewWorkspace> {
  const resolvedSource = await realpath(path.resolve(sourceCwd));
  const repositoryRoot = await realpath((
    await runGit(resolvedSource, ["rev-parse", "--show-toplevel"])
  )
    .toString("utf8")
    .trim());
  const relativeCwd = path.relative(repositoryRoot, resolvedSource);
  if (
    relativeCwd === ".." ||
    relativeCwd.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCwd)
  ) {
    throw new Error(
      `Review workspace source ${resolvedSource} is outside its Git repository.`,
    );
  }

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "tutti-flow-review-"),
  );
  const snapshotRoot = path.join(temporaryRoot, "workspace");
  try {
    await runCommand("git", [
      "clone",
      "--quiet",
      "--no-hardlinks",
      "--no-checkout",
      repositoryRoot,
      snapshotRoot,
    ]);
    const head = (
      await runGit(repositoryRoot, ["rev-parse", "HEAD"])
    )
      .toString("utf8")
      .trim();
    await runGit(snapshotRoot, ["checkout", "--quiet", "--detach", head]);

    const trackedChanges = await runGit(repositoryRoot, [
      "diff",
      "--binary",
      "HEAD",
      "--",
    ]);
    if (trackedChanges.length > 0) {
      await runGit(
        snapshotRoot,
        ["apply", "--binary", "--whitespace=nowarn", "-"],
        trackedChanges,
      );
    }

    const untracked = (
      await runGit(repositoryRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    for (const relativePath of untracked) {
      await copyEntry(
        path.join(repositoryRoot, relativePath),
        path.join(snapshotRoot, relativePath),
      );
    }

    await linkDependencyDirectory(repositoryRoot, snapshotRoot, "node_modules");
    const reviewCwd = path.join(snapshotRoot, relativeCwd);
    await mkdir(reviewCwd, { recursive: true });
    return {
      cwd: reviewCwd,
      cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function linkDependencyDirectory(
  sourceRoot: string,
  snapshotRoot: string,
  name: string,
): Promise<void> {
  const source = path.join(sourceRoot, name);
  const target = path.join(snapshotRoot, name);
  try {
    const stats = await lstat(source);
    if (stats.isDirectory() || stats.isSymbolicLink()) {
      await symlink(source, target, "junction");
    }
  } catch {
    // Dependencies are optional; review agents can still inspect repository truth.
  }
}

async function copyEntry(source: string, target: string): Promise<void> {
  const stats = await lstat(source);
  await mkdir(path.dirname(target), { recursive: true });
  if (stats.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  if (!stats.isFile()) {
    return;
  }
  await copyFile(source, target);
}

async function runGit(
  cwd: string,
  args: string[],
  stdin?: Buffer,
): Promise<Buffer> {
  return runCommand("git", ["-C", cwd, ...args], stdin);
}

async function runCommand(
  command: string,
  args: string[],
  stdin?: Buffer,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
    child.stdin.end(stdin);
  });
}
