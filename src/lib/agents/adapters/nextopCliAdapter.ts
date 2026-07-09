import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type {
  AgentRunInput,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentSessionRef,
  AgentSessionStatus,
  AgentTargetOption,
} from "../types";
import { createMockAgentAdapter, MOCK_AGENT_TARGET_ID } from "./mockAdapter";

type NextopCliAdapterOptions = {
  includeMockTarget?: boolean;
  cliPath?: string;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
  providerDetectionTimeoutMs?: number;
  providerModelsTimeoutMs?: number;
  commandDetector?: LocalCommandDetector;
  runner?: NextopCliRunner;
};

type NextopCliRunner = (
  args: string[],
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  },
) => Promise<unknown>;

type LocalCommandDetector = (command: string) => Promise<string | undefined>;

type NextopProviderStatus = {
  provider?: unknown;
  status?: unknown;
  detail?: unknown;
};

type NextopProvidersOutput = {
  providers?: unknown;
};

type NextopSessionOutput = {
  session?: unknown;
};

type NextopSessionSummaryOutput = {
  agentSessionId?: unknown;
  hasMore?: unknown;
  latestVersion?: unknown;
  messages?: unknown;
  session?: unknown;
};

type NextopComposerOptionsOutput = {
  effectiveSettings?: unknown;
  modelConfig?: unknown;
};

type NextopMessage = {
  role?: unknown;
  kind?: unknown;
  status?: unknown;
  text?: unknown;
  version?: unknown;
};

type NextopSession = {
  agentSessionId?: unknown;
  providerSessionId?: unknown;
  agentTargetId?: unknown;
  provider?: unknown;
  model?: unknown;
  status?: unknown;
  turnLifecycle?: unknown;
  title?: unknown;
  lastError?: unknown;
  settings?: unknown;
};

type NextopTurnLifecycle = {
  phase?: unknown;
  outcome?: unknown;
};

const DEFAULT_CLI_PATH = "tutti-dev";
const CLI_PATH_ENV_NAMES = ["TUTTI_CLI"] as const;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 360_000;
const DEFAULT_PROVIDER_DETECTION_TIMEOUT_MS = 3_000;
const DEFAULT_PROVIDER_MODELS_TIMEOUT_MS = 1_500;
const DEFAULT_LOCAL_COMMAND_TIMEOUT_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const TAIL_SUMMARY_LIMIT = 50;

type NextopAgentTargetSpec = {
  id: string;
  name: string;
  provider: string;
  startPath: string[];
};

// Daemon-owned system Agent Targets. Session creation is target-aware in
// tuttid: only the per-target start commands can launch sessions, so every
// launchable target needs an explicit CLI start path here.
const NEXTOP_AGENT_TARGETS: NextopAgentTargetSpec[] = [
  {
    id: "local:codex",
    name: "Codex",
    provider: "codex",
    startPath: ["codex", "start"],
  },
  {
    id: "local:claude-code",
    name: "Claude Code",
    provider: "claude-code",
    startPath: ["claude", "start"],
  },
];

export type NextopProviderAvailability = {
  provider: string;
  supported: boolean;
  reason?: string;
};

