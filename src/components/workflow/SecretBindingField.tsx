"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@tutti-os/ui-system";
import { GitBranch, KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GitHubCliConnection } from "@/lib/connections/github-cli";
import {
  looksLikeSecretValue,
  type FlowV1SecretBinding,
} from "@/lib/flow-v1/secret-bindings";
import type { FlowV1SchemaEntry } from "@/lib/flow-v1/types";

const UNCONFIGURED_VALUE = "__unconfigured__";
const ENVIRONMENT_VALUE = "__environment__";

export function SecretBindingField(props: {
  name: string;
  definition: FlowV1SchemaEntry;
  binding: FlowV1SecretBinding | undefined;
  onChange: (binding: FlowV1SecretBinding | undefined) => void;
}) {
  const provider =
    typeof props.definition.config.provider === "string"
      ? props.definition.config.provider
      : null;
  if (provider === "github") {
    return <GitHubSecretBindingField {...props} />;
  }
  return <EnvironmentSecretBindingField {...props} />;
}

function GitHubSecretBindingField(props: {
  name: string;
  definition: FlowV1SchemaEntry;
  binding: FlowV1SecretBinding | undefined;
  onChange: (binding: FlowV1SecretBinding | undefined) => void;
}) {
  const [catalog, setCatalog] = useState<{
    connections: GitHubCliConnection[];
    warning?: string;
  }>({ connections: [] });
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch(
      reloadKey > 0
        ? "/api/connections/github?refresh=1"
        : "/api/connections/github",
      {
      cache: "no-store",
      signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("GitHub connections could not be loaded.");
        }
        return (await response.json()) as {
          connections?: GitHubCliConnection[];
          warning?: string;
        };
      })
      .then((payload) => {
        setCatalog({
          connections: payload.connections ?? [],
          warning: payload.warning,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setCatalog({
          connections: [],
          warning:
            error instanceof Error
              ? error.message
              : "GitHub connections could not be loaded.",
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [reloadKey]);

  const selectedConnection = useMemo(() => {
    const binding = props.binding;
    if (
      binding?.kind !== "connection" ||
      binding.provider !== "github"
    ) {
      return null;
    }
    return (
      catalog.connections.find(
        (connection) =>
          connection.host === binding.host &&
          connection.login === binding.login,
      ) ?? null
    );
  }, [catalog.connections, props.binding]);
  const selectedValue =
    props.binding?.kind === "environment"
      ? ENVIRONMENT_VALUE
      : props.binding?.kind === "connection"
        ? selectedConnection?.id ?? connectionValue(props.binding)
        : UNCONFIGURED_VALUE;
  const selectedLabel =
    props.binding?.kind === "environment"
      ? "Environment variable"
      : props.binding?.kind === "connection"
        ? `${props.binding.login} · ${props.binding.host}`
        : loading
          ? "Loading GitHub connections…"
          : "Select a GitHub connection";

  return (
    <div className="flow-secret-binding-field">
      <span className="flow-secret-binding-label">
        Secret {props.name}
        {props.definition.required ? " · required" : ""}
      </span>
      <Select
        value={selectedValue}
        onValueChange={(value) => {
          if (value === UNCONFIGURED_VALUE) {
            props.onChange(undefined);
            return;
          }
          if (value === ENVIRONMENT_VALUE) {
            props.onChange({
              kind: "environment",
              env:
                props.binding?.kind === "environment"
                  ? props.binding.env
                  : "",
            });
            return;
          }
          const connection = catalog.connections.find(
            (candidate) => candidate.id === value,
          );
          if (!connection) {
            return;
          }
          props.onChange({
            kind: "connection",
            provider: "github",
            source: "github_cli",
            host: connection.host,
            login: connection.login,
          });
        }}
      >
        <SelectTrigger className="control-select flow-secret-binding-select">
          <GitBranch size={16} />
          <span className="select-display">{selectedLabel}</span>
        </SelectTrigger>
        <SelectContent align="start" className="workflow-select-content">
          <SelectItem value={UNCONFIGURED_VALUE}>
            No connection
          </SelectItem>
          {catalog.connections.map((connection) => (
            <SelectItem
              disabled={!connection.available}
              key={connection.id}
              value={connection.id}
            >
              {connection.login} · {connection.host}
              {connection.active ? " · active" : ""}
            </SelectItem>
          ))}
          <SelectItem value={ENVIRONMENT_VALUE}>
            Advanced · Environment variable
          </SelectItem>
        </SelectContent>
      </Select>
      {props.binding?.kind === "environment" ? (
        <EnvironmentVariableInput
          name={props.name}
          value={props.binding.env}
          onChange={(env) =>
            props.onChange({ kind: "environment", env })
          }
        />
      ) : null}
      {catalog.warning ? (
        <p className="flow-secret-binding-message" data-tone="warning">
          {catalog.warning}{" "}
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            Retry
          </button>
        </p>
      ) : null}
      {!loading &&
      !catalog.warning &&
      catalog.connections.every((connection) => !connection.available) ? (
        <p className="flow-secret-binding-message">
          No signed-in GitHub CLI account was found. Run <code>gh auth login</code>{" "}
          once, then retry.
        </p>
      ) : null}
      {!loading &&
      props.binding?.kind === "connection" &&
      selectedConnection?.available !== true ? (
        <p className="flow-secret-binding-message" data-tone="warning">
          The saved GitHub connection is not currently available.
        </p>
      ) : null}
    </div>
  );
}

function EnvironmentSecretBindingField(props: {
  name: string;
  definition: FlowV1SchemaEntry;
  binding: FlowV1SecretBinding | undefined;
  onChange: (binding: FlowV1SecretBinding | undefined) => void;
}) {
  const value =
    props.binding?.kind === "environment" ? props.binding.env : "";
  return (
    <div className="flow-secret-binding-field">
      <span className="flow-secret-binding-label">
        Secret {props.name}
        {props.definition.required ? " · required" : ""}
      </span>
      <EnvironmentVariableInput
        name={props.name}
        value={value}
        onChange={(env) =>
          props.onChange(
            env ? { kind: "environment", env } : undefined,
          )
        }
      />
    </div>
  );
}

function EnvironmentVariableInput(props: {
  name: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const credentialValue = looksLikeSecretValue(props.value);
  return (
    <label className="flow-secret-environment-field">
      <span>
        <KeyRound size={13} />
        Environment variable name
      </span>
      <input
        aria-invalid={credentialValue}
        id={`runtime-secret-${props.name}`}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        placeholder="ENVIRONMENT_VARIABLE_NAME"
        value={props.value}
      />
      {credentialValue ? (
        <span className="flow-field-error">
          This looks like a token value. Enter only the environment variable
          name.
        </span>
      ) : null}
    </label>
  );
}

function connectionValue(binding: {
  host: string;
  login: string;
}): string {
  return `github-cli:${encodeURIComponent(binding.host)}:${encodeURIComponent(binding.login)}`;
}
