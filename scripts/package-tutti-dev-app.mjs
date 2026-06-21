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
      "Script-first dynamic workflow orchestrator for local ACP agents.",
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
    "- Durable data is written to `DYNAMIC_WORKFLOWS_DATA_DIR`, falling back to `TUTTI_APP_DATA_DIR` and then the source `.data` directory.",
    "- Re-run `npm run import:tutti-dev` after changing manifest, bootstrap, or this package wrapper.",
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
