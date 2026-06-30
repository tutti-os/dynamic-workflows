#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  chmod,
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
const buildRoot = path.join(repoRoot, ".tmp", "tutti-dev-app");
const packageRoot = path.join(buildRoot, "package");

export async function packageTuttiDevApp(options = {}) {
  const sourceDir = path.resolve(
    options.sourceDir ??
      process.env.DYNAMIC_WORKFLOWS_SOURCE_DIR ??
      repoRoot,
  );
  const defaultNodeBin = path.resolve(
    options.nodeBin ?? process.env.DYNAMIC_WORKFLOWS_NODE ?? process.execPath,
  );
  const sourcePackageJsonPath = path.join(sourceDir, "package.json");
  await assertFile(sourcePackageJsonPath, "source package.json is required");
  await assertFile(defaultNodeBin, "default Node executable is required");
  await assertFile(
    path.join(sourceDir, "node_modules", "next", "dist", "bin", "next"),
    "source node_modules/next is required; run npm install first",
  );

  const sourcePackage = JSON.parse(
    await readFile(sourcePackageJsonPath, "utf8"),
  );
  const appId =
    options.appId ?? process.env.TUTTI_DEV_APP_ID ?? "dynamic-workflows-dev";
  const version =
    options.version ??
    process.env.TUTTI_DEV_APP_VERSION ??
    `0.0.0-dev.${timestampVersion()}`;
  const manifest = {
    schemaVersion: "tutti.app.manifest.v1",
    appId,
    version,
    name: "Dynamic Workflows Dev",
    description:
      sourcePackage.description ??
      "Script-first dynamic workflow orchestrator for local Nextop agents.",
    icon: {
      type: "asset",
      src: "icon.svg",
    },
    runtime: {
      bootstrap: "bootstrap.sh",
      healthcheckPath: "/api/health",
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
    tags: ["local-dev", "workflow", "agent"],
  };

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });

  await writeFile(
    path.join(packageRoot, "tutti.app.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, "tutti.cli.json"),
    `${JSON.stringify(cliManifest(), null, 2)}\n`,
  );
  await writeFile(path.join(packageRoot, "COMMANDS.md"), commandsMarkdown());
  await writeFile(path.join(packageRoot, "AGENTS.md"), packageAgents(sourceDir));
  await writeFile(path.join(packageRoot, "icon.svg"), iconSvg());

  const bootstrapPath = path.join(packageRoot, "bootstrap.sh");
  await writeFile(bootstrapPath, bootstrapScript(sourceDir, defaultNodeBin));
  await chmod(bootstrapPath, 0o755);

  const zipPath = path.join(buildRoot, `${appId}-${version}.zip`);
  await run("zip", ["-qry", zipPath, "."], { cwd: packageRoot });

  const result = {
    appId,
    buildRoot,
    manifest,
    nodeBin: defaultNodeBin,
    packageRoot,
    sourceDir,
    version,
    zipPath,
  };
  if (!options.silent) {
    console.log(`Tutti dev app package: ${packageRoot}`);
    console.log(`Tutti dev app archive: ${zipPath}`);
    console.log(`App ID: ${appId}`);
    console.log(`Version: ${version}`);
  }
  return result;
}

function bootstrapScript(sourceDir, defaultNodeBin) {
  return [
    "#!/bin/sh",
    "set -eu",
    "",
    `default_source_dir=${shellQuote(sourceDir)}`,
    `default_node_bin=${shellQuote(defaultNodeBin)}`,
    'source_dir="${DYNAMIC_WORKFLOWS_SOURCE_DIR:-$default_source_dir}"',
    'node_bin="${DYNAMIC_WORKFLOWS_NODE:-$default_node_bin}"',
    'host="${TUTTI_APP_HOST:-127.0.0.1}"',
    'port="${TUTTI_APP_PORT:-3000}"',
    'next_bin="$source_dir/node_modules/next/dist/bin/next"',
    "",
    'if [ ! -x "$node_bin" ]; then',
    '  node_bin="${TUTTI_APP_NODE:?TUTTI_APP_NODE is required}"',
    "fi",
    "",
    'if [ ! -f "$next_bin" ]; then',
    '  echo "dynamic-workflows dev package requires prepared source dependencies in $source_dir." >&2',
    "  exit 1",
    "fi",
    "",
    'export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"',
    'export NEXTOP_CLI_PATH="${NEXTOP_CLI_PATH:-${TUTTI_CLI:-tutti-dev}}"',
    'export DYNAMIC_WORKFLOWS_CWD_ROOT="${DYNAMIC_WORKFLOWS_CWD_ROOT:-${TUTTI_WORKSPACE_ROOT:-$source_dir}}"',
    'export DYNAMIC_WORKFLOWS_DATA_DIR="${DYNAMIC_WORKFLOWS_DATA_DIR:-${TUTTI_APP_DATA_DIR:-$source_dir/.data}}"',
    'mkdir -p "$DYNAMIC_WORKFLOWS_DATA_DIR" "${TUTTI_APP_LOG_DIR:-$source_dir/.tmp/tutti-logs}"',
    'cd "$source_dir"',
    "",
    'exec "$node_bin" "$next_bin" dev -H "$host" -p "$port"',
    "",
  ].join("\n");
}

