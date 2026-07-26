import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDataDir } from "@/lib/db/client";
import {
  getFlowV1BundleFile,
  materializeFlowV1Bundle,
  readFlowV1BundleDirectory,
} from "./bundle";
import { isFlowV1JsonValue } from "./contracts";
import type {
  FlowV1Bundle,
  FlowV1JsonObject,
  FlowV1JsonValue,
} from "./types";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const JS_WORKER_SOURCE = `
import fs from "node:fs";
const config = JSON.parse(process.env.TUTTI_FLOW_RUNNER_CONFIG);
try {
  const module = await import(config.moduleUrl);
  const handler = module[config.exportName];
  if (typeof handler !== "function") {
    throw new Error("Missing exported function " + config.exportName + "()");
  }
  const context = JSON.parse(fs.readFileSync(config.inputPath, "utf8"));
  const value = await handler(context);
  fs.writeFileSync(config.resultPath, JSON.stringify(value ?? null), "utf8");
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(message + "\\n");
  process.exitCode = 1;
}
`;

export type FlowV1CodeExecution = {
  value: FlowV1JsonValue;
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode: number;
};

export class FlowV1CodeRunnerError extends Error {
  readonly code: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(input: {
    code: string;
    message: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
  }) {
    super(input.message);
    this.name = "FlowV1CodeRunnerError";
    this.code = input.code;
    this.stdout = input.stdout ?? "";
    this.stderr = input.stderr ?? "";
    this.exitCode = input.exitCode ?? null;
  }
}

