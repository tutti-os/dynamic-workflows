import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listAgentTargets,
  readApiJsonError,
} from "@/components/workflow/workflowApiService";
import type {
  AgentTargetCatalogResult,
  AgentTargetOption,
} from "@/lib/agents/types";

export const DEFAULT_MODEL_VALUE = "__default__";
export const DEFAULT_PERMISSION_MODE_VALUE = "__default_permission__";

const FALLBACK_AGENTS: AgentTargetOption[] = [
  {
    id: "mock",
    name: "Mock local agent",
    provider: "mock",
    supported: true,
    models: ["mock"],
  },
];

type AgentCatalogLoadHandlers = {
  onStart: () => void;
  onSuccess: (catalog: AgentTargetCatalogResult) => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
};

export function createAgentCatalogLoadCoordinator() {
  let requestVersion = 0;
  let activeController: AbortController | undefined;

  return {
    async run(
      load: (signal: AbortSignal) => Promise<AgentTargetCatalogResult>,
      handlers: AgentCatalogLoadHandlers,
    ): Promise<void> {
      activeController?.abort();
      const controller = new AbortController();
      const version = ++requestVersion;
      activeController = controller;
      handlers.onStart();

      try {
        const catalog = await load(controller.signal);
        if (version === requestVersion && !controller.signal.aborted) {
          handlers.onSuccess(catalog);
        }
      } catch (error) {
        if (version === requestVersion && !controller.signal.aborted) {
          handlers.onError(error);
        }
      } finally {
        if (version === requestVersion && !controller.signal.aborted) {
          activeController = undefined;
          handlers.onSettled();
        }
      }
    },
    cancel(): void {
      requestVersion += 1;
      activeController?.abort();
      activeController = undefined;
    },
  };
}

export function useWorkflowRunSettings(initial?: {
  agent?: string;
  model?: string;
  permissionMode?: string;
}): {
  agents: AgentTargetOption[];
  effectiveAgent: string;
  model: string;
  modelOptions: string[];
  permissionMode: string;
  permissionModeOptions: NonNullable<AgentTargetOption["permissionModes"]>;
  cwd: string;
  agentsLoading: boolean;
  agentsError?: string;
  agentsWarning?: string;
  retryAgents: () => Promise<void>;
  setAgent: (value: string) => void;
  setModel: (value: string) => void;
  setPermissionMode: (value: string) => void;
  setCwd: (value: string) => void;
} {
  const [agents, setAgents] = useState<AgentTargetOption[]>(FALLBACK_AGENTS);
  const [agent, setAgentState] = useState(initial?.agent ?? "mock");
  const [model, setModel] = useState(initial?.model ?? "");
  const [permissionMode, setPermissionMode] = useState(
    initial?.permissionMode ?? "",
  );
  const [cwd, setCwd] = useState("");
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | undefined>();
  const [agentsWarning, setAgentsWarning] = useState<string | undefined>();
  const hasLoadedCatalogRef = useRef(false);
  const preserveInitialAgentRef = useRef(Boolean(initial?.agent));
  const agentRef = useRef(agent);
  const loadCoordinatorRef = useRef<
    ReturnType<typeof createAgentCatalogLoadCoordinator>
  >(undefined);
  loadCoordinatorRef.current ??= createAgentCatalogLoadCoordinator();
  const loadCoordinator = loadCoordinatorRef.current;

  const loadAgents = useCallback(
    () =>
      loadCoordinator.run(listAgentTargets, {
        onStart: () => setAgentsLoading(true),
        onSuccess: (catalog) => {
          const nextAgents =
            catalog.targets.length > 0 ? catalog.targets : FALLBACK_AGENTS;
          setAgents(nextAgents);
          const preferredAgent = selectDefaultAgentTarget(nextAgents);
          if (preferredAgent) {
            const currentAgent = agentRef.current;
            const nextAgent =
              (hasLoadedCatalogRef.current ||
                preserveInitialAgentRef.current) &&
              nextAgents.some(
                (item) => item.id === currentAgent && item.supported,
              )
                ? currentAgent
                : preferredAgent.id;
            if (nextAgent !== currentAgent) {
              agentRef.current = nextAgent;
              setAgentState(nextAgent);
              setModel("");
              setPermissionMode("");
            }
          }
          hasLoadedCatalogRef.current = true;
          setAgentsError(undefined);
          setAgentsWarning(
            catalog.freshness === "stale"
              ? catalog.warning ??
                  "Agent discovery is temporarily unavailable. Showing recently cached agents."
              : undefined,
          );
        },
        onError: (error) => {
          const apiError = readApiJsonError(
            error,
            "AGENT_TARGET_DETECTION_FAILED",
          );
          setAgents(FALLBACK_AGENTS);
          setAgentsError(undefined);
          setAgentsWarning(
            `${apiError.message} Using the Mock local agent fallback.`,
          );
        },
        onSettled: () => setAgentsLoading(false),
      }),
    [loadCoordinator],
  );

  useEffect(() => {
    void loadAgents();
    return () => loadCoordinator.cancel();
  }, [loadAgents, loadCoordinator]);

  const effectiveAgent = agent || FALLBACK_AGENTS[0].id;
  const selectedAgent =
    agents.find((item) => item.id === effectiveAgent) ?? agents[0];
  const modelOptions = useMemo(
    () => selectedAgent?.models ?? [],
    [selectedAgent?.models],
  );
  const permissionModeOptions = useMemo(
    () => selectedAgent?.permissionModes ?? [],
    [selectedAgent?.permissionModes],
  );

  function setAgent(value: string) {
    agentRef.current = value;
    setAgentState(value);
    setModel("");
    setPermissionMode("");
  }

  return {
    agents,
    effectiveAgent,
    model,
    modelOptions,
    permissionMode,
    permissionModeOptions,
    cwd,
    agentsLoading,
    agentsError,
    agentsWarning,
    retryAgents: loadAgents,
    setAgent,
    setModel,
    setPermissionMode,
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
