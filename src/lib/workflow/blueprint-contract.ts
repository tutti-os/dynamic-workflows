export const WORKFLOW_BLUEPRINT_CATEGORIES = [
  "coding",
  "review",
  "planning",
  "research",
  "ops",
] as const;

export const WORKFLOW_BLUEPRINT_DIFFICULTIES = [
  "starter",
  "advanced",
] as const;

export const WORKFLOW_BLUEPRINT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WORKFLOW_BLUEPRINT_TAG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
export const WORKFLOW_BLUEPRINT_SCRIPT_DIR = "src/lib/workflow/blueprints";
export const WORKFLOW_BLUEPRINT_SCRIPT_EXTENSION = ".workflow.js";

export type WorkflowBlueprintCategory =
  (typeof WORKFLOW_BLUEPRINT_CATEGORIES)[number];

export type WorkflowBlueprintDifficulty =
  (typeof WORKFLOW_BLUEPRINT_DIFFICULTIES)[number];

export function isWorkflowBlueprintCategory(
  value: unknown,
): value is WorkflowBlueprintCategory {
  return (
    typeof value === "string" &&
    WORKFLOW_BLUEPRINT_CATEGORIES.includes(value as WorkflowBlueprintCategory)
  );
}

export function isWorkflowBlueprintDifficulty(
  value: unknown,
): value is WorkflowBlueprintDifficulty {
  return (
    typeof value === "string" &&
    WORKFLOW_BLUEPRINT_DIFFICULTIES.includes(
      value as WorkflowBlueprintDifficulty,
    )
  );
}

export function getWorkflowBlueprintScriptPath(blueprintId: string): string {
  return `${WORKFLOW_BLUEPRINT_SCRIPT_DIR}/${blueprintId}${WORKFLOW_BLUEPRINT_SCRIPT_EXTENSION}`;
}
