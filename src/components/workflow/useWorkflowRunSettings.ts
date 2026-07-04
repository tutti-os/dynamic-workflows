import { useEffect, useMemo, useState } from "react";
import { apiJson } from "@/components/workflow/workflowApiClient";
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
    apiJson<{ targets?: AgentTargetOption[] }>(
      "/api/agents/targets",
      undefined,
      "AGENT_TARGET_DETECTION_FAILED",
    )
      .then((data: { targets?: AgentTargetOption[] }) => {
        const nextAgents =
          data.targets && data.targets.length > 0
            ? data.targets
            : FALLBACK_AGENTS;
        setAgents(nextAgents);
        const preferredAgent =
          nextAgents.find(
            (item) => item.supported && item.id === "local:codex",
          ) ??
          nextAgents.find((item) => item.supported && item.id !== "mock") ??
          nextAgents.find((item) => item.supported);
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
