import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir, getDb } from "@/lib/db/client";
import type {
  FlowV1MemoryDefinition,
  FlowV1MemoryUpdate,
} from "./types";

const MARKER_PATTERN =
  /<!--\s*flow-memory:section:([^:\s]+):(start|end)\s*-->/gu;

export type FlowV1MemoryDocument = {
  path: string;
  markdown: string;
  hash: string;
  sections: Record<string, string>;
};

export type FlowV1MemoryApplyResult =
  | {
      status: "completed";
      baseHash: string;
      resultHash: string;
      sections: Record<string, string>;
    }
  | {
      status: "conflict";
      baseHash: string;
      currentHash: string;
      candidateMarkdown: string;
    };

export class FlowV1MemoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowV1MemoryError";
    this.code = code;
  }
}

export function getFlowV1MemoryPath(flowId: string): string {
  return path.join(getDataDir(), "flows", flowId, "MEMORY.md");
}

export function initializeFlowV1Memory(input: {
  flowId: string;
  template: string;
  definition: FlowV1MemoryDefinition;
}): FlowV1MemoryDocument {
  parseMemoryDocument(input.template, input.definition);
  const filePath = getFlowV1MemoryPath(input.flowId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, input.template, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      )
    ) {
      throw error;
    }
  }
  return readFlowV1Memory(input.flowId, input.definition);
}

export function readFlowV1Memory(
  flowId: string,
  definition: FlowV1MemoryDefinition,
): FlowV1MemoryDocument {
  const filePath = getFlowV1MemoryPath(flowId);
  let markdown: string;
  try {
    markdown = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new FlowV1MemoryError(
      "flow_memory_missing",
      `Canonical Memory is missing for Flow ${flowId}.`,
    );
  }
  return {
    path: filePath,
    markdown,
    hash: hashMarkdown(markdown),
    sections: parseMemoryDocument(markdown, definition),
  };
}

export function applyFlowV1MemoryUpdates(input: {
  flowId: string;
  cycleId: string;
  runId: string;
  nodeId: string;
  definition: FlowV1MemoryDefinition;
  expectedBaseHash: string;
  updates: FlowV1MemoryUpdate[];
}): FlowV1MemoryApplyResult {
  validateUpdates(input.updates, input.definition);
  const keys = input.updates.map(
    (update) => `${input.cycleId}:${input.nodeId}:${update.sectionId}`,
  );
  const existing = listUpdateRows(input.flowId, keys);
  if (
    existing.length === keys.length &&
    existing.every((row) => row.status === "completed" && row.result_hash)
  ) {
    const document = readFlowV1Memory(input.flowId, input.definition);
    const resultHash = existing[0]!.result_hash!;
    if (document.hash !== resultHash) {
      throw new FlowV1MemoryError(
        "flow_memory_completed_update_diverged",
        "Canonical Memory changed after this Remember node completed.",
      );
    }
    return {
      status: "completed",
      baseHash: existing[0]!.base_hash,
      resultHash,
      sections: document.sections,
    };
  }

  const current = readFlowV1Memory(input.flowId, input.definition);
  const recoveredHash = existing.find((row) => row.result_hash)?.result_hash;
  if (
    recoveredHash &&
    current.hash === recoveredHash &&
    existing.every((row) => row.status === "starting")
  ) {
    markUpdatesCompleted(input.flowId, keys);
    return {
      status: "completed",
      baseHash: existing[0]!.base_hash,
      resultHash: recoveredHash,
      sections: current.sections,
    };
  }

  const candidateMarkdown = updateMemoryMarkdown(
    current.markdown,
    input.definition,
    input.updates,
  );
  if (current.hash !== input.expectedBaseHash) {
    recordConflict(input, keys, current.hash, candidateMarkdown);
    return {
      status: "conflict",
      baseHash: input.expectedBaseHash,
      currentHash: current.hash,
      candidateMarkdown,
    };
  }

  const resultHash = hashMarkdown(candidateMarkdown);
  recordStarting(input, keys, resultHash);
  writeMemoryAtomically(current.path, candidateMarkdown);
  markUpdatesCompleted(input.flowId, keys);
  const sections = parseMemoryDocument(candidateMarkdown, input.definition);
  return {
    status: "completed",
    baseHash: input.expectedBaseHash,
    resultHash,
    sections,
  };
}

