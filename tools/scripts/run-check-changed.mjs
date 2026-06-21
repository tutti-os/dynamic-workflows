import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const dryRun = process.argv.includes("--dry-run");
const forceFull = process.argv.includes("--full");
const tailLines = readPositiveIntegerOption("--tail-lines", 80);
const baseRef = readOption("--base") ?? resolveDefaultBaseRef();
const tmpRoot = join(workspaceRoot, ".tmp", "check-runs");

const changedFiles = listChangedFiles(baseRef);
const lanes = buildLanes(changedFiles);

if (lanes.length === 0) {
  console.log("check:changed found no changed files to validate");
  process.exit(0);
}

if (dryRun) {
  printPlan(lanes);
  process.exit(0);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDirectory = join(tmpRoot, runId);
mkdirSync(runDirectory, { recursive: true });

const startedAt = Date.now();
const results = [];

for (const lane of lanes) {
  results.push(await runLane(lane, runDirectory));
}

const durationMs = Date.now() - startedAt;
const failures = results.filter((result) => result.exitCode !== 0);
const summary = {
  baseRef,
  changedFiles,
  durationMs,
  forceFull,
  runDirectory,
  startedAt: new Date(startedAt).toISOString(),
  tailLines,
  results
};

writeFileSync(
  join(runDirectory, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`
);
writeFileSync(
  join(tmpRoot, "latest.json"),
  `${JSON.stringify(summary, null, 2)}\n`
);

printSummary(results, failures, durationMs, runDirectory);

if (failures.length > 0) {
  process.exitCode = 1;
}

function buildLanes(files) {
  const lanesByKey = new Map();
  const addLane = (lane) => {
    if (!lanesByKey.has(lane.key)) {
      lanesByKey.set(lane.key, lane);
    }
  };

  if (files.length > 0) {
    addLane({
      key: "diff-check",
      label: "diff-check",
      command: [
        "bash",
        "-lc",
        `git diff --check ${shellQuote(baseRef)}...HEAD && git diff --check && git diff --cached --check`
      ]
    });
  }

  if (forceFull || files.some(isFullValidationRelevant)) {
    addLane({
      key: "check:full",
      label: "check:full",
      command: [npmCommand, "run", "check:full"]
    });
    return Array.from(lanesByKey.values());
  }

  if (
    files.some(isQuickValidationRelevant) ||
    files.some(isUnknownCodeFile)
  ) {
    addLane({
      key: "check:quick",
      label: "check:quick",
      command: [npmCommand, "run", "check:quick"]
    });
  }

  return Array.from(lanesByKey.values());
}

function listChangedFiles(ref) {
  const files = new Set();
  const commands = [
    ["diff", "--name-only", `${ref}...HEAD`],
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"]
  ];

  for (const args of commands) {
    for (const file of gitLines(args)) {
      files.add(file);
    }
  }

  return Array.from(files).sort();
}

async function runLane(lane, runDirectory) {
  const index = lanes.indexOf(lane);
  const logPath = join(runDirectory, `${sanitizeFileName(lane.key)}.log`);
  const logStream = createWriteStream(logPath, { flags: "w" });
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const [command, ...args] = lane.command;
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    logStream.write(`$ ${formatCommand(lane.command)}\n\n`);
    child.stdout.on("data", (chunk) => logStream.write(chunk));
    child.stderr.on("data", (chunk) => logStream.write(chunk));

    child.on("error", (error) => {
      logStream.write(`\n[runner] ${error.message}\n`);
      logStream.end();
      resolve(buildLaneResult(lane, index, logPath, startedAt, 1));
    });

    child.on("close", (code) => {
      logStream.end();
      resolve(
        buildLaneResult(
          lane,
          index,
          logPath,
          startedAt,
          typeof code === "number" ? code : 1
        )
      );
    });
  });
}

function buildLaneResult(lane, index, logPath, startedAt, exitCode) {
  return {
    command: lane.command,
    durationMs: Date.now() - startedAt,
    exitCode,
    index,
    key: lane.key,
    label: lane.label,
    logPath,
    logPathRelative: relative(workspaceRoot, logPath)
  };
}

function printPlan(inputLanes) {
  console.log(`check:changed plan (${inputLanes.length} lane(s))`);
  for (const lane of inputLanes) {
    console.log(`- ${lane.label}: ${formatCommand(lane.command)}`);
  }
}

function printSummary(results, failures, durationMs, runDirectory) {
  if (failures.length === 0) {
    console.log(
      `check:changed passed ${results.length} lane(s) in ${formatDuration(durationMs)}`
    );
    return;
  }

  console.error(
    `check:changed failed ${failures.length}/${results.length} lane(s) in ${formatDuration(durationMs)}`
  );

  for (const failure of failures) {
    const tail = tailFile(failure.logPath, tailLines);
    const header = tail.truncated
      ? `${failure.label} tail last ${tailLines} lines (full log: ${failure.logPathRelative})`
      : `${failure.label} full log`;
    console.error(`\n--- ${header} ---`);
    console.error(tail.text);
  }

  console.error(`\nfull logs: ${relative(workspaceRoot, runDirectory)}`);
}

function isFullValidationRelevant(file) {
  return [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "next.config.mjs",
    "postcss.config.mjs",
    "next-env.d.ts"
  ].includes(file);
}

function isQuickValidationRelevant(file) {
  return (
    /^src\/.*\.(?:ts|tsx)$/u.test(file) ||
    /\.(?:test|spec)\.(?:ts|tsx)$/u.test(file) ||
    file === "vitest.config.ts"
  );
}

function isUnknownCodeFile(file) {
  if (isDocsOrMetadataFile(file) || isFullValidationRelevant(file)) {
    return false;
  }

  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx|css)$/u.test(file);
}

function isDocsOrMetadataFile(file) {
  return (
    /\.(?:md|mdx|txt)$/u.test(file) ||
    file.startsWith("docs/") ||
    file === ".gitignore" ||
    file === "LICENSE"
  );
}

function gitLines(args) {
  const result = spawnSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveDefaultBaseRef() {
  for (const candidate of ["origin/main", "main"]) {
    const result = spawnSync("git", ["rev-parse", "--verify", candidate], {
      cwd: workspaceRoot,
      encoding: "utf8"
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  return "HEAD";
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function readPositiveIntegerOption(name, defaultValue) {
  const value = readOption(name);
  if (value === null) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function formatCommand(command) {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sanitizeFileName(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, "-");
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function tailFile(path, lineCount) {
  if (!existsSync(path)) {
    return { text: "", truncated: false };
  }

  const content = readFileSync(path, "utf8");
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const truncated = lines.length > lineCount;

  return {
    text: lines.slice(-lineCount).join("\n"),
    truncated
  };
}
