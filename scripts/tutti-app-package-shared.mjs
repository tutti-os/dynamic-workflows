export function cliManifest(options = {}) {
  const scope = options.scope ?? "dynamic-workflows";
  return {
    schemaVersion: "tutti.app.cli.v1",
    scope,
    description:
      "Create, inspect, validate, and run local Dynamic Workflows.",
    documentation: {
      file: "COMMANDS.md",
    },
    commands: [
      {
        path: ["status"],
        summary: "Show Dynamic Workflows runtime status",
        description:
          "Report app health, workflow counts, cwd root, and agent provider detection status.",
        inputSchema: objectSchema({}),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/status"),
      },
      {
        path: ["providers"],
        summary: "List available agent providers",
        description:
          "List providers and model options detected through the local Tutti CLI.",
        inputSchema: objectSchema({}),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/providers"),
      },
      {
        path: ["list"],
        summary: "List saved workflows",
        description:
          "List saved workflows with their current version and latest run status.",
        inputSchema: objectSchema({
          limit: {
            type: "integer",
            description: "Maximum number of workflows to return. Defaults to 50.",
          },
        }),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/list"),
      },
      {
        path: ["show"],
        summary: "Show one workflow",
        description:
          "Return workflow metadata, current version, runs, and parsed node summary.",
        inputSchema: objectSchema(
          {
            "workflow-id": {
              type: "string",
              description: "Workflow id to inspect.",
            },
            "include-script": {
              type: "boolean",
              description: "Include the current workflow script in the output.",
            },
          },
          ["workflow-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/show"),
      },
      {
        path: ["validate"],
        summary: "Validate a workflow script",
        description:
          "Parse a workflow script and return diagnostics, external inputs, and node summary.",
        inputSchema: objectSchema(
          {
            script: {
              type: "string",
              description: "Workflow JavaScript source to validate.",
            },
          },
          ["script"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/validate"),
      },
      {
        path: ["create"],
        summary: "Generate and save a workflow",
        description:
          "Generate a workflow from a prompt, save it, and return the created workflow and script.",
        inputSchema: objectSchema(
          {
            prompt: {
              type: "string",
              description: "Natural-language workflow request.",
            },
            provider: {
              type: "string",
              description:
                "Optional agent provider for generation, such as codex or claude-code.",
            },
            model: {
              type: "string",
              description: "Optional model override.",
            },
            cwd: {
              type: "string",
              description:
                "Optional working directory, resolved inside the configured workflow cwd root.",
            },
          },
          ["prompt"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/create"),
      },
      {
        path: ["run"],
        summary: "Start a workflow run",
        description:
          "Start the current version of a saved workflow in the background and return the persisted run record used by the UI.",
        inputSchema: objectSchema(
          {
            "workflow-id": {
              type: "string",
              description: "Workflow id to run.",
            },
            inputs: {
              type: "string",
              description:
                "JSON object string containing external workflow inputs.",
            },
            provider: {
              type: "string",
              description:
                "Agent provider for nodes without an explicit provider. Defaults to mock.",
            },
            model: {
              type: "string",
              description: "Optional model override.",
            },
            cwd: {
              type: "string",
              description:
                "Optional working directory, resolved inside the configured workflow cwd root.",
            },
          },
          ["workflow-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/run"),
      },
    ],
  };
}

export function commandsMarkdown(options = {}) {
  const scope = options.scope ?? "dynamic-workflows";
  const packageLabel = options.packageLabel ?? "dev package";
  const routeLabel = options.routeLabel ?? "source Next app";
  return [
    "# Dynamic Workflows CLI",
    "",
    `The ${packageLabel} exposes the \`${scope}\` scope through \`tutti.cli.json\`. Commands return Tutti \`CliCommandOutput\` objects and are routed to the ${routeLabel} under \`/tutti/cli/*\`.`,
    "",
    "Use `--json` for machine-readable output:",
    "",
    "```bash",
    `tutti --json ${scope} status`,
    `tutti --json ${scope} providers`,
    `tutti --json ${scope} list --limit 20`,
    `tutti --json ${scope} show --workflow-id <id> --include-script`,
    `tutti --json ${scope} validate --script '<workflow-js>'`,
    `tutti --json ${scope} create --prompt 'Summarize this repo and propose next steps' --provider codex`,
    `tutti --json ${scope} run --workflow-id <id> --provider codex --inputs '{"topic":"release"}'`,
    "```",
    "",
    "Commands:",
    "",
    "- `status`: runtime health, cwd root, workflow count, and provider detection status.",
    "- `providers`: local agent providers and model options discovered through `TUTTI_CLI`.",
    "- `list`: saved workflow summaries with version and latest run status.",
    "- `show`: one workflow, parsed node summary, versions, and recent runs.",
    "- `validate`: parser diagnostics for a workflow script without saving it.",
    "- `create`: generate and save a workflow from a natural-language prompt.",
    "- `run`: start the current saved workflow version in the background and persist a run record.",
    "",
    "`run` accepts external workflow inputs through the `inputs` flag as a JSON object string. If `provider` is omitted, nodes without an explicit provider run with `mock` so local smoke checks stay safe.",
    "",
  ].join("\n");
}

export function iconSvg(options = {}) {
  const label = escapeSvgAttribute(options.label ?? "Dynamic Workflows");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${label}">
  <rect width="128" height="128" rx="28" fill="#111827"/>
  <path d="M28 38h28a16 16 0 0 1 16 16v20a16 16 0 0 0 16 16h12" fill="none" stroke="#38bdf8" stroke-width="10" stroke-linecap="round"/>
  <path d="M28 90h18a16 16 0 0 0 16-16V54a16 16 0 0 1 16-16h22" fill="none" stroke="#a3e635" stroke-width="10" stroke-linecap="round"/>
  <circle cx="28" cy="38" r="9" fill="#f9fafb"/>
  <circle cx="28" cy="90" r="9" fill="#f9fafb"/>
  <circle cx="100" cy="38" r="9" fill="#f9fafb"/>
  <circle cx="100" cy="90" r="9" fill="#f9fafb"/>
</svg>
`;
}

export function timestampVersion(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function jsonOutput() {
  return {
    defaultMode: "json",
    json: true,
  };
}

function httpHandler(pathname) {
  return {
    kind: "http",
    method: "POST",
    path: pathname,
  };
}

function escapeSvgAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
