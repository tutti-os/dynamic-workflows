import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type {
  AgentPermissionModeOption,
  AgentConversationMessage,
  AgentRunInput,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentSessionRef,
  AgentSessionStatus,
  AgentTargetCatalogResult,
  AgentTargetOption,
} from "../types";
import { createMockAgentAdapter, MOCK_AGENT_TARGET_ID } from "./mockAdapter";

type NextopCliAdapterOptions = {
  includeMockTarget?: boolean;
  cliPath?: string;
  pollIntervalMs?: number;
  providerDetectionTimeoutMs?: number;
  providerDetectionOverallTimeoutMs?: number;
  providerDetectionRetries?: number;
  providerDetectionRetryBackoffMs?: number;
  providerModelsTimeoutMs?: number;
  catalogTtlMs?: number;
  catalogMaxStaleAgeMs?: number;
  now?: () => number;
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

type NextopSessionsOutput = {
  sessions?: unknown;
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
  permissionConfig?: unknown;
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
const DEFAULT_PROVIDER_DETECTION_TIMEOUT_MS = 4_750;
const DEFAULT_PROVIDER_DETECTION_OVERALL_TIMEOUT_MS = 10_500;
const DEFAULT_PROVIDER_DETECTION_RETRIES = 1;
const DEFAULT_PROVIDER_DETECTION_RETRY_BACKOFF_MS = 100;
const DEFAULT_PROVIDER_MODELS_TIMEOUT_MS = 1_500;
const DEFAULT_CATALOG_TTL_MS = 30_000;
const DEFAULT_CATALOG_MAX_STALE_AGE_MS = 300_000;
const CLI_TERMINATION_GRACE_MS = 250;
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

type LoadedNextopAgentCatalog = {
  catalog: NextopAgentCatalog;
  loadedAt: number;
  stale: boolean;
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
  const providerDetectionTimeoutMs =
    options.providerDetectionTimeoutMs ??
    readPositiveIntegerEnv("NEXTOP_PROVIDER_DETECTION_TIMEOUT_MS") ??
    DEFAULT_PROVIDER_DETECTION_TIMEOUT_MS;
  const providerDetectionOverallTimeoutMs =
    options.providerDetectionOverallTimeoutMs ??
    readPositiveIntegerEnv("NEXTOP_PROVIDER_DETECTION_DEADLINE_MS") ??
    DEFAULT_PROVIDER_DETECTION_OVERALL_TIMEOUT_MS;
  const providerDetectionRetries =
    options.providerDetectionRetries ??
    readNonNegativeIntegerEnv("NEXTOP_PROVIDER_DETECTION_RETRIES") ??
    DEFAULT_PROVIDER_DETECTION_RETRIES;
  const providerDetectionRetryBackoffMs =
    options.providerDetectionRetryBackoffMs ??
    DEFAULT_PROVIDER_DETECTION_RETRY_BACKOFF_MS;
  const providerModelsTimeoutMs =
    options.providerModelsTimeoutMs ??
    readPositiveIntegerEnv("NEXTOP_PROVIDER_MODELS_TIMEOUT_MS") ??
    DEFAULT_PROVIDER_MODELS_TIMEOUT_MS;
  const catalogTtlMs =
    options.catalogTtlMs ??
    readPositiveIntegerEnv("NEXTOP_AGENT_CATALOG_TTL_MS") ??
    DEFAULT_CATALOG_TTL_MS;
  const catalogMaxStaleAgeMs =
    options.catalogMaxStaleAgeMs ??
    readPositiveIntegerEnv("NEXTOP_AGENT_CATALOG_MAX_STALE_AGE_MS") ??
    DEFAULT_CATALOG_MAX_STALE_AGE_MS;
  const now = options.now ?? Date.now;
  let catalogSnapshot:
    | { catalog: NextopAgentCatalog; loadedAt: number }
    | undefined;
  let targetSnapshot:
    | { targets: AgentTargetOption[]; loadedAt: number }
    | undefined;
  let catalogPromise: Promise<LoadedNextopAgentCatalog> | undefined;
  const loadCatalog = (): Promise<LoadedNextopAgentCatalog> => {
    if (
      catalogSnapshot &&
      Math.max(0, now() - catalogSnapshot.loadedAt) < catalogTtlMs
    ) {
      return Promise.resolve({ ...catalogSnapshot, stale: false });
    }
    if (catalogPromise) {
      return catalogPromise;
    }

    const startedAt = now();
    const pending = readNextopAgentCatalogWithRetry(
      runner,
      providerDetectionTimeoutMs,
      providerDetectionOverallTimeoutMs,
      providerDetectionRetries,
      providerDetectionRetryBackoffMs,
      now,
    )
      .then((catalog) => {
        const loadedAt = now();
        catalogSnapshot = { catalog, loadedAt };
        console.info(
          `[agent-runtime:nextop-cli] agent catalog loaded in ${Math.max(0, now() - startedAt)}ms`,
        );
        return { catalog, loadedAt, stale: false };
      })
      .catch((error) => {
        const staleAgeMs = catalogSnapshot
          ? Math.max(0, now() - catalogSnapshot.loadedAt)
          : Number.POSITIVE_INFINITY;
        if (
          catalogSnapshot &&
          catalogMaxStaleAgeMs > 0 &&
          staleAgeMs <= catalogMaxStaleAgeMs &&
          isTransientCatalogFailure(error)
        ) {
          console.warn(
            `[agent-runtime:nextop-cli] agent catalog refresh failed; using cached catalog: ${errorMessage(error)}`,
          );
          return { ...catalogSnapshot, stale: true };
        }
        throw error;
      })
      .finally(() => {
        if (catalogPromise === pending) {
          catalogPromise = undefined;
        }
      });
    catalogPromise = pending;
    return pending;
  };

  const listTargetCatalog = async (): Promise<AgentTargetCatalogResult> => {
    const loaded = await loadCatalog();
    if (loaded.stale && targetSnapshot?.loadedAt === loaded.loadedAt) {
      return {
        targets: targetSnapshot.targets,
        freshness: "stale",
        loadedAt: loaded.loadedAt,
        warning:
          "Agent discovery is temporarily unavailable. Showing recently cached agents.",
      };
    }

    const targets = await Promise.all(
      loaded.catalog.targets.map(async (spec): Promise<AgentTargetOption> => {
        const composerOptions = spec.supported
          ? await readAgentComposerOptions(spec, runner, providerModelsTimeoutMs)
          : { models: [], permissionModes: [] };
        return {
          id: spec.id,
          name: spec.name,
          provider: spec.provider,
          supported: spec.supported,
          models: composerOptions.models,
          ...(composerOptions.permissionModes.length > 0
            ? { permissionModes: composerOptions.permissionModes }
            : {}),
          ...(composerOptions.defaultPermissionMode
            ? { defaultPermissionMode: composerOptions.defaultPermissionMode }
            : {}),
          isDefault: spec.isDefault,
          reason: spec.reason,
        };
      }),
    );
    const combinedTargets =
      options.includeMockTarget === false
        ? targets
        : [...(await mockAdapter.listTargets()), ...targets];
    if (!loaded.stale) {
      targetSnapshot = {
        targets: combinedTargets,
        loadedAt: loaded.loadedAt,
      };
    }
    return {
      targets: combinedTargets,
      freshness: loaded.stale ? "stale" : "fresh",
      loadedAt: loaded.loadedAt,
      ...(loaded.stale
        ? {
            warning:
              "Agent discovery is temporarily unavailable. Showing recently cached agents.",
          }
        : {}),
    };
  };

  const adapter: AgentRuntimeAdapter = {
    id: "nextop-cli",
    label: "Nextop CLI agent adapter",
    async listTargets(): Promise<AgentTargetOption[]> {
      return (await listTargetCatalog()).targets;
    },
    listTargetCatalog,
    async startSession(input: {
      agent: string;
      model?: string;
      cwd: string;
      prompt: string;
    }): Promise<AgentSessionRef> {
      const target = findNextopAgentTarget(
        (await loadCatalog()).catalog,
        input.agent,
      );
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

      const target = findNextopAgentTarget(
        (await loadCatalog()).catalog,
        input.agent,
      );
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

          const startedAt = now();
          let startOutput: unknown;
          try {
            startOutput = await runner(
              [
                ...startCommand(target),
                "--model",
                model,
                ...(input.permissionMode
                  ? ["--permission-mode", input.permissionMode]
                  : []),
                "--prompt",
                input.prompt,
                ...(input.title ? ["--title", input.title] : []),
                "--cwd",
                input.cwd,
              ],
              { signal: input.signal },
            );
          } catch (error) {
            if (!isSubmitDeliveryUnknown(error)) {
              throw error;
            }
            const recovered = await recoverStartedSession({
              cwd: input.cwd,
              recoveredAt: now(),
              runner,
              startedAt,
              target,
              title: input.title,
            });
            if (!recovered) {
              throw error;
            }
            console.warn(
              `[agent-runtime:${adapter.id}] recovered Nextop session ${recovered.agentSessionId} after uncertain start delivery`,
            );
            startOutput = { session: recovered };
          }
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
            ],
            {
              signal: input.signal,
              // Durable waits end only at an agent stop point or caller abort.
              // The CLI owns internal continuations, so the adapter's generic
              // six-minute subprocess budget must not terminate this command.
              timeoutMs: 0,
            },
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
            // A stop with pending interactions is NOT completion: the agent is
            // blocked on user input (a provider quota prompt, an approval
            // request, a question). Inside a workflow nobody answers it, and
            // harvesting the interaction prompt as the node output would feed
            // provider error prose ("Upgrade your plan to continue") into
            // downstream prompts as if it were a deliverable.
            const pendingInteraction = readFirstPendingInteraction(waitOutput);
            if (pendingInteraction !== undefined) {
              yield {
                type: "error",
                code: "AGENT_WAITING_FOR_USER_INPUT",
                message:
                  "Agent session is waiting for user input and cannot finish inside a workflow" +
                  (pendingInteraction ? `: ${pendingInteraction}` : "") +
                  ". Resolve the interaction in the agent session (or the underlying provider issue), then retry the node.",
                retryable: false,
              };
              yield { type: "done", status: "failed", reason: "error" };
              return;
            }
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

          // Older Tutti versions may still return ready / timeout / waiting /
          // waiting_approval observation results. Current Tutti owns internal
          // continuations and normally returns only at a stop point. Keep this
          // loop for backward compatibility without imposing a local deadline.
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
    async sendToSession(
      agentSessionId: string,
      message: string,
      options?: { guidance?: boolean },
    ): Promise<void> {
      const trimmed = agentSessionId.trim();
      if (!trimmed) {
        throw new Error("agentSessionId is required");
      }
      await runner([
        "--json",
        "agent",
        "send",
        "--session-id",
        trimmed,
        "--prompt",
        message,
        // A workflow node execution is itself an active turn, so a plain send
        // ("start a new turn") is rejected. Guidance mode injects the steer into
        // the in-flight turn instead.
        ...(options?.guidance ? ["--guidance"] : []),
      ]);
    },
    async getSessionConversation(
      agentSessionId: string,
    ): Promise<AgentConversationMessage[]> {
      const trimmed = agentSessionId.trim();
      if (!trimmed) {
        throw new Error("agentSessionId is required");
      }
      return readVisibleConversation(trimmed, runner);
    },
  };

  return adapter;
}

async function readVisibleConversation(
  agentSessionId: string,
  runner: NextopCliRunner,
): Promise<AgentConversationMessage[]> {
  const collected: NextopMessage[] = [];
  let beforeVersion: number | undefined;
  const fallback: RequiredSessionRef = {
    agentSessionId,
    agent: "unknown",
    status: "running",
  };

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
    const page = parseSessionSummary(await runner(args), fallback);
    collected.push(...page.messages);
    if (!page.hasMore) {
      break;
    }
    const nextBefore = oldestMessageVersion(page.messages);
    if (
      nextBefore === undefined ||
      (beforeVersion !== undefined && nextBefore >= beforeVersion)
    ) {
      throw new Error(
        "Nextop CLI session-summary did not provide a usable conversation cursor.",
      );
    }
    beforeVersion = nextBefore;
  }

  return collected
    .flatMap((message): AgentConversationMessage[] => {
      if (!isTextMessage(message)) {
        return [];
      }
      const rawRole = readOptionalString(message.role);
      const role =
        rawRole === "user"
          ? "user"
          : rawRole === "assistant" || rawRole === "agent"
            ? "assistant"
            : undefined;
      const text = readOptionalString(message.text);
      if (!role || !text) {
        return [];
      }
      const version = readNumber(message.version);
      return [{ role, text, ...(version === undefined ? {} : { version }) }];
    })
    .sort((left, right) => (left.version ?? 0) - (right.version ?? 0));
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
  const seenProviders = new Set<string>();
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
      if (seenProviders.has(provider)) {
        throw new Error(
          `Nextop CLI legacy provider ${provider} maps to multiple agent targets.`,
        );
      }
      seen.add(id);
      seenProviders.add(provider);
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

async function readNextopAgentCatalogWithRetry(
  runner: NextopCliRunner,
  attemptTimeoutMs: number,
  overallTimeoutMs: number,
  retries: number,
  retryBackoffMs: number,
  now: () => number,
): Promise<NextopAgentCatalog> {
  const deadline = now() + overallTimeoutMs;
  let attempt = 0;
  while (true) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(
        `Nextop CLI agent catalog detection exceeded ${overallTimeoutMs}ms.`,
      );
    }
    const timeoutForAttemptMs = Math.max(
      1,
      Math.min(attemptTimeoutMs, remainingMs),
    );
    const deadlineBoundRunner: NextopCliRunner = (args, options) => {
      const remainingForCommandMs = deadline - now();
      if (remainingForCommandMs <= 0) {
        return Promise.reject(
          new Error(
            `Nextop CLI agent catalog detection exceeded ${overallTimeoutMs}ms.`,
          ),
        );
      }
      return runner(args, {
        ...options,
        timeoutMs: Math.max(
          1,
          Math.min(
            options?.timeoutMs ?? timeoutForAttemptMs,
            remainingForCommandMs,
          ),
        ),
      });
    };
    try {
      return await readNextopAgentCatalog(
        deadlineBoundRunner,
        timeoutForAttemptMs,
      );
    } catch (error) {
      if (attempt >= retries || !isNextopCliTimeout(error)) {
        throw error;
      }
      attempt += 1;
      console.warn(
        `[agent-runtime:nextop-cli] agent catalog detection timed out; retrying (${attempt}/${retries})`,
      );
      const remainingAfterAttemptMs = deadline - now();
      if (remainingAfterAttemptMs <= 0) {
        throw error;
      }
      const backoffMs = Math.min(
        Math.max(0, retryBackoffMs),
        Math.max(0, remainingAfterAttemptMs - 1),
      );
      if (backoffMs > 0) {
        await delay(backoffMs);
      }
    }
  }
}

