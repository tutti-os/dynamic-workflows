export function cliManifest(options = {}) {
  const scope = options.scope ?? "dynamic-workflows";
  return {
    schemaVersion: "tutti.app.cli.v1",
    scope,
    description:
      "Create, configure, inspect, and run persistent tutti.flow.v1 Bundles.",
    documentation: { file: "COMMANDS.md" },
    commands: [
      command(scope, ["status"], "Show runtime status", "Report Flow and agent availability."),
      command(scope, ["agents"], "List agent targets", "List locally available Agent targets."),
      command(
        scope,
        ["list"],
        "List Flows",
        "List persistent Flows with Cycle, Tick, lifecycle, and Schedule state.",
        { limit: integer("Maximum number of Flows to return.") },
      ),
      command(
        scope,
        ["show"],
        "Show one Flow",
        "Return Bundle metadata, graph, configuration, current Cycle, and history.",
        {
          "workflow-id": string("Flow id."),
          "include-script": boolean("Include all Bundle source files."),
        },
        ["workflow-id"],
      ),
      command(
        scope,
        ["validate"],
        "Validate a Flow Bundle",
        "Statically validate a standalone tutti.flow.v1 Bundle without executing code nodes.",
        { directory: string("Bundle directory containing flow.js.") },
        ["directory"],
      ),
      command(
        scope,
        ["create"],
        "Launch Flow authoring",
        "Launch an Agent that produces, reviews, and submits a standalone Flow Bundle.",
        {
          prompt: string("Natural-language Flow request."),
          agent: string("Authoring Agent target id."),
          model: string("Optional authoring model."),
          cwd: string("Optional runtime project directory."),
        },
        ["prompt"],
      ),
      command(
        scope,
        ["import"],
        "Import a Flow Bundle",
        "Save a standalone Bundle as a new persistent Flow.",
        {
          directory: string("Bundle directory containing flow.js."),
          params: string("JSON object containing initial Params."),
          cwd: string("Project directory used by code nodes."),
          "secret-bindings": string(
            "JSON object mapping Secrets to provider connections or environment variable names.",
          ),
          agent: string("Default Agent target for Agent nodes."),
          model: string("Default Agent model."),
          "permission-mode": string("Default Agent permission mode."),
          "reasoning-effort": string("Default Agent thinking depth."),
          publish: boolean("Publish the imported Version."),
          activate: boolean("Activate the Flow after import."),
        },
        ["directory"],
      ),
      command(
        scope,
        ["publish"],
        "Publish a Draft Version",
        "Publish an immutable reviewed Draft as the current Version without activating the Flow.",
        {
          "workflow-id": string("Flow id."),
          "version-id": string("Draft Version id."),
          params: string("JSON object containing initial Params."),
        },
        ["workflow-id", "version-id"],
      ),
      command(
        scope,
        ["run"],
        "Dispatch a Flow Tick",
        "Start a Cycle or resume the active Cycle and queue one durable Tick.",
        {
          "workflow-id": string("Flow id."),
          inputs: string("JSON object containing immutable Cycle Inputs."),
          "idempotency-key": string("Optional caller idempotency key."),
          agent: string("Default Agent target for Agent nodes."),
          model: string("Default Agent model."),
          "permission-mode": string("Default Agent permission mode."),
          "reasoning-effort": string("Default Agent thinking depth."),
          cwd: string("Runtime project directory override."),
        },
        ["workflow-id"],
      ),
      command(
        scope,
        ["configure"],
        "Configure a Flow",
        "Update Params, project cwd, and Secret provider/environment bindings.",
        {
          "workflow-id": string("Flow id."),
          params: string("JSON object containing Params."),
          "expected-params-revision": integer("Optimistic Params revision."),
          cwd: string("Project directory used by code nodes."),
          agent: string("Default Agent target for Agent nodes."),
          model: string("Default Agent model."),
          "permission-mode": string("Default Agent permission mode."),
          "reasoning-effort": string("Default Agent thinking depth."),
          "secret-bindings": string("JSON Secret binding object."),
        },
        ["workflow-id"],
      ),
      lifecycleCommand(scope, "activate", "active"),
      lifecycleCommand(scope, "pause", "paused"),
      command(
        scope,
        ["cancel-cycle"],
        "Cancel a Cycle",
        "Request cancellation and run matching Finally nodes.",
        {
          "workflow-id": string("Flow id."),
          "cycle-id": string("Optional Cycle id."),
          "run-id": string("Optional Tick id used to resolve its Cycle."),
        },
        ["workflow-id"],
      ),
      command(
        scope,
        ["runs", "get"],
        "Inspect a Tick",
        "Return its Cycle checkpoint, Attempts, Effects, and Human tasks.",
        { "run-id": string("Tick id.") },
        ["run-id"],
      ),
      {
        ...command(
        scope,
        ["runs", "wait"],
        "Wait for a Tick stop point",
        "Durably wait until a Tick stops or asks for Human input.",
        { "run-id": string("Tick id.") },
        ["run-id"],
        ),
        execution: { mode: "wait" },
      },
      command(
        scope,
        ["runs", "respond"],
        "Respond to a Human node",
        "Resolve a pending Human task and queue the next Tick.",
        {
          "run-id": string("Tick id."),
          "task-id": string("Human task id."),
          action: string("Selected action id."),
          values: string("JSON object containing action field values."),
          revision: integer("Optional optimistic task revision."),
        },
        ["run-id", "task-id", "action"],
      ),
      command(scope, ["blueprints", "list"], "List Blueprints", "List standalone Flow Bundle templates."),
      command(
        scope,
        ["blueprints", "search"],
        "Search Blueprints",
        "Search templates by scenario, tag, category, and capability.",
        {
          query: string("Search text."),
          category: string("Blueprint category."),
          tags: string("Comma-separated tags."),
          "requires-cwd": boolean("Filter by project requirement."),
          "include-script": boolean("Include Bundle files."),
          limit: integer("Maximum result count."),
        },
      ),
      command(
        scope,
        ["blueprints", "get"],
        "Get a Blueprint",
        "Return one Flow Bundle template.",
        {
          "blueprint-id": string("Blueprint id."),
          "include-script": boolean("Include Bundle files."),
        },
        ["blueprint-id"],
      ),
      command(
        scope,
        ["blueprints", "instantiate"],
        "Instantiate a Blueprint",
        "Copy a complete Blueprint Bundle into a new independent Flow.",
        {
          "blueprint-id": string("Blueprint id."),
          name: string("Optional Flow name override."),
        },
        ["blueprint-id"],
      ),
      command(
        scope,
        ["authoring", "validate"],
        "Validate an authored Bundle",
        "Validate draft.flow and optionally start an independent semantic review.",
        {
          "job-id": string("Authoring job id."),
          directory: string("Bundle directory inside the authoring workspace."),
          "review-mode": string('Either "none" or "agent".'),
          "reviewer-agent": string("Optional independent reviewer Agent."),
          "reviewer-model": string("Optional reviewer model."),
        },
        ["job-id", "directory"],
      ),
      command(
        scope,
        ["authoring", "review", "get"],
        "Get semantic review",
        "Read the current review bound to an authored Bundle.",
        { "job-id": string("Authoring job id.") },
        ["job-id"],
      ),
      {
        ...command(
        scope,
        ["authoring", "review", "wait"],
        "Wait for semantic review",
        "Durably wait for the independent review to stop.",
        { "job-id": string("Authoring job id.") },
        ["job-id"],
        ),
        execution: { mode: "wait" },
      },
      command(
        scope,
        ["authoring", "submit"],
        "Submit an authored Bundle",
        "Persist the exact reviewed Bundle as a new published Version.",
        {
          "job-id": string("Authoring job id."),
          directory: string("Bundle directory inside the authoring workspace."),
          "skip-semantic-review": boolean("Explicitly waive independent review."),
          reason: string("Required audit reason when review is waived."),
        },
        ["job-id", "directory"],
      ),
      command(
        scope,
        ["resume"],
        "Resume a waiting Flow",
        "Queue the next Tick for the active Cycle associated with a prior Tick.",
        {
          "workflow-id": string("Flow id."),
          "run-id": string("Prior Tick id."),
        },
        ["workflow-id", "run-id"],
      ),
    ],
  };
}

