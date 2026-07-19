#!/bin/sh
set -eu

host="${TUTTI_APP_HOST:-127.0.0.1}"
if [ -z "${TUTTI_APP_PORT:-}" ]; then
  echo "TUTTI_APP_PORT is required; Tutti must inject the allocated runtime port." >&2
  exit 1
fi
port="$TUTTI_APP_PORT"

package_dir="${TUTTI_APP_PACKAGE_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
project_root="$(CDPATH= cd -- "$package_dir/../.." && pwd)"

if [ -z "${TUTTI_APP_NODE:-}" ]; then
  echo "TUTTI_APP_NODE is required to launch the Next.js dev server." >&2
  exit 1
fi
if [ -z "${TUTTI_APP_NPM:-}" ]; then
  echo "TUTTI_APP_NPM is required to launch the Next.js dev server." >&2
  exit 1
fi
if [ ! -f "$project_root/package.json" ]; then
  echo "Could not find package.json at $project_root." >&2
  exit 1
fi
if [ ! -d "$project_root/node_modules/next" ]; then
  echo "Dynamic Workflows dependencies are missing. Run TUTTI_APP_NPM install in $project_root before loading this dev app." >&2
  exit 1
fi

export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export NEXTOP_CLI_PATH="${NEXTOP_CLI_PATH:-${TUTTI_CLI:-}}"
export DYNAMIC_WORKFLOWS_DATA_DIR="${DYNAMIC_WORKFLOWS_DATA_DIR:-${TUTTI_APP_DATA_DIR:-$project_root/.data}}"
mkdir -p "$DYNAMIC_WORKFLOWS_DATA_DIR"

cd "$project_root"
"$TUTTI_APP_NODE" ./tools/scripts/ensure-native-modules.mjs --fix
exec "$TUTTI_APP_NPM" run dev -- -H "$host" -p "$port"
