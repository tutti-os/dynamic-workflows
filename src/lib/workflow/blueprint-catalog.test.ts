import { describe, expect, it } from "vitest";
import { parseFlowV1Bundle } from "@/lib/flow-v1/parser";
import {
  WORKFLOW_BLUEPRINT_CATEGORIES,
  WORKFLOW_BLUEPRINT_DIFFICULTIES,
  WORKFLOW_BLUEPRINT_ID_PATTERN,
  WORKFLOW_BLUEPRINT_TAG_PATTERN,
} from "./blueprint-contract";
import { BUILTIN_FLOW_V1_BLUEPRINTS } from "./builtin-flow-blueprints";
import {
  getWorkflowBlueprint,
  listWorkflowBlueprints,
  searchWorkflowBlueprints,
} from "./blueprint-catalog";

describe("workflow blueprint catalog", () => {
  it("exposes built-in blueprints that satisfy the catalog contract", () => {
    const blueprints = listWorkflowBlueprints();
    const ids = blueprints.map((blueprint) => blueprint.id);

    expect(ids).toEqual([
      "human-feedback-loop-v1",
      "loop-primitive-rd-acceptance-test-v1",
      "rd-human-acceptance-delivery-v1",
      "parallel-review-synthesis-v1",
      "map-fan-out-demo-v1",
      "repo-migration-sweep-v1",
      "research-fanout-report-v1",
      "release-readiness-check-v1",
      "epic-breakdown-plan-v1",
      "large-file-governance-v1",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      BUILTIN_FLOW_V1_BLUEPRINTS.map((blueprint) => blueprint.id),
    ).toEqual(ids);

    for (const blueprint of blueprints) {
      const detail = getWorkflowBlueprint(blueprint.id);
      expect(detail).toBeDefined();
      expect(blueprint).not.toHaveProperty("script");
      expect(blueprint.id).toMatch(WORKFLOW_BLUEPRINT_ID_PATTERN);
      expect(blueprint.title.trim()).toBe(blueprint.title);
      expect(blueprint.title.length).toBeGreaterThanOrEqual(4);
      expect(blueprint.title.length).toBeLessThanOrEqual(80);
      expect(blueprint.description.trim()).toBe(blueprint.description);
      expect(blueprint.description.length).toBeGreaterThanOrEqual(20);
      expect(blueprint.description.length).toBeLessThanOrEqual(240);
      expect(blueprint.description).not.toMatch(/\bTODO\b/i);
      expect(WORKFLOW_BLUEPRINT_CATEGORIES).toContain(blueprint.category);
      expect(WORKFLOW_BLUEPRINT_DIFFICULTIES).toContain(blueprint.difficulty);
      expect(blueprint.tags.length).toBeGreaterThanOrEqual(2);
      expect(blueprint.tags.length).toBeLessThanOrEqual(8);
      expect(new Set(blueprint.tags).size).toBe(blueprint.tags.length);
      for (const tag of blueprint.tags) {
        expect(tag).toMatch(WORKFLOW_BLUEPRINT_TAG_PATTERN);
      }
      expect(blueprint.patternSummary.trim()).toBe(blueprint.patternSummary);
      expect(blueprint.patternSummary.length).toBeGreaterThanOrEqual(40);
      expect(blueprint.patternSummary.length).toBeLessThanOrEqual(600);
      expect(blueprint.patternSummary).not.toMatch(/\bTODO\b/i);
      expect(blueprint.useCases.length).toBeGreaterThanOrEqual(1);
      expect(blueprint.useCases.length).toBeLessThanOrEqual(6);
      for (const useCase of blueprint.useCases) {
        expect(useCase.trim()).toBe(useCase);
        expect(useCase.length).toBeGreaterThanOrEqual(12);
        expect(useCase).not.toMatch(/\bTODO\b/i);
      }
      expect(detail?.schemaVersion).toBe("tutti.flow.v1");
      if (detail?.schemaVersion !== "tutti.flow.v1") {
        throw new Error("Blueprint must be a Flow v1 Bundle.");
      }
      const parsed = parseFlowV1Bundle(detail.bundle);
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.meta.requiresCwd).toBe(blueprint.requiresCwd);
      expect(parsed.meta.name).toBe(blueprint.title);
      expect(parsed.nodes.length).toBeGreaterThan(0);
    }
  });

  it("preserves the pre-cutover Blueprint goals on the Flow v1 runtime", () => {
    const expectedShapes: Record<string, string[]> = {
      "human-feedback-loop-v1": ["loop", "complete_cycle"],
      "loop-primitive-rd-acceptance-test-v1": [
        "effect",
        "loop",
        "agent",
        "agent",
        "script",
        "effect",
        "effect",
        "effect",
        "complete_cycle",
        "complete_cycle",
        "complete_cycle",
        "finally",
      ],
      "rd-human-acceptance-delivery-v1": [
        "effect",
        "loop",
        "loop",
        "agent",
        "agent",
        "script",
        "effect",
        "effect",
        "effect",
        "complete_cycle",
        "complete_cycle",
        "complete_cycle",
        "finally",
      ],
      "parallel-review-synthesis-v1": [
        "agent",
        "agent",
        "agent",
        "agent",
        "agent",
        "complete_cycle",
      ],
      "map-fan-out-demo-v1": [
        "effect",
        "agent",
        "map",
        "agent",
        "complete_cycle",
        "finally",
      ],
      "repo-migration-sweep-v1": [
        "effect",
        "agent",
        "map",
        "loop",
        "agent",
        "agent",
        "script",
        "effect",
        "effect",
        "effect",
        "complete_cycle",
        "complete_cycle",
        "complete_cycle",
        "finally",
      ],
      "research-fanout-report-v1": [
        "agent",
        "map",
        "agent",
        "complete_cycle",
      ],
      "release-readiness-check-v1": [
        "map",
        "agent",
        "human",
        "transform",
        "complete_cycle",
        "complete_cycle",
      ],
      "epic-breakdown-plan-v1": [
        "loop",
        "transform",
        "map",
        "agent",
        "complete_cycle",
      ],
    };

    for (const [id, expectedKinds] of Object.entries(expectedShapes)) {
      const blueprint = getWorkflowBlueprint(id);
      expect(blueprint, id).toBeDefined();
      const parsed = parseFlowV1Bundle(blueprint!.bundle);
      expect(parsed.diagnostics, id).toEqual([]);
      expect(
        parsed.nodes.map((node) => node.kind),
        id,
      ).toEqual(expectedKinds);
    }
  });

  it("searches built-in blueprints by pattern terms", () => {
    const results = searchWorkflowBlueprints({
      query: "large file issue pull request loop",
      includeScript: true,
    });

    expect(results[0]).toMatchObject({
      id: "large-file-governance-v1",
      category: "coding",
      requiresCwd: true,
    });
    expect(results[0]?.bundle?.schemaVersion).toBe("tutti.flow.v1");
  });

  it("filters blueprints and omits scripts unless requested", () => {
    const results = searchWorkflowBlueprints({
      category: "coding",
      tags: ["schedule"],
      requiresCwd: true,
    });

    expect(results.map((result) => result.id)).toEqual([
      "large-file-governance-v1",
    ]);
    expect(results[0]).not.toHaveProperty("script");
    expect(
      searchWorkflowBlueprints({
        category: "research",
        tags: ["schedule"],
      }),
    ).toEqual([]);
  });
});
