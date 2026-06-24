# Dynamic Workflows CLI

The local debug app exposes the `dynamic-workflows` scope through `tutti.cli.json`. Commands return Tutti `CliCommandOutput` objects and are routed to the source Next app under `/tutti/cli/*`.

Use `--json` for machine-readable output:

```bash
tutti --json dynamic-workflows status
tutti --json dynamic-workflows providers
tutti --json dynamic-workflows list --limit 20
tutti --json dynamic-workflows show --workflow-id <id> --include-script
tutti --json dynamic-workflows validate --script '<workflow-js>'
tutti --json dynamic-workflows create --prompt 'Summarize this repo and propose next steps' --provider codex
tutti --json dynamic-workflows run --workflow-id <id> --provider codex --inputs '{"topic":"release"}'
```

Commands:

- `status`: runtime health, cwd root, workflow count, and provider detection status.
- `providers`: local agent providers and model options discovered through `TUTTI_CLI`.
- `list`: saved workflow summaries with version and latest run status.
- `show`: one workflow, parsed node summary, versions, and recent runs.
- `validate`: parser diagnostics for a workflow script without saving it.
- `create`: generate and save a workflow from a natural-language prompt.
- `run`: execute a saved workflow current version and persist a run record.

`run` accepts external workflow inputs through the `inputs` flag as a JSON object string. If `provider` is omitted, nodes without an explicit provider run with `mock` so local smoke checks stay safe.