export function createNextopCliAgentAdapter(
  options: NextopCliAdapterOptions = {},
): AgentRuntimeAdapter {
  const mockAdapter = createMockAgentAdapter();
  const activeSessions = new Map<string, string>();
  const cliPath = resolveNextopCliPath({ cliPath: options.cliPath });
  const runner =
    options.runner ??
    ((args, runnerOptions) =>
      runNextopJson(cliPath, args, {
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        ...runnerOptions,
      }));
  const pollIntervalMs =
    options.pollIntervalMs ??
    readPositiveIntegerEnv("NEXTOP_POLL_INTERVAL_MS") ??
    DEFAULT_POLL_INTERVAL_MS;
  const waitTimeoutMs =
    options.waitTimeoutMs ??
    readPositiveIntegerEnv("NEXTOP_WAIT_TIMEOUT_MS") ??
    DEFAULT_WAIT_TIMEOUT_MS;
  const providerDetectionTimeoutMs =
    options.providerDetectionTimeoutMs ??
    readPositiveIntegerEnv("NEXTOP_PROVIDER_DETECTION_TIMEOUT_MS") ??
    DEFAULT_PROVIDER_DETECTION_TIMEOUT_MS;
  const providerModelsTimeoutMs =
    options.providerModelsTimeoutMs ??
    readPositiveIntegerEnv("NEXTOP_PROVIDER_MODELS_TIMEOUT_MS") ??
    DEFAULT_PROVIDER_MODELS_TIMEOUT_MS;
  const commandDetector = options.commandDetector ?? detectLocalCommand;

  const adapter: AgentRuntimeAdapter = {
    id: "nextop-cli",
    label: "Nextop CLI agent adapter",
    async listTargets(): Promise<AgentTargetOption[]> {
      const availability = await readNextopProviderAvailability(
        runner,
        providerDetectionTimeoutMs,
      );
      const codexPath = await commandDetector("codex");
      if (codexPath && !availability.get("codex")?.supported) {
        availability.set("codex", {
          provider: "codex",
          supported: true,
          reason: codexPath,
        });
      }

      const targets = await Promise.all(
        NEXTOP_AGENT_TARGETS.map(async (spec): Promise<AgentTargetOption> => {
          const status = availability.get(spec.provider);
          const supported = status?.supported === true;
          return {
            id: spec.id,
            name: spec.name,
            provider: spec.provider,
            supported,
            models: supported
              ? await readProviderModels(
                  spec.provider,
                  runner,
                  providerModelsTimeoutMs,
                )
              : [],
            reason: status?.reason,
          };
        }),
      );

      if (options.includeMockTarget === false) {
        return targets;
      }

      return [...(await mockAdapter.listTargets()), ...targets];
    },
    async startSession(input: {
      agent: string;
      model?: string;
      cwd: string;
      prompt: string;
    }): Promise<AgentSessionRef> {
      const target = findNextopAgentTarget(input.agent);
      if (!target) {
        throw new Error(
          `Unknown agent target "${input.agent}". Known agent targets: ${knownAgentTargetIds().join(", ")}.`,
        );
      }

      const model =
        input.model || (await resolveDefaultModel(target.provider, runner));
      const startOutput = await runner([
        "--json",
        ...target.startPath,
        "--model",
        model,
        "--prompt",
        input.prompt,
        "--cwd",
        input.cwd,
      ]);
      const session = parseSessionFromOutput(startOutput);
      return {
        ...session,
        agent: target.id,
        model: session.model ?? model,
      };
    },
    async cancelSession(agentSessionId: string): Promise<void> {
      const trimmed = agentSessionId.trim();
      if (!trimmed) {
        return;
      }
      await cancelSession(trimmed, runner);
    },
    async *run(input: AgentRunInput): AsyncGenerator<AgentRuntimeEvent> {
      console.info(
        `[agent-runtime:${adapter.id}] agent=${input.agent} runId=${input.runId} cwd=${input.cwd}`,
      );

      if (input.agent === MOCK_AGENT_TARGET_ID) {
        yield* mockAdapter.run(input);
        return;
      }

      const target = findNextopAgentTarget(input.agent);
      if (!target) {
        yield {
          type: "error",
          code: "UNKNOWN_AGENT_TARGET",
          message: `Unknown agent target "${input.agent}". Known agent targets: ${knownAgentTargetIds().join(", ")}.`,
          retryable: false,
        };
        yield { type: "done", status: "failed", reason: "error" };
        return;
      }

      const model =
        input.model || (await resolveDefaultModel(target.provider, runner));
      let cancelPromise: Promise<void> | undefined;
      const requestCancel = () => {
        const agentSessionId = activeSessions.get(input.runId);
        if (!agentSessionId) {
          return Promise.resolve();
        }
        cancelPromise ??= cancelSession(agentSessionId, runner);
        return cancelPromise;
      };
      const abortListener = () => {
        void requestCancel();
      };
      input.signal?.addEventListener("abort", abortListener, { once: true });

      try {
        const attachSessionId = input.attachSessionId?.trim();
        const resumeSessionId = input.resumeSessionId?.trim();
        let latestVersion = 0;
        let initialSession: RequiredSessionRef;

        if (attachSessionId) {
          yield {
            type: "status",
            status: "spawning",
            message: `Attaching to Nextop session ${attachSessionId}.`,
          };

          activeSessions.set(input.runId, attachSessionId);
          const fallbackSession: RequiredSessionRef = {
            agentSessionId: attachSessionId,
            agent: target.id,
            model,
            status: "running",
          };
          const baseline = parseSessionSummary(
            await runner(
              [
                "--json",
                "agent",
                "session-summary",
                "--session-id",
                attachSessionId,
                "--limit",
                "1",
              ],
              { signal: input.signal },
            ),
            fallbackSession,
          );
          latestVersion = baseline.latestVersion;
          initialSession = {
            ...fallbackSession,
            ...baseline.session,
            agentSessionId: attachSessionId,
          };
        } else if (resumeSessionId) {
          yield {
            type: "status",
            status: "spawning",
            message: `Sending prompt to Nextop session ${resumeSessionId}.`,
          };

          activeSessions.set(input.runId, resumeSessionId);
          const fallbackSession: RequiredSessionRef = {
            agentSessionId: resumeSessionId,
            agent: target.id,
            model,
            status: "running",
          };
          const baseline = parseSessionSummary(
            await runner(
              [
                "--json",
                "agent",
                "session-summary",
                "--session-id",
                resumeSessionId,
                "--limit",
                "1",
              ],
              { signal: input.signal },
            ),
            fallbackSession,
          );
          latestVersion = baseline.latestVersion;

          const sendOutput = await runner(
            [
              "--json",
              "agent",
              "send",
              "--session-id",
              resumeSessionId,
              "--prompt",
              input.prompt,
            ],
            { signal: input.signal },
          );
          initialSession = createResumedSession(
            sendOutput,
            fallbackSession,
          );
        } else {
          yield {
            type: "status",
            status: "spawning",
            message: `Starting ${target.name} agent session through Nextop CLI.`,
          };

          const startOutput = await runner(
            [
              "--json",
              ...target.startPath,
              "--model",
              model,
              "--prompt",
              input.prompt,
              "--cwd",
              input.cwd,
            ],
            { signal: input.signal },
          );
          initialSession = parseSessionFromOutput(startOutput);
        }

        const agentSessionId = initialSession.agentSessionId;
        activeSessions.set(input.runId, agentSessionId);

        yield sessionRefEvent(input, target.id, model, initialSession);
        yield {
          type: "status",
          status: "running",
          message: `Nextop session ${agentSessionId} is running.`,
        };

        let latestText = "";

        // Turn completion is decided by `agent wait` reasons. Session-level
        // status/turnLifecycle from session-summary is stale while a turn is
        // active, so it must not be used as a terminal signal.
        while (true) {
          if (input.signal?.aborted) {
            await requestCancel();
            yield { type: "done", status: "canceled", reason: "cancelled" };
            return;
          }

          const waitOutput = await runner(
            [
              "--json",
              "agent",
              "wait",
              "--session-id",
              agentSessionId,
              "--after-version",
              String(latestVersion),
              "--timeout-ms",
              String(waitTimeoutMs),
            ],
            { signal: input.signal },
          );
          const wait = parseSessionSummary(waitOutput, initialSession);
          const reason = readWaitReason(waitOutput);
          latestVersion = Math.max(latestVersion, wait.latestVersion);
          const nextText = latestAssistantText(wait.messages);
          if (nextText) {
            latestText = nextText;
          }

          yield sessionRefEvent(input, target.id, model, {
            ...initialSession,
            ...wait.session,
            agentSessionId,
          });

          if (reason === "completed" || reason === "waiting_input") {
            const finalText =
              (await readLatestAssistantTextFromTail(
                agentSessionId,
                initialSession,
                runner,
                input.signal,
              )) || latestText;
            if (finalText) {
              yield { type: "text_delta", text: finalText };
            }
            yield { type: "done", status: "completed", reason: "completed" };
            return;
          }

          if (reason === "canceled") {
            yield { type: "done", status: "canceled", reason: "cancelled" };
            return;
          }

          if (reason === "failed") {
            const message =
              readOptionalString(wait.session.lastError) ??
              "Nextop agent session failed.";
            yield {
              type: "error",
              code: "NEXTOP_SESSION_FAILED",
              message,
              retryable: false,
            };
            yield { type: "done", status: "failed", reason: "error" };
            return;
          }

          // ready / timeout / waiting / waiting_approval: the turn is still in
          // flight (or blocked on an in-GUI approval); keep waiting. `agent
          // wait` blocks server-side, so no extra delay is needed when it
          // returned with fresh messages.
          if (reason !== "ready" && !wait.hasMore) {
            await delay(pollIntervalMs, input.signal);
          }
        }
      } catch (error) {
        if (isAbortError(error) || input.signal?.aborted) {
          yield { type: "done", status: "canceled", reason: "cancelled" };
          return;
        }
        yield {
          type: "error",
          code: "NEXTOP_CLI_ERROR",
          message: error instanceof Error ? error.message : "Nextop CLI failed.",
          retryable: true,
        };
        yield { type: "done", status: "failed", reason: "error" };
      } finally {
        input.signal?.removeEventListener("abort", abortListener);
        activeSessions.delete(input.runId);
      }
    },
    async cancel(runId: string): Promise<void> {
      const agentSessionId = activeSessions.get(runId);
      if (!agentSessionId) {
        return;
      }
      await cancelSession(agentSessionId, runner);
    },
    async openSession(agentSessionId: string): Promise<void> {
      const trimmed = agentSessionId.trim();
      if (!trimmed) {
        throw new Error("agentSessionId is required");
      }
      await runner(["--json", "agent", "open", "--session-id", trimmed]);
    },
  };

  return adapter;
}

