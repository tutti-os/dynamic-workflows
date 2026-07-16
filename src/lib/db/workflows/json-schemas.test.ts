import { describe, expect, it } from "vitest";
import {
  parseJsonObjectColumn,
  parseWorkflowEditJobErrorColumn,
  parseWorkflowRunCheckpointStateColumn,
  parseWorkflowMetaColumn,
  stringifyJsonObjectColumn,
  stringifyJsonValueColumn,
  stringifyWorkflowGenerationErrorColumn,
  stringifyWorkflowRunCheckpointStateColumn,
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
          code: "workflow.input.typeMissing",
          message: "Missing node id",
          path: "inputs.requirement.type",
          hint: "Add a type field.",
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

  const checkpointContext = {
    table: "workflow_run_checkpoints",
    column: "checkpoint_json",
    id: "run-1:loop",
  };

  it("validates loop checkpoint boundaries", () => {
    const loopState = {
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
    const checkpoint = { kind: "loop", state: loopState };

    expect(
      parseWorkflowRunCheckpointStateColumn(
        JSON.stringify(checkpoint),
        checkpointContext,
      ),
    ).toEqual(checkpoint);
    expect(
      stringifyWorkflowRunCheckpointStateColumn(checkpoint, checkpointContext),
    ).toBe(JSON.stringify(checkpoint));
    expect(
      stringifyWorkflowRunCheckpointStateColumn(
        {
          kind: "loop",
          state: {
            ...loopState,
            previousStepOutputs: {
              draft: { action: "revise", values: { comment: "fix it" } },
            },
          },
        },
        checkpointContext,
      ),
    ).toContain('"action":"revise"');
    expect(() =>
      stringifyWorkflowRunCheckpointStateColumn(
        {
          kind: "loop",
          state: { ...loopState, previousStepOutputs: { draft: undefined } },
        },
        checkpointContext,
      ),
    ).toThrow("is not JSON serializable");
  });

  it("reads legacy untagged loop checkpoints as loop state", () => {
    const legacyLoopState = {
      nextIteration: 1,
      previousStepOutputs: { draft: "one" },
      iterations: [],
    };

    expect(
      parseWorkflowRunCheckpointStateColumn(
        JSON.stringify(legacyLoopState),
        checkpointContext,
      ),
    ).toEqual({ kind: "loop", state: legacyLoopState });
  });

  it("validates map checkpoint boundaries", () => {
    const checkpoint = {
      kind: "map",
      state: {
        items: [{ file: "a.ts" }, { file: "b.ts" }],
        completions: [
          { index: 1, status: "completed", output: "migrated a.ts" },
          { index: 2, status: "failed", error: "boom" },
        ],
      },
    };

    expect(
      parseWorkflowRunCheckpointStateColumn(
        JSON.stringify(checkpoint),
        checkpointContext,
      ),
    ).toEqual(checkpoint);
    expect(
      stringifyWorkflowRunCheckpointStateColumn(checkpoint, checkpointContext),
    ).toBe(JSON.stringify(checkpoint));
    expect(() =>
      parseWorkflowRunCheckpointStateColumn(
        JSON.stringify({ kind: "map", state: { items: "nope", completions: [] } }),
        checkpointContext,
      ),
    ).toThrow("has invalid shape");
  });

  it("accepts map completions with and without a step attribution", () => {
    // The multi-step failure record carries `step`; legacy single-step
    // checkpoints omit it and must stay valid for backward compat.
    const checkpoint = {
      kind: "map",
      state: {
        items: [{ file: "a.ts" }, { file: "b.ts" }],
        completions: [
          // Legacy: no `step`.
          { index: 1, status: "completed", output: "migrated a.ts" },
          // New: failing step attributed.
          { index: 2, status: "failed", step: "process_one", error: "boom" },
        ],
      },
    };

    expect(
      parseWorkflowRunCheckpointStateColumn(
        JSON.stringify(checkpoint),
        checkpointContext,
      ),
    ).toEqual(checkpoint);
    expect(
      stringifyWorkflowRunCheckpointStateColumn(checkpoint, checkpointContext),
    ).toBe(JSON.stringify(checkpoint));

    // A non-string `step` is rejected.
    expect(() =>
      parseWorkflowRunCheckpointStateColumn(
        JSON.stringify({
          kind: "map",
          state: {
            items: [],
            completions: [{ index: 1, status: "failed", step: 7, error: "x" }],
          },
        }),
        checkpointContext,
      ),
    ).toThrow("has invalid shape");
  });
});
