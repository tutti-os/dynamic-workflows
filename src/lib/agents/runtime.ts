import { createNextopCliAgentAdapter } from "./adapters/nextopCliAdapter";
import type { AgentRuntimeAdapter } from "./types";

let defaultAdapter: AgentRuntimeAdapter | undefined;

export function getAgentRuntimeAdapter(): AgentRuntimeAdapter {
  defaultAdapter ??= createNextopCliAgentAdapter({
    includeMockProvider: true,
  });
  return defaultAdapter;
}

export async function listAgentProviders() {
  return getAgentRuntimeAdapter().listProviders();
}

export function runAgent(input: Parameters<AgentRuntimeAdapter["run"]>[0]) {
  return getAgentRuntimeAdapter().run(input);
}

export async function openAgentSession(agentSessionId: string) {
  const adapter = getAgentRuntimeAdapter();
  if (!adapter.openSession) {
    throw new Error("Agent session opening is not supported by this adapter.");
  }
  await adapter.openSession(agentSessionId);
}

export async function cancelAgentRun(runId: string) {
  const adapter = getAgentRuntimeAdapter();
  if (!adapter.cancel) {
    return;
  }
  await adapter.cancel(runId);
}