export function resolveNextopCliPath(options: { cliPath?: string } = {}): string {
  const configuredPath = readOptionalString(options.cliPath);
  if (configuredPath) {
    return configuredPath;
  }

  for (const envName of CLI_PATH_ENV_NAMES) {
    const envPath = readOptionalString(process.env[envName]);
    if (envPath) {
      return envPath;
    }
  }

  return DEFAULT_CLI_PATH;
}

export async function runNextopJson(
  cliPath: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const output = await runNextop(cliPath, args, options);
  return parseNextopJson(output.stdout);
}

export function parseNextopJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(
      `Nextop CLI returned invalid JSON: ${
        error instanceof Error ? error.message : "unknown parse error"
      }`,
    );
  }
}

export function parseProviderAvailability(
  value: unknown,
): Map<string, NextopProviderAvailability> {
  const output = value as NextopProvidersOutput;
  const providers = Array.isArray(output.providers) ? output.providers : [];
  const availability = new Map<string, NextopProviderAvailability>();
  for (const item of providers) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const provider = normalizeNextopProvider(
      String((item as NextopProviderStatus).provider ?? ""),
    );
    if (!provider) {
      continue;
    }
    const status = readOptionalString((item as NextopProviderStatus).status);
    availability.set(provider, {
      provider,
      supported: status === "available",
      reason: readOptionalString((item as NextopProviderStatus).detail),
    });
  }
  return availability;
}

