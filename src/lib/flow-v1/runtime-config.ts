import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import {
  parseJsonObjectColumn,
  stringifyJsonObjectColumn,
} from "@/lib/db/workflows/json-schemas";
import {
  GitHubCliConnectionError,
  resolveGitHubCliToken,
} from "@/lib/connections/github-cli";
import {
  parseFlowV1SecretBinding,
  type FlowV1SecretBinding,
  validateFlowV1SecretBindingsAgainstSchema,
  validateFlowV1SecretBinding,
} from "./secret-bindings";
import type { ParsedFlowV1 } from "./types";

export type { FlowV1SecretBinding } from "./secret-bindings";

export class FlowV1RuntimeConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowV1RuntimeConfigError";
    this.code = code;
  }
}

export type FlowV1RuntimeConfig = {
  projectCwd: string | null;
  defaultAgent: string | null;
  defaultModel: string | null;
  defaultPermissionMode: string | null;
  defaultReasoningEffort: string | null;
  secretBindings: Record<string, FlowV1SecretBinding>;
};

export function setFlowV1RuntimeConfig(input: {
  flowId: string;
  projectCwd?: string | null;
  defaultAgent?: string | null;
  defaultModel?: string | null;
  defaultPermissionMode?: string | null;
  defaultReasoningEffort?: string | null;
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
    if (
      input.defaultAgent !== undefined ||
      input.defaultModel !== undefined ||
      input.defaultPermissionMode !== undefined ||
      input.defaultReasoningEffort !== undefined
    ) {
      const defaultAgent = normalizeRuntimeSetting(
        input.defaultAgent,
        "Agent",
      );
      const defaultModel = normalizeRuntimeSetting(
        input.defaultModel,
        "Model",
      );
      const defaultPermissionMode = normalizeRuntimeSetting(
        input.defaultPermissionMode,
        "Permission mode",
      );
      const defaultReasoningEffort = normalizeRuntimeSetting(
        input.defaultReasoningEffort,
        "Reasoning effort",
      );
      const updated = database
        .prepare(
          `
          UPDATE workflows
          SET
            default_agent = CASE WHEN ? = 1 THEN ? ELSE default_agent END,
            default_model = CASE WHEN ? = 1 THEN ? ELSE default_model END,
            default_permission_mode = CASE
              WHEN ? = 1 THEN ?
              ELSE default_permission_mode
            END,
            default_reasoning_effort = CASE
              WHEN ? = 1 THEN ?
              ELSE default_reasoning_effort
            END,
            updated_at = ?
          WHERE id = ?
        `,
        )
        .run(
          input.defaultAgent !== undefined ? 1 : 0,
          defaultAgent,
          input.defaultModel !== undefined ? 1 : 0,
          defaultModel,
          input.defaultPermissionMode !== undefined ? 1 : 0,
          defaultPermissionMode,
          input.defaultReasoningEffort !== undefined ? 1 : 0,
          defaultReasoningEffort,
          new Date().toISOString(),
          input.flowId,
        ).changes;
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
      const bindingError = validateFlowV1SecretBinding(name, binding);
      if (bindingError) {
        throw new FlowV1RuntimeConfigError(
          "flow_secret_binding_invalid",
          bindingError,
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
    .prepare(
      `
      SELECT project_cwd, default_agent, default_model,
        default_permission_mode, default_reasoning_effort
      FROM workflows
      WHERE id = ?
    `,
    )
    .get(flowId) as
    | {
        project_cwd: string | null;
        default_agent: string | null;
        default_model: string | null;
        default_permission_mode: string | null;
        default_reasoning_effort: string | null;
      }
    | undefined;
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
    const parsedBinding = parseFlowV1SecretBinding(binding);
    if (
      !parsedBinding ||
      validateFlowV1SecretBinding(row.secret_name, parsedBinding)
    ) {
      throw new FlowV1RuntimeConfigError(
        "flow_secret_binding_corrupt",
        `Secret binding ${row.secret_name} is invalid.`,
      );
    }
    secretBindings[row.secret_name] = parsedBinding;
  }
  return {
    projectCwd: flow.project_cwd,
    defaultAgent: flow.default_agent,
    defaultModel: flow.default_model,
    defaultPermissionMode: flow.default_permission_mode,
    defaultReasoningEffort: flow.default_reasoning_effort,
    secretBindings,
  };
}

export async function resolveFlowV1ExecutionConfig(input: {
  flowId: string;
  flow: ParsedFlowV1;
}): Promise<{
  projectCwd: string | undefined;
  defaultAgent: string | undefined;
  defaultModel: string | undefined;
  defaultPermissionMode: string | undefined;
  defaultReasoningEffort: string | undefined;
  secrets: Record<string, string>;
  missingSecretNames: string[];
}> {
  const config = getFlowV1RuntimeConfig(input.flowId);
  const bindingSchemaError = validateFlowV1SecretBindingsAgainstSchema(
    input.flow.secrets,
    config.secretBindings,
  );
  if (bindingSchemaError) {
    throw new FlowV1RuntimeConfigError(
      "flow_secret_binding_invalid",
      bindingSchemaError,
    );
  }
  const secrets: Record<string, string> = {};
  const missingSecretNames: string[] = [];
  for (const [name, definition] of Object.entries(input.flow.secrets)) {
    const binding = config.secretBindings[name];
    let value: string | undefined;
    if (binding?.kind === "environment") {
      value = process.env[binding.env];
    } else if (binding?.kind === "connection") {
      try {
        value = await resolveGitHubCliToken({
          host: binding.host,
          login: binding.login,
        });
      } catch (error) {
        if (error instanceof GitHubCliConnectionError) {
          throw new FlowV1RuntimeConfigError(error.code, error.message);
        }
        throw error;
      }
    }
    if (value !== undefined && binding) {
      secrets[name] = value;
    } else if (definition.required) {
      missingSecretNames.push(name);
    }
  }
  return {
    projectCwd: config.projectCwd ?? undefined,
    defaultAgent: config.defaultAgent ?? undefined,
    defaultModel: config.defaultModel ?? undefined,
    defaultPermissionMode: config.defaultPermissionMode ?? undefined,
    defaultReasoningEffort: config.defaultReasoningEffort ?? undefined,
    secrets,
    missingSecretNames,
  };
}

function normalizeRuntimeSetting(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new FlowV1RuntimeConfigError(
      "flow_runtime_setting_invalid",
      `${label} must be a non-empty string or null.`,
    );
  }
  return normalized;
}
