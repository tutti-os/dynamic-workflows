import { describe, expect, it } from "vitest";
import {
  createNextopCliAgentAdapter,
  isUnknownAgentListCommand,
  latestAssistantText,
  newestAssistantText,
  parseNextopJson,
  parseSessionFromOutput,
  resolveNextopCliPath,
  runNextopJson,
} from "./nextopCliAdapter";

describe("nextop cli adapter", () => {
  it("resolves the Tutti CLI path and explicit overrides", () => {
    const previousTuttiCli = process.env.TUTTI_CLI;

    try {
      process.env.TUTTI_CLI = "/tmp/tutti-dev";

      expect(resolveNextopCliPath()).toBe("/tmp/tutti-dev");
      expect(resolveNextopCliPath({ cliPath: "/tmp/custom" })).toBe(
        "/tmp/custom",
      );

      process.env.TUTTI_CLI = "";
      expect(resolveNextopCliPath()).toBe("tutti-dev");
    } finally {
      restoreEnv("TUTTI_CLI", previousTuttiCli);
    }
  });

  it("parses valid JSON and rejects invalid JSON", () => {
    expect(parseNextopJson('{"ok":true}\n')).toEqual({ ok: true });
    expect(() => parseNextopJson("not json")).toThrow(/invalid JSON/);
  });

  it("lists every agent target and preserves the daemon default when providers repeat", async () => {
    const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      providerDetectionTimeoutMs: 123,
      providerModelsTimeoutMs: 456,
      runner: async (args, options) => {
        calls.push({ args, timeoutMs: options?.timeoutMs });
        if (args.includes("list")) {
          return {
            schemaVersion: 1,
            defaultAgentTargetId: "team:reviewer",
            agents: [
              {
                id: "team:builder",
                name: "Builder",
                provider: "codex",
                availability: { status: "available", detail: "" },
              },
              {
                id: "team:reviewer",
                name: "Reviewer",
                provider: "codex",
                availability: { status: "available", detail: "" },
              },
            ],
          };
        }
        if (args.includes("composer-options")) {
          return {
            effectiveSettings: { model: "gpt-5.5" },
            modelConfig: { options: [] },
            permissionConfig: {
              defaultValue: "full-access",
              modes: [
                {
                  id: "auto",
                  label: "Auto",
                  description: "Ask for risky operations.",
                  semantic: "auto",
                },
                { id: "full-access", label: "Full access" },
              ],
            },
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await expect(adapter.listTargets()).resolves.toEqual([
      {
        id: "team:builder",
        name: "Builder",
        provider: "codex",
        supported: true,
        models: ["gpt-5.5"],
        permissionModes: [
          {
            id: "auto",
            label: "Auto",
            description: "Ask for risky operations.",
            semantic: "auto",
          },
          { id: "full-access", label: "Full access" },
        ],
        defaultPermissionMode: "full-access",
        isDefault: false,
        reason: undefined,
      },
      {
        id: "team:reviewer",
        name: "Reviewer",
        provider: "codex",
        supported: true,
        models: ["gpt-5.5"],
        permissionModes: [
          {
            id: "auto",
            label: "Auto",
            description: "Ask for risky operations.",
            semantic: "auto",
          },
          { id: "full-access", label: "Full access" },
        ],
        defaultPermissionMode: "full-access",
        isDefault: true,
        reason: undefined,
      },
    ]);
    expect(calls).toContainEqual({
      args: ["--json", "agent", "list"],
      timeoutMs: 123,
    });
    expect(calls).toContainEqual({
      args: [
        "--json",
        "agent",
        "composer-options",
        "--agent-id",
        "team:reviewer",
      ],
      timeoutMs: 456,
    });
  });

  it("falls back to the legacy catalog only for the exact unsupported command", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      runner: async (args) => {
        calls.push(args);
        if (args.includes("list")) {
          throw new Error("Nextop CLI failed: unknown command: agent list");
        }
        if (args.includes("providers")) {
          return {
            defaultProviderId: "codex",
            providers: [
              { provider: "codex", displayName: "Codex", status: "available" },
            ],
          };
        }
        if (args.includes("composer-options")) {
          return { effectiveSettings: { model: "gpt-5" } };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await expect(adapter.listTargets()).resolves.toEqual([
      {
        id: "local:codex",
        name: "Codex",
        provider: "codex",
        supported: true,
        models: ["gpt-5"],
        isDefault: true,
        reason: undefined,
      },
    ]);
    expect(calls.slice(0, 2)).toEqual([
      ["--json", "agent", "list"],
      ["--json", "agent", "providers"],
    ]);
  });

  it("rejects a legacy catalog when one provider maps to multiple targets", async () => {
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      runner: async (args) => {
        if (isAgentListCall(args)) {
          throw new Error("unknown command: agent list");
        }
        if (args.includes("providers")) {
          return {
            schemaVersion: 2,
            defaultProviderId: "codex",
            providers: [
              {
                providerId: "codex",
                agentTargetId: "team:builder",
                availability: { status: "available" },
              },
              {
                providerId: "codex",
                agentTargetId: "team:reviewer",
                availability: { status: "available" },
              },
            ],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await expect(adapter.listTargets()).rejects.toThrow(
      /provider codex maps to multiple agent targets/,
    );
  });

  it("retries transient catalog timeouts without using the legacy fallback", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      runner: async (args) => {
        calls.push(args);
        throw new Error("Nextop CLI timed out after 3000ms.");
      },
    });

    await expect(adapter.listTargets()).rejects.toThrow(/timed out/);
    expect(calls).toEqual([
      ["--json", "agent", "list"],
      ["--json", "agent", "list"],
    ]);
    expect(
      isUnknownAgentListCommand(new Error("unknown command: agent list")),
    ).toBe(true);
    expect(
      isUnknownAgentListCommand(new Error("unknown command: agent list now")),
    ).toBe(false);
  });

  it("returns a catalog when the second detection attempt succeeds", async () => {
    const detectionTimeouts: number[] = [];
    let detectionAttempt = 0;
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      providerDetectionRetryBackoffMs: 0,
      runner: async (args, options) => {
        if (isAgentListCall(args)) {
          detectionTimeouts.push(options?.timeoutMs ?? 0);
          detectionAttempt += 1;
          if (detectionAttempt === 1) {
            throw new Error(`Nextop CLI timed out after ${options?.timeoutMs}ms.`);
          }
          return currentAgentCatalog();
        }
        if (args.includes("composer-options")) {
          return { effectiveSettings: { model: "gpt-5" } };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await expect(adapter.listTargets()).resolves.toHaveLength(1);
    expect(detectionTimeouts).toEqual([4_750, 4_750]);
  });

  it("keeps retry attempt budgets within the overall discovery deadline", async () => {
    let currentTime = 1_000;
    const detectionTimeouts: number[] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      providerDetectionTimeoutMs: 8_000,
      providerDetectionOverallTimeoutMs: 10_500,
      providerDetectionRetryBackoffMs: 0,
      now: () => currentTime,
      runner: async (_args, options) => {
        const timeoutMs = options?.timeoutMs ?? 0;
        detectionTimeouts.push(timeoutMs);
        currentTime += timeoutMs;
        throw new Error(`Nextop CLI timed out after ${timeoutMs}ms.`);
      },
    });

    await expect(adapter.listTargets()).rejects.toThrow(/timed out/);
    expect(detectionTimeouts).toEqual([8_000, 2_500]);
    expect(detectionTimeouts.reduce((total, value) => total + value, 0)).toBe(
      10_500,
    );
  });

  it("shares the overall deadline with legacy provider detection", async () => {
    let currentTime = 1_000;
    const commandTimeouts: Array<{ command: string; timeoutMs: number }> = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      providerDetectionRetryBackoffMs: 0,
      now: () => currentTime,
      runner: async (args, options) => {
        const timeoutMs = options?.timeoutMs ?? 0;
        commandTimeouts.push({ command: args.at(-1) ?? "", timeoutMs });
        currentTime += timeoutMs;
        if (isAgentListCall(args)) {
          throw new Error("unknown command: agent list");
        }
        throw new Error(`Nextop CLI timed out after ${timeoutMs}ms.`);
      },
    });

    await expect(adapter.listTargets()).rejects.toThrow(/exceeded/);
    expect(commandTimeouts).toEqual([
      { command: "list", timeoutMs: 4_750 },
      { command: "providers", timeoutMs: 4_750 },
      { command: "list", timeoutMs: 1_000 },
    ]);
    expect(
      commandTimeouts.reduce((total, item) => total + item.timeoutMs, 0),
    ).toBe(10_500);
  });

  it("reuses a fresh catalog and coalesces concurrent discovery", async () => {
    const calls: string[][] = [];
    let releaseCatalog: (() => void) | undefined;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      catalogTtlMs: 60_000,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) {
          await catalogGate;
          return currentAgentCatalog();
        }
        if (args.includes("composer-options")) {
          return { effectiveSettings: { model: "gpt-5" } };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const first = adapter.listTargets();
    const second = adapter.listTargets();
    releaseCatalog?.();
    await Promise.all([first, second]);
    await adapter.listTargets();

    expect(calls.filter(isAgentListCall)).toHaveLength(1);
  });

  it("serves the last successful catalog when a refresh times out", async () => {
    const calls: string[][] = [];
    let currentTime = 1_000;
    let catalogAvailable = true;
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      catalogTtlMs: 100,
      catalogMaxStaleAgeMs: 500,
      providerDetectionRetries: 0,
      now: () => currentTime,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) {
          if (!catalogAvailable) {
            throw new Error("Nextop CLI timed out after 10000ms.");
          }
          return currentAgentCatalog();
        }
        if (args.includes("composer-options")) {
          return { effectiveSettings: { model: "gpt-5" } };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await expect(adapter.listTargetCatalog?.()).resolves.toMatchObject({
      freshness: "fresh",
      targets: [{ id: "local:codex", models: ["gpt-5"] }],
    });
    currentTime += 101;
    catalogAvailable = false;
    await expect(adapter.listTargetCatalog?.()).resolves.toMatchObject({
      freshness: "stale",
      loadedAt: 1_000,
      targets: [{ id: "local:codex", models: ["gpt-5"] }],
    });
    await expect(adapter.listTargetCatalog?.()).resolves.toMatchObject({
      freshness: "stale",
    });

    expect(calls.filter(isAgentListCall)).toHaveLength(3);
  });

  it("rejects transient failures after the maximum stale age", async () => {
    let currentTime = 1_000;
    let catalogAvailable = true;
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      catalogTtlMs: 100,
      catalogMaxStaleAgeMs: 200,
      providerDetectionRetries: 0,
      now: () => currentTime,
      runner: async (args) => {
        if (isAgentListCall(args)) {
          if (!catalogAvailable) {
            throw new Error("Nextop CLI timed out after 5000ms.");
          }
          return currentAgentCatalog();
        }
        if (args.includes("composer-options")) {
          return { effectiveSettings: { model: "gpt-5" } };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await adapter.listTargets();
    currentTime += 201;
    catalogAvailable = false;

    await expect(adapter.listTargets()).rejects.toThrow(/timed out/);
  });

  it("uses bounded stale data for temporary CLI execution failures", async () => {
    let currentTime = 1_000;
    let daemonAvailable = true;
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      catalogTtlMs: 100,
      catalogMaxStaleAgeMs: 500,
      providerDetectionRetries: 0,
      now: () => currentTime,
      runner: async (args) => {
        if (isAgentListCall(args)) {
          if (!daemonAvailable) {
            throw new Error(
              "Nextop CLI failed: daemon is temporarily unavailable",
            );
          }
          return currentAgentCatalog();
        }
        if (args.includes("composer-options")) {
          return { effectiveSettings: { model: "gpt-5" } };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await adapter.listTargets();
    currentTime += 101;
    daemonAvailable = false;

    await expect(adapter.listTargetCatalog?.()).resolves.toMatchObject({
      freshness: "stale",
    });
  });

  it("does not hide catalog schema failures behind stale data", async () => {
    let currentTime = 1_000;
    let returnInvalidCatalog = false;
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      catalogTtlMs: 100,
      catalogMaxStaleAgeMs: 500,
      providerDetectionRetries: 0,
      now: () => currentTime,
      runner: async (args) => {
        if (isAgentListCall(args)) {
          return returnInvalidCatalog
            ? { schemaVersion: 1, agents: "invalid" }
            : currentAgentCatalog();
        }
        if (args.includes("composer-options")) {
          return { effectiveSettings: { model: "gpt-5" } };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await adapter.listTargets();
    currentTime += 101;
    returnInvalidCatalog = true;

    await expect(adapter.listTargets()).rejects.toThrow(
      /unsupported agent catalog/,
    );
  });

  it("waits for a timed-out CLI child to exit after the termination grace", async () => {
    const startedAt = Date.now();
    await expect(
      runNextopJson(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow("Nextop CLI timed out after 100ms.");

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
  });

  it("starts the exact selected target through the agent-id contract", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) {
          return {
            schemaVersion: 1,
            defaultAgentTargetId: "team:builder",
            agents: [
              {
                id: "team:builder",
                name: "Builder",
                provider: "codex",
                availability: { status: "available" },
              },
              {
                id: "team:reviewer",
                name: "Reviewer",
                provider: "codex",
                availability: { status: "available" },
              },
            ],
          };
        }
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-reviewer",
              provider: "codex",
            },
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await expect(
      adapter.startSession?.({
        agent: "team:reviewer",
        model: "gpt-5",
        cwd: "/tmp/project",
        prompt: "review",
      }),
    ).resolves.toMatchObject({
      agentSessionId: "session-reviewer",
      agent: "team:reviewer",
    });
    expect(calls).toContainEqual([
      "--json",
      "agent",
      "start",
      "--agent-id",
      "team:reviewer",
      "--model",
      "gpt-5",
      "--prompt",
      "review",
      "--cwd",
      "/tmp/project",
    ]);
  });

  it("uses the old provider launcher only after exact agent-list fallback", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) {
          throw new Error("unknown command: agent list");
        }
        if (args.includes("providers")) {
          return {
            defaultProviderId: "codex",
            providers: [
              {
                providerId: "codex",
                displayName: "Codex",
                agentTargetId: "local:codex",
                availability: { status: "available" },
              },
            ],
          };
        }
        if (args.includes("start")) {
          return { session: { agentSessionId: "legacy-1", provider: "codex" } };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await expect(
      adapter.startSession?.({
        agent: "local:codex",
        model: "gpt-5",
        cwd: "/tmp/project",
        prompt: "work",
      }),
    ).resolves.toMatchObject({ agent: "local:codex" });
    expect(calls).toContainEqual([
      "--json",
      "codex",
      "start",
      "--model",
      "gpt-5",
      "--prompt",
      "work",
      "--cwd",
      "/tmp/project",
    ]);
  });

  it("requires agentSessionId in start output", () => {
    expect(() =>
      parseSessionFromOutput({ session: { provider: "codex" } }),
    ).toThrow(/agentSessionId/);
    expect(() =>
      parseSessionFromOutput({
        session: { agentSessionId: "session-1", provider: "codex" },
      }),
    ).toThrow(/resolvable agent target/);
  });

  it("extracts the latest assistant text", () => {
    expect(
      latestAssistantText([
        { role: "assistant", text: "first" },
        { role: "user", text: "ignored" },
        { role: "agent", text: "last" },
      ]),
    ).toBe("last");
  });

  it("extracts the newest assistant text from descending messages", () => {
    expect(
      newestAssistantText([
        { role: "agent", text: "newest" },
        { role: "user", text: "ignored" },
        { role: "assistant", text: "older" },
      ]),
    ).toBe("newest");
  });

  it("skips a trailing tool_call message when selecting the latest text", () => {
    expect(
      latestAssistantText([
        { role: "assistant", kind: "text", text: "the report" },
        { role: "assistant", kind: "tool_call", text: "tool_call: Bash" },
      ]),
    ).toBe("the report");
  });

  it("skips a leading tool_call message when selecting the newest text", () => {
    expect(
      newestAssistantText([
        { role: "assistant", kind: "tool_call", text: "tool_call: Bash" },
        { role: "assistant", kind: "text", text: "the report" },
      ]),
    ).toBe("the report");
  });

  it("still selects legacy messages that carry no kind field", () => {
    expect(
      latestAssistantText([{ role: "assistant", text: "legacy report" }]),
    ).toBe("legacy report");
    expect(
      newestAssistantText([{ role: "agent", text: "legacy report" }]),
    ).toBe("legacy report");
  });

  it("streams session refs and final text from waiting", async () => {
    const calls: string[][] = [];
    const waitTimeouts: Array<number | undefined> = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args, options) => {
        calls.push(args);
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("session-summary")) {
          return {
            hasMore: false,
            latestVersion: 0,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "completed",
            },
            messages: [{ role: "assistant", text: "done", version: 2 }],
          };
        }
        if (args.includes("wait")) {
          waitTimeouts.push(options?.timeoutMs);
          return {
            reason: "completed",
            timedOut: false,
            hasMore: false,
            latestVersion: 2,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "completed",
            },
            messages: [],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:scan",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "scan",
      title: "Scan repository",
      model: "gpt-5",
      permissionMode: "auto",
    })) {
      events.push(event);
    }

    expect(calls).toContainEqual([
      "--json",
      "agent",
      "start",
      "--agent-id",
      "local:codex",
      "--model",
      "gpt-5",
      "--permission-mode",
      "auto",
      "--prompt",
      "scan",
      "--title",
      "Scan repository",
      "--cwd",
      "/tmp/project",
    ]);
    expect(events).toContainEqual({
      type: "session_ref",
      session: {
        agentSessionId: "session-1",
        agent: "local:codex",
        model: "gpt-5",
        status: "running",
      },
    });
    expect(events).toContainEqual({ type: "text_delta", text: "done" });
    expect(waitTimeouts).toEqual([0]);
    expect(calls.find((args) => args.includes("wait"))).not.toContain(
      "--timeout-ms",
    );
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      reason: "completed",
    });
  });

  it("recovers a uniquely matching session after uncertain start delivery", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      now: () => 10_000,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          throw new Error(
            'Nextop CLI failed: {"error":{"reasonCode":"agent_submit_delivery_unknown"}}',
          );
        }
        if (args.includes("sessions")) {
          return {
            sessions: [
              {
                agentSessionId: "session-recovered",
                agentTargetId: "local:codex",
                provider: "codex",
                cwd: "/tmp/project",
                title: "Scan repository",
                createdAtUnixMs: 10_100,
                status: "running",
              },
            ],
          };
        }
        if (args.includes("session-summary")) {
          return {
            hasMore: false,
            latestVersion: 2,
            session: {
              agentSessionId: "session-recovered",
              provider: "codex",
              status: "completed",
            },
            messages: [{ role: "assistant", text: "done", version: 2 }],
          };
        }
        if (args.includes("wait")) {
          return {
            reason: "completed",
            hasMore: false,
            latestVersion: 2,
            session: {
              agentSessionId: "session-recovered",
              provider: "codex",
              status: "completed",
            },
            messages: [],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:scan",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "scan",
      title: "Scan repository",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    expect(calls).toContainEqual(["--json", "agent", "sessions"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session_ref",
          session: expect.objectContaining({
            agentSessionId: "session-recovered",
            agent: "local:codex",
            model: "gpt-5",
            status: "running",
          }),
        }),
      ]),
    );
    expect(events).toContainEqual({ type: "text_delta", text: "done" });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      reason: "completed",
    });
  });

  it("fails the run when the session stops with a pending interaction", async () => {
    // A quota prompt / approval request / question blocks the agent on user
    // input; harvesting the interaction prose as the node output would feed it
    // downstream as a deliverable. The adapter must fail loudly instead.
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("wait")) {
          return {
            reason: "waiting_input",
            timedOut: false,
            hasMore: false,
            latestVersion: 2,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "waiting_input",
              pendingInteractions: [
                { kind: "input", prompt: "Upgrade your plan to continue" },
              ],
            },
            messages: [
              {
                role: "assistant",
                kind: "text",
                text: "Upgrade your plan to continue",
                version: 2,
              },
            ],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:review",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "review",
      title: "Review",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    const errorEvent = events.find(
      (event) => event.type === "error",
    ) as { type: string; code?: string; message?: string } | undefined;
    expect(errorEvent?.code).toBe("AGENT_WAITING_FOR_USER_INPUT");
    expect(errorEvent?.message).toContain("waiting for user input");
    expect(errorEvent?.message).toContain("Upgrade your plan to continue");
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "failed",
      reason: "error",
    });
    // The interaction prose must never be emitted as harvested output text.
    expect(events.some((event) => event.type === "text_delta")).toBe(false);
  });

  it("surfaces the terminal provider error returned by agent wait", async () => {
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("wait")) {
          return {
            reason: "failed",
            turnId: "turn-1",
            latestVersion: 2,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "failed",
            },
            error: {
              code: "provider_error",
              message:
                "Selected model is at capacity. Please try a different model.",
              retryable: true,
            },
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:review",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "review",
      title: "Review",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "error",
      code: "provider_error",
      message:
        "Selected model is at capacity. Please try a different model.",
      retryable: true,
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "failed",
      reason: "error",
    });
  });

  it("includes session and turn identifiers when a failed wait has no error details", async () => {
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("wait")) {
          return {
            reason: "failed",
            turnId: "turn-1",
            latestVersion: 2,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "failed",
            },
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:review",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "review",
      title: "Review",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "error",
      code: "NEXTOP_SESSION_FAILED",
      message:
        "Agent local:codex (model gpt-5) failed in session session-1, turn turn-1. The agent host did not provide terminal error details.",
      retryable: false,
    });
  });

  it("completes on wait reason completed while session status stays created", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("session-summary")) {
          return {
            hasMore: false,
            latestVersion: 154,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "created",
              turnLifecycle: {
                phase: "settled",
                outcome: "completed",
              },
            },
            messages: [{ role: "assistant", text: "done", version: 154 }],
          };
        }
        if (args.includes("wait")) {
          return {
            reason: "completed",
            timedOut: false,
            hasMore: false,
            latestVersion: 154,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "created",
              turnLifecycle: {
                phase: "settled",
                outcome: "completed",
              },
            },
            messages: [{ role: "assistant", text: "done", version: 154 }],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:scan",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "scan",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    expect(calls).toContainEqual([
      "--json",
      "agent",
      "wait",
      "--session-id",
      "session-1",
      "--after-version",
      "0",
    ]);
    expect(events).toContainEqual({
      type: "session_ref",
      session: {
        agentSessionId: "session-1",
        agent: "local:codex",
        model: "gpt-5",
        status: "completed",
      },
    });
    expect(events).toContainEqual({ type: "text_delta", text: "done" });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      reason: "completed",
    });
  });

  it("keeps waiting through ready and timeout reasons despite stale settled lifecycle", async () => {
    const calls: string[][] = [];
    let waitCount = 0;
    // The daemon reports turnLifecycle settled/completed even while a turn is
    // active, so only the wait reason may end the turn.
    const staleSession = {
      agentSessionId: "session-1",
      provider: "codex",
      status: "created",
      turnLifecycle: {
        activeTurnId: null,
        phase: "settled",
        outcome: "completed",
      },
    };
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "created",
            },
          };
        }
        if (args.includes("session-summary")) {
          return {
            hasMore: false,
            latestVersion: 3,
            session: staleSession,
            messages: [{ role: "assistant", text: "done", version: 3 }],
          };
        }
        if (args.includes("wait")) {
          waitCount += 1;
          if (waitCount === 1) {
            return {
              reason: "ready",
              timedOut: false,
              hasMore: false,
              latestVersion: 1,
              session: staleSession,
              messages: [{ role: "user", text: "prompt", version: 1 }],
            };
          }
          if (waitCount === 2) {
            return {
              reason: "timeout",
              timedOut: true,
              hasMore: false,
              latestVersion: 1,
              session: staleSession,
              messages: [],
            };
          }
          return {
            reason: "completed",
            timedOut: false,
            hasMore: false,
            latestVersion: 3,
            session: staleSession,
            messages: [{ role: "assistant", text: "done", version: 3 }],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:scan",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "scan",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    expect(waitCount).toBe(3);
    expect(events).toContainEqual({ type: "text_delta", text: "done" });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      reason: "completed",
    });
  });

  it("keeps waiting on ready assistant text until wait reports completed", async () => {
    let waitCount = 0;
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("wait")) {
          waitCount += 1;
          if (waitCount === 1) {
            return {
              reason: "ready",
              timedOut: false,
              hasMore: false,
              latestVersion: 13,
              session: {
                agentSessionId: "session-1",
                provider: "codex",
                status: "created",
                submitAvailability: { state: "available" },
                turnLifecycle: {
                  activeTurnId: null,
                  phase: "settled",
                  outcome: "completed",
                },
              },
              messages: [
                { role: "assistant", text: "starting work", version: 13 },
              ],
            };
          }
          return {
            reason: "completed",
            timedOut: false,
            hasMore: false,
            latestVersion: 48,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "created",
              submitAvailability: { state: "available" },
              turnLifecycle: {
                activeTurnId: null,
                phase: "settled",
                outcome: "completed",
              },
            },
            messages: [
              { role: "assistant", text: "final baseline", version: 48 },
            ],
          };
        }
        if (args.includes("session-summary")) {
          return {
            hasMore: false,
            latestVersion: 48,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "created",
              submitAvailability: { state: "available" },
              turnLifecycle: {
                activeTurnId: null,
                phase: "settled",
                outcome: "completed",
              },
            },
            messages: [
              { role: "assistant", text: "final baseline", version: 48 },
            ],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:scan",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "scan",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    expect(waitCount).toBe(2);
    expect(events).toContainEqual({
      type: "text_delta",
      text: "final baseline",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      reason: "completed",
    });
  });

  it("keeps waiting on ready assistant text while submit is blocked", async () => {
    let waitCount = 0;
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("wait")) {
          waitCount += 1;
          if (waitCount === 1) {
            return {
              reason: "ready",
              timedOut: false,
              hasMore: false,
              latestVersion: 13,
              session: {
                agentSessionId: "session-1",
                provider: "codex",
                status: "created",
                submitAvailability: {
                  state: "blocked",
                  reason: "active_turn",
                },
                turnLifecycle: {
                  activeTurnId: null,
                  phase: "settled",
                  outcome: "completed",
                },
              },
              messages: [
                { role: "assistant", text: "starting work", version: 13 },
              ],
            };
          }
          return {
            reason: "completed",
            timedOut: false,
            hasMore: false,
            latestVersion: 48,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "created",
              submitAvailability: { state: "available" },
              turnLifecycle: {
                activeTurnId: null,
                phase: "settled",
                outcome: "completed",
              },
            },
            messages: [
              { role: "assistant", text: "final output", version: 48 },
            ],
          };
        }
        if (args.includes("session-summary")) {
          return {
            hasMore: false,
            latestVersion: 48,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "created",
              submitAvailability: { state: "available" },
            },
            messages: [
              { role: "assistant", text: "final output", version: 48 },
            ],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:scan",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "scan",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    expect(waitCount).toBe(2);
    expect(events).toContainEqual({ type: "text_delta", text: "final output" });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      reason: "completed",
    });
  });

  it("keeps waiting when wait times out after the raw session status is completed", async () => {
    const calls: string[][] = [];
    let waitCount = 0;
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("wait")) {
          waitCount += 1;
          if (waitCount === 1) {
            return {
              reason: "timeout",
              timedOut: true,
              hasMore: false,
              latestVersion: 12,
              session: {
                agentSessionId: "session-1",
                agentTargetId: "local:codex",
                provider: "codex",
                status: "completed",
              },
              messages: [],
            };
          }
          return {
            reason: "completed",
            timedOut: false,
            hasMore: false,
            latestVersion: 14,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "completed",
            },
            messages: [],
          };
        }
        if (args.includes("session-summary")) {
          return {
            hasMore: false,
            latestVersion: 14,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "completed",
            },
            messages: [{ role: "assistant", text: "done", version: 14 }],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:scan",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "scan",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    expect(calls).toContainEqual([
      "--json",
      "agent",
      "wait",
      "--session-id",
      "session-1",
      "--after-version",
      "0",
    ]);
    expect(calls).toContainEqual([
      "--json",
      "agent",
      "wait",
      "--session-id",
      "session-1",
      "--after-version",
      "12",
    ]);
    expect(waitCount).toBe(2);
    expect(events).toContainEqual({ type: "text_delta", text: "done" });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      reason: "completed",
    });
  });

  it("sends prompts to an existing session when resumeSessionId is provided", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("composer-options")) {
          return {
            effectiveSettings: { model: "gpt-5" },
            modelConfig: { options: [] },
          };
        }
        if (args.includes("send")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("session-summary")) {
          if (args.includes("--limit") && args.includes("1")) {
            return {
              latestVersion: 4,
              session: {
                agentSessionId: "session-1",
                agentTargetId: "local:codex",
                provider: "codex",
                status: "completed",
              },
              messages: [],
            };
          }
          if (args.includes("--order")) {
            return {
              hasMore: false,
              latestVersion: 0,
              session: {
                agentSessionId: "session-1",
                provider: "codex",
                status: "completed",
              },
              messages: [
                { role: "assistant", text: "second done", version: 6 },
              ],
            };
          }
        }
        if (args.includes("wait")) {
          return {
            reason: "completed",
            timedOut: false,
            hasMore: false,
            latestVersion: 6,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "completed",
            },
            messages: [],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:revise",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "revise",
      resumeSessionId: "session-1",
    })) {
      events.push(event);
    }

    expect(calls).toContainEqual([
      "--json",
      "agent",
      "session-summary",
      "--session-id",
      "session-1",
      "--limit",
      "1",
    ]);
    expect(calls).toContainEqual([
      "--json",
      "agent",
      "send",
      "--session-id",
      "session-1",
      "--prompt",
      "revise",
    ]);
    expect(calls).toContainEqual([
      "--json",
      "agent",
      "wait",
      "--session-id",
      "session-1",
      "--after-version",
      "4",
    ]);
    expect(events).toContainEqual({ type: "text_delta", text: "second done" });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      reason: "completed",
    });
  });

  it.each(["attachSessionId", "resumeSessionId"] as const)(
    "refuses to use a %s that belongs to another target with the same provider",
    async (sessionField) => {
      const calls: string[][] = [];
      const adapter = createNextopCliAgentAdapter({
        includeMockTarget: false,
        runner: async (args) => {
          calls.push(args);
          if (isAgentListCall(args)) {
            return {
              schemaVersion: 1,
              defaultAgentTargetId: "team:builder",
              agents: [
                {
                  id: "team:builder",
                  name: "Builder",
                  provider: "codex",
                  availability: { status: "available" },
                },
                {
                  id: "team:reviewer",
                  name: "Reviewer",
                  provider: "codex",
                  availability: { status: "available" },
                },
              ],
            };
          }
          if (args.includes("composer-options")) {
            return {
              effectiveSettings: { model: "gpt-5" },
              modelConfig: { options: [] },
            };
          }
          if (args.includes("session-summary")) {
            return {
              latestVersion: 4,
              session: {
                agentSessionId: "session-reviewer",
                agentTargetId: "team:reviewer",
                provider: "codex",
                status: "completed",
              },
              messages: [],
            };
          }
          throw new Error(`unexpected call: ${args.join(" ")}`);
        },
      });

      const events = [];
      for await (const event of adapter.run({
        runId: `run-1:${sessionField}`,
        agent: "team:builder",
        cwd: "/tmp/project",
        prompt: "continue",
        [sessionField]: "session-reviewer",
      })) {
        events.push(event);
      }

      expect(events).toContainEqual({
        type: "error",
        code: "NEXTOP_CLI_ERROR",
        message:
          "Nextop session belongs to agent target team:reviewer, not team:builder.",
        retryable: true,
      });
      expect(events.at(-1)).toEqual({
        type: "done",
        status: "failed",
        reason: "error",
      });
      expect(calls.some((args) => args.includes("send"))).toBe(false);
    },
  );

  it.each(["attachSessionId", "resumeSessionId"] as const)(
    "refuses to use a legacy %s from another provider",
    async (sessionField) => {
      const calls: string[][] = [];
      const adapter = createNextopCliAgentAdapter({
        includeMockTarget: false,
        runner: async (args) => {
          calls.push(args);
          if (isAgentListCall(args)) {
            throw new Error("unknown command: agent list");
          }
          if (args.includes("providers")) {
            return {
              defaultProviderId: "codex",
              providers: [
                {
                  providerId: "codex",
                  displayName: "Codex",
                  availability: { status: "available" },
                },
              ],
            };
          }
          if (args.includes("composer-options")) {
            return { effectiveSettings: { model: "gpt-5" } };
          }
          if (args.includes("session-summary")) {
            return {
              latestVersion: 4,
              session: {
                agentSessionId: "session-claude",
                provider: "claude-code",
                status: "completed",
              },
              messages: [],
            };
          }
          throw new Error(`unexpected call: ${args.join(" ")}`);
        },
      });

      const events = [];
      for await (const event of adapter.run({
        runId: `run-legacy:${sessionField}`,
        agent: "local:codex",
        cwd: "/tmp/project",
        prompt: "continue",
        [sessionField]: "session-claude",
      })) {
        events.push(event);
      }

      expect(events).toContainEqual({
        type: "error",
        code: "NEXTOP_CLI_ERROR",
        message: "Nextop session belongs to provider claude-code, not codex.",
        retryable: true,
      });
      expect(calls.some((args) => args.includes("send"))).toBe(false);
    },
  );

  it("reads final text from descending tail pages after completion", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("wait")) {
          return {
            reason: "completed",
            timedOut: false,
            hasMore: false,
            latestVersion: 120,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "completed",
            },
            messages: [{ role: "tool", text: "tool output", version: 120 }],
          };
        }
        if (
          args.includes("session-summary") &&
          args.includes("--order") &&
          !args.includes("--before-version")
        ) {
          return {
            hasMore: true,
            latestVersion: 0,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "completed",
            },
            messages: [
              { role: "tool", text: "newer tool", version: 120 },
              { role: "user", text: "ignored", version: 119 },
            ],
          };
        }
        if (
          args.includes("session-summary") &&
          args.includes("--before-version")
        ) {
          return {
            hasMore: false,
            latestVersion: 0,
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "completed",
            },
            messages: [
              { role: "assistant", text: "tail result", version: 118 },
            ],
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:scan",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "scan",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    expect(calls).toContainEqual([
      "--json",
      "agent",
      "session-summary",
      "--session-id",
      "session-1",
      "--order",
      "desc",
      "--limit",
      "50",
    ]);
    expect(calls).toContainEqual([
      "--json",
      "agent",
      "session-summary",
      "--session-id",
      "session-1",
      "--order",
      "desc",
      "--limit",
      "50",
      "--before-version",
      "119",
    ]);
    expect(events).toContainEqual({ type: "text_delta", text: "tail result" });
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      reason: "completed",
    });
  });

  it("cancels active sessions with the session-id flag", async () => {
    const calls: string[][] = [];
    const abortController = new AbortController();
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        calls.push(args);
        if (isAgentListCall(args)) return currentAgentCatalog();
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("cancel")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "canceled",
            },
          };
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    const events = [];
    for await (const event of adapter.run({
      runId: "run-1:scan",
      agent: "local:codex",
      cwd: "/tmp/project",
      prompt: "scan",
      model: "gpt-5",
      signal: abortController.signal,
    })) {
      events.push(event);
      if (event.type === "session_ref") {
        abortController.abort();
      }
    }

    expect(calls).toContainEqual([
      "--json",
      "agent",
      "cancel",
      "--session-id",
      "session-1",
    ]);
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "canceled",
      reason: "cancelled",
    });
  });

  it("opens sessions with the session-id flag", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      runner: async (args) => {
        calls.push(args);
        return {
          session: {
            agentSessionId: "session-1",
            provider: "codex",
            status: "completed",
          },
        };
      },
    });

    await adapter.openSession?.(" session-1 ");

    expect(calls).toEqual([
      ["--json", "agent", "open", "--session-id", "session-1"],
    ]);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function isAgentListCall(args: string[]): boolean {
  return args.join(" ") === "--json agent list";
}

function currentAgentCatalog() {
  return {
    schemaVersion: 1,
    defaultAgentTargetId: "local:codex",
    agents: [
      {
        id: "local:codex",
        name: "Codex",
        provider: "codex",
        availability: { status: "available", reasonCode: "", detail: "" },
      },
    ],
  };
}
