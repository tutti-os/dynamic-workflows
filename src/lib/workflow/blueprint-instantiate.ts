import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    ...resolveInstantiationDefaults(blueprint.instantiationDefaults),
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

function resolveInstantiationDefaults(
  defaults:
    | {
        projectCwd?: string;
        defaultAgent?: string;
        defaultModel?: string;
        defaultPermissionMode?: string;
      }
    | undefined,
) {
  const configuredCwd = defaults?.projectCwd?.trim();
  const expandedCwd = configuredCwd
    ? expandHomeDirectory(configuredCwd)
    : undefined;
  const projectCwd =
    expandedCwd && isDirectory(expandedCwd) ? expandedCwd : undefined;

  return {
    projectCwd,
    defaultAgent: defaults?.defaultAgent,
    defaultModel: defaults?.defaultModel,
    defaultPermissionMode: defaults?.defaultPermissionMode,
  };
}

function expandHomeDirectory(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}
