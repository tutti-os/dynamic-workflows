# Dynamic Workflows Local Dev App

This directory is a Tutti local debug wrapper for the source project at `/Users/ccr/tsh-project/dynamic-workflows`. Keep it small: it describes and launches the checkout, but the app implementation stays in the project root.

Tutti Desktop can Load unpacked either from the project root or directly from `.tutti/dev-app/`.

Runtime contract:

- `bootstrap.sh` is the Tutti runtime entrypoint and starts the source Next.js dev server.
- It reads `TUTTI_APP_HOST`, defaulting to `127.0.0.1` only when absent.
- It requires `TUTTI_APP_PORT`; there is no hard-coded or guessed fallback port.
- It uses `TUTTI_APP_NPM` to run `npm run dev -- -H "$TUTTI_APP_HOST" -p "$TUTTI_APP_PORT"` from the project root.
- It requires existing project dependencies; run `npm install` in the project root before loading the app if `node_modules` is absent.
- The manifest healthcheck is the source app's `GET /api/health` route.

Source hot reload:

- Edits under `src/`, `package.json`, and other project source files are handled by the Next.js dev server.
- Edits to `tutti.app.json`, `tutti.cli.json`, `bootstrap.sh`, `COMMANDS.md`, `icon.svg`, or this `AGENTS.md` require App Center's local-dev Reload action so Tutti rereads the manifest and restarts the runtime.

Data and integration:

- Workflow data uses `DYNAMIC_WORKFLOWS_DATA_DIR`, defaulting to `TUTTI_APP_DATA_DIR` and then `.data` only outside the Tutti runtime.
- Workflow cwd validation uses `DYNAMIC_WORKFLOWS_CWD_ROOT`, defaulting to `TUTTI_WORKSPACE_ROOT` and then the project root.
- CLI command handlers are declared in `tutti.cli.json` and served by the source app under `/tutti/cli/*`.
- Agent/provider discovery should use `TUTTI_CLI`; `bootstrap.sh` also sets `NEXTOP_CLI_PATH` from it for existing adapter compatibility.
