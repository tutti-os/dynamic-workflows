import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type {
  AgentProviderOption,
  AgentRunInput,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentSessionRef,
  AgentSessionStatus,
} from "../types";
import { createMockAgentAdapter } from "./mockAdapter";

type NextopCliAdapterOptions = {
  includeMockProvider?: boolean;
  cliPath?: string;
  pollIntervalMs?: number;
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
const CLI_PATH_ENV_NAMES = ["TUTTI_CLI", "NEXTOP_CLI_PATH"] as const;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 360_000;
const DEFAULT_PROVIDER_DETECTION_TIMEOUT_MS = 3_000;
const DEFAULT_PROVIDER_MODELS_TIMEOUT_MS = 1_500;
const DEFAULT_LOCAL_COMMAND_TIMEOUT_MS = 2_000;
const POLL_SUMMARY_LIMIT = 100;
const TAIL_SUMMARY_LIMIT = 50;
const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "canceled"]);

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
    async listProviders(): Promise<AgentProviderOption[]> {
      const providersOutput = await readNextopProviderOptions(
        runner,
        providerDetectionTimeoutMs,
      );
      const providerOptions = await applyLocalProviderDetections(
        providersOutput,
        commandDetector,
      );
      const realProviders = await Promise.all(
        providerOptions.map(async (provider) => ({
          ...provider,
          models: provider.supported
            ? await readProviderModels(
                provider.id,
                runner,
                providerModelsTimeoutMs,
              )
            : [],
        })),
      );

      if (options.includeMockProvider === false) {
        return realProviders;
      }

      return [...(await mockAdapter.listProviders()), ...realProviders];
    },
    async *run(input: AgentRunInput): AsyncGenerator<AgentRuntimeEvent> {
      console.info(
        `[agent-runtime:${adapter.id}] provider=${input.provider} runId=${input.runId} cwd=${input.cwd}`,
      );

      if (input.provider === "mock") {
        yield* mockAdapter.run(input);
        return;
      }

      const provider = normalizeNextopProvider(input.provider);
      const model = input.model || (await resolveDefaultModel(provider, runner));
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
            provider,
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
            provider,
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
            message: `Starting ${provider} session through Nextop CLI.`,
          };

          const startOutput = await runner(
            [
              "--json",
              ...providerStartPath(provider),
              "--model",
              model,
              "--prompt",
              input.prompt,
              "--cwd",
              input.cwd,
              "--visible",
            ],
            { signal: input.signal },
          );
          initialSession = parseSessionFromOutput(startOutput);
        }

        const agentSessionId = initialSession.agentSessionId;
        activeSessions.set(input.runId, agentSessionId);

        yield sessionRefEvent(input, provider, model, initialSession);
        yield {
          type: "status",
          status: "running",
          message: `Nextop session ${agentSessionId} is running.`,
        };

        let latestText = "";

        while (true) {
          if (input.signal?.aborted) {
            await requestCancel();
            yield { type: "done", status: "canceled", reason: "cancelled" };
            return;
          }

          const summaryOutput = await runner(
            [
              "--json",
              "agent",
              "session-summary",
              "--session-id",
              agentSessionId,
              "--after-version",
              String(latestVersion),
              "--limit",
              String(POLL_SUMMARY_LIMIT),
            ],
            { signal: input.signal },
          );
          const previousVersion = latestVersion;
          const summary = parseSessionSummary(summaryOutput, initialSession);
          latestVersion = Math.max(latestVersion, summary.latestVersion);
          if (summary.hasMore && latestVersion <= previousVersion) {
            throw new Error(
              "Nextop CLI session-summary did not advance while hasMore is true.",
            );
          }
          const nextText = latestAssistantText(summary.messages);
          if (nextText) {
            latestText = nextText;
          }

          yield sessionRefEvent(input, provider, model, {
            ...initialSession,
            ...summary.session,
            agentSessionId,
          });

          const status = normalizeSessionStatus(summary.session.status);
          if (status && TERMINAL_SESSION_STATUSES.has(status)) {
            if (status === "completed") {
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

            if (status === "canceled") {
              yield { type: "done", status: "canceled", reason: "cancelled" };
              return;
            }

            const message =
              readOptionalString(summary.session.lastError) ??
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

          if (summary.hasMore) {
            continue;
          }

          await delay(pollIntervalMs, input.signal);
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

export function parseProviderOptions(value: unknown): AgentProviderOption[] {
  const output = value as NextopProvidersOutput;
  const providers = Array.isArray(output.providers) ? output.providers : [];
  return providers
    .flatMap((item): AgentProviderOption[] => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const provider = normalizeNextopProvider(
        String((item as NextopProviderStatus).provider ?? ""),
      );
      if (!provider) {
        return [];
      }
      const status = readOptionalString((item as NextopProviderStatus).status);
      return [
        {
          id: provider,
          label: providerLabel(provider),
          supported: status === "available",
          models: [],
          reason: readOptionalString((item as NextopProviderStatus).detail),
        },
      ];
    })
    .sort((left, right) => providerSortOrder(left.id) - providerSortOrder(right.id));
}

async function readNextopProviderOptions(
  runner: NextopCliRunner,
  timeoutMs: number,
): Promise<AgentProviderOption[]> {
  try {
    return parseProviderOptions(
      await runner(["--json", "agent", "providers"], { timeoutMs }),
    );
  } catch {
    return [];
  }
}

async function applyLocalProviderDetections(
  providers: AgentProviderOption[],
  commandDetector: LocalCommandDetector,
): Promise<AgentProviderOption[]> {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const codexPath = await commandDetector("codex");

  if (codexPath) {
    const existing = byId.get("codex");
    byId.set("codex", {
      id: "codex",
      label: "Codex",
      supported: true,
      models: existing?.models ?? [],
      reason: existing?.supported ? existing.reason : codexPath,
    });
  }

  return [...byId.values()].sort(
    (left, right) => providerSortOrder(left.id) - providerSortOrder(right.id),
  );
}

export function parseSessionFromOutput(value: unknown): RequiredSessionRef {
  const output = value as NextopSessionOutput;
  const session = normalizeSession(output.session);
  if (!session.agentSessionId) {
    throw new Error("Nextop CLI did not return agentSessionId.");
  }
  if (!session.provider) {
    throw new Error("Nextop CLI did not return session provider.");
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
    provider: session.provider || fallbackSession.provider,
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
  provider: string;
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

function providerStartPath(provider: string): string[] {
  switch (normalizeNextopProvider(provider)) {
    case "codex":
      return ["codex", "start"];
    case "claude-code":
      return ["claude", "start"];
    default:
      return ["agent", "start", "--provider", provider];
  }
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

function providerLabel(provider: string): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude-code":
      return "Claude Code";
    default:
      return provider;
  }
}

function providerSortOrder(provider: string): number {
  switch (provider) {
    case "codex":
      return 0;
    case "claude-code":
      return 1;
    default:
      return 10;
  }
}

function sessionRefEvent(
  input: AgentRunInput,
  provider: string,
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
      provider: session.provider || provider,
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
  const provider = readOptionalString(session.provider);
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
    ...(provider ? { provider: normalizeNextopProvider(provider) } : {}),
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
