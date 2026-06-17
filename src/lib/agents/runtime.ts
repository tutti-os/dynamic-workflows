import { createAcpKitAgentAdapter } from "./adapters/acpKitAdapter";
import type { AgentRuntimeAdapter } from "./types";

let defaultAdapter: AgentRuntimeAdapter | undefined;

export function getAgentRuntimeAdapter(): AgentRuntimeAdapter {
  defaultAdapter ??= createAcpKitAgentAdapter({
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
