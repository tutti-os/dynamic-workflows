import type { WorkflowDetail } from "@/lib/db/workflows/types";
import {
  createWorkflowFromScript,
  updateWorkflowMetadata,
} from "@/lib/db/workflows/workflow-repository";
import { getWorkflowBlueprint } from "@/lib/workflow/blueprint-catalog";

/**
 * Thrown when a blueprint id does not resolve to a built-in blueprint. Callers
 * map this to their surface's not-found error (HTTP 404 / CLI code).
 */
export class BlueprintNotFoundError extends Error {
  readonly blueprintId: string;

  constructor(blueprintId: string) {
    super("Workflow blueprint not found.");
    this.name = "BlueprintNotFoundError";
    this.blueprintId = blueprintId;
  }
}

/**
 * Turn a built-in blueprint into a saved, runnable workflow. This is the single
 * service behind BOTH the UI instantiate route and the CLI `blueprints
 * instantiate` command, so they stay in lockstep. An optional `name` overrides
 * the blueprint's own name for the created workflow.
 */
export function instantiateWorkflowBlueprint(
  blueprintId: string,
  options: { name?: string } = {},
): WorkflowDetail {
  const blueprint = getWorkflowBlueprint(blueprintId);
  if (!blueprint) {
    throw new BlueprintNotFoundError(blueprintId);
  }

  const detail = createWorkflowFromScript(blueprint.script, {
    source: "blueprint",
    note: blueprint.id,
  });

  const name = options.name?.trim();
  if (name && name !== detail.workflow.name) {
    return updateWorkflowMetadata({
      workflowId: detail.workflow.id,
      name,
      description: detail.workflow.description,
    });
  }
  return detail;
}
