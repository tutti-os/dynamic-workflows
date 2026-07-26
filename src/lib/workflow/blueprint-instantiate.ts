import type { WorkflowDetail } from "@/lib/db/workflows/types";
import {
  updateWorkflowMetadata,
} from "@/lib/db/workflows/workflow-repository";
import { getWorkflowBlueprint } from "@/lib/workflow/blueprint-catalog";
import { createFlowV1 } from "@/lib/flow-v1/flow-service";
import { getWorkflowDetail } from "@/lib/db/workflows/workflow-repository";

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

  const created = createFlowV1({
    bundle: blueprint.bundle,
    publish: true,
    activate: false,
  });
  const detail = getWorkflowDetail(created.flowId);
  if (!detail) {
    throw new Error("Instantiated Flow could not be loaded.");
  }
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