export function getLatestFlowV1MemoryHashForCycle(
  cycleId: string,
): string | null {
  const row = getDb()
    .prepare(
      `
      SELECT result_hash
      FROM workflow_memory_updates
      WHERE cycle_id = ? AND status = 'completed' AND result_hash IS NOT NULL
      ORDER BY applied_at DESC, rowid DESC
      LIMIT 1
    `,
    )
    .get(cycleId) as { result_hash: string } | undefined;
  return row?.result_hash ?? null;
}

function parseMemoryDocument(
  markdown: string,
  definition: FlowV1MemoryDefinition,
): Record<string, string> {
  const markers = [...markdown.matchAll(MARKER_PATTERN)].map((match) => ({
    sectionId: match[1]!,
    boundary: match[2] as "start" | "end",
    index: match.index,
    end: match.index + match[0].length,
  }));
  const sections: Record<string, string> = {};
  for (const section of Object.values(definition.sections)) {
    const starts = markers.filter(
      (marker) =>
        marker.sectionId === section.id && marker.boundary === "start",
    );
    const ends = markers.filter(
      (marker) =>
        marker.sectionId === section.id && marker.boundary === "end",
    );
    if (
      starts.length !== 1 ||
      ends.length !== 1 ||
      starts[0]!.end > ends[0]!.index
    ) {
      throw new FlowV1MemoryError(
        "flow_memory_markers_invalid",
        `Memory section ${section.id} has invalid reserved markers.`,
      );
    }
    sections[section.id] = markdown
      .slice(starts[0]!.end, ends[0]!.index)
      .trim();
  }
  const unknown = markers.find(
    (marker) => !definition.sections[marker.sectionId],
  );
  if (unknown) {
    throw new FlowV1MemoryError(
      "flow_memory_marker_unknown",
      `Memory contains an unknown section marker: ${unknown.sectionId}.`,
    );
  }
  return sections;
}

function updateMemoryMarkdown(
  markdown: string,
  definition: FlowV1MemoryDefinition,
  updates: FlowV1MemoryUpdate[],
): string {
  let next = markdown;
  for (const update of updates) {
    const startMarker = `<!-- flow-memory:section:${update.sectionId}:start -->`;
    const endMarker = `<!-- flow-memory:section:${update.sectionId}:end -->`;
    const start = next.indexOf(startMarker);
    const end = next.indexOf(endMarker);
    if (start < 0 || end < start) {
      throw new FlowV1MemoryError(
        "flow_memory_markers_invalid",
        `Memory section ${update.sectionId} markers are missing or reordered.`,
      );
    }
    const contentStart = start + startMarker.length;
    const previous = next.slice(contentStart, end).trim();
    const value =
      update.mode === "append" && previous
        ? `${previous}\n\n${update.markdown.trim()}`
        : update.markdown.trim();
    next = `${next.slice(0, contentStart)}\n${value}\n${next.slice(end)}`;
  }
  parseMemoryDocument(next, definition);
  return next;
}

