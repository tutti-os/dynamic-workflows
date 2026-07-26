import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import {
  parseJsonObjectColumn,
  stringifyJsonObjectColumn,
} from "@/lib/db/workflows/json-schemas";
import type { ParsedFlowV1 } from "./types";

export class FlowV1RuntimeConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowV1RuntimeConfigError";
    this.code = code;
  }
}

export type FlowV1SecretBinding = {
  kind: "environment";
  env: string;
};

export type FlowV1RuntimeConfig = {
  projectCwd: string | null;
  secretBindings: Record<string, FlowV1SecretBinding>;
};

export function setFlowV1RuntimeConfig(input: {
  flowId: string;
  projectCwd?: string | null;
  secretBindings?: Record<string, FlowV1SecretBinding>;
}): FlowV1RuntimeConfig {
  const database = getDb();
  database.transaction(() => {
    if (input.projectCwd !== undefined) {
      let projectCwd: string | null = null;
      if (input.projectCwd !== null) {
        projectCwd = fs.realpathSync(
          /* turbopackIgnore: true */
          path.resolve(input.projectCwd),
        );
        if (
          !fs
            .statSync(
              /* turbopackIgnore: true */
              projectCwd,
            )
            .isDirectory()
        ) {
          throw new FlowV1RuntimeConfigError(
            "flow_project_cwd_invalid",
            `Flow project cwd is not a directory: ${input.projectCwd}.`,
          );
        }
      }
      const updated = database
        .prepare(
          `
          UPDATE workflows
          SET project_cwd = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(projectCwd, new Date().toISOString(), input.flowId).changes;
      if (updated !== 1) {
        throw new FlowV1RuntimeConfigError(
          "flow_not_found",
          `Flow ${input.flowId} was not found.`,
        );
      }
    }
    if (input.secretBindings !== undefined) {
      database
        .prepare(
          "DELETE FROM workflow_secret_bindings WHERE flow_id = ?",
        )
        .run(input.flowId);
    }
    for (const [name, binding] of Object.entries(input.secretBindings ?? {})) {
      if (
        !name.trim() ||
        binding.kind !== "environment" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(binding.env)
      ) {
        throw new FlowV1RuntimeConfigError(
          "flow_secret_binding_invalid",
          `Secret binding ${name || "(empty)"} is invalid.`,
        );
      }
      database
        .prepare(
          `
          INSERT INTO workflow_secret_bindings (
            flow_id, secret_name, binding_json, updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(flow_id, secret_name) DO UPDATE SET
            binding_json = excluded.binding_json,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          input.flowId,
          name,
          stringifyJsonObjectColumn(binding, {
            table: "workflow_secret_bindings",
            column: "binding_json",
            id: `${input.flowId}:${name}`,
          }),
          new Date().toISOString(),
        );
    }
  })();
  return getFlowV1RuntimeConfig(input.flowId);
}

export function getFlowV1RuntimeConfig(
  flowId: string,
): FlowV1RuntimeConfig {
  const database = getDb();
  const flow = database
    .prepare("SELECT project_cwd FROM workflows WHERE id = ?")
    .get(flowId) as { project_cwd: string | null } | undefined;
  if (!flow) {
    throw new FlowV1RuntimeConfigError(
      "flow_not_found",
      `Flow ${flowId} was not found.`,
    );
  }
  const rows = database
    .prepare(
      `
      SELECT secret_name, binding_json
      FROM workflow_secret_bindings
      WHERE flow_id = ?
      ORDER BY secret_name ASC
    `,
    )
    .all(flowId) as Array<{
    secret_name: string;
    binding_json: string;
  }>;
  const secretBindings: Record<string, FlowV1SecretBinding> = {};
  for (const row of rows) {
    const binding = parseJsonObjectColumn(row.binding_json, {
      table: "workflow_secret_bindings",
      column: "binding_json",
      id: `${flowId}:${row.secret_name}`,
    });
    if (
      binding.kind !== "environment" ||
      typeof binding.env !== "string"
    ) {
      throw new FlowV1RuntimeConfigError(
        "flow_secret_binding_corrupt",
        `Secret binding ${row.secret_name} is invalid.`,
      );
    }
    secretBindings[row.secret_name] = {
      kind: "environment",
      env: binding.env,
    };
  }
  return { projectCwd: flow.project_cwd, secretBindings };
}

export function resolveFlowV1ExecutionConfig(input: {
  flowId: string;
  flow: ParsedFlowV1;
}): {
  projectCwd: string | undefined;
  secrets: Record<string, string>;
  missingSecretNames: string[];
} {
  const config = getFlowV1RuntimeConfig(input.flowId);
  const secrets: Record<string, string> = {};
  const missingSecretNames: string[] = [];
  for (const [name, definition] of Object.entries(input.flow.secrets)) {
    const binding = config.secretBindings[name];
    const value = binding ? process.env[binding.env] : undefined;
    if (value !== undefined && binding) {
      secrets[name] = value;
    } else if (definition.required) {
      missingSecretNames.push(name);
    }
  }
  return {
    projectCwd: config.projectCwd ?? undefined,
    secrets,
    missingSecretNames,
  };
}
