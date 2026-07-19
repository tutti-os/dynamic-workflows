import fs from "node:fs";
import path from "node:path";

export class WorkflowCwdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCwdError";
  }
}

export function resolveWorkflowCwd(input?: string): string {
  const policy = getWorkflowCwdPolicy();
  const value = input?.trim();
  const requested = value
    ? path.isAbsolute(value)
      ? value
      : path.resolve(/* turbopackIgnore: true */ policy.defaultCwd, value)
    : policy.defaultCwd;

  let realRequested: string;
  try {
    realRequested = fs.realpathSync(/* turbopackIgnore: true */ requested);
  } catch {
    throw new WorkflowCwdError(`Workflow cwd does not exist: ${requested}`);
  }

  const stat = fs.statSync(/* turbopackIgnore: true */ realRequested);
  if (!stat.isDirectory()) {
    throw new WorkflowCwdError(`Workflow cwd is not a directory: ${requested}`);
  }

  if (!policy.roots.some((root) => isPathInside(root, realRequested))) {
    throw new WorkflowCwdError(
      `Workflow cwd is outside the allowed app data/runtime directories: ${requested}`,
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
        /* turbopackIgnore: true */ baseCwd ?? resolveWorkflowCwd(),
        input.trim(),
      );
  return resolveWorkflowCwd(requested);
}

function getWorkflowCwdPolicy(): { defaultCwd: string; roots: string[] } {
  const dataDir = process.env.TUTTI_APP_DATA_DIR?.trim();
  const runtimeDir = process.env.TUTTI_APP_RUNTIME_DIR?.trim();

  if (!dataDir && !runtimeDir) {
    const developmentRoot = realpathRoot(process.cwd(), "development cwd");
    return { defaultCwd: developmentRoot, roots: [developmentRoot] };
  }
  if (!dataDir || !runtimeDir) {
    throw new WorkflowCwdError(
      "TUTTI_APP_DATA_DIR and TUTTI_APP_RUNTIME_DIR are both required for workflow cwd access.",
    );
  }

  const realDataDir = realpathRoot(dataDir, "TUTTI_APP_DATA_DIR");
  const realRuntimeDir = realpathRoot(runtimeDir, "TUTTI_APP_RUNTIME_DIR");
  return {
    defaultCwd: realRuntimeDir,
    roots: [realDataDir, realRuntimeDir],
  };
}

function realpathRoot(root: string, name: string): string {
  try {
    return fs.realpathSync(/* turbopackIgnore: true */ root);
  } catch {
    throw new WorkflowCwdError(`${name} does not exist: ${root}`);
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
