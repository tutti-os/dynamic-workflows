import { createNextopCliAgentAdapter } from "./adapters/nextopCliAdapter";
import type {
  AgentRuntimeAdapter,
  AgentSessionStartInput,
  AgentTargetCatalogResult,
} from "./types";

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

export async function listAgentTargetCatalog(): Promise<AgentTargetCatalogResult> {
  const adapter = getAgentRuntimeAdapter();
  if (adapter.listTargetCatalog) {
    return adapter.listTargetCatalog();
  }
  return {
    targets: await adapter.listTargets(),
    freshness: "fresh",
  };
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

export async function sendAgentMessage(input: {
  agentSessionId: string;
  message: string;
}): Promise<void> {
  const adapter = getAgentRuntimeAdapter();
  if (!adapter.sendToSession) {
    throw new Error(
      "Delivering a message to a live agent session is not supported by this adapter.",
    );
  }
  await adapter.sendToSession(input.agentSessionId, input.message);
}
