# Dynamic Workflows CLI

The dev package exposes the `dynamic-workflows` scope through `tutti.cli.json`. Commands return Tutti `CliCommandOutput` objects and are routed to the source Next app under `/tutti/cli/*`.

Use `--json` for machine-readable output:

Discover exact agent ids with `tutti --json agent list`. The available targets
are dynamic and multiple targets may share a provider; the ids below are only
examples.

```bash
tutti --json dynamic-workflows status
tutti --json dynamic-workflows agents
tutti --json dynamic-workflows list --limit 20
tutti --json dynamic-workflows show --workflow-id <id> --include-script
tutti --json dynamic-workflows validate --script '<workflow-js>'
tutti --json dynamic-workflows create --prompt 'Summarize this repo and propose next steps' --agent local:codex
tutti --json dynamic-workflows run --workflow-id <id> --agent local:codex --inputs '{"topic":"release"}'
tutti --json dynamic-workflows resume --workflow-id <id> --run-id <run-id>
tutti --json dynamic-workflows blueprints list
tutti --json dynamic-workflows blueprints search --query 'acceptance loop' --category coding
tutti --json dynamic-workflows blueprints get --blueprint-id <id> --include-script
tutti --json dynamic-workflows authoring submit --job-id <job-id> --file draft.workflow.js
```

Commands:

- `status`: runtime health, cwd root, workflow count, and agent target detection status.
- `agents`: local agent targets and model options discovered through `TUTTI_CLI`.
- `list`: saved workflow summaries with version and latest run status.
- `show`: one workflow, parsed node summary, versions, and recent runs.
- `validate`: parser diagnostics for a workflow script without saving it.
- `create`: launch a workflow authoring agent session from a natural-language prompt and return immediately (workflow id + session). Versions land whenever the session submits; poll `show` to observe them.
- `run`: start the official or a selected saved workflow version in the background and persist a run record.
- `resume`: continue an interrupted workflow run by reattaching to persisted agent sessions.
- `blueprints list|search|get`: browse the built-in blueprint library used as authoring references.
- `authoring submit`: save a script version for an authoring job (used by the authoring agent itself; validates and saves, or returns diagnostics with `accepted: false`). A session may submit multiple times; each accepted submit saves a new version.

`run` accepts external workflow inputs through the `inputs` flag as a JSON object string. If `agent` is omitted, nodes without an explicit agent target run with `mock` so local smoke checks stay safe.
