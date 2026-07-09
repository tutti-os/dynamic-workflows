import { createNextopCliAgentAdapter } from "./adapters/nextopCliAdapter";
import type { AgentRuntimeAdapter, AgentSessionStartInput } from "./types";

let defaultAdapter: AgentRuntimeAdapter | undefined;

export function getAgentRuntimeAdapter(): AgentRuntimeAdapter {
  defaultAdapter ??= createNextopCliAgentAdapter({
    includeMockTarget: true,
  });
  return defaultAdapter;
}

export async function listAgentTargets() {
  return getAgentRuntimeAdapter().listTargets();
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

export async function startAgentSession(input: AgentSessionStartInput) {
  const adapter = getAgentRuntimeAdapter();
  if (!adapter.startSession) {
    throw new Error("Agent session start is not supported by this adapter.");
  }
  return adapter.startSession(input);
}

export async function cancelAgentSession(agentSessionId: string) {
  const adapter = getAgentRuntimeAdapter();
  if (!adapter.cancelSession) {
    return;
  }
  await adapter.cancelSession(agentSessionId);
}

export async function cancelAgentRun(runId: string) {
  const adapter = getAgentRuntimeAdapter();
  if (!adapter.cancel) {
    return;
  }
  await adapter.cancel(runId);
}
