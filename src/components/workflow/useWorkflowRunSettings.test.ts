import { describe, expect, it } from "vitest";
import { selectDefaultAgentTarget } from "./useWorkflowRunSettings";

describe("workflow run settings", () => {
  it("uses the daemon default when it is available", () => {
    expect(
      selectDefaultAgentTarget([
        {
          id: "team:builder",
          name: "Builder",
          provider: "codex",
          supported: true,
          models: ["gpt-5"],
        },
        {
          id: "team:reviewer",
          name: "Reviewer",
          provider: "codex",
          supported: true,
          models: ["gpt-5"],
          isDefault: true,
        },
      ])?.id,
    ).toBe("team:reviewer");
  });

  it("falls back to an available non-mock target when the daemon default is unavailable", () => {
    expect(
      selectDefaultAgentTarget([
        {
          id: "mock",
          name: "Mock",
          provider: "mock",
          supported: true,
          models: ["mock"],
        },
        {
          id: "team:builder",
          name: "Builder",
          provider: "codex",
          supported: true,
          models: ["gpt-5"],
        },
        {
          id: "team:reviewer",
          name: "Reviewer",
          provider: "codex",
          supported: false,
          models: ["gpt-5"],
          isDefault: true,
        },
      ])?.id,
    ).toBe("team:builder");
  });
});
