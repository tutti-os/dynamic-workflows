import { describe, expect, it } from "vitest";
import {
  renderTemplate,
  renderTemplateValue,
  resolveWorkflowValuePath,
  validateRuntimeOptionTemplate,
} from "./templates";

describe("structured workflow templates", () => {
  const value = { action: "revise", values: { comment: "fix it" } };

  it("preserves whole structured values and stringifies embedded values", () => {
    expect(renderTemplateValue("{{decision}}", () => value)).toEqual(value);
    expect(renderTemplate("decision={{decision}}", () => value)).toBe(
      'decision={"action":"revise","values":{"comment":"fix it"}}',
    );
  });

  it("resolves nested object paths", () => {
    expect(resolveWorkflowValuePath(value, ["values", "comment"])).toBe("fix it");
    expect(resolveWorkflowValuePath(value, ["missing"])).toBeUndefined();
  });
});

describe("validateRuntimeOptionTemplate", () => {
  it("accepts literals and one runtime input placeholder with an optional default", () => {
    expect(validateRuntimeOptionTemplate("gpt-5")).toEqual({
      refs: [],
      diagnostics: [],
    });
    expect(validateRuntimeOptionTemplate("{{coder_model:gpt-5}}")).toEqual({
      refs: [{ name: "coder_model", defaultValue: "gpt-5" }],
      diagnostics: [],
    });
    expect(validateRuntimeOptionTemplate("{{models.coder:gpt-5.5}}")).toEqual({
      refs: [{ name: "models.coder", defaultValue: "gpt-5.5" }],
      diagnostics: [],
    });
  });

  it("rejects ambiguous runtime option templates", () => {
    expect(validateRuntimeOptionTemplate("gpt-{{model}}").diagnostics).toEqual([
      expect.stringContaining("exactly one placeholder"),
    ]);
    expect(validateRuntimeOptionTemplate("{{agent}}{{model}}").diagnostics).toEqual([
      expect.stringContaining("exactly one placeholder"),
    ]);
    expect(validateRuntimeOptionTemplate("{{model:}}").diagnostics).toEqual([
      expect.stringContaining("defaults must be non-empty"),
    ]);
    expect(validateRuntimeOptionTemplate("{{workflow.cwd}}").diagnostics).toEqual([
      expect.stringContaining("resolve run inputs only"),
    ]);
  });
});
