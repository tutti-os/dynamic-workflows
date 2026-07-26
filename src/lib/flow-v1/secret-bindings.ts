import { isSafeGitHubConnectionReference } from "@/lib/connections/github-reference";
import type { FlowV1SchemaEntry } from "./types";

export type FlowV1EnvironmentSecretBinding = {
  kind: "environment";
  env: string;
};

export type FlowV1GitHubConnectionSecretBinding = {
  kind: "connection";
  provider: "github";
  source: "github_cli";
  host: string;
  login: string;
};

export type FlowV1SecretBinding =
  | FlowV1EnvironmentSecretBinding
  | FlowV1GitHubConnectionSecretBinding;

export function validateFlowV1SecretBinding(
  name: string,
  binding: FlowV1SecretBinding,
): string | null {
  if (!name.trim()) {
    return "Secret binding name is required.";
  }
  if (binding.kind === "environment") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(binding.env)) {
      return `Secret binding ${name} must reference a valid environment variable name.`;
    }
    if (looksLikeSecretValue(binding.env)) {
      return `Secret binding ${name} looks like a credential value. Select a connection or enter an environment variable name instead.`;
    }
    return null;
  }
  if (
    binding.kind === "connection" &&
    binding.provider === "github" &&
    binding.source === "github_cli" &&
    isSafeGitHubConnectionReference(binding)
  ) {
    return null;
  }
  return `Secret binding ${name} is invalid.`;
}

export function looksLikeSecretValue(value: string): boolean {
  return /^(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/u.test(
    value.trim(),
  );
}

export function parseFlowV1SecretBinding(
  value: unknown,
): FlowV1SecretBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const binding = value as Record<string, unknown>;
  if (binding.kind === "environment" && typeof binding.env === "string") {
    return { kind: "environment", env: binding.env };
  }
  const host = binding.host;
  const login = binding.login;
  if (
    binding.kind === "connection" &&
    binding.provider === "github" &&
    binding.source === "github_cli" &&
    typeof host === "string" &&
    typeof login === "string" &&
    isSafeGitHubConnectionReference({
      host,
      login,
    })
  ) {
    return {
      kind: "connection",
      provider: "github",
      source: "github_cli",
      host,
      login,
    };
  }
  return null;
}

export function parseFlowV1SecretBindings(
  value: unknown,
): Record<string, FlowV1SecretBinding> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const parsed = Object.create(null) as Record<
    string,
    FlowV1SecretBinding
  >;
  for (const [name, candidate] of Object.entries(value)) {
    const binding = parseFlowV1SecretBinding(candidate);
    if (!binding || validateFlowV1SecretBinding(name, binding)) {
      return null;
    }
    parsed[name] = binding;
  }
  return parsed;
}

export function validateFlowV1SecretBindingsAgainstSchema(
  secrets: Record<string, FlowV1SchemaEntry>,
  bindings: Record<string, FlowV1SecretBinding>,
): string | null {
  for (const [name, binding] of Object.entries(bindings)) {
    const bindingError = validateFlowV1SecretBinding(name, binding);
    if (bindingError) {
      return bindingError;
    }
    if (!Object.hasOwn(secrets, name)) {
      return `Secret binding ${name} does not match a declared Flow Secret.`;
    }
    const definition = secrets[name]!;
    if (binding.kind !== "connection") {
      continue;
    }
    if (definition.helper !== "connectionSecret") {
      return `Secret ${name} does not accept a connection binding.`;
    }
    const expectedProvider = definition.config.provider;
    if (
      typeof expectedProvider !== "string" ||
      binding.provider !== expectedProvider
    ) {
      return `Secret ${name} requires a ${String(expectedProvider)} connection, but the saved binding uses ${binding.provider}.`;
    }
  }
  return null;
}
