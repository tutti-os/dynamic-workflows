import { useEffect, useMemo, useState } from "react";
import { apiJson } from "@/components/workflow/workflowApiClient";
import type { AgentProviderOption } from "@/lib/agents/types";

export const DEFAULT_MODEL_VALUE = "__default__";

const FALLBACK_PROVIDERS: AgentProviderOption[] = [
  {
    id: "mock",
    label: "Mock local agent",
    supported: true,
    models: ["mock"],
  },
];

export function useWorkflowRunSettings(): {
  providers: AgentProviderOption[];
  effectiveProvider: string;
  model: string;
  modelOptions: string[];
  cwd: string;
  setProvider: (value: string) => void;
  setModel: (value: string) => void;
  setCwd: (value: string) => void;
} {
  const [providers, setProviders] =
    useState<AgentProviderOption[]>(FALLBACK_PROVIDERS);
  const [provider, setProviderState] = useState("mock");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState("");

  useEffect(() => {
    apiJson<{ providers?: AgentProviderOption[] }>(
      "/api/agents/providers",
      undefined,
      "PROVIDER_DETECTION_FAILED",
    )
      .then((data: { providers?: AgentProviderOption[] }) => {
        const nextProviders =
          data.providers && data.providers.length > 0
            ? data.providers
            : FALLBACK_PROVIDERS;
        setProviders(nextProviders);
        const preferredProvider =
          nextProviders.find((item) => item.supported && item.id === "codex") ??
          nextProviders.find((item) => item.supported && item.id !== "mock") ??
          nextProviders.find((item) => item.supported);
        if (preferredProvider) {
          setProviderState(preferredProvider.id);
        }
      })
      .catch(() => {
        setProviders(FALLBACK_PROVIDERS);
      });
  }, []);

  const effectiveProvider = provider || FALLBACK_PROVIDERS[0].id;
  const selectedProvider =
    providers.find((item) => item.id === effectiveProvider) ?? providers[0];
  const modelOptions = useMemo(
    () => selectedProvider?.models ?? [],
    [selectedProvider?.models],
  );

  function setProvider(value: string) {
    setProviderState(value);
    setModel("");
  }

  return {
    providers,
    effectiveProvider,
    model,
    modelOptions,
    cwd,
    setProvider,
    setModel,
    setCwd,
  };
}