export function commandsMarkdown(options = {}) {
  const scope = options.scope ?? "dynamic-workflows";
  const commandIndex = cliManifest({ scope }).commands.map(
    (entry) => `- \`${entry.path.join(" ")}\` — ${entry.summary}.`,
  );
  return [
    "# Dynamic Workflows CLI",
    "",
    "This app supports only standalone `tutti.flow.v1` Bundles. A Flow owns durable Cycles; each dispatch or Schedule fire creates one bounded Tick.",
    "",
    "## Core commands",
    "",
    `- \`tutti --json ${scope} list\` — list Flows and runtime state.`,
    `- \`tutti --json ${scope} show --workflow-id <id> --include-script\` — inspect graph, configuration, history, and Bundle.`,
    `- \`tutti --json ${scope} validate --directory ./my.flow\` — static validation only.`,
    `- \`tutti --json ${scope} import --directory ./my.flow --activate\` — create a Flow from a Bundle.`,
    `- \`tutti --json ${scope} run --workflow-id <id> --inputs '{}'\` — start or resume one Cycle Tick.`,
    `- \`tutti --json ${scope} runs wait --run-id <tick-id>\` — wait for a durable stop point.`,
    "",
    "## Authoring",
    "",
    "The Agent writes `draft.flow/`, searches Blueprints as templates, validates without executing modules, obtains an independent semantic review, and submits the exact reviewed Bundle as a Draft. The user reviews and publishes it explicitly.",
    "",
    `1. \`tutti --json ${scope} create --prompt '<business scenario>' --agent <agent-id>\``,
    `2. \`tutti --json ${scope} authoring validate --job-id <job-id> --directory draft.flow --review-mode agent\``,
    `3. \`tutti --json ${scope} authoring review wait --job-id <job-id>\``,
    `4. \`tutti --json ${scope} authoring submit --job-id <job-id> --directory draft.flow\``,
    `5. \`tutti --json ${scope} publish --workflow-id <flow-id> --version-id <version-id> --params '{}'\``,
    "",
    "## Runtime rules",
    "",
    "- Script and Gate nodes must be deterministic checks; external mutations belong in Effect nodes with idempotency keys and reconcile handlers.",
    "- Recurring schedules re-check waiting Gates without Agent token use.",
    "- Params are revisioned configuration; Inputs are immutable per Cycle; Secrets store only provider connection references or environment variable names.",
    "- Agent runtime defaults can include model, permission mode, and reasoning effort; omit reasoning effort to use the selected Agent's default.",
    "- Human responses and failed-node retries create new Ticks in the same Cycle.",
    "- `runs get` exposes Checkpoint, Attempts, Effect ledger, and pending Human tasks for audit.",
    "- Blueprints are copied authoring templates, never runtime dependencies.",
    "",
    "## Command index",
    "",
    ...commandIndex,
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

function command(scope, path, summary, description, properties = {}, required = []) {
  return {
    path,
    summary,
    description,
    inputSchema: objectSchema(properties, required),
    output: jsonOutput(),
    handler: httpHandler(`/tutti/cli/${path.join("/")}`),
  };
}

function lifecycleCommand(scope, name, lifecycle) {
  return command(
    scope,
    [name],
    `${name[0].toUpperCase()}${name.slice(1)} a Flow`,
    `Set the Flow lifecycle to ${lifecycle}.`,
    { "workflow-id": string("Flow id.") },
    ["workflow-id"],
  );
}

function string(description) {
  return { type: "string", description };
}

function integer(description) {
  return { type: "integer", description };
}

function boolean(description) {
  return { type: "boolean", description };
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function jsonOutput() {
  return { defaultMode: "json", json: true };
}

function httpHandler(pathname) {
  return { kind: "http", method: "POST", path: pathname };
}

function escapeSvgAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
