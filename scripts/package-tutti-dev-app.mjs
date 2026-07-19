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
import {
  cliManifest,
  commandsMarkdown,
  iconSvg,
  timestampVersion,
} from "./tutti-app-package-shared.mjs";

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
  await writeFile(
    path.join(packageRoot, "icon.svg"),
    iconSvg({ label: manifest.name }),
  );

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
    "- `bootstrap.sh` uses `TUTTI_CLI` for agent target detection, while still setting `NEXTOP_CLI_PATH` for older adapter code.",
    "- `tutti.cli.json` exposes `dynamic-workflows` commands for status, agent target discovery, workflow listing, workflow inspection, script validation, workflow creation, and workflow execution.",
    "- CLI command handlers are served by the source Next app under `/tutti/cli/*` and return Tutti `CliCommandOutput` objects directly.",
    "- In Tutti, workflow cwd inputs must resolve to existing directories staged under `TUTTI_APP_DATA_DIR` or `TUTTI_APP_RUNTIME_DIR`; relative values resolve from the runtime directory, and nested node cwd values cannot escape either directory. Direct local development falls back to the source checkout as its boundary.",
    "- Durable data is written to `DYNAMIC_WORKFLOWS_DATA_DIR`, falling back to `TUTTI_APP_DATA_DIR` and then the source `.data` directory.",
    "- Re-run `npm run import:tutti-dev` after changing manifest, bootstrap, or this package wrapper.",
    "",
  ].join("\n");
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
