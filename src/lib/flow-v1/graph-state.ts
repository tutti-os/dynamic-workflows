import type {
  FlowV1CheckpointNodeState,
  FlowV1ControlEdge,
  FlowV1DataEdge,
  FlowV1GraphCheckpoint,
  FlowV1Node,
  FlowV1NodeResult,
  ParsedFlowV1,
} from "./types";

export function createFlowV1GraphCheckpoint(
  flow: ParsedFlowV1,
): FlowV1GraphCheckpoint {
  return {
    nodes: Object.fromEntries(
      flow.nodes.map((node) => [
        node.id,
        { status: "idle", attemptCount: 0 },
      ]),
    ),
    selectedControlEdgeIds: [],
    notSelectedControlEdgeIds: [],
  };
}

export function planFlowV1Graph(
  flow: ParsedFlowV1,
  checkpoint: FlowV1GraphCheckpoint,
): {
  checkpoint: FlowV1GraphCheckpoint;
  readyNodeIds: string[];
} {
  const next = cloneCheckpoint(checkpoint);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of flow.nodes) {
      const state = requireNodeState(next, node.id);
      if (state.status !== "idle" || node.kind === "finally") {
        continue;
      }
      const decision = evaluateNode(flow, next, node);
      if (decision === "not_selected") {
        state.status = "not_selected";
        changed = true;
      }
    }
  }

  const readyNodeIds = flow.nodes
    .filter((node) => {
      const state = requireNodeState(next, node.id);
      return (
        state.status === "idle" &&
        node.kind !== "finally" &&
        evaluateNode(flow, next, node) === "ready"
      );
    })
    .map((node) => node.id);
  for (const nodeId of readyNodeIds) {
    requireNodeState(next, nodeId).status = "queued";
  }
  refreshControlProjection(flow, next);
  return { checkpoint: next, readyNodeIds };
}

export function markFlowV1NodeRunning(
  checkpoint: FlowV1GraphCheckpoint,
  nodeId: string,
): FlowV1GraphCheckpoint {
  const next = cloneCheckpoint(checkpoint);
  const state = requireNodeState(next, nodeId);
  if (state.status !== "queued") {
    throw new Error(
      `Flow node ${nodeId} must be queued before it can start running.`,
    );
  }
  state.status = "running";
  state.attemptCount += 1;
  return next;
}

export function incrementFlowV1NodeAttemptCount(
  checkpoint: FlowV1GraphCheckpoint,
  nodeId: string,
): FlowV1GraphCheckpoint {
  const next = cloneCheckpoint(checkpoint);
  const state = requireNodeState(next, nodeId);
  if (state.status !== "running") {
    throw new Error(
      `Flow node ${nodeId} must be running before recording a retry.`,
    );
  }
  state.attemptCount += 1;
  return next;
}

export function queueFlowV1Node(
  checkpoint: FlowV1GraphCheckpoint,
  nodeId: string,
): FlowV1GraphCheckpoint {
  const next = cloneCheckpoint(checkpoint);
  const state = requireNodeState(next, nodeId);
  if (state.status !== "idle") {
    throw new Error(`Flow node ${nodeId} must be idle before it is queued.`);
  }
  state.status = "queued";
  return next;
}

export function setFlowV1NodeProgress(
  checkpoint: FlowV1GraphCheckpoint,
  nodeId: string,
  progress: FlowV1GraphCheckpoint["nodes"][string]["progress"],
): FlowV1GraphCheckpoint {
  const next = cloneCheckpoint(checkpoint);
  const state = requireNodeState(next, nodeId);
  if (state.status !== "running") {
    throw new Error(
      `Flow node ${nodeId} must be running before saving progress.`,
    );
  }
  if (progress === undefined) {
    delete state.progress;
  } else {
    state.progress = structuredClone(progress);
  }
  return next;
}

export function applyFlowV1NodeResult(
  flow: ParsedFlowV1,
  checkpoint: FlowV1GraphCheckpoint,
  nodeId: string,
  result: FlowV1NodeResult,
): FlowV1GraphCheckpoint {
  const next = cloneCheckpoint(checkpoint);
  const node = flow.nodes.find((entry) => entry.id === nodeId);
  if (!node) {
    throw new Error(`Unknown Flow node ${nodeId}.`);
  }
  const state = requireNodeState(next, nodeId);
  if (state.status !== "running") {
    throw new Error(
      `Flow node ${nodeId} must be running before recording a result.`,
    );
  }
  delete state.output;
  delete state.outcome;
  delete state.waitingReason;
  delete state.error;
  switch (result.status) {
    case "completed":
      if (
        node.kind === "gate" &&
        (!result.outcome || !node.outcomes.includes(result.outcome))
      ) {
        throw new Error(
          `Gate ${nodeId} returned an undeclared control outcome.`,
        );
      }
      state.status = "completed";
      delete state.progress;
      if (result.output !== undefined) {
        state.output = result.output;
      }
      if (result.outcome !== undefined) {
        state.outcome = result.outcome;
      }
      break;
    case "waiting":
      if (
        node.kind !== "gate" &&
        node.kind !== "human" &&
        node.kind !== "loop" &&
        node.kind !== "map"
      ) {
        throw new Error(`Node ${nodeId} cannot return waiting.`);
      }
      state.status = "waiting";
      state.waitingReason = result.reason;
      break;
    case "skipped":
      state.status = "not_selected";
      state.waitingReason = result.reason;
      break;
    case "failed":
      state.status = "failed";
      state.error = result.error;
      break;
    case "uncertain":
      state.status = "uncertain";
      state.error = result.error;
      break;
    case "conflict":
      state.status = "failed";
      state.error = result.error;
      break;
  }
  refreshControlProjection(flow, next);
  return next;
}

