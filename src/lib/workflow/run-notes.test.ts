import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunEvent } from "./types";

const mocks = vi.hoisted(() => ({
  sendAgentMessage: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock("@/lib/agents/runtime", () => ({
  sendAgentMessage: mocks.sendAgentMessage,
  runAgent: mocks.runAgent,
}));

const SCRIPT = `
export const meta = { name: "notes", description: "Notes workflow" }
const first = await agent({ id: "first", prompt: "first" })
`;

let dataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "dynamic-workflows-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
  mocks.sendAgentMessage.mockReset();
});

afterEach(() => {
  vi.resetModules();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
});

async function createRunningRunWithLiveSession() {
  const { createWorkflowFromScript } = await import(
    "@/lib/db/workflows/workflow-repository"
  );
  const { createWorkflowRun } = await import("@/lib/db/workflows/runs");
  const { ensureRunLogDirectory, appendRunLogEvent } = await import(
    "@/lib/workflow/run-log"
  );
  const detail = createWorkflowFromScript(SCRIPT);
  const version = detail.currentVersion;
  if (!version) {
    throw new Error("version missing");
  }
  const run = createWorkflowRun({
    workflowId: detail.workflow.id,
    workflowVersionId: version.id,
    executorKind: "local-agent",
    cwd: process.cwd(),
    request: { inputs: {} },
  });
  ensureRunLogDirectory(run.logPath);
  const events: WorkflowRunEvent[] = [
    { type: "node_started", runId: run.id, nodeId: "first", node: {} as never, agent: "mock", input: "first" },
    {
      type: "node_event",
      runId: run.id,
      nodeId: "first",
      event: {
        type: "session_ref",
        session: {
          agentSessionId: "sess-live",
          agent: "mock",
          status: "running",
        },
      },
    },
  ];
  for (const event of events) {
    appendRunLogEvent(run.logPath, event);
  }
  return run;
}

describe("recordRunNote current delivery", () => {
  it("records the note then delivers it to the live agent session", async () => {
    const run = await createRunningRunWithLiveSession();
    mocks.sendAgentMessage.mockResolvedValue(undefined);

    const { recordRunNote } = await import("./run-notes");
    const { listWorkflowRunNotes } = await import(
      "@/lib/db/workflows/run-notes"
    );

    const result = await recordRunNote({
      runId: run.id,
      message: "stop and rerun the tests",
      target: "current",
      nodeId: "first",
    });

    // Steering a running node must use guidance mode: the node execution is an
    // active turn, so a plain send would be rejected.
    expect(mocks.sendAgentMessage).toHaveBeenCalledWith({
      agentSessionId: "sess-live",
      message: "stop and rerun the tests",
      guidance: true,
    });
    expect(result.note.status).toBe("delivered");
    expect(result.delivery).toEqual({ ok: true, agentSessionId: "sess-live" });

    // Provenance: the note is persisted regardless of the delivery channel.
    const persisted = listWorkflowRunNotes(run.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe("delivered");
  });

  it("rejects current delivery to a node with no live session", async () => {
    const run = await createRunningRunWithLiveSession();

    const { recordRunNote, RunNoteError } = await import("./run-notes");

    await expect(
      recordRunNote({
        runId: run.id,
        message: "steer",
        target: "current",
        nodeId: "other",
      }),
    ).rejects.toBeInstanceOf(RunNoteError);
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  });
});