export function prepareFlowV1ExecutionBundle(input: {
  versionId: string;
  bundle: FlowV1Bundle;
}): string {
  if (!input.versionId.trim()) {
    throw new FlowV1CodeRunnerError({
      code: "flow_runner_version_invalid",
      message: "versionId must be non-empty.",
    });
  }
  const destination = path.join(
    getDataDir(),
    "flow-v1",
    "bundles",
    input.versionId,
    input.bundle.hash,
  );
  if (fs.existsSync(destination)) {
    const materialized = readFlowV1BundleDirectory(destination);
    if (materialized.hash !== input.bundle.hash) {
      throw new FlowV1CodeRunnerError({
        code: "flow_runner_bundle_corrupt",
        message: `Materialized Bundle ${input.versionId} does not match its immutable hash.`,
      });
    }
    return destination;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  materializeFlowV1Bundle(input.bundle, destination);
  return destination;
}

export async function runFlowV1CodeModule(input: {
  versionId: string;
  bundle: FlowV1Bundle;
  file: string;
  exportName: "run" | "check" | "apply" | "reconcile";
  context: FlowV1JsonObject;
  projectCwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  environment?: Record<string, string>;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<FlowV1CodeExecution> {
  const module = getFlowV1BundleFile(input.bundle, input.file);
  if (!module || module.role !== "code") {
    throw new FlowV1CodeRunnerError({
      code: "flow_runner_module_not_found",
      message: `Code module ${input.file} is not present in the pinned Bundle.`,
    });
  }
  if (input.projectCwd && !fs.statSync(input.projectCwd).isDirectory()) {
    throw new FlowV1CodeRunnerError({
      code: "flow_runner_cwd_invalid",
      message: `Project cwd is not a directory: ${input.projectCwd}.`,
    });
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes =
    input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new FlowV1CodeRunnerError({
      code: "flow_runner_timeout_invalid",
      message: "timeoutMs must be a positive number.",
    });
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new FlowV1CodeRunnerError({
      code: "flow_runner_output_limit_invalid",
      message: "maxOutputBytes must be a positive integer.",
    });
  }
  if (input.signal?.aborted) {
    throw new FlowV1CodeRunnerError({
      code: "flow_runner_aborted",
      message: "Code execution was canceled before launch.",
    });
  }

  const bundleDir = prepareFlowV1ExecutionBundle(input);
  const executionDir = path.join(
    getDataDir(),
    "flow-v1",
    "executions",
    randomUUID(),
  );
  fs.mkdirSync(executionDir, { recursive: true });
  const inputPath = path.join(executionDir, "input.json");
  const resultPath = path.join(executionDir, "result.json");
  fs.writeFileSync(inputPath, JSON.stringify(input.context), "utf8");

  const modulePath = path.join(bundleDir, ...input.file.split("/"));
  const environment = buildEnvironment(
    input.environment,
    input.secrets,
    inputPath,
    resultPath,
  );
  let command: string;
  let args: string[];
  if (module.mediaKind === "shell") {
    command = "/bin/bash";
    args = [modulePath];
  } else if (module.mediaKind === "javascript") {
    command = process.execPath;
    environment.TUTTI_FLOW_RUNNER_CONFIG = JSON.stringify({
      moduleUrl: pathToFileURL(modulePath).href,
      exportName: input.exportName,
      inputPath,
      resultPath,
    });
    args = ["--input-type=module", "--eval", JS_WORKER_SOURCE];
  } else {
    throw new FlowV1CodeRunnerError({
      code: "flow_runner_module_type_invalid",
      message: `Code module ${input.file} must be JavaScript or Bash.`,
    });
  }

  try {
    const processResult = await runChild({
      command,
      args,
      cwd: input.projectCwd ?? bundleDir,
      env: environment,
      timeoutMs,
      maxOutputBytes,
      signal: input.signal,
      redactions: Object.values(input.secrets ?? {}),
    });
    if (processResult.exitCode !== 0) {
      throw new FlowV1CodeRunnerError({
        code: "flow_runner_exit_nonzero",
        message: `Code module ${input.file} exited with code ${processResult.exitCode}.`,
        ...processResult,
      });
    }
    if (!fs.existsSync(resultPath)) {
      throw new FlowV1CodeRunnerError({
        code: "flow_runner_result_missing",
        message: `Code module ${input.file} did not write a structured result.`,
        ...processResult,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    } catch (error) {
      throw new FlowV1CodeRunnerError({
        code: "flow_runner_result_invalid_json",
        message: `Code module ${input.file} wrote invalid result JSON: ${error instanceof Error ? error.message : String(error)}.`,
        ...processResult,
      });
    }
    if (!isFlowV1JsonValue(value)) {
      throw new FlowV1CodeRunnerError({
        code: "flow_runner_result_invalid",
        message: `Code module ${input.file} returned a non-JSON value.`,
        ...processResult,
      });
    }
    if (containsSecretValue(value, Object.values(input.secrets ?? {}))) {
      throw new FlowV1CodeRunnerError({
        code: "flow_runner_secret_output",
        message: `Code module ${input.file} returned a value containing a Secret.`,
        ...processResult,
      });
    }
    return { value, ...processResult };
  } finally {
    fs.rmSync(executionDir, { recursive: true, force: true });
  }
}

function containsSecretValue(
  value: FlowV1JsonValue,
  secretValues: string[],
): boolean {
  const nonEmptySecrets = secretValues.filter(Boolean);
  if (nonEmptySecrets.length === 0) {
    return false;
  }
  if (typeof value === "string") {
    return nonEmptySecrets.some((secret) => value.includes(secret));
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSecretValue(entry, nonEmptySecrets));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) =>
      containsSecretValue(entry, nonEmptySecrets),
    );
  }
  return false;
}

function buildEnvironment(
  extra: Record<string, string> | undefined,
  secrets: Record<string, string> | undefined,
  inputPath: string,
  resultPath: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  for (const name of [
    "HOME",
    "USER",
    "PATH",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SSH_AUTH_SOCK",
  ]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  for (const [name, value] of Object.entries({
    ...extra,
    ...secrets,
  })) {
    if (!ENV_NAME.test(name)) {
      throw new FlowV1CodeRunnerError({
        code: "flow_runner_environment_name_invalid",
        message: `Invalid environment variable name: ${name}.`,
      });
    }
    env[name] = value;
  }
  env.TUTTI_FLOW_INPUT_PATH = inputPath;
  env.TUTTI_FLOW_RESULT_PATH = resultPath;
  return env;
}

async function runChild(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  redactions: string[];
}): Promise<{
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode: number;
}> {
  const startedAt = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forcedError: FlowV1CodeRunnerError | null = null;

    const capture = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= input.maxOutputBytes) {
        target.push(chunk);
        return;
      }
      if (!forcedError) {
        forcedError = new FlowV1CodeRunnerError({
          code: "flow_runner_output_limit",
          message: `Code process exceeded ${input.maxOutputBytes} output bytes.`,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
        killProcessTree(child.pid);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

    const timeout = setTimeout(() => {
      forcedError = new FlowV1CodeRunnerError({
        code: "flow_runner_timeout",
        message: `Code process exceeded ${input.timeoutMs}ms.`,
      });
      killProcessTree(child.pid);
    }, input.timeoutMs);
    const abort = () => {
      forcedError = new FlowV1CodeRunnerError({
        code: "flow_runner_aborted",
        message: "Code execution was canceled.",
      });
      killProcessTree(child.pid);
    };
    input.signal?.addEventListener("abort", abort, { once: true });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      reject(
        new FlowV1CodeRunnerError({
          code: "flow_runner_spawn_failed",
          message: `Failed to launch code process: ${error.message}.`,
        }),
      );
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      const captured = {
        stdout: redact(
          Buffer.concat(stdout).toString("utf8"),
          input.redactions,
        ),
        stderr: redact(
          Buffer.concat(stderr).toString("utf8"),
          input.redactions,
        ),
      };
      if (forcedError) {
        reject(
          new FlowV1CodeRunnerError({
            code: forcedError.code,
            message: forcedError.message,
            ...captured,
            exitCode,
          }),
        );
        return;
      }
      resolve({
        ...captured,
        durationMs: Date.now() - startedAt,
        exitCode: exitCode ?? -1,
      });
    });
  });
}

function redact(value: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
      value,
    );
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // The process may have exited between the timer/event and this call.
  }
}
