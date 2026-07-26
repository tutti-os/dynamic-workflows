# Dynamic Workflows Dev Package

This is a local-only Tutti development package. It does not contain the app implementation; `bootstrap.sh` launches the checked-out source repository directly.

Source directory: `/Users/liying/project/dynamic-workflows`

Runtime rules:

- Run `npm install` in the source directory before starting this package.
- `bootstrap.sh` starts `next dev` with the source environment Node by default and repairs native-module ABI mismatches before launch, because this dev package reuses `node_modules` from the checkout. Set `DYNAMIC_WORKFLOWS_NODE` to override it.
- `bootstrap.sh` uses `TUTTI_CLI` for agent target detection, while still setting `NEXTOP_CLI_PATH` for older adapter code.
- `tutti.cli.json` exposes `dynamic-workflows` commands for status, agent target discovery, workflow listing, workflow inspection, script validation, workflow creation, and workflow execution.
- CLI command handlers are served by the source Next app under `/tutti/cli/*` and return Tutti `CliCommandOutput` objects directly.
- In Tutti, workflow cwd inputs must resolve to existing directories staged under `TUTTI_APP_DATA_DIR` or `TUTTI_APP_RUNTIME_DIR`; relative values resolve from the runtime directory, and nested node cwd values cannot escape either directory. Direct local development falls back to the source checkout as its boundary.
- Durable data is written to `DYNAMIC_WORKFLOWS_DATA_DIR`, falling back to `TUTTI_APP_DATA_DIR` and then the source `.data` directory.
- Re-run `npm run import:tutti-dev` after changing manifest, bootstrap, or this package wrapper.
