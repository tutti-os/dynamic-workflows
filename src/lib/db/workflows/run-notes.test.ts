import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCRIPT = `
export const meta = { name: "notes", description: "Notes workflow" }
const first = await agent({ id: "first", prompt: "first" })
`;

let dataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
});

async function createRun() {
  const { createWorkflowFromScript } = await import(
    "@/lib/db/workflows/workflow-repository"
  );
  const { createWorkflowRun } = await import("@/lib/db/workflows/runs");
  const detail = createWorkflowFromScript(SCRIPT);
  const version = detail.currentVersion;
  if (!version) {
    throw new Error("version missing");
  }
  return createWorkflowRun({
    workflowId: detail.workflow.id,
    workflowVersionId: version.id,
    executorKind: "mock",
    cwd: process.cwd(),
    request: { inputs: {} },
  });
}

describe("workflow run notes", () => {
  it("records and lists a pending note", async () => {
    const run = await createRun();
    const { createWorkflowRunNote, listWorkflowRunNotes } = await import(
      "./run-notes"
    );

    const note = createWorkflowRunNote({
      runId: run.id,
      message: "steer left",
      target: "next-step",
    });
    expect(note.status).toBe("pending");
    expect(note.message).toBe("steer left");

    const listed = listWorkflowRunNotes(run.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(note.id);
  });

  it("consumes a matching note once, marking it consumed with the execution key", async () => {
    const run = await createRun();
    const { createWorkflowRunNote, consumeMatchingRunNotes, getWorkflowRunNote } =
      await import("./run-notes");

    const note = createWorkflowRunNote({
      runId: run.id,
      message: "guidance",
      target: "next-step",
    });

    const firstClaim = consumeMatchingRunNotes({
      runId: run.id,
      nodeId: "nodeA",
      executionKey: "nodeA",
    });
    expect(firstClaim.map((claimed) => claimed.id)).toEqual([note.id]);
    expect(firstClaim[0].status).toBe("consumed");
    expect(firstClaim[0].consumedExecutionKey).toBe("nodeA");
    expect(getWorkflowRunNote(note.id)?.status).toBe("consumed");

    // A second execution (e.g. a concurrent map item) claims nothing — one
    // note = one delivery, first consumer wins.
    const secondClaim = consumeMatchingRunNotes({
      runId: run.id,
      nodeId: "nodeA",
      executionKey: "nodeB",
    });
    expect(secondClaim).toEqual([]);
  });

  it("skips a node-scoped note for other nodes and claims it for its node", async () => {
    const run = await createRun();
    const { createWorkflowRunNote, consumeMatchingRunNotes } = await import(
      "./run-notes"
    );

    createWorkflowRunNote({
      runId: run.id,
      message: "only target",
      target: "next-step",
      nodeId: "target",
    });

    const otherNode = consumeMatchingRunNotes({
      runId: run.id,
      nodeId: "other",
      executionKey: "other",
    });
    expect(otherNode).toEqual([]);

    const targetNode = consumeMatchingRunNotes({
      runId: run.id,
      nodeId: "target",
      executionKey: "target",
    });
    expect(targetNode.map((note) => note.message)).toEqual(["only target"]);
  });

  it("delivers multiple pending notes together in arrival order", async () => {
    const run = await createRun();
    const { createWorkflowRunNote, consumeMatchingRunNotes } = await import(
      "./run-notes"
    );

    createWorkflowRunNote({ runId: run.id, message: "one", target: "next-step" });
    createWorkflowRunNote({ runId: run.id, message: "two", target: "next-step" });

    const claimed = consumeMatchingRunNotes({
      runId: run.id,
      nodeId: "n",
      executionKey: "n",
    });
    expect(claimed.map((note) => note.message)).toEqual(["one", "two"]);
  });

  it("marks a current note delivered with its delivery result", async () => {
    const run = await createRun();
    const { createWorkflowRunNote, markWorkflowRunNoteDelivered } = await import(
      "./run-notes"
    );

    const note = createWorkflowRunNote({
      runId: run.id,
      message: "steer now",
      target: "current",
    });
    const delivered = markWorkflowRunNoteDelivered({
      noteId: note.id,
      ok: true,
      agentSessionId: "sess-1",
    });
    expect(delivered.status).toBe("delivered");
    expect(delivered.delivery).toEqual({ ok: true, agentSessionId: "sess-1" });
  });

  it("refuses a note on a finished run", async () => {
    const run = await createRun();
    const { updateWorkflowRun } = await import("@/lib/db/workflows/runs");
    const { createWorkflowRunNote, RunNoteConflictError } = await import(
      "./run-notes"
    );
    updateWorkflowRun({ runId: run.id, status: "completed" });

    expect(() =>
      createWorkflowRunNote({
        runId: run.id,
        message: "too late",
        target: "next-step",
      }),
    ).toThrow(RunNoteConflictError);
  });
});
