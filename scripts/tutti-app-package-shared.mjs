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
          "Report app health, workflow counts, cwd root, and agent target detection status.",
        inputSchema: objectSchema({}),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/status"),
      },
      {
        path: ["agents"],
        summary: "List available agent targets",
        description:
          "List agent targets and model options detected through the local Tutti CLI.",
        inputSchema: objectSchema({}),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/agents"),
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
        summary: "Launch a workflow authoring session",
        description:
          "Create a workflow and launch an authoring agent session from a prompt, returning immediately with the workflow id and session. Versions land whenever the authoring agent submits.",
        inputSchema: objectSchema(
          {
            prompt: {
              type: "string",
              description: "Natural-language workflow request.",
            },
            agent: {
              type: "string",
              description:
                "Optional exact agent target id for generation. Discover current targets with tutti --json agent list.",
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
          "Start the official or selected version of a saved workflow in the background and return the persisted run record used by the UI.",
        inputSchema: objectSchema(
          {
            "workflow-id": {
              type: "string",
              description: "Workflow id to run.",
            },
            "version-id": {
              type: "string",
              description:
                "Optional workflow version id. Omit to run the official version.",
            },
            inputs: {
              type: "string",
              description:
                "JSON object string containing external workflow inputs, including runtime option inputs used by agent/model templates.",
            },
            agent: {
              type: "string",
              description:
                "Exact agent target id for nodes without an explicit agent. Discover current targets with tutti --json agent list. Defaults to mock.",
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
            force: {
              type: "boolean",
              description:
                "Start even if another run is already active in the same resolved cwd. Without this, the run is refused when a same-cwd run is executing.",
            },
          },
          ["workflow-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/run"),
      },
      {
        path: ["runs", "get"],
        summary: "Get a run's record, result, tasks, and report",
        description:
          "Fetch a workflow run's persisted record, structured result (outputs, node statuses, rendered node inputs, error), pending human tasks with rendered context, and a convenience report built from the run's terminal node outputs.",
        inputSchema: objectSchema(
          {
            "run-id": {
              type: "string",
              description: "Workflow run id to fetch.",
            },
          },
          ["run-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/runs/get"),
      },
      {
        path: ["runs", "wait"],
        summary: "Block until a run reaches a stop point",
        description:
          "Server-side bounded wait that returns when a run reaches a stop point: a terminal status (completed/failed/canceled/interrupted) or waiting on human input. Returns a reason, a timedOut flag, and the same detail shape as runs get; loop on bounded waits until a non-timeout reason.",
        inputSchema: objectSchema(
          {
            "run-id": {
              type: "string",
              description: "Workflow run id to wait on.",
            },
            "timeout-ms": {
              type: "integer",
              description:
                "Maximum server-side wait in milliseconds. Defaults to 120000 and is capped at 120000; on expiry the response has reason \"timeout\" and timedOut true.",
            },
          },
          ["run-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/runs/wait"),
      },
      {
        path: ["blueprints", "list"],
        summary: "List workflow blueprints",
        description:
          "List built-in workflow blueprint summaries (patterns, tags, use cases).",
        inputSchema: objectSchema({}),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/blueprints/list"),
      },
      {
        path: ["blueprints", "search"],
        summary: "Search workflow blueprints",
        description:
          "Search built-in workflow blueprints by keywords, category, tags, or cwd requirement.",
        inputSchema: objectSchema({
          query: {
            type: "string",
            description:
              "Keywords matched against title, description, tags, and pattern summary.",
          },
          category: {
            type: "string",
            description:
              "Filter by category: coding, review, planning, research, or ops.",
          },
          tags: {
            type: "string",
            description: "Comma-separated tag filter.",
          },
          "requires-cwd": {
            type: "boolean",
            description:
              "Filter by whether the blueprint requires an explicit cwd.",
          },
          "include-script": {
            type: "boolean",
            description: "Include full workflow scripts in the results.",
          },
          limit: {
            type: "integer",
            description: "Maximum number of results. Defaults to 20.",
          },
        }),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/blueprints/search"),
      },
      {
        path: ["blueprints", "get"],
        summary: "Show one workflow blueprint",
        description:
          "Return one blueprint's metadata and optionally its full workflow script.",
        inputSchema: objectSchema(
          {
            "blueprint-id": {
              type: "string",
              description: "Blueprint id to fetch.",
            },
            "include-script": {
              type: "boolean",
              description: "Include the full workflow script.",
            },
          },
          ["blueprint-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/blueprints/get"),
      },
      {
        path: ["authoring", "validate"],
        summary: "Validate an authored workflow script",
        description:
          "Validate a script file inside an authoring job workspace without saving a workflow version.",
        inputSchema: objectSchema(
          {
            "job-id": {
              type: "string",
              description:
                "Authoring job id from the task prompt (generation or edit job).",
            },
            file: {
              type: "string",
              description:
                "Script file path inside the authoring workspace.",
            },
          },
          ["job-id", "file"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/authoring/validate"),
      },
      {
        path: ["authoring", "submit"],
        summary: "Submit an authored workflow script",
        description:
          "Validate and save a script version for a workflow authoring job.",
        inputSchema: objectSchema(
          {
            "job-id": {
              type: "string",
              description:
                "Authoring job id from the task prompt (generation or edit job).",
            },
            file: {
              type: "string",
              description:
                "Script file path inside the authoring workspace.",
            },
            script: {
              type: "string",
              description: "Inline workflow script; alternative to file.",
            },
          },
          ["job-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/authoring/submit"),
      },
      {
        path: ["resume"],
        summary: "Resume an interrupted workflow run",
        description:
          "Resume a recoverable workflow run by reattaching to persisted agent sessions and continuing the same run record.",
        inputSchema: objectSchema(
          {
            "workflow-id": {
              type: "string",
              description: "Workflow id that owns the run.",
            },
            "run-id": {
              type: "string",
              description: "Interrupted workflow run id to resume.",
            },
          },
          ["workflow-id", "run-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/resume"),
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
    "Discover exact agent ids with `tutti --json agent list`. The available targets are dynamic and multiple targets may share a provider; the ids below are only examples.",
    "",
    "```bash",
    `tutti --json ${scope} status`,
    `tutti --json ${scope} agents`,
    `tutti --json ${scope} list --limit 20`,
    `tutti --json ${scope} show --workflow-id <id> --include-script`,
    `tutti --json ${scope} validate --script '<workflow-js>'`,
    `tutti --json ${scope} create --prompt 'Summarize this repo and propose next steps' --agent local:codex`,
    `tutti --json ${scope} run --workflow-id <id> --agent local:codex --inputs '{"topic":"release"}'`,
    `tutti --json ${scope} runs wait --run-id <run-id> --timeout-ms 120000`,
    `tutti --json ${scope} runs get --run-id <run-id>`,
    `tutti --json ${scope} resume --workflow-id <id> --run-id <run-id>`,
    `tutti --json ${scope} blueprints list`,
    `tutti --json ${scope} blueprints search --query 'acceptance loop' --category coding`,
    `tutti --json ${scope} blueprints get --blueprint-id <id> --include-script`,
    `tutti --json ${scope} authoring validate --job-id <job-id> --file draft.workflow.js`,
    `tutti --json ${scope} authoring submit --job-id <job-id> --file draft.workflow.js`,
    "```",
    "",
    "Commands:",
    "",
    "- `status`: runtime health, cwd root, workflow count, and agent target detection status.",
    "- `agents`: local agent targets and model options discovered through `TUTTI_CLI`.",
    "- `list`: saved workflow summaries with version and latest run status.",
    "- `show`: one workflow, parsed node summary, versions, and recent runs.",
    "- `validate`: parser diagnostics for a workflow script without saving it.",
    "- `create`: launch an authoring agent session and return immediately; versions land whenever the agent submits.",
    "- `run`: start the current saved workflow version in the background and persist a run record. Refuses when another run is already active in the same resolved cwd unless `--force` is passed.",
    "- `runs wait`: block until a run reaches a stop point (terminal status or waiting on human input), returning a reason and a timedOut flag; loop on bounded waits.",
    "- `runs get`: fetch a run's record, structured result, pending human tasks, and a convenience report of the terminal node outputs.",
    "- `resume`: continue an interrupted workflow run by reattaching to persisted agent sessions.",
    "- `blueprints list|search|get`: browse the built-in workflow blueprint library.",
    "- `authoring validate|submit`: validate and save scripts produced by authoring sessions.",
    "",
    "`run` accepts external workflow inputs through the `inputs` flag as a JSON object string. If `agent` is omitted, nodes without an explicit agent target run with `mock` so local smoke checks stay safe.",
    "",
    "Workflow scripts can make `agent` and `model` runtime-configurable by setting the whole field to `{{input_name}}` or `{{input_name:default_value}}`, for example `model: \"{{coder_model:gpt-5}}\"`. Runtime option inputs with defaults are optional but still surfaced by validation and run UIs for overrides. These templates resolve only run inputs, not upstream node outputs. Do not partially template these fields, and do not reuse workflow node ids, variable names, loop step ids, `iteration`, or `workflow.*` names as runtime option input names.",
    "",
    "Example runtime model override:",
    "",
    "```bash",
    `tutti --json ${scope} run --workflow-id <id> --agent local:codex --inputs '{"requirement":"fix login","coder_model":"gpt-5.5","reviewer_model":"gpt-5-mini"}'`,
    "```",
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
