import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  githubCliConnectionId,
  isSafeGitHubHost,
  isSafeGitHubLogin,
} from "./github-reference";

export {
  githubCliConnectionId,
  isSafeGitHubConnectionReference,
} from "./github-reference";

const GH_COMMAND_TIMEOUT_MS = 10_000;
const GITHUB_CONNECTION_CACHE_MS = 15_000;
const execFileAsync = promisify(execFile);

export type GitHubCliConnection = {
  id: string;
  provider: "github";
  source: "github_cli";
  host: string;
  login: string;
  active: boolean;
  available: boolean;
  tokenSource: string | null;
  scopes: string[];
};

export type GitHubCliConnectionCatalog = {
  connections: GitHubCliConnection[];
  warning?: string;
};

type GitHubCliCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type GitHubCliCommandRunner = (
  args: string[],
) => Promise<GitHubCliCommandResult>;

let catalogCache:
  | { expiresAt: number; value: GitHubCliConnectionCatalog }
  | undefined;
let catalogRequest: Promise<GitHubCliConnectionCatalog> | undefined;

export class GitHubCliConnectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitHubCliConnectionError";
    this.code = code;
  }
}

export async function listGitHubCliConnections(
  run: GitHubCliCommandRunner = runGitHubCli,
  options?: { forceRefresh?: boolean },
): Promise<GitHubCliConnectionCatalog> {
  if (run !== runGitHubCli) {
    return loadGitHubCliConnections(run);
  }
  if (
    !options?.forceRefresh &&
    catalogCache &&
    catalogCache.expiresAt > Date.now()
  ) {
    return catalogCache.value;
  }
  catalogRequest ??= loadGitHubCliConnections(runGitHubCli).then((value) => {
    catalogCache = {
      expiresAt: Date.now() + GITHUB_CONNECTION_CACHE_MS,
      value,
    };
    return value;
  }).finally(() => {
    catalogRequest = undefined;
  });
  return catalogRequest;
}

async function loadGitHubCliConnections(
  run: GitHubCliCommandRunner,
): Promise<GitHubCliConnectionCatalog> {
  const result = await run(["auth", "status", "--json", "hosts"]);
  if (result.error || result.status !== 0) {
    return {
      connections: [],
      warning:
        "GitHub connections could not be loaded. Install GitHub CLI and run `gh auth login`, then retry.",
    };
  }

  try {
    return {
      connections: parseGitHubAuthStatus(result.stdout),
    };
  } catch {
    return {
      connections: [],
      warning:
        "GitHub CLI returned an unreadable connection catalog. Update GitHub CLI and retry.",
    };
  }
}

export async function resolveGitHubCliToken(input: {
  host: string;
  login: string;
}, run: GitHubCliCommandRunner = runGitHubCli): Promise<string> {
  const result = await run([
    "auth",
    "token",
    "--hostname",
    input.host,
    "--user",
    input.login,
  ]);
  const token = result.stdout.trim();
  if (result.error || result.status !== 0 || !token) {
    throw new GitHubCliConnectionError(
      "github_connection_unavailable",
      `GitHub connection ${input.login} on ${input.host} is unavailable. Run \`gh auth login --hostname ${input.host}\` and retry.`,
    );
  }
  return token;
}

export function parseGitHubAuthStatus(source: string): GitHubCliConnection[] {
  const payload = JSON.parse(source) as unknown;
  if (!isRecord(payload) || !isRecord(payload.hosts)) {
    throw new Error("GitHub auth status is missing hosts.");
  }

  const connections: GitHubCliConnection[] = [];
  for (const [host, accounts] of Object.entries(payload.hosts)) {
    if (!isSafeGitHubHost(host) || !Array.isArray(accounts)) {
      continue;
    }
    for (const account of accounts) {
      if (!isRecord(account) || !isSafeGitHubLogin(account.login)) {
        continue;
      }
      const login = account.login;
      connections.push({
        id: githubCliConnectionId(host, login),
        provider: "github",
        source: "github_cli",
        host,
        login,
        active: account.active === true,
        available: account.state === "success",
        tokenSource:
          typeof account.tokenSource === "string" ? account.tokenSource : null,
        scopes:
          typeof account.scopes === "string"
            ? account.scopes
                .split(",")
                .map((scope) => scope.trim())
                .filter(Boolean)
            : [],
      });
    }
  }

  return connections.sort((left, right) => {
    if (left.available !== right.available) {
      return left.available ? -1 : 1;
    }
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }
    return `${left.host}/${left.login}`.localeCompare(
      `${right.host}/${right.login}`,
    );
  });
}

async function runGitHubCli(
  args: string[],
): Promise<GitHubCliCommandResult> {
  try {
    const result = await execFileAsync("gh", args, {
      encoding: "utf8",
      env: process.env,
      timeout: GH_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return {
      status: 0,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout || "",
      stderr: failure.stderr || "",
      error: failure,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
