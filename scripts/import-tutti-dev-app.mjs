#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageTuttiDevApp } from "./package-tutti-dev-app.mjs";

const args = parseArgs(process.argv.slice(2));
const packaged = await packageTuttiDevApp({ silent: true });
const listener = await readListenerInfo(args);
const workspaceId =
  args.workspaceId ??
  process.env.TUTTI_WORKSPACE_ID ??
  (await resolveStartupWorkspaceId(listener));

if (!workspaceId) {
  throw new Error(
    "No workspace id available. Pass --workspace-id <id> or open a Tutti workspace first.",
  );
}

await requestJson(listener, "POST", `/v1/workspaces/${encodeURIComponent(workspaceId)}/apps/import`, {
  archivePath: packaged.zipPath,
});

await requestJson(
  listener,
  "POST",
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(packaged.appId)}/install`,
  { restartRunning: true },
);

console.log(`Imported and installed ${packaged.appId}@${packaged.version}`);
console.log(`Workspace: ${workspaceId}`);
console.log(`Archive: ${packaged.zipPath}`);

async function resolveStartupWorkspaceId(listener) {
  const body = await requestJson(listener, "GET", "/v1/workspaces/startup");
  return typeof body?.workspace?.id === "string" ? body.workspace.id : null;
}

async function readListenerInfo(options) {
  const candidates = listenerInfoCandidates(options);
  const failures = [];
  for (const candidate of candidates) {
    try {
      const body = JSON.parse(await readFile(candidate, "utf8"));
      const addr = stringValue(body.addr);
      const token = stringValue(body.auth?.token);
      if (addr && token) {
        return { addr, path: candidate, token };
      }
      failures.push(`${candidate}: missing addr or auth.token`);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `Could not read a Tutti listener file.\nTried:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
}

function listenerInfoCandidates(options) {
  const candidates = [];
  if (options.listenerInfo) {
    candidates.push(path.resolve(options.listenerInfo));
  }
  if (process.env.TUTTID_LISTENER_INFO_PATH) {
    candidates.push(path.resolve(process.env.TUTTID_LISTENER_INFO_PATH));
  }
  const stateDir = options.stateDir ?? process.env.TUTTI_STATE_DIR;
  if (stateDir) {
    candidates.push(path.join(path.resolve(stateDir), "run", "tuttid.listener.json"));
  }
  candidates.push(
    path.join(os.homedir(), ".tutti-dev", "run", "tuttid.listener.json"),
    path.join(os.homedir(), ".tutti", "run", "tuttid.listener.json"),
  );
  return [...new Set(candidates)];
}

async function requestJson(listener, method, pathname, body) {
  const response = await fetch(`http://${listener.addr}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${listener.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = parseJson(text);
  if (!response.ok) {
    const message =
      stringValue(parsed?.developerMessage) ??
      stringValue(parsed?.message) ??
      stringValue(parsed?.error) ??
      text;
    throw new Error(`${method} ${pathname} failed with ${response.status}: ${message}`);
  }
  return parsed;
}

function parseJson(text) {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace-id") {
      parsed.workspaceId = requireValue(argv, (index += 1), arg);
    } else if (arg === "--listener-info") {
      parsed.listenerInfo = requireValue(argv, (index += 1), arg);
    } else if (arg === "--state-dir") {
      parsed.stateDir = requireValue(argv, (index += 1), arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
