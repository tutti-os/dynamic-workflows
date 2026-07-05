import { describe, expect, it } from "vitest";
import {
  parseJsonObjectColumn,
  parseWorkflowEditJobErrorColumn,
  parseWorkflowLoopRecoveryStateColumn,
  parseWorkflowMetaColumn,
  stringifyJsonObjectColumn,
  stringifyJsonValueColumn,
  stringifyWorkflowGenerationErrorColumn,
  stringifyWorkflowLoopRecoveryStateColumn,
  stringifyWorkflowMetaColumn,
} from "./json-schemas";

const context = {
  table: "workflow_versions",
  column: "meta_json",
  id: "version-1",
};

describe("workflow JSON column schemas", () => {
  it("parses and serializes valid workflow meta", () => {
    const meta = { name: "Build", description: "Build workflow", requiresCwd: true };

    expect(parseWorkflowMetaColumn(JSON.stringify(meta), context)).toEqual(meta);
    expect(stringifyWorkflowMetaColumn(meta, context)).toBe(
      JSON.stringify(meta),
    );
  });

  it("rejects invalid workflow meta with column context", () => {
    expect(() =>
      parseWorkflowMetaColumn(JSON.stringify({ name: "Build" }), context),
    ).toThrow(
      "Invalid JSON column workflow_versions.meta_json for version-1: has invalid shape.",
    );
    expect(() => parseWorkflowMetaColumn("{", context)).toThrow(
      "Invalid JSON column workflow_versions.meta_json for version-1: is not valid JSON.",
    );
  });

  it("validates JSON object columns and rejects non-object roots", () => {
    expect(
      parseJsonObjectColumn(JSON.stringify({ inputs: { query: "hello" } }), {
        table: "workflow_runs",
        column: "input_json",
        id: "run-1",
      }),
    ).toEqual({ inputs: { query: "hello" } });
    expect(() =>
      stringifyJsonObjectColumn("not an object", {
        table: "workflow_runs",
        column: "input_json",
        id: "run-1",
      }),
    ).toThrow("has invalid shape");
  });

  it("rejects values that JSON.stringify would otherwise coerce", () => {
    expect(() =>
      stringifyJsonValueColumn(Number.NaN, {
        table: "workflow_generations",
        column: "generation_json",
        id: "generation-1",
      }),
    ).toThrow("is not JSON serializable");
    expect(() =>
      stringifyJsonObjectColumn({ inputs: undefined }, {
        table: "workflow_runs",
        column: "input_json",
        id: "run-1",
      }),
    ).toThrow("is not JSON serializable");
  });

  it("validates workflow error diagnostics", () => {
    const error = {
      code: "WORKFLOW_SCRIPT_INVALID",
      message: "Invalid script",
      diagnostics: [
        {
          severity: "error",
          message: "Missing node id",
          range: { start: 1, end: 4 },
        },
      ],
    };

    expect(
      parseWorkflowEditJobErrorColumn(JSON.stringify(error), {
        table: "workflow_edit_jobs",
        column: "error_json",
        id: "edit-1",
      }),
    ).toEqual(error);
    expect(
      stringifyWorkflowGenerationErrorColumn(error, {
        table: "workflow_generations",
        column: "error_json",
        id: "generation-1",
      }),
    ).toBe(JSON.stringify(error));
    expect(() =>
      stringifyWorkflowGenerationErrorColumn(
        { message: "Invalid", diagnostics: [{ severity: "fatal", message: "x" }] },
        {
          table: "workflow_generations",
          column: "error_json",
          id: "generation-1",
        },
      ),
    ).toThrow("has invalid shape");
  });

  it("validates loop checkpoint boundaries", () => {
    const checkpoint = {
      nextIteration: 2,
      currentIteration: 1,
      currentStepOutputs: { draft: "one" },
      previousStepOutputs: { draft: "one", review: "PASS" },
      iterations: [
        {
          index: 1,
          outputs: { draft: "one", review: "PASS" },
          untilOutput: "PASS",
          untilMatched: true,
        },
      ],
    };

    expect(
      parseWorkflowLoopRecoveryStateColumn(JSON.stringify(checkpoint), {
        table: "workflow_run_checkpoints",
        column: "checkpoint_json",
        id: "run-1:loop",
      }),
    ).toEqual(checkpoint);
    expect(
      stringifyWorkflowLoopRecoveryStateColumn(checkpoint, {
        table: "workflow_run_checkpoints",
        column: "checkpoint_json",
        id: "run-1:loop",
      }),
    ).toBe(JSON.stringify(checkpoint));
    expect(() =>
      stringifyWorkflowLoopRecoveryStateColumn(
        { ...checkpoint, previousStepOutputs: { draft: 1 } },
        {
          table: "workflow_run_checkpoints",
          column: "checkpoint_json",
          id: "run-1:loop",
        },
      ),
    ).toThrow("has invalid shape");
  });
});