function isNextopCliTimeout(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("Nextop CLI timed out after") ||
    message.includes("agent catalog detection exceeded")
  );
}

function isTransientCatalogFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    isNextopCliTimeout(error) ||
    message.includes("temporarily unavailable") ||
    message.includes("daemon is not reachable") ||
    message.includes("connection refused") ||
    message.includes("connection reset") ||
    message.includes("database is locked") ||
    message.includes("resource busy") ||
    /\b(eagain|econnrefused|econnreset|epipe|etimedout)\b/.test(message)
  );
}

function isSubmitDeliveryUnknown(error: unknown): boolean {
  return errorMessage(error).includes("agent_submit_delivery_unknown");
}

async function recoverStartedSession(input: {
  cwd: string;
  recoveredAt: number;
  runner: NextopCliRunner;
  startedAt: number;
  target: NextopAgentTargetSpec;
  title?: string;
}): Promise<Record<string, unknown> | undefined> {
  const output = (await input.runner([
    "--json",
    "agent",
    "sessions",
  ])) as NextopSessionsOutput;
  const sessions = Array.isArray(output.sessions) ? output.sessions : [];
  const candidates = sessions.flatMap((value): Record<string, unknown>[] => {
    const session = readRecord(value);
    if (!session) {
      return [];
    }
    const createdAt = readNumber(session.createdAtUnixMs);
    const targetId = readOptionalString(session.agentTargetId);
    const cwd = readOptionalString(session.cwd);
    const title = readOptionalString(session.title);
    if (
      targetId !== input.target.id ||
      cwd !== input.cwd ||
      createdAt === undefined ||
      createdAt < input.startedAt - 1_000 ||
      createdAt > input.recoveredAt + 5_000 ||
      (input.title && title !== input.title)
    ) {
      return [];
    }
    return [session];
  });
  return candidates.length === 1 ? candidates[0] : undefined;
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
  const output = value as NextopSessionSummaryOutput;
  const session = readRecord(output.session) as NextopSession | undefined;
  if (target.cliContract === "provider-compat") {
    const actualProvider = normalizeNextopProvider(
      readOptionalString(session?.provider) ?? "",
    );
    if (!actualProvider) {
      throw new Error(
        `Nextop session summary did not return a provider for ${target.id}.`,
      );
    }
    if (actualProvider !== target.provider) {
      throw new Error(
        `Nextop session belongs to provider ${actualProvider}, not ${target.provider}.`,
      );
    }
    return;
  }
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

/**
 * A non-empty pendingInteractions on the waited session means the agent is
 * blocked on user input (quota prompt, approval request, question) rather than
 * finished. Returns undefined when there is no pending interaction, and a
 * best-effort one-line description (possibly "") when there is one — the
 * interaction shape varies by provider, so extraction is defensive.
 */
export function readFirstPendingInteraction(
  waitOutput: unknown,
): string | undefined {
  const output = readRecord(waitOutput);
  const session = readRecord(output?.session);
  const interactions = session?.pendingInteractions;
  if (!Array.isArray(interactions) || interactions.length === 0) {
    return undefined;
  }
  const first = interactions[0];
  if (typeof first === "string") {
    return first;
  }
  const record = readRecord(first);
  const described =
    readOptionalString(record?.title) ??
    readOptionalString(record?.prompt) ??
    readOptionalString(record?.message) ??
    readOptionalString(record?.text) ??
    readOptionalString(record?.kind);
  if (described) {
    return described;
  }
  try {
    return JSON.stringify(first).slice(0, 200);
  } catch {
    return "";
  }
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

function isTextMessage(message: NextopMessage): boolean {
  // tool_call / tool_result messages carry a literal rendering in `text`
  // (e.g. "tool_call: Bash"); only messages that are genuine assistant text
  // should be considered. Tolerate messages with no `kind` for backward compat.
  const kind = readOptionalString(message.kind);
  return kind === undefined || kind === "text";
}

export function latestAssistantText(messages: NextopMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = readOptionalString(message.role);
    if (role !== "assistant" && role !== "agent") {
      continue;
    }
    if (!isTextMessage(message)) {
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
    if (!isTextMessage(message)) {
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
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let terminationTimeout: ReturnType<typeof setTimeout> | undefined;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (terminationTimeout) {
        clearTimeout(terminationTimeout);
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
        timedOut = true;
        child.kill("SIGTERM");
        terminationTimeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, CLI_TERMINATION_GRACE_MS);
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
      if (timedOut) {
        return;
      }
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
        if (timedOut) {
          reject(new Error(`Nextop CLI timed out after ${options.timeoutMs}ms.`));
          return;
        }
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

async function readAgentComposerOptions(
  target: NextopAgentTargetSpec,
  runner: NextopCliRunner,
  timeoutMs: number,
): Promise<{
  models: string[];
  permissionModes: AgentPermissionModeOption[];
  defaultPermissionMode?: string;
}> {
  try {
    const output = (await runner(composerOptionsCommand(target), {
      timeoutMs,
    })) as NextopComposerOptionsOutput;
    return {
      models: parseComposerModels(output),
      ...parseComposerPermissions(output),
    };
  } catch {
    return { models: [], permissionModes: [] };
  }
}

function parseComposerPermissions(output: NextopComposerOptionsOutput): {
  permissionModes: AgentPermissionModeOption[];
  defaultPermissionMode?: string;
} {
  const permissionConfig = readRecord(output.permissionConfig);
  const defaultPermissionMode = readOptionalString(
    permissionConfig?.defaultValue,
  );
  const modes = Array.isArray(permissionConfig?.modes)
    ? permissionConfig.modes
    : [];
  const permissionModes = modes.flatMap((mode): AgentPermissionModeOption[] => {
    const record = readRecord(mode);
    const id = readOptionalString(record?.id);
    if (!id) {
      return [];
    }
    const description = readOptionalString(record?.description);
    const semantic = readOptionalString(record?.semantic);
    return [
      {
        id,
        label: readOptionalString(record?.label) ?? id,
        ...(description ? { description } : {}),
        ...(semantic ? { semantic } : {}),
      },
    ];
  });
  return {
    permissionModes,
    ...(defaultPermissionMode ? { defaultPermissionMode } : {}),
  };
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

function readNonNegativeIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
