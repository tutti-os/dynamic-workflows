import fs from "node:fs";
import path from "node:path";

export class WorkflowCwdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCwdError";
  }
}

export function resolveWorkflowCwd(input?: string): string {
  const root = getWorkflowCwdRoot();
  const requested = input?.trim()
    ? path.resolve(/* turbopackIgnore: true */ root, input.trim())
    : root;

  let realRoot: string;
  let realRequested: string;
  try {
    realRoot = fs.realpathSync(/* turbopackIgnore: true */ root);
  } catch {
    throw new WorkflowCwdError(`Workflow cwd root does not exist: ${root}`);
  }

  try {
    realRequested = fs.realpathSync(/* turbopackIgnore: true */ requested);
  } catch {
    throw new WorkflowCwdError(`Workflow cwd does not exist: ${requested}`);
  }

  const stat = fs.statSync(/* turbopackIgnore: true */ realRequested);
  if (!stat.isDirectory()) {
    throw new WorkflowCwdError(`Workflow cwd is not a directory: ${requested}`);
  }

  if (!isPathInside(realRoot, realRequested)) {
    throw new WorkflowCwdError(
      `Workflow cwd must stay inside ${realRoot}: ${requested}`,
    );
  }

  return realRequested;
}

export function resolveWorkflowCwdFrom(
  baseCwd: string | undefined,
  input?: string,
): string {
  if (!input?.trim()) {
    return resolveWorkflowCwd(baseCwd);
  }
  const requested = path.isAbsolute(input.trim())
    ? input.trim()
    : path.resolve(
        /* turbopackIgnore: true */ baseCwd ?? getWorkflowCwdRoot(),
        input.trim(),
      );
  return resolveWorkflowCwd(requested);
}

export function getWorkflowCwdRoot(): string {
  const root = process.env.DYNAMIC_WORKFLOWS_CWD_ROOT;
  if (root?.trim()) {
    return path.resolve(/* turbopackIgnore: true */ root);
  }
  return path.resolve(/* turbopackIgnore: true */ process.cwd());
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
