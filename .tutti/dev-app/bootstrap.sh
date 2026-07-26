#!/bin/sh
set -eu

default_source_dir='/Users/liying/project/dynamic-workflows'
default_node_bin='/Users/liying/.local/opt/node-v24.18.0-darwin-arm64/bin/node'
source_dir="${DYNAMIC_WORKFLOWS_SOURCE_DIR:-$default_source_dir}"
node_bin="${DYNAMIC_WORKFLOWS_NODE:-$default_node_bin}"
host="${TUTTI_APP_HOST:-127.0.0.1}"
port="${TUTTI_APP_PORT:-3000}"
next_bin="$source_dir/node_modules/next/dist/bin/next"

if [ ! -x "$node_bin" ]; then
  node_bin="${TUTTI_APP_NODE:?TUTTI_APP_NODE is required}"
fi

if [ ! -f "$next_bin" ]; then
  echo "dynamic-workflows dev package requires prepared source dependencies in $source_dir." >&2
  exit 1
fi
native_check="$source_dir/tools/scripts/ensure-native-modules.mjs"
if [ ! -f "$native_check" ]; then
  echo "dynamic-workflows dev package requires $native_check." >&2
  exit 1
fi

export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export NEXTOP_CLI_PATH="${NEXTOP_CLI_PATH:-${TUTTI_CLI:-tutti-dev}}"
export DYNAMIC_WORKFLOWS_DATA_DIR="${DYNAMIC_WORKFLOWS_DATA_DIR:-${TUTTI_APP_DATA_DIR:-$source_dir/.data}}"
mkdir -p "$DYNAMIC_WORKFLOWS_DATA_DIR" "${TUTTI_APP_LOG_DIR:-$source_dir/.tmp/tutti-logs}"
cd "$source_dir"

"$node_bin" "$native_check" --fix
exec "$node_bin" "$next_bin" dev -H "$host" -p "$port"
