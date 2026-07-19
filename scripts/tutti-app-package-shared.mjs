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
        path: ["import"],
        summary: "Import a workflow script as a saved workflow",
        description:
          "Save a workflow JavaScript source string as a new runnable workflow, returning the created workflow and its current version. The backbone of adapting a blueprint (edit its script, then import) and of self-authored workflows (write the DSL, validate, then import). Invalid scripts return a workflow_script_invalid domain error with diagnostics.",
        inputSchema: objectSchema(
          {
            script: {
              type: "string",
              description: "Workflow JavaScript source to save as a new workflow.",
            },
          },
          ["script"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/import"),
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
            "permission-mode": {
              type: "string",
              description:
                "Optional run-level permission mode id. Discover exact ids with tutti agent composer-options --agent-id <agent-id> --json. Omit to use the agent default.",
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
          "Server-side bounded wait that returns when a run reaches a stop point: a terminal status (completed/failed/canceled/interrupted) or waiting on human input. A real stop point returns the full runs-get detail; a timeout returns only a compact progress fingerprint (run status, logBytes, pending task count) — loop on bounded waits until a non-timeout reason.",
        inputSchema: objectSchema(
          {
            "run-id": {
              type: "string",
              description: "Workflow run id to wait on.",
            },
            "timeout-ms": {
              type: "integer",
              description:
                "Maximum server-side wait in milliseconds. Defaults to 10000 and is capped at 10000 (safely under the daemon CLI proxy's ~16s budget); on expiry the response has reason \"timeout\" and timedOut true. Loop on short bounded waits.",
            },
          },
          ["run-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/runs/wait"),
      },
      {
        path: ["runs", "respond"],
        summary: "Respond to a pending human task and resume the run",
        description:
          "Answer a pending human gate on behalf of your user, then resume the run exactly as the UI does. Pick an action id from the task spec (runs get/wait humanTasks) and pass required field values as a JSON object. Revision defaults to the task's current revision (read-modify-write); pass revision to enforce optimistic concurrency. Returns the resolved task plus the refreshed runs get payload so you can loop back into runs wait.",
        inputSchema: objectSchema(
          {
            "run-id": {
              type: "string",
              description: "Workflow run id that owns the task.",
            },
            "task-id": {
              type: "string",
              description:
                "Pending human task id from the run's humanTasks list.",
            },
            action: {
              type: "string",
              description:
                "Action id to take, chosen from the task spec's actions.",
            },
            values: {
              type: "string",
              description:
                "JSON object string mapping the action's field ids to string values. Required fields must be present.",
            },
            revision: {
              type: "integer",
              description:
                "Optional expected task revision for optimistic concurrency. Omit to use the task's current revision (read-modify-write).",
            },
          },
          ["run-id", "task-id", "action"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/runs/respond"),
      },
      {
        path: ["runs", "note"],
        summary: "Steer a running run with a recorded operator note",
        description:
          "Record an operator note that steers a running workflow with full provenance. The note is written to the run log as a run_note event BEFORE any delivery, so run review and replay stay truthful. target=next-step (default) injects the note as a final labeled block into the NEXT agent execution's rendered prompt (any node/step/map item; scope it to one node with node-id); target=current delegates the note to the live agent session via the tutti agent channel and rejects with a clear error if no live session exists. Returns the recorded note and, for current, the delivery result.",
        inputSchema: objectSchema(
          {
            "run-id": {
              type: "string",
              description: "Workflow run id to steer.",
            },
            message: {
              type: "string",
              description: "Operator guidance to inject or deliver.",
            },
            target: {
              type: "string",
              description:
                'Delivery semantics: "next-step" (default) injects into the next agent execution; "current" delegates to the live agent session.',
            },
            "node-id": {
              type: "string",
              description:
                "Optional node id. For next-step, only an execution of this node consumes the note; for current, selects which live session to steer.",
            },
          },
          ["run-id", "message"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/runs/note"),
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
        path: ["blueprints", "instantiate"],
        summary: "Instantiate a blueprint as a runnable workflow",
        description:
          "Instantiate a blueprint as-is into a saved, runnable workflow when it matches the requirement exactly; otherwise adapt its script (blueprints get --include-script) and import. Wraps the same service as the UI instantiate route and returns the created workflow and its current version.",
        inputSchema: objectSchema(
          {
            "blueprint-id": {
              type: "string",
              description: "Blueprint id to instantiate.",
            },
            name: {
              type: "string",
              description:
                "Optional name override for the created workflow. Defaults to the blueprint's name.",
            },
          },
          ["blueprint-id"],
        ),
        output: jsonOutput(),
        handler: httpHandler("/tutti/cli/blueprints/instantiate"),
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
    `tutti --json ${scope} import --script '<workflow-js>'`,
    `tutti --json ${scope} run --workflow-id <id> --agent local:codex --inputs '{"topic":"release"}'`,
    `tutti --json ${scope} runs wait --run-id <run-id> --timeout-ms 10000`,
    `tutti --json ${scope} runs get --run-id <run-id>`,
    `tutti --json ${scope} runs respond --run-id <run-id> --task-id <task-id> --action approve --values '{"notes":"ship it"}'`,
    `tutti --json ${scope} runs note --run-id <run-id> --message 'Prioritize the failing auth test' --target next-step`,
    `tutti --json ${scope} resume --workflow-id <id> --run-id <run-id>`,
    `tutti --json ${scope} blueprints list`,
    `tutti --json ${scope} blueprints search --query 'acceptance loop' --category coding`,
    `tutti --json ${scope} blueprints get --blueprint-id <id> --include-script`,
    `tutti --json ${scope} blueprints instantiate --blueprint-id <id> --name 'My workflow'`,
    `tutti --json ${scope} authoring validate --job-id <job-id> --file draft.workflow.js`,
    `tutti --json ${scope} authoring submit --job-id <job-id> --file draft.workflow.js`,
    "```",
    "",
    "Commands:",
    "",
    "- `status`: runtime health, cwd root, `baseUrl` (the app's HTTP origin, derived from the request), workflow count, and agent target detection status.",
    "- `agents`: local agent targets and model options discovered through `TUTTI_CLI`.",
    "- `list`: saved workflow summaries with version and latest run status.",
    "- `show`: one workflow, parsed node summary, versions, and recent runs.",
    "- `validate`: parser diagnostics for a workflow script without saving it.",
    "- `create`: launch an authoring agent session and return immediately; versions land whenever the agent submits.",
    "- `import`: save a workflow script string as a new runnable workflow (adapt-a-blueprint and self-authored paths). Returns the created workflow and current version.",
    "- `run`: start the current saved workflow version in the background and persist a run record. Refuses when another run is already active in the same resolved cwd unless `--force` is passed.",
    "- `runs wait`: block until a run reaches a stop point (terminal status or waiting on human input), returning a reason and a timedOut flag; loop on bounded waits.",
    "- `runs get`: fetch a run's record, structured result, pending human tasks, and a convenience report of the terminal node outputs.",
    "- `runs respond`: answer a pending human task (action id + field values) and resume the run exactly as the UI does; returns the refreshed `runs get` payload so you can loop back into `runs wait`.",
    "- `runs note`: steer a running run with a recorded operator note (`next-step` injects into the next agent execution; `current` delegates to the live agent session). See \"Steering a run\" below.",
    "- `resume`: continue an interrupted workflow run by reattaching to persisted agent sessions.",
    "- `blueprints list|search|get`: browse the built-in workflow blueprint library.",
    "- `blueprints instantiate`: instantiate a blueprint as-is into a saved workflow (only when it matches the requirement exactly). Returns the created workflow and current version.",
    "- `authoring validate|submit`: validate and save scripts produced by authoring sessions.",
    "",
    "### Error envelope (run / import / instantiate / runs \\*)",
    "",
    "The daemon CLI proxy flattens any non-2xx handler response into a generic `workspace_operation_failed`, which would destroy domain codes. So the run-shaped commands (`run`, `import`, `blueprints instantiate`, and every `runs *`) return their EXPECTED domain errors as an HTTP-200 structured envelope instead:",
    "",
    "```json",
    '{ "ok": false, "error": { "code": "run_cwd_conflict", "status": 409, "message": "...", "details": { } } }',
    "```",
    "",
    "Success payloads from those commands carry `\"ok\": true` alongside their normal fields (e.g. `{ ok: true, run, result }`). Always branch on `value.ok` for these commands; read `value.error.code` for the domain code (`run_cwd_conflict`, `run_not_found`, `run_note_no_live_session`, `human_task_conflict`, `human_task_invalid`, `human_task_not_found`, `workflow_script_invalid`, `invalid_input`, …) and `value.error.status` for the HTTP-equivalent status. Only unexpected server failures still surface as a non-2xx proxy error.",
    "",
    "If you ever need a raw HTTP fallback, target the `baseUrl` returned by `status` (no need to discover the port from process tables).",
    "",
    "`run` accepts external workflow inputs through the `inputs` flag as a JSON object string. If `agent` is omitted, nodes without an explicit agent target run with `mock` so local smoke checks stay safe. `--permission-mode` is optional; omit it to use each selected agent's default. Before setting it, call `tutti agent composer-options --agent-id <agent-id> --json` and use an exact `permissionConfig.modes[].id` because ids differ by provider. In Tutti, `--cwd` must resolve to an existing directory staged under the app data/runtime directories; relative values resolve from the runtime directory.",
    "",
    "Workflow scripts can make `agent`, `model`, and `permissionMode` runtime-configurable by setting the whole field to `{{input_name}}` or `{{input_name:default_value}}`, for example `permissionMode: \"{{reviewer_permission}}\"`. Runtime option inputs with defaults are optional but still surfaced by validation and run UIs for overrides. These templates resolve only run inputs, not upstream node outputs. Do not partially template these fields, and do not reuse workflow node ids, variable names, loop step ids, `iteration`, or `workflow.*` names as runtime option input names.",
    "",
    "Example runtime model override:",
    "",
    "```bash",
    `tutti --json ${scope} run --workflow-id <id> --agent local:codex --inputs '{"requirement":"fix login","coder_model":"gpt-5.5","reviewer_model":"gpt-5-mini"}'`,
    "```",
    "",
    agentJourneyGuide(scope),
  ].join("\n");
}

/**
 * The agent-consumer journey guide. This is the doc an upstream agent driving a
 * workflow (not authoring one) actually reads. The package manifest points
 * `documentation.file` at COMMANDS.md and ships no separate skill/doc file, so
 * the guide lives here as a first-class section.
 */
function agentJourneyGuide(scope) {
  return [
    "## Driving workflows as an agent",
    "",
    "You are an upstream agent orchestrating a Dynamic Workflow on behalf of your own user. Every command below takes `--json`; treat its `value` as the contract. The run-shaped commands (`run`, `import`, `blueprints instantiate`, `runs *`) wrap their expected errors in an `{ ok, error }` envelope — see the error-envelope section above; branch on `value.ok`. The loop is: select or build the right workflow for the requirement, honor its input contract, start a run, bounded-wait until it stops, relay any human gate to your user, then consume the report.",
    "",
    "### 1. Select the workflow — a ladder, by requirement fit, never by convenience",
    "",
    "Prefer an existing workflow over a blueprint, and a blueprint over writing new. Decide by how well the candidate matches the requirement (its input contract covers it, its graph behavior fits) — not by which is fastest to reach. Climb down only when the tier above does not fit.",
    "",
    "**Tier 1 — an existing saved workflow (check FIRST).** List what already exists and inspect the closest matches; if one already covers the requirement, run it directly and do NOT create a duplicate.",
    "",
    "```bash",
    `tutti --json ${scope} list --limit 50`,
    `tutti --json ${scope} show --workflow-id <id>`,
    "```",
    "",
    "**Tier 2 — a blueprint as a reference template (NOT a turnkey product).** Blueprints are starting points, not finished workflows. Search by intent, then decide:",
    "",
    "```bash",
    `tutti --json ${scope} blueprints search --query 'code review acceptance loop' --category coding`,
    `tutti --json ${scope} blueprints get --blueprint-id <id> --include-script`,
    "```",
    "",
    "- Only when a blueprint matches the requirement EXACTLY (inputs, prompts, scope all fit as-is) take the shortcut and instantiate it verbatim:",
    "",
    "```bash",
    `tutti --json ${scope} blueprints instantiate --blueprint-id <id> --name 'My workflow'`,
    "```",
    "",
    "- The NORMAL case is ADAPTATION: read the script (`blueprints get --include-script`), rewrite it for the actual requirement (inputs, prompts, scope — the blueprint/DSL adaptation rules apply), validate, then import:",
    "",
    "```bash",
    `tutti --json ${scope} validate --script '<edited-workflow-js>'`,
    `tutti --json ${scope} import --script '<edited-workflow-js>'`,
    "```",
    "",
    "**Tier 3 — a new implementation (LAST).** When neither an existing workflow nor a blueprint fits, either author the DSL yourself (write it, `validate --script`, `import --script`) or delegate to the AI authoring session, which runs the full authoring agent with the DSL skill:",
    "",
    "```bash",
    `tutti --json ${scope} create --prompt 'Describe the workflow you need, including its inputs and acceptance criteria' --agent local:codex`,
    "```",
    "",
    "Either way you end with a saved workflow id. `import` and `blueprints instantiate` both return the created workflow and its current version; `create` returns immediately and fills in versions as the authoring agent submits (poll `show`).",
    "",
    "### 2. Read the input contract — it IS the handoff spec",
    "",
    "```bash",
    `tutti --json ${scope} show --workflow-id <id>`,
    "```",
    "",
    "`parsed.inputSchema` lists every input with a `description`. Those descriptions are the contract: compose each input value exactly as its description asks — if it says \"one-paragraph requirement including acceptance criteria\", write that paragraph, do not paste a bare title. `requiredInputNames` must all be supplied. `meta.requiresCwd` true means the workflow edits a real repo and you MUST pass `--cwd`.",
    "",
    "### 3. Start the run",
    "",
    "```bash",
    `tutti --json ${scope} run --workflow-id <id> --agent local:codex --cwd <path> --inputs '{"requirement":"..."}'`,
    "```",
    "",
    "`--inputs` is a JSON object string keyed by input name. `--agent` is the exact target id for nodes without their own agent (discover with `tutti --json agent list`); omit it and nodes fall back to `mock` for a safe smoke run. The response's `value.run.id` is the run id you drive from here. In Tutti, stage the project under the app data/runtime directories and pass that directory as `--cwd`; relative values resolve from the runtime directory, and nested cwd values cannot escape through absolute paths, `..`, or symlinks.",
    "",
    "Honor every optional input too, not just the required ones: the acceptance-delivery blueprints expose a `max_rounds` number input that sizes the acceptance loop — its own description carries the sizing ladder (small requirement ≈ 2, medium ≈ 3, large/migration ≈ 4–5; blank uses the default). Read each input's `description` and set it deliberately by requirement scale rather than leaving quality-gating budgets at their default.",
    "",
    "A `run_cwd_conflict` error (`value.ok` false, `value.error.code` `run_cwd_conflict`, status 409) means another run is already active in the same resolved `--cwd`. That guard is deliberate — two runs mutating one working tree corrupt each other. Do NOT reflexively retry with `--force`. First check the other run (`runs get`); `--force` is legitimate only when you have confirmed the other run is abandoned or intentionally parallel on a path that will not collide.",
    "",
    "### 4. Bounded-wait loop",
    "",
    "```bash",
    `tutti --json ${scope} runs wait --run-id <run-id> --timeout-ms 10000`,
    "```",
    "",
    "Short bounded waits in a loop are the contract: `--timeout-ms` defaults to and is capped at 10000 (10s), safely under the daemon CLI proxy's ~16s budget — a longer hold would die with a proxy error instead of a clean `timedOut`. `runs wait` blocks server-side until the run reaches a stop point; a real stop point returns `reason` plus the full `runs get` detail, while a timeout returns only a compact progress fingerprint (`run` status plus `progress.logBytes` and `progress.pendingHumanTasks`). Handle each `reason`:",
    "",
    "- `timeout` (with `timedOut: true`): nothing decided yet — re-issue the same `runs wait`. For long runs, sleep locally between bounded waits (runs take minutes to hours; second-level polling is unnecessary) — e.g. wait 10s → if `timedOut`, sleep 20–30s → wait again. This is the normal heartbeat, not an error. If `progress.logBytes` is unchanged across many consecutive waits, the run may be stuck — surface that to your user instead of continuing silently.",
    "",
    "**Orchestrator discipline.** Between stop points there is NOTHING for you to act on — the workflow's own gates do the supervising. Trust them: do not call `runs get` for progress, do not read partial outputs, and do not broadcast status updates between waits. Progress snapshots are pure context noise (high volume, zero decision value, stale on arrival) and they crowd out what you will need at the real stop point; your user can watch live progress in the run UI. Act at stop points, steer with operator notes when asked, and otherwise wait.",
    "- `waiting_human`: a human gate is open — go to step 5.",
    "- `completed`: consume the report — go to step 6.",
    "- `failed` / `interrupted` / `canceled`: go to step 7.",
    "",
    "### 5. Relay a human gate to your user",
    "",
    "When `reason` is `waiting_human`, the payload's `humanTasks[]` holds one or more pending tasks. For each task, present its `spec.description` and every `spec.context[]` item (each has a `label`, `value`, and `display` of text/markdown/json) to YOUR user, then present the choices in `spec.actions[]` — each action has an `id`, a `label`, and `fields[]` (each field has an `id`, `label`, `type`, and `required`). Do not decide on your user's behalf; surface the question and collect their choice.",
    "",
    "A long context `value` may be truncated to bound the payload: it then carries an inline `…[truncated N chars]` marker and a `truncated: true` flag on that context item. Relay the marker so your user knows the content was cut rather than treating it as the full artifact.",
    "",
    "Then respond with the chosen action id and field values:",
    "",
    "```bash",
    `tutti --json ${scope} runs respond --run-id <run-id> --task-id <task-id> --action <actionId> --values '{"<fieldId>":"<value>"}'`,
    "```",
    "",
    "`--values` is a JSON object mapping the action's field ids to string values; include every required field. `runs respond` reuses the exact service the UI uses: it validates the action and fields, records the response under optimistic concurrency, and resumes the run. `--revision` is optional — omit it to answer the current revision (read-modify-write); pass the `revision` from the task if you want to fail loudly should the task have changed underneath you. Expected errors arrive in the envelope (`value.ok` false, `value.error.code`): `human_task_not_found` (status 404), `human_task_invalid` (status 400, bad action/field/missing required), `human_task_conflict` (status 409, already answered, run finished, or revision mismatch). On success (`value.ok` true) the payload is the refreshed `runs get` detail, so loop straight back into `runs wait`.",
    "",
    "### 6. Consume the result",
    "",
    "On `completed`, read `report` from `runs get` / the last wait payload: `report.text` is the concatenated terminal-node output, `report.outputs` is keyed by node id. Delivery blueprints emit a structured JSON report with fields like `result` (e.g. `mr_created` / `blocked` / `not_accepted`), `prUrl`, `branch`, `commit`, and `unverified`; determine the delivery outcome only from each terminal object in `report.outputs` and its exact `result` field, never by matching prose in `report.text`. The release-readiness blueprint's record is likewise JSON (`decision`, `reason`, `blockers`). Surface every `unverified` item to your user verbatim — these are things the workflow could NOT confirm (tests not run, criteria not checked). Never silently drop them; an unverified delivery reported as done is a lie to your user.",
    "",
    "Intermediate node outputs are also available: `result.outputs` in `runs get` is keyed by node id — useful when a non-terminal node holds the machine-readable artifact (e.g. the approved task array from the epic-breakdown blueprint's `extract` node) while the terminal node is a prose deliverable.",
    "",
    "### 7. Failure handling",
    "",
    "On `failed`, call `runs get --run-id <run-id>` and read `result.error` for the cause; report it to your user with the run id. On `interrupted` (the run's process died mid-flight, a recoverable state), resume it:",
    "",
    "```bash",
    `tutti --json ${scope} resume --workflow-id <id> --run-id <run-id>`,
    "```",
    "",
    "then go back to `runs wait`. A terminal `failed` run cannot be resumed; it can be retried from the run detail UI (a retry route exists for terminal runs). `canceled` means a human stopped it — do not restart it without your user's say-so.",
    "",
    "**Taking over a `not_accepted` delivery.** When a delivery blueprint completes with a terminal object in `report.outputs` whose `result` is exactly `\"not_accepted\"` (the acceptance loop ran out of rounds), the work is not lost: the working tree holds the work in progress, and the final reviewer verdict in `result.outputs` is a machine-readable handover packet — `criteria` (items marked 通过 are DONE; do not redo or break them), `blockers` (location/issue/evidence/expectation — the remaining work), and `unverified` (must stay reported at delivery). The terminal status report also includes a same-cwd continuation hint; relay it with the remaining blockers. Two levers, cheapest first: (1) re-run the same workflow on the same cwd with a larger `max_rounds` — the workspace persists, so the loop continues from the current state under the same independent gate; (2) take over free-form: fix the blockers yourself in the cwd within the requirement's stated scope (a blocker needing a new product decision goes to your user, never guessed), verify against the criteria, then either deliver per the requirement or re-run the workflow so the independent reviewer gives the final PASS.",
    "",
    "### Steering a run",
    "",
    "To course-correct a run that is already executing, record an operator note — never steer the underlying agent session directly. A note is a first-class, recorded workflow event, so run review and replay stay truthful; an out-of-band `tutti agent send` to the session bypasses the run log and poisons the record.",
    "",
    "```bash",
    `tutti --json ${scope} runs note --run-id <run-id> --message '<guidance>' --target next-step`,
    "```",
    "",
    "- `--target next-step` (default): the note is injected as a final labeled block into the NEXT agent execution's rendered prompt (any node, loop step, or map item). Use this for guidance that should shape upcoming work; it is durable and shows up in the persisted prompt. Scope it to one node with `--node-id <id>` so only executions of that node consume it. One note is delivered once, to the first matching execution.",
    "- `--target current`: the note is delivered to the agent session running right now, as guidance into its in-flight turn (a workflow node execution IS an active turn, so this uses the guidance channel rather than starting a new turn). Use this to interrupt live work. If no live session exists, it is rejected (`value.error.code` `run_note_no_live_session`) — fall back to next-step. The note is recorded either way before delivery is attempted.",
    "",
    "Recorded notes surface in `runs get` under `notes` (with delivery/consumption status), so you can confirm a next-step note was actually consumed by an execution.",
    "",
    "### End-to-end sequence",
    "",
    "```bash",
    `# 1. select by requirement fit: existing workflow > blueprint > new`,
    `tutti --json ${scope} list --limit 50                       # tier 1: reuse if one already fits`,
    `tutti --json ${scope} blueprints search --query 'acceptance delivery' --category coding`,
    `tutti --json ${scope} blueprints get --blueprint-id <id> --include-script  # exact match -> instantiate; else adapt + import`,
    `tutti --json ${scope} show --workflow-id wf_123             # inspect the chosen/created workflow's input contract`,
    `# 2. start (stage the project under the app data/runtime directories)`,
    `# Optional permissions: tutti agent composer-options --agent-id local:codex --json`,
    `tutti --json ${scope} run --workflow-id wf_123 --agent local:codex --cwd /absolute/app-runtime-or-data/path/repo/app \\`,
    `  --inputs '{"requirement":"Add rate limiting to /login; acceptance: 429 after 5 tries/min, covered by a test"}'`,
    `#    -> value.run.id = run_456`,
    `# 3. wait; on timeout, just re-run this line`,
    `tutti --json ${scope} runs wait --run-id run_456 --timeout-ms 10000`,
    `#    -> reason: waiting_human, humanTasks[0].id = task_789`,
    `# 4. relay task_789 to your user, then respond`,
    `tutti --json ${scope} runs respond --run-id run_456 --task-id task_789 --action approve --values '{"notes":"looks good"}'`,
    `# 5. keep waiting until terminal`,
    `tutti --json ${scope} runs wait --run-id run_456 --timeout-ms 10000`,
    `#    -> reason: completed`,
    `# 6. read the delivery report`,
    `tutti --json ${scope} runs get --run-id run_456`,
    `#    -> report: { result: "mr_created", prUrl: "...", unverified: [...] }  <- surface unverified to your user`,
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
