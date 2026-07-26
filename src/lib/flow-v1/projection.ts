import { getFlowV1BundleForVersion } from "@/lib/db/workflows/flow-bundles";
import { getDb } from "@/lib/db/client";
import {
  getFlowV1CycleCheckpoint,
  listFlowV1Cycles,
  listFlowV1RunsForCycle,
} from "@/lib/db/workflows/flow-runtime";
import {
  listFlowV1Effects,
  listFlowV1NodeAttempts,
} from "@/lib/db/workflows/flow-attempts";
import {
  getCurrentFlowV1Params,
  getFlowV1RuntimeSummary,
} from "@/lib/db/workflows/flow-settings";
import { listFlowV1HumanTasks } from "@/lib/db/workflows/human-tasks";
import { parseFlowV1Bundle } from "./parser";
import {
  listFlowV1MemoryConflicts,
  readFlowV1Memory,
} from "./memory";
import { getFlowV1RuntimeConfig } from "./runtime-config";
import type {
  FlowV1DetailProjection,
  FlowV1GraphCheckpoint,
} from "./types";

export function getFlowV1DetailProjection(
  flowId: string,
  cycleId?: string,
): FlowV1DetailProjection | null {
  const runtime = getFlowV1RuntimeSummary(flowId);
  if (!runtime) {
    return null;
  }
  const cycles = listFlowV1Cycles(flowId);
  const selectedCycle =
    (cycleId ? cycles.find((cycle) => cycle.id === cycleId) : null) ??
    runtime.activeCycle ??
    cycles[0] ??
    null;
  const versionId =
    selectedCycle?.flowVersionId ??
    runtime.latestRun?.flowVersionId ??
    (
      getDb()
        .prepare("SELECT current_version_id FROM workflows WHERE id = ?")
        .get(flowId) as { current_version_id: string | null } | undefined
    )?.current_version_id;
  if (!versionId) {
    return null;
  }
  const bundle = getFlowV1BundleForVersion(versionId);
  if (!bundle) {
    return null;
  }
  const flow = parseFlowV1Bundle(bundle);
  const storedCheckpoint = selectedCycle
    ? getFlowV1CycleCheckpoint(selectedCycle.id)
    : null;
  const checkpoint =
    storedCheckpoint && "nodes" in storedCheckpoint.state
      ? (storedCheckpoint.state as unknown as FlowV1GraphCheckpoint)
      : null;
  let memory: FlowV1DetailProjection["memory"] = null;
  if (flow.memory) {
    try {
      const document = readFlowV1Memory(flowId, flow.memory);
      memory = {
        path: document.path,
        markdown: document.markdown,
        hash: document.hash,
        sections: document.sections,
        conflicts: listFlowV1MemoryConflicts({
          flowId,
          cycleId: selectedCycle?.id,
        }),
      };
    } catch (error) {
      memory = {
        path: "",
        markdown: "",
        hash: "",
        sections: {},
        conflicts: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    schemaVersion: "tutti.flow.v1",
    runtime,
    graph: {
      nodes: flow.nodes,
      edges: flow.edges,
    },
    cycles,
    selectedCycle,
    runs: selectedCycle ? listFlowV1RunsForCycle(selectedCycle.id) : [],
    checkpoint,
    attempts: selectedCycle
      ? listFlowV1NodeAttempts(selectedCycle.id)
      : [],
    effects: selectedCycle ? listFlowV1Effects(selectedCycle.id) : [],
    humanTasks: selectedCycle
      ? listFlowV1HumanTasks(selectedCycle.id)
      : [],
    configuration: {
      paramsSchema: flow.params,
      inputsSchema: flow.inputs,
      secretsSchema: flow.secrets,
      params: getCurrentFlowV1Params(flowId),
      ...getFlowV1RuntimeConfig(flowId),
    },
    memory,
  };
}
