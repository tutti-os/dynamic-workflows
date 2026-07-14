import { spawn } from "node:child_process";
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
  runner?: NextopCliRunner;
};

type NextopCliRunner = (
  args: string[],
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  },
) => Promise<unknown>;

type NextopProvidersOutput = {
  schemaVersion?: unknown;
  defaultProviderId?: unknown;
  providers?: unknown;
};

type NextopAgentsOutput = {
  schemaVersion?: unknown;
  defaultAgentTargetId?: unknown;
  agents?: unknown;
};

type NextopAgentCatalogEntry = {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  availability?: unknown;
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
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const TAIL_SUMMARY_LIMIT = 50;

type NextopAgentTargetSpec = {
  id: string;
  name: string;
  provider: string;
  supported: boolean;
  reason?: string;
  isDefault: boolean;
  cliContract: "agent-id" | "provider-compat";
};

type NextopAgentCatalog = {
  targets: NextopAgentTargetSpec[];
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
  let catalogPromise: Promise<NextopAgentCatalog> | undefined;
  const loadCatalog = (refresh = false): Promise<NextopAgentCatalog> => {
    if (refresh || !catalogPromise) {
      catalogPromise = readNextopAgentCatalog(
        runner,
        providerDetectionTimeoutMs,
      ).catch((error) => {
        catalogPromise = undefined;
        throw error;
      });
    }
    return catalogPromise;
  };

  const adapter: AgentRuntimeAdapter = {
    id: "nextop-cli",
    label: "Nextop CLI agent adapter",
    async listTargets(): Promise<AgentTargetOption[]> {
      const catalog = await loadCatalog(true);
      const targets = await Promise.all(
        catalog.targets.map(async (spec): Promise<AgentTargetOption> => {
          return {
            id: spec.id,
            name: spec.name,
            provider: spec.provider,
            supported: spec.supported,
            models: spec.supported
              ? await readAgentModels(spec, runner, providerModelsTimeoutMs)
              : [],
            isDefault: spec.isDefault,
            reason: spec.reason,
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
      const target = findNextopAgentTarget(await loadCatalog(), input.agent);
      if (!target) {
        throw new Error(
          `Unknown agent target "${input.agent}". Run tutti --json agent list to discover available agents.`,
        );
      }

      const model = input.model || (await resolveDefaultModel(target, runner));
      const startOutput = await runner([
        ...startCommand(target),
        "--model",
        model,
        "--prompt",
        input.prompt,
        "--cwd",
        input.cwd,
      ]);
      const session = parseSessionFromOutput(startOutput, target.id);
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

      const target = findNextopAgentTarget(await loadCatalog(), input.agent);
      if (!target) {
        yield {
          type: "error",
          code: "UNKNOWN_AGENT_TARGET",
          message: `Unknown agent target "${input.agent}". Run tutti --json agent list to discover available agents.`,
          retryable: false,
        };
        yield { type: "done", status: "failed", reason: "error" };
        return;
      }

      const model = input.model || (await resolveDefaultModel(target, runner));
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
          const summaryOutput = await runner(
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
          );
          assertSessionMatchesAgentTarget(summaryOutput, target);
          const baseline = parseSessionSummary(summaryOutput, fallbackSession);
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
          const summaryOutput = await runner(
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
          );
          assertSessionMatchesAgentTarget(summaryOutput, target);
          const baseline = parseSessionSummary(summaryOutput, fallbackSession);
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
          initialSession = createResumedSession(sendOutput, fallbackSession);
        } else {
          yield {
            type: "status",
            status: "spawning",
            message: `Starting ${target.name} agent session through Nextop CLI.`,
          };

          const startOutput = await runner(
            [
              ...startCommand(target),
              "--model",
              model,
              "--prompt",
              input.prompt,
              "--cwd",
              input.cwd,
            ],
            { signal: input.signal },
          );
          initialSession = parseSessionFromOutput(startOutput, target.id);
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
          const rawTerminalStatus = readRawNonSuccessTerminalStatus(waitOutput);
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

          if (reason === "canceled" || rawTerminalStatus === "canceled") {
            yield { type: "done", status: "canceled", reason: "cancelled" };
            return;
          }

          if (reason === "failed" || rawTerminalStatus === "failed") {
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
          message:
            error instanceof Error ? error.message : "Nextop CLI failed.",
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

export function resolveNextopCliPath(
  options: { cliPath?: string } = {},
): string {
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

export function parseAgentCatalog(value: unknown): NextopAgentCatalog {
  const output = value as NextopAgentsOutput;
  if (output.schemaVersion !== 1 || !Array.isArray(output.agents)) {
    throw new Error("Nextop CLI returned an unsupported agent catalog.");
  }
  const defaultAgentTargetId =
    readOptionalString(output.defaultAgentTargetId) ?? "";
  const seen = new Set<string>();
  const targets = output.agents.map((item, index) => {
    const entry = readRecord(item) as NextopAgentCatalogEntry | undefined;
    const id = readOptionalString(entry?.id);
    const name = readOptionalString(entry?.name);
    const provider = normalizeNextopProvider(
      readOptionalString(entry?.provider) ?? "",
    );
    if (!id || !name || !provider || seen.has(id)) {
      throw new Error(
        `Nextop CLI returned an invalid agent catalog entry at index ${index}.`,
      );
    }
    seen.add(id);
    const availability = readRecord(entry?.availability);
    const status = readOptionalString(availability?.status);
    return {
      id,
      name,
      provider,
      supported: status === "available",
      reason: readOptionalString(availability?.detail),
      isDefault: id === defaultAgentTargetId,
      cliContract: "agent-id" as const,
    };
  });
  if (
    (targets.length === 0 && defaultAgentTargetId) ||
    (targets.length > 0 && !targets.some((target) => target.isDefault))
  ) {
    throw new Error("Nextop CLI returned an invalid default agent target.");
  }
  return { targets };
}

export function parseLegacyAgentCatalog(value: unknown): NextopAgentCatalog {
  const output = value as NextopProvidersOutput;
  if (!Array.isArray(output.providers)) {
    throw new Error("Nextop CLI returned an invalid legacy provider catalog.");
  }
  const defaultProvider = normalizeNextopProvider(
    readOptionalString(output.defaultProviderId) ?? "",
  );
  const seen = new Set<string>();
  const targets = output.providers.flatMap(
    (item, index): NextopAgentTargetSpec[] => {
      const record = readRecord(item);
      const provider = normalizeNextopProvider(
        readOptionalString(record?.providerId) ??
          readOptionalString(record?.provider) ??
          "",
      );
      if (!provider) {
        throw new Error(
          `Nextop CLI returned an invalid legacy provider at index ${index}.`,
        );
      }
      const explicitAgentTargetId = readOptionalString(record?.agentTargetId);
      if (output.schemaVersion === 2 && !explicitAgentTargetId) {
        throw new Error(
          `Nextop CLI legacy provider ${provider} does not resolve to one agent target.`,
        );
      }
      const id = explicitAgentTargetId ?? `local:${provider}`;
      if (seen.has(id)) {
        throw new Error(
          `Nextop CLI returned duplicate legacy agent target ${id}.`,
        );
      }
      seen.add(id);
      const availability = readRecord(record?.availability);
      const status =
        readOptionalString(availability?.status) ??
        readOptionalString(record?.status);
      const legacyPath = legacyStartPath(provider);
      const detail =
        readOptionalString(availability?.detail) ??
        readOptionalString(record?.detail);
      return [
        {
          id,
          name:
            readOptionalString(record?.displayName) ??
            readOptionalString(record?.name) ??
            provider,
          provider,
          supported: status === "available" && Boolean(legacyPath),
          reason:
            detail ??
            (legacyPath
              ? undefined
              : "This legacy daemon cannot start this agent runtime."),
          isDefault: provider === defaultProvider,
          cliContract: "provider-compat" as const,
        },
      ];
    },
  );
  if (!targets.some((target) => target.isDefault)) {
    const fallback = targets.find((target) => target.supported) ?? targets[0];
    if (fallback) fallback.isDefault = true;
  }
  return { targets };
}

async function readNextopAgentCatalog(
  runner: NextopCliRunner,
  timeoutMs: number,
): Promise<NextopAgentCatalog> {
  try {
    return parseAgentCatalog(
      await runner(["--json", "agent", "list"], { timeoutMs }),
    );
  } catch (error) {
    if (!isUnknownAgentListCommand(error)) {
      throw error;
    }
  }
  return parseLegacyAgentCatalog(
    await runner(["--json", "agent", "providers"], { timeoutMs }),
  );
}

export function isUnknownAgentListCommand(error: unknown): boolean {
  const message = error instanceof Error ? error.message.trim() : "";
  const detail = message.startsWith("Nextop CLI failed: ")
    ? message.slice("Nextop CLI failed: ".length).trim()
    : message;
  return detail === "unknown command: agent list";
}

export function parseSessionFromOutput(
  value: unknown,
  fallbackAgentTargetId?: string,
): RequiredSessionRef {
  const output = value as NextopSessionOutput;
  const session = {
    ...(fallbackAgentTargetId ? { agent: fallbackAgentTargetId } : {}),
    ...normalizeSession(output.session),
  };
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
        message && typeof message === "object"
          ? [message as NextopMessage]
          : [],
      )
    : [];

  return {
    hasMore: output.hasMore === true,
    latestVersion,
    messages,
    session,
  };
}

function assertSessionMatchesAgentTarget(
  value: unknown,
  target: NextopAgentTargetSpec,
): void {
  if (target.cliContract !== "agent-id") {
    return;
  }
  const output = value as NextopSessionSummaryOutput;
  const session = readRecord(output.session) as NextopSession | undefined;
  const actualAgentTargetId = readOptionalString(session?.agentTargetId);
  if (!actualAgentTargetId) {
    throw new Error(
      `Nextop session summary did not return an agent target for ${target.id}.`,
    );
  }
  if (actualAgentTargetId !== target.id) {
    throw new Error(
      `Nextop session belongs to agent target ${actualAgentTargetId}, not ${target.id}.`,
    );
  }
}

export function readWaitReason(waitOutput: unknown): string | undefined {
  const output = readRecord(waitOutput);
  return readOptionalString(output?.reason);
}

function readRawNonSuccessTerminalStatus(
  waitOutput: unknown,
): AgentSessionStatus | undefined {
  const output = readRecord(waitOutput);
  const session = readRecord(output?.session) as NextopSession | undefined;
  const status = readOptionalString(session?.status);
  switch (status) {
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return undefined;
  }
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

    const settle = (callback: () => void) => {
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
          reject(
            new Error(`Nextop CLI timed out after ${options.timeoutMs}ms.`),
          ),
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
        const suffix =
          stderr.trim() || stdout.trim() || signal || `exit ${code}`;
        reject(new Error(`Nextop CLI failed: ${suffix}`));
      });
    });
  });
}

async function readAgentModels(
  target: NextopAgentTargetSpec,
  runner: NextopCliRunner,
  timeoutMs: number,
): Promise<string[]> {
  try {
    const output = (await runner(composerOptionsCommand(target), {
      timeoutMs,
    })) as NextopComposerOptionsOutput;
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

  const options = Array.isArray(modelConfig?.options)
    ? modelConfig.options
    : [];
  for (const option of options) {
    const record = readRecord(option);
    const value =
      readOptionalString(record?.value) ?? readOptionalString(record?.id);
    if (value) {
      models.add(value);
    }
  }

  return [...models];
}

async function resolveDefaultModel(
  target: NextopAgentTargetSpec,
  runner: NextopCliRunner,
): Promise<string> {
  const output = (await runner(
    composerOptionsCommand(target),
  )) as NextopComposerOptionsOutput;
  const models = parseComposerModels(output);
  const model = models[0];
  if (!model) {
    throw new Error(`No default model is available for ${target.id}.`);
  }
  return model;
}

function composerOptionsCommand(target: NextopAgentTargetSpec): string[] {
  return target.cliContract === "agent-id"
    ? ["--json", "agent", "composer-options", "--agent-id", target.id]
    : ["--json", "agent", "composer-options", "--provider", target.provider];
}

function startCommand(target: NextopAgentTargetSpec): string[] {
  if (target.cliContract === "agent-id") {
    return ["--json", "agent", "start", "--agent-id", target.id];
  }
  const path = legacyStartPath(target.provider);
  if (!path) {
    throw new Error(
      `The legacy daemon cannot start agent target ${target.id}.`,
    );
  }
  return ["--json", ...path];
}

function legacyStartPath(provider: string): string[] | undefined {
  switch (normalizeNextopProvider(provider)) {
    case "codex":
      return ["codex", "start"];
    case "claude-code":
      return ["claude", "start"];
    default:
      return undefined;
  }
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
  catalog: NextopAgentCatalog,
  agent: string,
): NextopAgentTargetSpec | undefined {
  const value = agent.trim();
  return catalog.targets.find((target) => target.id === value);
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
  const agent = readOptionalString(session.agentTargetId);
  const settings = readRecord(session.settings);
  const model =
    readOptionalString(session.model) ?? readOptionalString(settings?.model);
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
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function createAbortError(): Error {
  const error = new Error("Nextop CLI request aborted.");
  error.name = "AbortError";
  return error;
}
