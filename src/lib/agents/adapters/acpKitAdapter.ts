import {
  createClaudeProvider,
  createCodexProvider,
  createLocalAgentRuntime,
  type AgentEvent,
} from "@tutti-os/agent-acp-kit";
import type {
  AgentProviderOption,
  AgentRunInput,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
} from "../types";
import { createMockAgentAdapter } from "./mockAdapter";

type AcpKitProviderId = "codex" | "claude";

export function createAcpKitAgentAdapter(options?: {
  includeMockProvider?: boolean;
}): AgentRuntimeAdapter {
  const mockAdapter = createMockAgentAdapter();

  return {
    id: "acp-kit",
    label: "ACP Kit local agent adapter",
    async listProviders(): Promise<AgentProviderOption[]> {
      const runtime = createLocalAgentRuntime({
        providers: [createCodexProvider(), createClaudeProvider()],
      });

      const detected = await runtime.detect();
      const realProviders = detected.map((item) => ({
        id: item.provider,
        label: item.displayName,
        supported: item.result?.supported !== false,
        models: item.result?.models?.map((model) => model.id) ?? [],
        reason: item.result?.unsupportedReason,
      }));

      if (options?.includeMockProvider === false) {
        return realProviders;
      }

      return [...(await mockAdapter.listProviders()), ...realProviders];
    },
    async *run(input: AgentRunInput): AsyncGenerator<AgentRuntimeEvent> {
      console.info(
        `[agent-runtime:${this.id}] provider=${input.provider} runId=${input.runId} cwd=${input.cwd}`,
      );

      if (input.provider === "mock") {
        yield* mockAdapter.run(input);
        return;
      }

      const provider = toAcpKitProviderId(input.provider);
      const runtime = createLocalAgentRuntime({
        providers: [createCodexProvider(), createClaudeProvider()],
      });

      for await (const event of runtime.run({
        runId: input.runId,
        provider,
        cwd: input.cwd,
        prompt: input.prompt,
        model: input.model,
        signal: input.signal,
        metadata: input.metadata,
      })) {
        yield normalizeAcpKitEvent(event);
      }
    },
    async cancel(runId: string): Promise<void> {
      const runtime = createLocalAgentRuntime({
        providers: [createCodexProvider(), createClaudeProvider()],
      });
      await runtime.cancel(runId);
    },
  };
}

function toAcpKitProviderId(provider: string): AcpKitProviderId {
  if (provider === "codex" || provider === "claude") {
    return provider;
  }

  throw new Error(`Unsupported ACP kit provider: ${provider}`);
}

function normalizeAcpKitEvent(event: AgentEvent): AgentRuntimeEvent {
  return event;
}
