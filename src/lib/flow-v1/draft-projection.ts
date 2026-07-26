import { getFlowV1BundleForVersion } from "@/lib/db/workflows/flow-bundles";
import { getCurrentFlowV1Params } from "@/lib/db/workflows/flow-settings";
import type { WorkflowDraftReview } from "@/lib/db/workflows/types";
import { listWorkflowVersions } from "@/lib/db/workflows/versions";
import { parseFlowV1Bundle } from "./parser";
import { getFlowV1RuntimeConfig } from "./runtime-config";
import type { FlowV1JsonObject } from "./types";

export function getLatestFlowV1DraftReview(
  flowId: string,
): WorkflowDraftReview | null {
  const version = listWorkflowVersions(flowId).find(
    (candidate) => candidate.status === "draft",
  );
  if (!version) {
    return null;
  }
  const bundle = getFlowV1BundleForVersion(version.id);
  if (!bundle) {
    return null;
  }
  const flow = parseFlowV1Bundle(bundle);
  const currentParams = getCurrentFlowV1Params(flowId)?.values ?? {};
  const suggestedParams: FlowV1JsonObject = {};
  for (const entry of Object.values(flow.params)) {
    if (currentParams[entry.name] !== undefined) {
      suggestedParams[entry.name] = currentParams[entry.name]!;
    } else if (entry.config.default !== undefined) {
      suggestedParams[entry.name] = entry.config.default;
    }
  }
  const runtimeConfig = getFlowV1RuntimeConfig(flowId);
  return {
    version,
    bundle: {
      hash: bundle.hash,
      files: bundle.files,
    },
    graph: {
      nodes: flow.nodes,
      edges: flow.edges,
    },
    configuration: {
      paramsSchema: flow.params,
      inputsSchema: flow.inputs,
      secretsSchema: flow.secrets,
      suggestedParams,
      projectCwd: runtimeConfig.projectCwd,
      defaultAgent: runtimeConfig.defaultAgent,
      defaultModel: runtimeConfig.defaultModel,
      defaultPermissionMode: runtimeConfig.defaultPermissionMode,
    },
    diagnostics: flow.diagnostics,
  };
}
