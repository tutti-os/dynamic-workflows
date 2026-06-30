import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";

const require = createRequire(import.meta.url);
const shouldFix = process.argv.includes("--fix");
const projectRoot = process.cwd();
const nativeBinaryPath = join(
  projectRoot,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);

function verifyBetterSqlite3() {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.close();
}

function npmCommand() {
  return process.env.TUTTI_APP_NPM || process.env.npm_execpath || "npm";
}

function rebuildBetterSqlite3() {
  rmSync(nativeBinaryPath, { force: true });

  const npmPath = npmCommand();
  const result = spawnSync(
    npmPath,
    ["rebuild", "better-sqlite3", "--build-from-source"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:${process.env.PATH || ""}`,
      },
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `npm rebuild better-sqlite3 failed with exit code ${result.status}`,
    );
  }
}

try {
  verifyBetterSqlite3();
  console.log(
    `[native-modules] better-sqlite3 ok for ${process.version} ABI ${process.versions.modules}`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  if (!shouldFix) {
    console.error(
      `[native-modules] better-sqlite3 is not compatible with ${process.version} ABI ${process.versions.modules}: ${message}`,
    );
    process.exit(1);
  }

  console.warn(
    `[native-modules] rebuilding better-sqlite3 for ${process.version} ABI ${process.versions.modules}`,
  );
  console.warn(`[native-modules] previous load error: ${message}`);
  rebuildBetterSqlite3();

  try {
    verifyBetterSqlite3();
    console.log(
      `[native-modules] better-sqlite3 rebuilt for ${process.version} ABI ${process.versions.modules}`,
    );
  } catch (verifyError) {
    const verifyMessage =
      verifyError instanceof Error ? verifyError.message : String(verifyError);
    console.error(
      `[native-modules] better-sqlite3 still failed after rebuild: ${verifyMessage}`,
    );
    process.exit(1);
  }
}
