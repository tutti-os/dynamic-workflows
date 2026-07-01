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
import {
  cliManifest,
  commandsMarkdown,
  iconSvg,
  timestampVersion,
} from "./tutti-app-package-shared.mjs";

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
      routeLabel: "packaged Next app",
      scope: cliScope,
    }),
  );
  await writeFile(path.join(packageRoot, "AGENTS.md"), packageAgents({
    cliScope,
    environment,
  }));
  await writeFile(
    path.join(packageRoot, "icon.svg"),
    iconSvg({ label: manifest.name }),
  );

  const preparePath = path.join(packageRoot, "prepare.sh");
  await writeFile(preparePath, prepareScript());
  await chmod(preparePath, 0o755);

  const bootstrapPath = path.join(packageRoot, "bootstrap.sh");
  await writeFile(bootstrapPath, bootstrapScript());
  await chmod(bootstrapPath, 0o755);

  await preparePackageForRuntime();

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

async function preparePackageForRuntime() {
  const env = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? "1",
  };

  await runNpm(["ci"], { cwd: packageRoot, env });
  await run(process.execPath, ["./tools/scripts/ensure-native-modules.mjs", "--fix"], {
    cwd: packageRoot,
    env,
  });
  await runNpm(["run", "build"], { cwd: packageRoot, env });
  await copyStandaloneAssets();
  await removeBuildOnlyStateFromPackage();
  await assertStandaloneServer();
}

async function copyStandaloneAssets() {
  await rm(path.join(packageRoot, ".next", "standalone", ".next", "static"), {
    recursive: true,
    force: true,
  });
  await rm(path.join(packageRoot, ".next", "standalone", "public"), {
    recursive: true,
    force: true,
  });
  await mkdir(path.join(packageRoot, ".next", "standalone", ".next"), {
    recursive: true,
  });
  await cp(
    path.join(packageRoot, ".next", "static"),
    path.join(packageRoot, ".next", "standalone", ".next", "static"),
    { recursive: true },
  );
  if (await exists(path.join(packageRoot, "public"))) {
    await cp(
      path.join(packageRoot, "public"),
      path.join(packageRoot, ".next", "standalone", "public"),
      { recursive: true },
    );
  }
}

async function removeBuildOnlyStateFromPackage() {
  await Promise.all(
    [
      "node_modules",
      ".next/cache",
      ".next/diagnostics",
      ".next/server/app-paths-manifest.json",
      ".next/trace",
    ].map((relativePath) =>
      rm(path.join(packageRoot, relativePath), {
        recursive: true,
        force: true,
      }),
    ),
  );
}

async function assertStandaloneServer() {
  const serverPath = path.join(packageRoot, ".next", "standalone", "server.js");
  if (!(await exists(serverPath))) {
    throw new Error(`Packaged Next.js standalone server is missing: ${serverPath}`);
  }
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
    "- The repository package script prebuilds the Next.js standalone output before release upload, including static assets and traced runtime dependencies.",
    "- `prepare.sh` can rebuild the package with `TUTTI_APP_NPM` and `TUTTI_APP_NODE` when doing local package repair, but the published package is expected to already contain `.next/standalone/server.js`.",
    "- `bootstrap.sh` is the Tutti runtime entrypoint and starts the prebuilt Next.js standalone server.",
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

async function runNpm(args, options) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && (await exists(npmExecPath))) {
    await run(process.execPath, [npmExecPath, ...args], options);
    return;
  }
  await run("npm", args, options);
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