export function requeueWaitingFlowV1Node(
  checkpoint: FlowV1GraphCheckpoint,
  nodeId: string,
): FlowV1GraphCheckpoint {
  const next = cloneCheckpoint(checkpoint);
  const state = requireNodeState(next, nodeId);
  if (state.status !== "waiting") {
    throw new Error(`Flow node ${nodeId} is not waiting.`);
  }
  state.status = "queued";
  delete state.waitingReason;
  return next;
}

export function requeueUncertainFlowV1Effect(
  checkpoint: FlowV1GraphCheckpoint,
  nodeId: string,
): FlowV1GraphCheckpoint {
  const next = cloneCheckpoint(checkpoint);
  const state = requireNodeState(next, nodeId);
  if (state.status !== "uncertain") {
    throw new Error(`Flow node ${nodeId} is not uncertain.`);
  }
  state.status = "queued";
  delete state.error;
  return next;
}

export function resetQueuedFlowV1Nodes(
  checkpoint: FlowV1GraphCheckpoint,
): FlowV1GraphCheckpoint {
  const next = cloneCheckpoint(checkpoint);
  for (const state of Object.values(next.nodes)) {
    if (state.status === "queued") {
      state.status = "idle";
    }
  }
  return next;
}

export function invalidateFlowV1NodeAndDownstream(
  flow: ParsedFlowV1,
  checkpoint: FlowV1GraphCheckpoint,
  nodeId: string,
  options?: { preserveRootProgress?: boolean },
): {
  checkpoint: FlowV1GraphCheckpoint;
  invalidatedNodeIds: string[];
} {
  requireNodeState(checkpoint, nodeId);
  const invalidated = new Set<string>([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of flow.edges) {
      if (
        invalidated.has(edge.sourceNodeId) &&
        !invalidated.has(edge.targetNodeId)
      ) {
        invalidated.add(edge.targetNodeId);
        changed = true;
      }
    }
  }

  const next = cloneCheckpoint(checkpoint);
  for (const invalidatedNodeId of invalidated) {
    const state = requireNodeState(next, invalidatedNodeId);
    state.status = "idle";
    delete state.output;
    delete state.outcome;
    delete state.waitingReason;
    delete state.error;
    if (
      invalidatedNodeId !== nodeId ||
      !options?.preserveRootProgress
    ) {
      delete state.progress;
    }
  }
  refreshControlProjection(flow, next);
  return {
    checkpoint: next,
    invalidatedNodeIds: flow.nodes
      .map((node) => node.id)
      .filter((id) => invalidated.has(id)),
  };
}

function evaluateNode(
  flow: ParsedFlowV1,
  checkpoint: FlowV1GraphCheckpoint,
  node: FlowV1Node,
): "blocked" | "ready" | "not_selected" {
  const dataEdges = flow.edges.filter(
    (edge): edge is FlowV1DataEdge =>
      edge.kind === "data" && edge.targetNodeId === node.id,
  );
  const controlEdges = flow.edges.filter(
    (edge): edge is FlowV1ControlEdge =>
      edge.kind === "control" && edge.targetNodeId === node.id,
  );
  if (
    dataEdges.some(
      (edge) =>
        requireNodeState(checkpoint, edge.sourceNodeId).status ===
        "not_selected",
    )
  ) {
    return "not_selected";
  }
  if (
    dataEdges.some(
      (edge) =>
        requireNodeState(checkpoint, edge.sourceNodeId).status !==
        "completed",
    )
  ) {
    return "blocked";
  }
  if (controlEdges.length === 0) {
    return "ready";
  }
  if (
    controlEdges.some((edge) => {
      const source = requireNodeState(checkpoint, edge.sourceNodeId);
      return source.status === "completed" && source.outcome === edge.outcome;
    })
  ) {
    return "ready";
  }
  const allControlSourcesResolved = controlEdges.every((edge) => {
    const source = requireNodeState(checkpoint, edge.sourceNodeId);
    return (
      source.status === "completed" || source.status === "not_selected"
    );
  });
  return allControlSourcesResolved ? "not_selected" : "blocked";
}

function refreshControlProjection(
  flow: ParsedFlowV1,
  checkpoint: FlowV1GraphCheckpoint,
): void {
  const selected = new Set<string>();
  const notSelected = new Set<string>();
  for (const edge of flow.edges) {
    if (edge.kind !== "control") {
      continue;
    }
    const source = requireNodeState(checkpoint, edge.sourceNodeId);
    if (source.status !== "completed" || !source.outcome) {
      continue;
    }
    if (source.outcome === edge.outcome) {
      selected.add(edge.id);
    } else {
      notSelected.add(edge.id);
    }
  }
  checkpoint.selectedControlEdgeIds = [...selected].sort();
  checkpoint.notSelectedControlEdgeIds = [...notSelected].sort();
}

function requireNodeState(
  checkpoint: FlowV1GraphCheckpoint,
  nodeId: string,
): FlowV1CheckpointNodeState {
  const state = checkpoint.nodes[nodeId];
  if (!state) {
    throw new Error(`Checkpoint has no state for Flow node ${nodeId}.`);
  }
  return state;
}

function cloneCheckpoint(
  checkpoint: FlowV1GraphCheckpoint,
): FlowV1GraphCheckpoint {
  return structuredClone(checkpoint);
}
