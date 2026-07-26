import { describe, expect, it } from "vitest";
import { createFlowV1Bundle } from "./bundle";
import {
  applyFlowV1NodeResult,
  createFlowV1GraphCheckpoint,
  invalidateFlowV1NodeAndDownstream,
  markFlowV1NodeRunning,
  planFlowV1Graph,
  requeueWaitingFlowV1Node,
} from "./graph-state";
import { parseFlowV1Bundle } from "./parser";

describe("Flow v1 graph state", () => {
  it("selects one Gate branch and projects the other as not selected", () => {
    const flow = referenceFlow();
    let checkpoint = createFlowV1GraphCheckpoint(flow);
    ({ checkpoint } = expectReady(flow, checkpoint, ["scan"]));
    checkpoint = complete(flow, checkpoint, "scan", {
      path: "src/large.ts",
    });
    ({ checkpoint } = expectReady(flow, checkpoint, ["approval"]));
    checkpoint = complete(
      flow,
      checkpoint,
      "approval",
      { approvedBy: "owner" },
      "approved",
    );

    const planned = planFlowV1Graph(flow, checkpoint);
    expect(planned.readyNodeIds).toEqual(["implement"]);
    expect(planned.checkpoint.nodes.rejected?.status).toBe("not_selected");
    expect(planned.checkpoint.selectedControlEdgeIds).toHaveLength(1);
    expect(planned.checkpoint.notSelectedControlEdgeIds).toHaveLength(1);
  });

  it("persists a waiting Gate and requeues only that Gate on the next Tick", () => {
    const flow = referenceFlow();
    let checkpoint = createFlowV1GraphCheckpoint(flow);
    ({ checkpoint } = expectReady(flow, checkpoint, ["scan"]));
    checkpoint = complete(flow, checkpoint, "scan", {});
    ({ checkpoint } = expectReady(flow, checkpoint, ["approval"]));
    checkpoint = markFlowV1NodeRunning(checkpoint, "approval");
    checkpoint = applyFlowV1NodeResult(flow, checkpoint, "approval", {
      status: "waiting",
      reason: "Issue is not approved",
    });

    expect(planFlowV1Graph(flow, checkpoint).readyNodeIds).toEqual([]);
    checkpoint = requeueWaitingFlowV1Node(checkpoint, "approval");
    expect(checkpoint.nodes.scan?.status).toBe("completed");
    expect(checkpoint.nodes.approval?.status).toBe("queued");
  });

  it("invalidates only the retried node and its transitive downstream graph", () => {
    const flow = referenceFlow();
    let checkpoint = createFlowV1GraphCheckpoint(flow);
    ({ checkpoint } = expectReady(flow, checkpoint, ["scan"]));
    checkpoint = complete(flow, checkpoint, "scan", { path: "large.ts" });
    ({ checkpoint } = expectReady(flow, checkpoint, ["approval"]));
    checkpoint = complete(
      flow,
      checkpoint,
      "approval",
      { approvedBy: "owner" },
      "approved",
    );
    ({ checkpoint } = expectReady(flow, checkpoint, ["implement"]));
    checkpoint = complete(flow, checkpoint, "implement", { pr: "42" });
    ({ checkpoint } = expectReady(flow, checkpoint, ["done"]));

    const invalidated = invalidateFlowV1NodeAndDownstream(
      flow,
      checkpoint,
      "approval",
    );

    expect(invalidated.invalidatedNodeIds).toEqual([
      "approval",
      "implement",
      "rejected",
      "done",
    ]);
    expect(invalidated.checkpoint.nodes.scan?.status).toBe("completed");
    expect(invalidated.checkpoint.nodes.approval?.status).toBe("idle");
    expect(invalidated.checkpoint.nodes.implement?.status).toBe("idle");
    expect(invalidated.checkpoint.nodes.done?.status).toBe("idle");
    expect(invalidated.checkpoint.nodes.rejected?.status).toBe("idle");
    expect(invalidated.checkpoint.selectedControlEdgeIds).toEqual([]);
    expect(invalidated.checkpoint.notSelectedControlEdgeIds).toEqual([]);
  });
});

function expectReady(
  flow: ReturnType<typeof referenceFlow>,
  checkpoint: ReturnType<typeof createFlowV1GraphCheckpoint>,
  expected: string[],
) {
  const planned = planFlowV1Graph(flow, checkpoint);
  expect(planned.readyNodeIds).toEqual(expected);
  return planned;
}

function complete(
  flow: ReturnType<typeof referenceFlow>,
  checkpoint: ReturnType<typeof createFlowV1GraphCheckpoint>,
  nodeId: string,
  output: Record<string, string>,
  outcome?: string,
) {
  const running = markFlowV1NodeRunning(checkpoint, nodeId);
  return applyFlowV1NodeResult(flow, running, nodeId, {
    status: "completed",
    output,
    ...(outcome ? { outcome } : {}),
  });
}

function referenceFlow() {
  return parseFlowV1Bundle(
    createFlowV1Bundle([
      {
        path: "flow.js",
        content: `
          export const schemaVersion = "tutti.flow.v1";
          const scan = script({ id: "scan", file: "scripts/scan.mjs" });
          const approval = gate({
            id: "approval",
            file: "scripts/approval.mjs",
            inputs: { scan },
            outcomes: ["approved", "rejected"],
          });
          const implement = agent({
            id: "implement",
            inputs: { approval },
            prompt: "Implement {{approval}}",
          });
          const rejected = cancelCycle({
            id: "rejected",
            inputs: { approval },
          });
          const done = completeCycle({
            id: "done",
            inputs: { implement },
          });
          route(approval, { approved: implement, rejected });
        `,
      },
      {
        path: "scripts/scan.mjs",
        content: "export async function run() { return {}; }",
      },
      {
        path: "scripts/approval.mjs",
        content: "export async function check() { return { status: 'waiting', reason: 'no' }; }",
      },
    ]),
  );
}