async function readNextopProviderAvailability(
  runner: NextopCliRunner,
  timeoutMs: number,
): Promise<Map<string, NextopProviderAvailability>> {
  try {
    return parseProviderAvailability(
      await runner(["--json", "agent", "providers"], { timeoutMs }),
    );
  } catch {
    return new Map();
  }
}

export function parseSessionFromOutput(value: unknown): RequiredSessionRef {
  const output = value as NextopSessionOutput;
  const session = normalizeSession(output.session);
  if (!session.agentSessionId) {
    throw new Error("Nextop CLI did not return agentSessionId.");
  }
  if (!session.agent) {
    throw new Error("Nextop CLI did not return a resolvable agent target.");
  }
  return session as RequiredSessionRef;
}

function createResumedSession(
  value: unknown,
  fallbackSession: RequiredSessionRef,
): RequiredSessionRef {
  const output = value as NextopSessionOutput;
  const session = {
    ...fallbackSession,
    ...normalizeSession(output.session),
  };
  return {
    ...session,
    agentSessionId: session.agentSessionId || fallbackSession.agentSessionId,
    agent: session.agent || fallbackSession.agent,
    status: session.status ?? "running",
  };
}

export function parseSessionSummary(
  value: unknown,
  fallbackSession: RequiredSessionRef,
): {
  hasMore: boolean;
  latestVersion: number;
  messages: NextopMessage[];
  session: RequiredSessionRef & {
    lastError?: string;
  };
} {
  const output = value as NextopSessionSummaryOutput;
  const session = {
    ...fallbackSession,
    ...normalizeSession(output.session),
  };
  const latestVersion = readNumber(output.latestVersion) ?? 0;
  const messages = Array.isArray(output.messages)
    ? output.messages.flatMap((message): NextopMessage[] =>
        message && typeof message === "object" ? [message as NextopMessage] : [],
      )
    : [];

  return {
    hasMore: output.hasMore === true,
    latestVersion,
    messages,
    session,
  };
}

