import { describe, expect, it } from "vitest";
import {
  createNextopCliAgentAdapter,
  isUnknownAgentListCommand,
  latestAssistantText,
  newestAssistantText,
  parseNextopJson,
  parseSessionFromOutput,
  resolveNextopCliPath,
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
        isDefault: false,
        reason: undefined,
      },
      {
        id: "team:reviewer",
        name: "Reviewer",
        provider: "codex",
        supported: true,
        models: ["gpt-5.5"],
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

  it("does not hide ordinary agent list failures behind provider fallback", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      runner: async (args) => {
        calls.push(args);
        throw new Error("Nextop CLI timed out after 3000ms.");
      },
    });

    await expect(adapter.listTargets()).rejects.toThrow(/timed out/);
    expect(calls).toEqual([["--json", "agent", "list"]]);
    expect(
      isUnknownAgentListCommand(new Error("unknown command: agent list")),
    ).toBe(true);
    expect(
      isUnknownAgentListCommand(new Error("unknown command: agent list now")),
    ).toBe(false);
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

  it("streams session refs and final text from waiting", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      waitTimeoutMs: 1_000,
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
      model: "gpt-5",
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
      "--prompt",
      "scan",
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
    expect(events.at(-1)).toEqual({
      type: "done",
      status: "completed",
      reason: "completed",
    });
  });

  it("completes on wait reason completed while session status stays created", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockTarget: false,
      pollIntervalMs: 1,
      waitTimeoutMs: 1_000,
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
      "--timeout-ms",
      "1000",
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
      waitTimeoutMs: 1_000,
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
      waitTimeoutMs: 1_000,
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
      waitTimeoutMs: 1_000,
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
      waitTimeoutMs: 1_000,
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
      "--timeout-ms",
      "1000",
    ]);
    expect(calls).toContainEqual([
      "--json",
      "agent",
      "wait",
      "--session-id",
      "session-1",
      "--after-version",
      "12",
      "--timeout-ms",
      "1000",
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
      "--timeout-ms",
      "30000",
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
