import { useEffect, useMemo, useState } from "react";
import { listAgentTargets } from "@/components/workflow/workflowApiService";
import type { AgentTargetOption } from "@/lib/agents/types";

export const DEFAULT_MODEL_VALUE = "__default__";

const FALLBACK_AGENTS: AgentTargetOption[] = [
  {
    id: "mock",
    name: "Mock local agent",
    provider: "mock",
    supported: true,
    models: ["mock"],
  },
];

export function useWorkflowRunSettings(): {
  agents: AgentTargetOption[];
  effectiveAgent: string;
  model: string;
  modelOptions: string[];
  cwd: string;
  setAgent: (value: string) => void;
  setModel: (value: string) => void;
  setCwd: (value: string) => void;
} {
  const [agents, setAgents] = useState<AgentTargetOption[]>(FALLBACK_AGENTS);
  const [agent, setAgentState] = useState("mock");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState("");

  useEffect(() => {
    listAgentTargets()
      .then((targets) => {
        const nextAgents =
          targets.length > 0
            ? targets
            : FALLBACK_AGENTS;
        setAgents(nextAgents);
        const preferredAgent = selectDefaultAgentTarget(nextAgents);
        if (preferredAgent) {
          setAgentState(preferredAgent.id);
        }
      })
      .catch(() => {
        setAgents(FALLBACK_AGENTS);
      });
  }, []);

  const effectiveAgent = agent || FALLBACK_AGENTS[0].id;
  const selectedAgent =
    agents.find((item) => item.id === effectiveAgent) ?? agents[0];
  const modelOptions = useMemo(
    () => selectedAgent?.models ?? [],
    [selectedAgent?.models],
  );

  function setAgent(value: string) {
    setAgentState(value);
    setModel("");
  }

  return {
    agents,
    effectiveAgent,
    model,
    modelOptions,
    cwd,
    setAgent,
    setModel,
    setCwd,
  };
}

export function selectDefaultAgentTarget(
  agents: AgentTargetOption[],
): AgentTargetOption | undefined {
  return (
    agents.find((item) => item.isDefault && item.supported) ??
    agents.find((item) => item.supported && item.id !== "mock") ??
    agents.find((item) => item.supported)
  );
}
