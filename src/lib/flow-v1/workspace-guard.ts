import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class FlowV1WorkspaceDriftError extends Error {
  readonly code = "flow_workspace_drift";

  constructor(message: string) {
    super(message);
    this.name = "FlowV1WorkspaceDriftError";
  }
}

export async function assertFlowV1WorkspaceBranch(
  cwd: string,
  expectedBranch: string,
): Promise<void> {
  let actualBranch: string;
  try {
    const result = await execFileAsync(
      "git",
      ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { encoding: "utf8" },
    );
    actualBranch = result.stdout.trim();
  } catch (error) {
    throw new FlowV1WorkspaceDriftError(
      `Workspace ${cwd} must be checked out on ${expectedBranch}, but its current Git branch could not be determined: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (actualBranch !== expectedBranch) {
    throw new FlowV1WorkspaceDriftError(
      `Workspace ${cwd} is checked out on ${actualBranch || "(detached HEAD)"}, expected ${expectedBranch}. Restore the Flow branch before retrying.`,
    );
  }
}