function packageAgents(sourceDir) {
  return [
    "# Dynamic Workflows Dev Package",
    "",
    "This is a local-only Tutti development package. It does not contain the app implementation; `bootstrap.sh` launches the checked-out source repository directly.",
    "",
    `Source directory: \`${sourceDir}\``,
    "",
    "Runtime rules:",
    "",
    "- Run `npm install` in the source directory before starting this package.",
    "- `bootstrap.sh` starts `next dev` with the source environment Node by default, because this dev package reuses native `node_modules` from the checkout. Set `DYNAMIC_WORKFLOWS_NODE` to override it.",
    "- `bootstrap.sh` uses `TUTTI_CLI` for agent provider detection, while still setting `NEXTOP_CLI_PATH` for older adapter code.",
    "- `tutti.cli.json` exposes `dynamic-workflows` commands for status, provider discovery, workflow listing, workflow inspection, script validation, workflow creation, and workflow execution.",
    "- CLI command handlers are served by the source Next app under `/tutti/cli/*` and return Tutti `CliCommandOutput` objects directly.",
    "- Workflow cwd validation is rooted at `DYNAMIC_WORKFLOWS_CWD_ROOT`, falling back to `TUTTI_WORKSPACE_ROOT` and then the source directory.",
    "- Durable data is written to `DYNAMIC_WORKFLOWS_DATA_DIR`, falling back to `TUTTI_APP_DATA_DIR` and then the source `.data` directory.",
    "- Re-run `npm run import:tutti-dev` after changing manifest, bootstrap, or this package wrapper.",
    "",
  ].join("\n");
}

function cliManifest() {
  return {
    schemaVersion: "tutti.app.cli.v1",
    scope: "dynamic-workflows",
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
        summary: "Run a workflow",
        description:
          "Run the current version of a saved workflow and persist the same run records used by the UI.",
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

function commandsMarkdown() {
  return [
    "# Dynamic Workflows CLI",
    "",
    "The dev package exposes the `dynamic-workflows` scope through `tutti.cli.json`. Commands return Tutti `CliCommandOutput` objects and are routed to the source Next app under `/tutti/cli/*`.",
    "",
    "Use `--json` for machine-readable output:",
    "",
    "```bash",
    "tutti --json dynamic-workflows status",
    "tutti --json dynamic-workflows providers",
    "tutti --json dynamic-workflows list --limit 20",
    "tutti --json dynamic-workflows show --workflow-id <id> --include-script",
    "tutti --json dynamic-workflows validate --script '<workflow-js>'",
    "tutti --json dynamic-workflows create --prompt 'Summarize this repo and propose next steps' --provider codex",
    "tutti --json dynamic-workflows run --workflow-id <id> --provider codex --inputs '{\"topic\":\"release\"}'",
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
    "- `run`: execute a saved workflow current version and persist a run record.",
    "",
    "`run` accepts external workflow inputs through the `inputs` flag as a JSON object string. If `provider` is omitted, nodes without an explicit provider run with `mock` so local smoke checks stay safe.",
    "",
  ].join("\n");
}

function iconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Dynamic Workflows Dev">
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

async function assertFile(filePath, message) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(message);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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

if (process.argv[1] === scriptPath) {
  await packageTuttiDevApp();
}