export function readWaitReason(waitOutput: unknown): string | undefined {
  const output = readRecord(waitOutput);
  return readOptionalString(output?.reason);
}

export function latestAssistantText(messages: NextopMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = readOptionalString(message.role);
    if (role !== "assistant" && role !== "agent") {
      continue;
    }
    const text = readOptionalString(message.text);
    if (text) {
      return text;
    }
  }
  return "";
}

export function newestAssistantText(messages: NextopMessage[]): string {
  for (const message of messages) {
    const role = readOptionalString(message.role);
    if (role !== "assistant" && role !== "agent") {
      continue;
    }
    const text = readOptionalString(message.text);
    if (text) {
      return text;
    }
  }
  return "";
}

type RequiredSessionRef = AgentSessionRef & {
  agentSessionId: string;
  agent: string;
  lastError?: string;
};

async function detectLocalCommand(command: string): Promise<string | undefined> {
  const commandPath = await findExecutablePath(command);
  if (!commandPath) {
    return undefined;
  }

  try {
    await runNextop(commandPath, ["--version"], {
      timeoutMs: DEFAULT_LOCAL_COMMAND_TIMEOUT_MS,
    });
    return commandPath;
  } catch {
    return undefined;
  }
}

async function findExecutablePath(command: string): Promise<string | undefined> {
  if (command.includes("/")) {
    return (await isExecutable(command)) ? command : undefined;
  }

  const pathValue = createCliEnv().PATH ?? "";
  const seen = new Set<string>();
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || seen.has(directory)) {
      continue;
    }
    seen.add(directory);
    const candidate = join(directory, command);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function createCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.PATH = createCliPath(env.PATH);
  return env;
}

function createCliPath(pathValue: string | undefined): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  const addEntry = (entry: string) => {
    if (!entry || seen.has(entry)) {
      return;
    }
    seen.add(entry);
    entries.push(entry);
  };

  for (const directory of localBinDirectories()) {
    addEntry(directory);
  }
  for (const directory of (pathValue ?? "").split(delimiter)) {
    addEntry(directory);
  }

  return entries.join(delimiter);
}

