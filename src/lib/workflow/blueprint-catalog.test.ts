import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertWorkflowScriptValid } from "./parser";
import {
  getWorkflowBlueprintScriptPath,
  WORKFLOW_BLUEPRINT_CATEGORIES,
  WORKFLOW_BLUEPRINT_DIFFICULTIES,
  WORKFLOW_BLUEPRINT_ID_PATTERN,
  WORKFLOW_BLUEPRINT_TAG_PATTERN,
} from "./blueprint-contract";
import { BUILTIN_WORKFLOW_BLUEPRINTS } from "./builtin-blueprints";
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
      "loop-primitive-rd-acceptance-test-v1",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BUILTIN_WORKFLOW_BLUEPRINTS.map((blueprint) => blueprint.id)).toEqual(
      ids,
    );

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
      expect(detail?.script.trimStart()).toBe(detail?.script);
      expect(detail?.script.trimEnd()).toBe(
        detail?.script.replace(/\n$/, ""),
      );

      const parsed = assertWorkflowScriptValid(detail?.script ?? "");
      expect(parsed.meta.requiresCwd ?? false).toBe(blueprint.requiresCwd);
      expect(parsed.meta.name).toBe(blueprint.title);
      expect(parsed.meta.description.trim()).toBeTruthy();
      expect(parsed.meta.description).not.toMatch(/\bTODO\b/i);
      expect(parsed.nodes.length).toBeGreaterThan(0);
    }
  });

  it("loads the built-in blueprint script from a workflow file", () => {
    const detail = getWorkflowBlueprint("loop-primitive-rd-acceptance-test-v1");
    const fileScript = fs.readFileSync(
      path.join(process.cwd(), getWorkflowBlueprintScriptPath(detail?.id ?? "")),
      "utf8",
    );

    expect(detail?.script).toBe(fileScript);
  });

  it("keeps every built-in blueprint id aligned with a checked-in script file", () => {
    for (const blueprint of BUILTIN_WORKFLOW_BLUEPRINTS) {
      const scriptPath = getWorkflowBlueprintScriptPath(blueprint.id);
      const absoluteScriptPath = path.join(process.cwd(), scriptPath);

      expect(path.basename(scriptPath)).toBe(`${blueprint.id}.workflow.js`);
      expect(fs.existsSync(absoluteScriptPath)).toBe(true);
      expect(fs.readFileSync(absoluteScriptPath, "utf8")).toBe(blueprint.script);
    }
  });

  it("searches built-in blueprints by pattern terms", () => {
    const results = searchWorkflowBlueprints({
      query: "acceptance loop pass",
      includeScript: true,
    });

    expect(results[0]).toMatchObject({
      id: "loop-primitive-rd-acceptance-test-v1",
      category: "coding",
      requiresCwd: true,
    });
    expect(results[0]?.script).toContain("delivery_loop");
  });

  it("filters blueprints and omits scripts unless requested", () => {
    const results = searchWorkflowBlueprints({
      category: "coding",
      tags: ["acceptance"],
      requiresCwd: true,
    });

    expect(results.map((result) => result.id)).toEqual([
      "loop-primitive-rd-acceptance-test-v1",
    ]);
    expect(results[0]).not.toHaveProperty("script");
    expect(
      searchWorkflowBlueprints({
        category: "research",
        tags: ["acceptance"],
      }),
    ).toEqual([]);
  });
});
