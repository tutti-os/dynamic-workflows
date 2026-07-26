import { BUILTIN_FLOW_V1_BLUEPRINTS } from "./builtin-flow-blueprints";
import type {
  WorkflowBlueprintCategory,
  WorkflowBlueprintDetail,
  WorkflowBlueprintSearchResult,
  WorkflowBlueprintSummary,
} from "./blueprint-types";

export type WorkflowBlueprintSearchInput = {
  query?: string;
  category?: WorkflowBlueprintCategory;
  tags?: string[];
  requiresCwd?: boolean;
  includeScript?: boolean;
  limit?: number;
};

export function listWorkflowBlueprints(): WorkflowBlueprintSummary[] {
  return allBlueprints().map(toWorkflowBlueprintSummary);
}

export function getWorkflowBlueprint(
  blueprintId: string,
): WorkflowBlueprintDetail | undefined {
  return allBlueprints().find((blueprint) => blueprint.id === blueprintId);
}

export function searchWorkflowBlueprints(
  input: WorkflowBlueprintSearchInput = {},
): WorkflowBlueprintSearchResult[] {
  const queryTokens = tokenize(input.query ?? "");
  const requestedTags = new Set(
    (input.tags ?? []).map((tag) => normalizeSearchText(tag)).filter(Boolean),
  );

  return allBlueprints().map((blueprint) => ({
    blueprint,
    score: scoreWorkflowBlueprint(blueprint, queryTokens),
  }))
    .filter(({ blueprint, score }) => {
      if (input.category && blueprint.category !== input.category) {
        return false;
      }
      if (
        input.requiresCwd !== undefined &&
        blueprint.requiresCwd !== input.requiresCwd
      ) {
        return false;
      }
      if (
        requestedTags.size > 0 &&
        !blueprint.tags.some((tag) => requestedTags.has(normalizeSearchText(tag)))
      ) {
        return false;
      }
      return queryTokens.length === 0 || score > 0;
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.blueprint.title.localeCompare(right.blueprint.title);
    })
    .slice(0, normalizeLimit(input.limit))
    .map(({ blueprint, score }) => ({
      ...toWorkflowBlueprintSummary(blueprint),
      score,
      ...(input.includeScript && blueprint.bundle
        ? { bundle: blueprint.bundle }
        : {}),
    }));
}

function toWorkflowBlueprintSummary(
  blueprint: WorkflowBlueprintDetail,
): WorkflowBlueprintSummary {
  return {
    id: blueprint.id,
    title: blueprint.title,
    description: blueprint.description,
    category: blueprint.category,
    tags: [...blueprint.tags],
    difficulty: blueprint.difficulty,
    requiresCwd: blueprint.requiresCwd,
    patternSummary: blueprint.patternSummary,
    useCases: [...blueprint.useCases],
    ...(blueprint.schemaVersion
      ? { schemaVersion: blueprint.schemaVersion }
      : {}),
    ...(blueprint.capabilities
      ? { capabilities: [...blueprint.capabilities] }
      : {}),
  };
}

function allBlueprints(): WorkflowBlueprintDetail[] {
  return BUILTIN_FLOW_V1_BLUEPRINTS;
}

function scoreWorkflowBlueprint(
  blueprint: WorkflowBlueprintDetail,
  queryTokens: string[],
): number {
  if (queryTokens.length === 0) {
    return 1;
  }

  const fields = [
    { value: blueprint.id, weight: 4 },
    { value: blueprint.title, weight: 6 },
    { value: blueprint.description, weight: 4 },
    { value: blueprint.category, weight: 2 },
    { value: blueprint.tags.join(" "), weight: 5 },
    { value: blueprint.patternSummary, weight: 3 },
    { value: blueprint.useCases.join(" "), weight: 2 },
  ].map((field) => ({
    value: normalizeSearchText(field.value),
    weight: field.weight,
  }));

  return queryTokens.reduce((total, token) => {
    const tokenScore = fields.reduce((fieldTotal, field) => {
      return field.value.includes(token) ? fieldTotal + field.weight : fieldTotal;
    }, 0);
    return total + tokenScore;
  }, 0);
}

function tokenize(value: string): string[] {
  return normalizeSearchText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").trim();
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 20;
  }
  return Math.max(1, Math.min(50, Math.trunc(limit)));
}