function localBinDirectories(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

function runNextop(
  cliPath: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child = spawn(cliPath, args, {
      env: createCliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const settle = (
      callback: () => void,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      settle(() => reject(createAbortError()));
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        settle(() =>
          reject(new Error(`Nextop CLI timed out after ${options.timeoutMs}ms.`)),
        );
      }, options.timeoutMs);
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle(() =>
        reject(
          new Error(
            `Failed to start Nextop CLI (${cliPath}): ${error.message}`,
          ),
        ),
      );
    });
    child.on("close", (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const suffix = stderr.trim() || stdout.trim() || signal || `exit ${code}`;
        reject(new Error(`Nextop CLI failed: ${suffix}`));
      });
    });
  });
}

async function readProviderModels(
  provider: string,
  runner: NextopCliRunner,
  timeoutMs: number,
): Promise<string[]> {
  try {
    const output = (await runner(
      [
        "--json",
        "agent",
        "composer-options",
        "--provider",
        provider,
      ],
      { timeoutMs },
    )) as NextopComposerOptionsOutput;
    return parseComposerModels(output);
  } catch {
    return [];
  }
}

function parseComposerModels(output: NextopComposerOptionsOutput): string[] {
  const modelConfig = readRecord(output.modelConfig);
  const effectiveSettings = readRecord(output.effectiveSettings);
  const models = new Set<string>();

  const currentValue = readOptionalString(modelConfig?.currentValue);
  const defaultValue = readOptionalString(modelConfig?.defaultValue);
  const effectiveModel = readOptionalString(effectiveSettings?.model);
  for (const model of [effectiveModel, currentValue, defaultValue]) {
    if (model) {
      models.add(model);
    }
  }

  const options = Array.isArray(modelConfig?.options) ? modelConfig.options : [];
  for (const option of options) {
    const record = readRecord(option);
    const value = readOptionalString(record?.value) ?? readOptionalString(record?.id);
    if (value) {
      models.add(value);
    }
  }

  return [...models];
}

async function resolveDefaultModel(
  provider: string,
  runner: NextopCliRunner,
): Promise<string> {
  const output = (await runner([
    "--json",
    "agent",
    "composer-options",
    "--provider",
    provider,
  ])) as NextopComposerOptionsOutput;
  const models = parseComposerModels(output);
  const model = models[0];
  if (!model) {
    throw new Error(`No default model is available for ${provider}.`);
  }
  return model;
}

async function readLatestAssistantTextFromTail(
  agentSessionId: string,
  fallbackSession: RequiredSessionRef,
  runner: NextopCliRunner,
  signal?: AbortSignal,
): Promise<string> {
  let beforeVersion: number | undefined;

  while (true) {
    const args = [
      "--json",
      "agent",
      "session-summary",
      "--session-id",
      agentSessionId,
      "--order",
      "desc",
      "--limit",
      String(TAIL_SUMMARY_LIMIT),
    ];
    if (beforeVersion !== undefined) {
      args.push("--before-version", String(beforeVersion));
    }

    const summary = parseSessionSummary(
      await runner(args, { signal }),
      fallbackSession,
    );
    const text = newestAssistantText(summary.messages);
    if (text) {
      return text;
    }
    if (!summary.hasMore) {
      return "";
    }

    const nextBeforeVersion = oldestMessageVersion(summary.messages);
    if (
      nextBeforeVersion === undefined ||
      (beforeVersion !== undefined && nextBeforeVersion >= beforeVersion)
    ) {
      throw new Error(
        "Nextop CLI session-summary did not provide a usable before-version cursor.",
      );
    }
    beforeVersion = nextBeforeVersion;
  }
}

function oldestMessageVersion(messages: NextopMessage[]): number | undefined {
  return messages.reduce<number | undefined>((oldest, message) => {
    const version = readNumber(message.version);
    if (version === undefined) {
      return oldest;
    }
    return oldest === undefined ? version : Math.min(oldest, version);
  }, undefined);
}

