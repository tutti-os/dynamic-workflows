import { describe, expect, it } from "vitest";
import {
  createNextopCliAgentAdapter,
  latestAssistantText,
  newestAssistantText,
  parseNextopJson,
  parseProviderOptions,
  parseSessionFromOutput,
  resolveNextopCliPath,
} from "./nextopCliAdapter";

describe("nextop cli adapter", () => {
  it("resolves the Tutti CLI path before the legacy Nextop env var", () => {
    const previousTuttiCli = process.env.TUTTI_CLI;
    const previousNextopCliPath = process.env.NEXTOP_CLI_PATH;

    try {
      process.env.TUTTI_CLI = "/tmp/tutti-dev";
      process.env.NEXTOP_CLI_PATH = "/tmp/nextop";

      expect(resolveNextopCliPath()).toBe("/tmp/tutti-dev");
      expect(resolveNextopCliPath({ cliPath: "/tmp/custom" })).toBe(
        "/tmp/custom",
      );

      process.env.TUTTI_CLI = "";
      expect(resolveNextopCliPath()).toBe("/tmp/nextop");

      process.env.NEXTOP_CLI_PATH = "";
      expect(resolveNextopCliPath()).toBe("tutti-dev");
    } finally {
      restoreEnv("TUTTI_CLI", previousTuttiCli);
      restoreEnv("NEXTOP_CLI_PATH", previousNextopCliPath);
    }
  });

  it("parses valid JSON and rejects invalid JSON", () => {
    expect(parseNextopJson('{"ok":true}\n')).toEqual({ ok: true });
    expect(() => parseNextopJson("not json")).toThrow(/invalid JSON/);
  });

  it("maps provider availability to provider options", () => {
    expect(
      parseProviderOptions({
        providers: [
          { provider: "claude-code", status: "unavailable", detail: "login" },
          { provider: "codex", status: "available" },
        ],
      }),
    ).toEqual([
      {
        id: "codex",
        label: "Codex",
        supported: true,
        models: [],
        reason: undefined,
      },
      {
        id: "claude-code",
        label: "Claude Code",
        supported: false,
        models: [],
        reason: "login",
      },
    ]);
  });

  it("uses local Codex detection when Nextop reports Codex unavailable", async () => {
    const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockProvider: false,
      providerDetectionTimeoutMs: 123,
      providerModelsTimeoutMs: 456,
      commandDetector: async (command) =>
        command === "codex" ? "/Users/me/.local/bin/codex" : undefined,
      runner: async (args, options) => {
        calls.push({ args, timeoutMs: options?.timeoutMs });
        if (args.includes("providers")) {
          return {
            providers: [
              {
                provider: "codex",
                status: "unavailable",
                detail: "not found",
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

    await expect(adapter.listProviders()).resolves.toEqual([
      {
        id: "codex",
        label: "Codex",
        supported: true,
        models: ["gpt-5.5"],
        reason: "/Users/me/.local/bin/codex",
      },
    ]);
    expect(calls).toContainEqual({
      args: ["--json", "agent", "providers"],
      timeoutMs: 123,
    });
    expect(calls).toContainEqual({
      args: ["--json", "agent", "composer-options", "--provider", "codex"],
      timeoutMs: 456,
    });
  });

  it("falls back to local Codex when provider discovery fails", async () => {
    const adapter = createNextopCliAgentAdapter({
      includeMockProvider: false,
      commandDetector: async (command) =>
        command === "codex" ? "/Users/me/.local/bin/codex" : undefined,
      runner: async (args) => {
        if (args.includes("providers")) {
          throw new Error("provider discovery timed out");
        }
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
    });

    await expect(adapter.listProviders()).resolves.toEqual([
      {
        id: "codex",
        label: "Codex",
        supported: true,
        models: [],
        reason: "/Users/me/.local/bin/codex",
      },
    ]);
  });

  it("requires agentSessionId in start output", () => {
    expect(() =>
      parseSessionFromOutput({ session: { provider: "codex" } }),
    ).toThrow(/agentSessionId/);
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

  it("streams session refs and final text from polling", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockProvider: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        calls.push(args);
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
          if (args.includes("--order")) {
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
          return {
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
      provider: "codex",
      cwd: "/tmp/project",
      prompt: "scan",
      model: "gpt-5",
    })) {
      events.push(event);
    }

    expect(calls[0]).toEqual([
      "--json",
      "codex",
      "start",
      "--model",
      "gpt-5",
      "--prompt",
      "scan",
      "--cwd",
      "/tmp/project",
      "--visible",
    ]);
    expect(events).toContainEqual({
      type: "session_ref",
      session: {
        agentSessionId: "session-1",
        provider: "codex",
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

  it("reads final text from descending tail pages after completion", async () => {
    const calls: string[][] = [];
    const adapter = createNextopCliAgentAdapter({
      includeMockProvider: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        calls.push(args);
        if (args.includes("start")) {
          return {
            session: {
              agentSessionId: "session-1",
              provider: "codex",
              status: "running",
            },
          };
        }
        if (args.includes("session-summary") && !args.includes("--order")) {
          return {
            hasMore: true,
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
      provider: "codex",
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
      includeMockProvider: false,
      pollIntervalMs: 1,
      runner: async (args) => {
        calls.push(args);
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
      provider: "codex",
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
      includeMockProvider: false,
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
