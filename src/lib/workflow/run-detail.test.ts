import { describe, expect, it } from "vitest";
import type { WorkflowRunRecord } from "@/lib/db/workflows/types";
import { parseWorkflowScript } from "./parser";
import {
  buildRunNodeDetail,
  hasNotAcceptedDelivery,
  type RunDetail,
} from "./run-detail";
import type { WorkflowNode } from "./types";

const parsed = parseWorkflowScript(`
const first = await agent({ id: "first", prompt: "one" })
const second = await agent({ id: "second", inputs: { first }, prompt: "two {{first}}" })
`);
const secondNode = parsed.nodes.find((node) => node.id === "second");

function runDetail(result: unknown): RunDetail {
  const run: WorkflowRunRecord = {
    id: "run-1",
    workflowId: "wf-1",
    workflowVersionId: "wfv-1",
    executorKind: "local-agent",
    externalRunId: null,
    status: "completed",
    agent: null,
    model: null,
    cwd: null,
    input: { inputs: {} },
    result,
    logPath: null,
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
  };
  return { run, log: "" };
}

describe("buildRunNodeDetail input", () => {
  it("prefers the persisted node input over re-rendering from current outputs", () => {
    if (!secondNode) {
      throw new Error("second node missing");
    }
    // Outputs would re-render the prompt as "two CURRENT", but the persisted
    // input captured what was actually sent. The persisted value must win.
    const detail = runDetail({
      outputs: { first: "CURRENT" },
      nodeStatuses: { second: "completed" },
      nodeSessions: {},
      loopStepRuns: {},
      mapItemRuns: {},
      nodeInputs: { second: "two PERSISTED" },
    });

    expect(buildRunNodeDetail(detail, secondNode as WorkflowNode).input).toBe(
      "two PERSISTED",
    );
  });

  it("falls back to reconstruction for a legacy result without nodeInputs", () => {
    if (!secondNode) {
      throw new Error("second node missing");
    }
    const detail = runDetail({
      outputs: { first: "CURRENT" },
      nodeStatuses: { second: "completed" },
      nodeSessions: {},
      loopStepRuns: {},
    });

    expect(buildRunNodeDetail(detail, secondNode as WorkflowNode).input).toBe(
      "two CURRENT",
    );
  });
});

describe("hasNotAcceptedDelivery", () => {
  it("detects a delivery report that ended not_accepted", () => {
    expect(
      hasNotAcceptedDelivery({
        outputs: {
          submit_mr: {
            result: "not_accepted",
            prUrl: null,
            summary: "验收未通过",
          },
        },
        nodeStatuses: {},
        nodeSessions: {},
        loopStepRuns: {},
        mapItemRuns: {},
      }),
    ).toBe(true);
  });

  it("ignores accepted deliveries, prose outputs, and malformed results", () => {
    expect(
      hasNotAcceptedDelivery({
        outputs: {
          submit_mr: { result: "mr_created", prUrl: "https://example.com/pr/1" },
          notes: "not_accepted mentioned in prose only",
          items: ["not_accepted"],
        },
        nodeStatuses: {},
        nodeSessions: {},
        loopStepRuns: {},
        mapItemRuns: {},
      }),
    ).toBe(false);
    expect(hasNotAcceptedDelivery(undefined)).toBe(false);
    expect(hasNotAcceptedDelivery("not json")).toBe(false);
  });
});