function validateUpdates(
  updates: FlowV1MemoryUpdate[],
  definition: FlowV1MemoryDefinition,
): void {
  if (updates.length === 0) {
    throw new FlowV1MemoryError(
      "flow_memory_updates_empty",
      "Remember must update at least one Memory section.",
    );
  }
  const seen = new Set<string>();
  for (const update of updates) {
    const section = definition.sections[update.sectionId];
    if (!section || section.update !== update.mode || seen.has(update.sectionId)) {
      throw new FlowV1MemoryError(
        "flow_memory_update_invalid",
        `Invalid ${update.mode} update for Memory section ${update.sectionId}.`,
      );
    }
    if (MARKER_PATTERN.test(update.markdown)) {
      MARKER_PATTERN.lastIndex = 0;
      throw new FlowV1MemoryError(
        "flow_memory_reserved_marker",
        "Memory update content must not contain reserved section markers.",
      );
    }
    MARKER_PATTERN.lastIndex = 0;
    seen.add(update.sectionId);
  }
}

type UpdateRow = {
  id: string;
  idempotency_key: string;
  status: string;
  base_hash: string;
  result_hash: string | null;
};

function listUpdateRows(flowId: string, keys: string[]): UpdateRow[] {
  if (keys.length === 0) {
    return [];
  }
  const placeholders = keys.map(() => "?").join(", ");
  return getDb()
    .prepare(
      `
      SELECT id, idempotency_key, status, base_hash, result_hash
      FROM workflow_memory_updates
      WHERE flow_id = ? AND idempotency_key IN (${placeholders})
    `,
    )
    .all(flowId, ...keys) as UpdateRow[];
}

function recordStarting(
  input: Parameters<typeof applyFlowV1MemoryUpdates>[0],
  keys: string[],
  resultHash: string,
): void {
  const now = new Date().toISOString();
  const database = getDb();
  database.transaction(() => {
    input.updates.forEach((update, index) => {
      database
        .prepare(
          `
          INSERT OR IGNORE INTO workflow_memory_updates (
            id, flow_id, cycle_id, run_id, node_id, section_id, mode,
            idempotency_key, base_hash, result_hash, status, markdown,
            candidate_markdown, created_at, applied_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, NULL, ?,
            NULL)
        `,
        )
        .run(
          randomUUID(),
          input.flowId,
          input.cycleId,
          input.runId,
          input.nodeId,
          update.sectionId,
          update.mode,
          keys[index],
          input.expectedBaseHash,
          resultHash,
          update.markdown,
          now,
        );
    });
  })();
}

function recordConflict(
  input: Parameters<typeof applyFlowV1MemoryUpdates>[0],
  keys: string[],
  currentHash: string,
  candidateMarkdown: string,
): void {
  const now = new Date().toISOString();
  const database = getDb();
  database.transaction(() => {
    input.updates.forEach((update, index) => {
      database
        .prepare(
          `
          INSERT INTO workflow_memory_updates (
            id, flow_id, cycle_id, run_id, node_id, section_id, mode,
            idempotency_key, base_hash, result_hash, status, markdown,
            candidate_markdown, created_at, applied_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'conflict', ?, ?, ?, NULL)
          ON CONFLICT(flow_id, idempotency_key) DO UPDATE SET
            status = 'conflict',
            result_hash = excluded.result_hash,
            candidate_markdown = excluded.candidate_markdown
        `,
        )
        .run(
          randomUUID(),
          input.flowId,
          input.cycleId,
          input.runId,
          input.nodeId,
          update.sectionId,
          update.mode,
          keys[index],
          input.expectedBaseHash,
          currentHash,
          update.markdown,
          candidateMarkdown,
          now,
        );
    });
  })();
}

function markUpdatesCompleted(flowId: string, keys: string[]): void {
  const placeholders = keys.map(() => "?").join(", ");
  getDb()
    .prepare(
      `
      UPDATE workflow_memory_updates
      SET status = 'completed', applied_at = ?
      WHERE flow_id = ? AND idempotency_key IN (${placeholders})
        AND status = 'starting'
    `,
    )
    .run(new Date().toISOString(), flowId, ...keys);
}

function writeMemoryAtomically(filePath: string, markdown: string): void {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, markdown, "utf8");
  fs.renameSync(temporary, filePath);
}

function hashMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}
