#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, "..");
const buildRoot = path.join(repoRoot, ".tmp", "tutti-app");
const packageRoot = path.join(repoRoot, "package");

const args = parseArgs(process.argv.slice(2));

await packageTuttiApp({
  appId: args["app-id"],
  cliScope: args["cli-scope"],
  environment: args.environment,
  version: args.version,
});

export async function packageTuttiApp(options = {}) {
  const environment = normalizeEnvironment(
    options.environment ?? process.env.TUTTI_APP_ENV ?? "staging",
  );
  assertPackagingEnvironmentAllowed(environment);
  const sourcePackage = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const appId =
    options.appId ??
    process.env.TUTTI_PACKAGE_APP_ID ??
    defaultAppId(environment);
  const cliScope =
    options.cliScope ??
    process.env.TUTTI_PACKAGE_CLI_SCOPE ??
    defaultCliScope(environment);
  const version =
    options.version ??
    process.env.TUTTI_PACKAGE_VERSION ??
    defaultVersion(sourcePackage.version, environment);
  const manifest = appManifest({
    appId,
    cliScope,
    description:
      sourcePackage.description ??
      "Script-first dynamic workflow orchestrator for local Nextop agents.",
    environment,
    version,
  });

  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });

  await copySourcePackage();
  await removeRuntimeStateFromPackage();

  await writeFile(
    path.join(packageRoot, "tutti.app.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, "tutti.cli.json"),
    `${JSON.stringify(cliManifest({ scope: cliScope }), null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, "COMMANDS.md"),
    commandsMarkdown({
      packageLabel: `${environment} package`,
      scope: cliScope,
    }),
  );
  await writeFile(path.join(packageRoot, "AGENTS.md"), packageAgents({
    cliScope,
    environment,
  }));
  await writeFile(path.join(packageRoot, "icon.svg"), iconSvg());

  const preparePath = path.join(packageRoot, "prepare.sh");
  await writeFile(preparePath, prepareScript());
  await chmod(preparePath, 0o755);

  const bootstrapPath = path.join(packageRoot, "bootstrap.sh");
  await writeFile(bootstrapPath, bootstrapScript());
  await chmod(bootstrapPath, 0o755);

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  const zipPath = path.join(buildRoot, `${appId}-${version}.zip`);
  await rm(zipPath, { force: true });
  await run("zip", ["-qry", zipPath, "."], { cwd: packageRoot });

  const result = {
    appId,
    buildRoot,
    cliScope,
    environment,
    packageRoot,
    version,
    zipPath,
  };
  console.log(`Tutti ${environment} app package: ${packageRoot}`);
  console.log(`Tutti ${environment} app archive: ${zipPath}`);
  console.log(`App ID: ${appId}`);
  console.log(`CLI scope: ${cliScope}`);
  console.log(`Version: ${version}`);
  return result;
}

function appManifest({ appId, cliScope, description, environment, version }) {
  const name = `Dynamic Workflows ${titleCase(environment)}`;

  return {
    schemaVersion: "tutti.app.manifest.v1",
    appId,
    version,
    name,
    description,
    icon: {
      type: "asset",
      src: "icon.svg",
    },
    runtime: {
      bootstrap: "bootstrap.sh",
      healthcheckPath: "/api/health",
      profile: "node-static",
    },
    window: {
      minimizeBehavior: "keep-mounted",
      minWidth: 960,
      minHeight: 640,
    },
    cli: {
      manifest: "tutti.cli.json",
    },
    author: {
      name: "Tutti",
    },
    tags: ["workflow", "agent", environment],
  };
}

function cliManifest(options = {}) {
  const scope = options.scope ?? "dynamic-workflows-staging";
  return {
    schemaVersion: "tutti.app.cli.v1",
    scope,
    description:
      "Create, inspect, validate, and run local Dynamic Workflows.",
    documentation: {
      file: "COMMANDS.md",
    },
    commands: [
      {
        path: ["status"],
        summary: "Show Dynamic Workflows runtime status",
        description:
          "Report app health, workflow counts, cwd root, and agent provider detection status.",
        inputSchema: objectSchema({}),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/status"),
      },
      {
        path: ["providers"],
        summary: "List available agent providers",
        description:
          "List providers and model options detected through the local Tutti CLI.",
        inputSchema: objectSchema({}),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/providers"),
      },
      {
        path: ["list"],
        summary: "List saved workflows",
        description:
          "List saved workflows with their current version and latest run status.",
        inputSchema: objectSchema({
          limit: {
            type: "integer",
            description: "Maximum number of workflows to return. Defaults to 50.",
          },
        }),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/list"),
      },
      {
        path: ["show"],
        summary: "Show one workflow",
        description:
          "Return workflow metadata, current version, runs, and parsed node summary.",
        inputSchema: objectSchema(
          {
            "workflow-id": {
              type: "string",
              description: "Workflow id to inspect.",
            },
            "include-script": {
              type: "boolean",
              description: "Include the current workflow script in the output.",
            },
          },
          ["workflow-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/show"),
      },
      {
        path: ["validate"],
        summary: "Validate a workflow script",
        description:
          "Parse a workflow script and return diagnostics, external inputs, and node summary.",
        inputSchema: objectSchema(
          {
            script: {
              type: "string",
              description: "Workflow JavaScript source to validate.",
            },
          },
          ["script"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/validate"),
      },
      {
        path: ["create"],
        summary: "Generate and save a workflow",
        description:
          "Generate a workflow from a prompt, save it, and return the created workflow and script.",
        inputSchema: objectSchema(
          {
            prompt: {
              type: "string",
              description: "Natural-language workflow request.",
            },
            provider: {
              type: "string",
              description:
                "Optional agent provider for generation, such as codex or claude-code.",
            },
            model: {
              type: "string",
              description: "Optional model override.",
            },
            cwd: {
              type: "string",
              description:
                "Optional working directory, resolved inside the configured workflow cwd root.",
            },
          },
          ["prompt"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/create"),
      },
      {
        path: ["run"],
        summary: "Start a workflow run",
        description:
          "Start the current version of a saved workflow in the background and return the persisted run record used by the UI.",
        inputSchema: objectSchema(
          {
            "workflow-id": {
              type: "string",
              description: "Workflow id to run.",
            },
            inputs: {
              type: "string",
              description:
                "JSON object string containing external workflow inputs.",
            },
            provider: {
              type: "string",
              description:
                "Agent provider for nodes without an explicit provider. Defaults to mock.",
            },
            model: {
              type: "string",
              description: "Optional model override.",
            },
            cwd: {
              type: "string",
              description:
                "Optional working directory, resolved inside the configured workflow cwd root.",
            },
          },
          ["workflow-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/run"),
      },
    ],
  };
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function jsonOutput() {
  return {
    defaultMode: "json",
    json: true,
  };
}

function httpHandler(pathname) {
  return {
    kind: "http",
    method: "POST",
    path: pathname,
  };
}

function commandsMarkdown(options = {}) {
  const scope = options.scope ?? "dynamic-workflows-staging";
  const packageLabel = options.packageLabel ?? "staging package";
  return [
    "# Dynamic Workflows CLI",
    "",
    `The ${packageLabel} exposes the \`${scope}\` scope through \`tutti.cli.json\`. Commands return Tutti \`CliCommandOutput\` objects and are routed to the Next app under \`/tutti/cli/*\`.`,
    "",
    "Use `--json` for machine-readable output:",
    "",
    "```bash",
    `tutti --json ${scope} status`,
    `tutti --json ${scope} providers`,
    `tutti --json ${scope} list --limit 20`,
    `tutti --json ${scope} show --workflow-id <id> --include-script`,
    `tutti --json ${scope} validate --script '<workflow-js>'`,
    `tutti --json ${scope} create --prompt 'Summarize this repo and propose next steps' --provider codex`,
    `tutti --json ${scope} run --workflow-id <id> --provider codex --inputs '{"topic":"release"}'`,
    "```",
    "",
    "Commands:",
    "",
    "- `status`: runtime health, cwd root, workflow count, and provider detection status.",
    "- `providers`: local agent providers and model options discovered through `TUTTI_CLI`.",
    "- `list`: saved workflow summaries with version and latest run status.",
    "- `show`: one workflow, parsed node summary, versions, and recent runs.",
    "- `validate`: parser diagnostics for a workflow script without saving it.",
    "- `create`: generate and save a workflow from a natural-language prompt.",
    "- `run`: start the current saved workflow version in the background and persist a run record.",
    "",
    "`run` accepts external workflow inputs through the `inputs` flag as a JSON object string. If `provider` is omitted, nodes without an explicit provider run with `mock` so local smoke checks stay safe.",
    "",
  ].join("\n");
}

function iconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Dynamic Workflows Staging">
  <rect width="128" height="128" rx="28" fill="#111827"/>
  <path d="M28 38h28a16 16 0 0 1 16 16v20a16 16 0 0 0 16 16h12" fill="none" stroke="#38bdf8" stroke-width="10" stroke-linecap="round"/>
  <path d="M28 90h18a16 16 0 0 0 16-16V54a16 16 0 0 1 16-16h22" fill="none" stroke="#a3e635" stroke-width="10" stroke-linecap="round"/>
  <circle cx="28" cy="38" r="9" fill="#f9fafb"/>
  <circle cx="28" cy="90" r="9" fill="#f9fafb"/>
  <circle cx="100" cy="38" r="9" fill="#f9fafb"/>
  <circle cx="100" cy="90" r="9" fill="#f9fafb"/>
</svg>
`;
}

function prepareScript() {
  return [
    "#!/bin/sh",
    "set -eu",
    "",
    'package_dir="${TUTTI_APP_PACKAGE_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"',
    'if [ -z "${TUTTI_APP_NODE:-}" ]; then',
    '  echo "TUTTI_APP_NODE is required to prepare Dynamic Workflows." >&2',
    "  exit 1",
    "fi",
    'if [ -z "${TUTTI_APP_NPM:-}" ]; then',
    '  echo "TUTTI_APP_NPM is required to install and build Dynamic Workflows." >&2',
    "  exit 1",
    "fi",
    "",
    'export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"',
    'cd "$package_dir"',
    '"$TUTTI_APP_NPM" ci',
    '"$TUTTI_APP_NODE" ./tools/scripts/ensure-native-modules.mjs --fix',
    '"$TUTTI_APP_NPM" run build',
    "",
    'rm -rf .next/standalone/.next/static .next/standalone/public',
    'mkdir -p .next/standalone/.next',
    'cp -R .next/static .next/standalone/.next/static',
    'if [ -d public ]; then',
    '  cp -R public .next/standalone/public',
    "fi",
    "",
  ].join("\n");
}

function bootstrapScript() {
  return [
    "#!/bin/sh",
    "set -eu",
    "",
    'host="${TUTTI_APP_HOST:-127.0.0.1}"',
    'if [ -z "${TUTTI_APP_PORT:-}" ]; then',
    '  echo "TUTTI_APP_PORT is required; Tutti must inject the allocated runtime port." >&2',
    "  exit 1",
    "fi",
    'if [ -z "${TUTTI_APP_NODE:-}" ]; then',
    '  echo "TUTTI_APP_NODE is required to launch the packaged Next.js server." >&2',
    "  exit 1",
    "fi",
    'if [ -z "${TUTTI_APP_DATA_DIR:-}" ]; then',
    '  echo "TUTTI_APP_DATA_DIR is required for durable workflow data." >&2',
    "  exit 1",
    "fi",
    "",
    'package_dir="${TUTTI_APP_PACKAGE_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"',
    'server_dir="$package_dir/.next/standalone"',
    'server_js="$server_dir/server.js"',
    'if [ ! -f "$server_js" ]; then',
    '  echo "Prepared Next.js server is missing. Run prepare.sh before bootstrap.sh." >&2',
    "  exit 1",
    "fi",
    "",
    'export NODE_ENV="${NODE_ENV:-production}"',
    'export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"',
    'export HOSTNAME="$host"',
    'export PORT="$TUTTI_APP_PORT"',
    'export NEXTOP_CLI_PATH="${NEXTOP_CLI_PATH:-${TUTTI_CLI:-}}"',
    'export DYNAMIC_WORKFLOWS_CWD_ROOT="${DYNAMIC_WORKFLOWS_CWD_ROOT:-${TUTTI_WORKSPACE_ROOT:-$package_dir}}"',
    'export DYNAMIC_WORKFLOWS_DATA_DIR="${DYNAMIC_WORKFLOWS_DATA_DIR:-$TUTTI_APP_DATA_DIR}"',
    'mkdir -p "$DYNAMIC_WORKFLOWS_DATA_DIR"',
    "",
    'cd "$server_dir"',
    'exec "$TUTTI_APP_NODE" server.js',
    "",
  ].join("\n");
}

function packageAgents({ cliScope, environment }) {
  return [
    `# Dynamic Workflows ${titleCase(environment)} Package`,
    "",
    "This directory is the self-contained Tutti workspace app package generated from the repository root.",
    "",
    "Runtime contract:",
    "",
    "- `prepare.sh` installs dependencies with `TUTTI_APP_NPM`, repairs native modules with `TUTTI_APP_NODE`, builds Next.js standalone output, and copies static assets into the standalone runtime directory.",
    "- `bootstrap.sh` is the Tutti runtime entrypoint and starts the prepared Next.js standalone server.",
    "- It reads `TUTTI_APP_HOST`, defaulting to `127.0.0.1` only when absent.",
    "- It requires `TUTTI_APP_PORT`; the daemon owns port allocation.",
    "- It requires `TUTTI_APP_NODE`; no system `node` binary is used.",
    "- It requires `TUTTI_APP_DATA_DIR` and maps workflow data to `DYNAMIC_WORKFLOWS_DATA_DIR` under that directory.",
    "- The package directory is treated as read-only at runtime.",
    "- Workflow cwd validation is rooted at `DYNAMIC_WORKFLOWS_CWD_ROOT`, falling back to `TUTTI_WORKSPACE_ROOT` and then this package directory.",
    "- Agent/provider discovery uses `TUTTI_CLI`; `bootstrap.sh` also sets `NEXTOP_CLI_PATH` from it for existing adapter compatibility.",
    "- The manifest healthcheck is `GET /api/health`.",
    "",
    "CLI integration:",
    "",
    `- \`tutti.cli.json\` exposes the \`${cliScope}\` scope.`,
    "- Command handlers are served by the packaged Next app under `/tutti/cli/*` and return Tutti `CliCommandOutput` objects directly.",
    "",
    "Modification rules:",
    "",
    "- Rebuild this package from the repository root with `npm run package:tutti:staging`.",
    "- Production packaging is intentionally disabled in this repository until the staging release path is promoted.",
    "- Do not edit generated package files by hand; update the source repository and regenerate the package.",
    "- Add or change CLI commands in the source app and shared package scripts, then regenerate the package.",
    "",
  ].join("\n");
}