function findNextopAgentTarget(
  agent: string,
): NextopAgentTargetSpec | undefined {
  const value = agent.trim();
  return NEXTOP_AGENT_TARGETS.find((target) => target.id === value);
}

function knownAgentTargetIds(): string[] {
  return [
    MOCK_AGENT_TARGET_ID,
    ...NEXTOP_AGENT_TARGETS.map((target) => target.id),
  ];
}

function agentTargetIdForProvider(
  provider: string | undefined,
): string | undefined {
  if (!provider) {
    return undefined;
  }
  const normalized = normalizeNextopProvider(provider);
  return NEXTOP_AGENT_TARGETS.find((target) => target.provider === normalized)
    ?.id;
}

function normalizeNextopProvider(provider: string): string {
  const value = provider.trim().toLowerCase();
  if (value === "codex") {
    return "codex";
  }
  if (value === "claude" || value === "claude-code") {
    return "claude-code";
  }
  return value;
}

function sessionRefEvent(
  input: AgentRunInput,
  agent: string,
  model: string,
  session: RequiredSessionRef,
): Extract<AgentRuntimeEvent, { type: "session_ref" }> {
  return {
    type: "session_ref",
    session: {
      agentSessionId: session.agentSessionId,
      ...(session.providerSessionId
        ? { providerSessionId: session.providerSessionId }
        : {}),
      agent: session.agent || agent,
      model: session.model || model || input.model,
      ...(session.status ? { status: session.status } : {}),
      ...(session.title ? { title: session.title } : {}),
    },
  };
}

function normalizeSession(value: unknown): Partial<RequiredSessionRef> {
  const session = readRecord(value) as NextopSession | undefined;
  if (!session) {
    return {};
  }
  const agentSessionId = readOptionalString(session.agentSessionId);
  const providerSessionId = readOptionalString(session.providerSessionId);
  const agent =
    readOptionalString(session.agentTargetId) ??
    agentTargetIdForProvider(readOptionalString(session.provider));
  const settings = readRecord(session.settings);
  const model =
    readOptionalString(session.model) ??
    readOptionalString(settings?.model);
  const status = normalizeSessionStatus(session.status, session.turnLifecycle);
  const title = readOptionalString(session.title);
  const lastError = readOptionalString(session.lastError);

  return {
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(status ? { status } : {}),
    ...(title ? { title } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

function normalizeSessionStatus(
  value: unknown,
  turnLifecycleValue?: unknown,
): AgentSessionStatus | undefined {
  const status = readOptionalString(value);
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "running":
    case "working":
    case "waiting":
    case "created":
    case "active": {
      const turnStatus = normalizeTurnLifecycleStatus(turnLifecycleValue);
      return turnStatus ?? "running";
    }
    case undefined:
      return normalizeTurnLifecycleStatus(turnLifecycleValue);
    default:
      return normalizeTurnLifecycleStatus(turnLifecycleValue) ?? "running";
  }
}

function normalizeTurnLifecycleStatus(
  value: unknown,
): AgentSessionStatus | undefined {
  const turnLifecycle = readRecord(value) as NextopTurnLifecycle | undefined;
  const phase = readOptionalString(turnLifecycle?.phase);
  if (phase !== "settled") {
    return undefined;
  }

  const outcome = readOptionalString(turnLifecycle?.outcome);
  switch (outcome) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return undefined;
  }
}

async function cancelSession(
  agentSessionId: string,
  runner: NextopCliRunner,
): Promise<void> {
  try {
    await runner(["--json", "agent", "cancel", "--session-id", agentSessionId]);
  } catch {
    // Cancellation is best-effort; the run path still reports local cancellation.
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError());
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error && error.name === "AbortError"
  );
}

function createAbortError(): Error {
  const error = new Error("Nextop CLI request aborted.");
  error.name = "AbortError";
  return error;
}
