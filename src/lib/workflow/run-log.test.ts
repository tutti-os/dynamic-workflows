import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendRunLogEvent,
  readRunLog,
  readRunLogChunk,
} from "./run-log";
import { parseRunLogEntries, parseRunLogEvents } from "./run-state";
import type { WorkflowRunEvent } from "./types";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("workflow run log", () => {
  it("preserves repeated identical events with stable entry ids", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "workflow-run-log-"));
    const logPath = path.join(tempDir, "run.jsonl");
    const event: WorkflowRunEvent = {
      type: "node_event",
      runId: "run-1",
      nodeId: "node-1",
      event: { type: "text_delta", text: "same" },
    };

    const first = appendRunLogEvent(logPath, event);
    const second = appendRunLogEvent(logPath, event);
    const entries = parseRunLogEntries(await readRunLog(logPath));

    expect(first.id).not.toBe(second.id);
    expect(entries.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(entries.map((entry) => entry.event)).toEqual([event, event]);
  });

  it("reads only complete lines after the previous byte offset", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "workflow-run-log-"));
    const logPath = path.join(tempDir, "run.jsonl");
    const first: WorkflowRunEvent = {
      type: "run_completed",
      runId: "run-1",
      status: "completed",
      outputs: {},
    };
    appendRunLogEvent(logPath, first);

    const initial = await readRunLogChunk(logPath, 0);
    expect(parseRunLogEvents(initial.text)).toEqual([first]);

    writeFileSync(logPath, '{"id":"partial"', { flag: "a" });
    const partial = await readRunLogChunk(logPath, initial.nextOffset);
    expect(partial).toEqual({ text: "", nextOffset: initial.nextOffset });
  });

  it("continues to parse legacy unwrapped JSONL events", () => {
    const event: WorkflowRunEvent = {
      type: "run_completed",
      runId: "legacy-run",
      status: "completed",
      outputs: {},
    };

    expect(parseRunLogEvents(JSON.stringify(event))).toEqual([event]);
  });
});