function defaultAppId(environment) {
  return `dynamic-workflows-${environment}`;
}

function defaultCliScope(environment) {
  return `dynamic-workflows-${environment}`;
}

function defaultVersion(sourceVersion, environment) {
  const baseVersion =
    typeof sourceVersion === "string" && sourceVersion.trim()
      ? sourceVersion.trim()
      : "0.1.0";
  return `${baseVersion}-${environment}.${timestampVersion()}`;
}

function timestampVersion(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function normalizeEnvironment(value) {
  const environment = String(value || "")
    .trim()
    .toLowerCase();
  if (!environment) {
    return "staging";
  }
  if (!/^[a-z0-9-]+$/.test(environment)) {
    throw new Error(
      `Invalid environment "${value}". Use lowercase letters, numbers, and hyphens.`,
    );
  }
  return environment;
}

function assertPackagingEnvironmentAllowed(environment) {
  if (environment === "production") {
    throw new Error(
      "Production Tutti packaging is temporarily disabled. Use --environment staging.",
    );
  }
}

function titleCase(value) {
  return String(value)
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function exists(filePath) {
  return Boolean(await stat(filePath).catch(() => null));
}

async function copySourcePackage() {
  const files = [
    "next-env.d.ts",
    "next.config.mjs",
    "package-lock.json",
    "package.json",
    "postcss.config.mjs",
    "tsconfig.json",
  ];
  const directories = ["src", "tools"];

  for (const file of files) {
    if (await exists(path.join(repoRoot, file))) {
      await cp(path.join(repoRoot, file), path.join(packageRoot, file));
    }
  }
  for (const directory of directories) {
    if (await exists(path.join(repoRoot, directory))) {
      await cp(path.join(repoRoot, directory), path.join(packageRoot, directory), {
        recursive: true,
        filter: shouldCopyPackageSource,
      });
    }
  }
  if (await exists(path.join(repoRoot, "public"))) {
    await cp(path.join(repoRoot, "public"), path.join(packageRoot, "public"), {
      recursive: true,
    });
  }
}

function shouldCopyPackageSource(sourcePath) {
  const relativePath = path.relative(repoRoot, sourcePath).replaceAll(path.sep, "/");
  if (
    /(^|\/)__tests__(\/|$)/.test(relativePath) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
  ) {
    return false;
  }
  return true;
}

async function removeRuntimeStateFromPackage() {
  const runtimeStatePaths = [
    ".data",
    ".tmp",
    ".git",
    "coverage",
    "dist",
    "out",
    "tsconfig.tsbuildinfo",
  ];
  await Promise.all(
    runtimeStatePaths.map((relativePath) =>
      rm(path.join(packageRoot, relativePath), { recursive: true, force: true }),
    ),
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--environment") {
      parsed.environment = requireValue(argv, (index += 1), arg);
    } else if (arg === "--app-id") {
      parsed["app-id"] = requireValue(argv, (index += 1), arg);
    } else if (arg === "--cli-scope") {
      parsed["cli-scope"] = requireValue(argv, (index += 1), arg);
    } else if (arg === "--version") {
      parsed.version = requireValue(argv, (index += 1), arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function run(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}
