import { describe, expect, it } from "vitest";
import {
  isFlowV1CycleStatus,
  isFlowV1EffectReconcileResult,
  isFlowV1JsonValue,
  isFlowV1NodeResult,
} from "./contracts";

describe("flow v1 contracts", () => {
  it("accepts only finite JSON values", () => {
    expect(
      isFlowV1JsonValue({
        path: "src/a.ts",
        values: [1, true, null, { nested: "ok" }],
      }),
    ).toBe(true);
    expect(isFlowV1JsonValue(Number.NaN)).toBe(false);
    expect(isFlowV1JsonValue(undefined)).toBe(false);
  });

  it("pins cycle status values", () => {
    expect(isFlowV1CycleStatus("waiting_gate")).toBe(true);
    expect(isFlowV1CycleStatus("waiting_external")).toBe(false);
  });

  it("validates node result boundaries", () => {
    expect(
      isFlowV1NodeResult({
        status: "completed",
        outcome: "approved",
        output: { approvedBy: "alice" },
      }),
    ).toBe(true);
    expect(
      isFlowV1NodeResult({
        status: "waiting",
        reason: "Waiting for approval",
      }),
    ).toBe(true);
    expect(isFlowV1NodeResult({ status: "waiting", reason: "" })).toBe(false);
    expect(
      isFlowV1NodeResult({
        status: "failed",
        error: { code: "network_error", message: "offline", retryable: true },
      }),
    ).toBe(true);
  });

  it("requires an explicit effect reconciliation outcome", () => {
    expect(
      isFlowV1EffectReconcileResult({
        status: "completed",
        externalRef: "issue:1",
        output: { number: 1 },
      }),
    ).toBe(true);
    expect(
      isFlowV1EffectReconcileResult({ status: "not_applied" }),
    ).toBe(true);
    expect(
      isFlowV1EffectReconcileResult({ status: "unknown", reason: "" }),
    ).toBe(false);
  });
});
