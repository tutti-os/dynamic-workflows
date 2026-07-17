import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RunNoteError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    getWorkflowDetail: vi.fn(),
    getWorkflowRun: vi.fn(),
    recordRunNote: vi.fn(),
    RunNoteError,
  };
});

const { RunNoteError } = mocks;

vi.mock("@/lib/db/workflows/workflow-repository", () => ({
  getWorkflowDetail: mocks.getWorkflowDetail,
}));
vi.mock("@/lib/db/workflows/runs", () => ({
  getWorkflowRun: mocks.getWorkflowRun,
}));
vi.mock("@/lib/workflow/run-notes", () => ({
  recordRunNote: mocks.recordRunNote,
  RunNoteError: mocks.RunNoteError,
}));

import { POST } from "./route";

const params = Promise.resolve({ id: "workflow-1", runId: "run-1" });

function noteRequest(body?: unknown): Request {
  return new Request("http://localhost/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("workflow run notes route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkflowDetail.mockReturnValue({ workflow: { id: "workflow-1" } });
    mocks.getWorkflowRun.mockReturnValue({ id: "run-1", workflowId: "workflow-1" });
  });

  it("records a next-step note and returns it with the run", async () => {
    const note = { id: "note-1", target: "next-step", status: "pending" };
    mocks.recordRunNote.mockResolvedValue({ note });

    const response = await POST(noteRequest({ message: "steer left" }), {
      params,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      note,
      run: { id: "run-1", workflowId: "workflow-1" },
    });
    expect(mocks.recordRunNote).toHaveBeenCalledWith({
      runId: "run-1",
      message: "steer left",
      target: "next-step",
      nodeId: undefined,
    });
  });

  it("passes a current target and node id through", async () => {
    mocks.recordRunNote.mockResolvedValue({
      note: { id: "note-1" },
      delivery: { ok: true, agentSessionId: "s1" },
    });

    const response = await POST(
      noteRequest({ message: "steer now", target: "current", nodeId: "n2" }),
      { params },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.delivery).toEqual({ ok: true, agentSessionId: "s1" });
    expect(mocks.recordRunNote).toHaveBeenCalledWith({
      runId: "run-1",
      message: "steer now",
      target: "current",
      nodeId: "n2",
    });
  });

  it("rejects a missing message before recording", async () => {
    const response = await POST(noteRequest({ message: "  " }), { params });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RUN_NOTE_INVALID" },
    });
    expect(mocks.recordRunNote).not.toHaveBeenCalled();
  });

  it("maps a RunNoteError to its status and code", async () => {
    mocks.recordRunNote.mockRejectedValue(
      new RunNoteError(
        "RUN_NOTE_NO_LIVE_SESSION",
        "No live agent session; use next-step.",
        409,
      ),
    );

    const response = await POST(noteRequest({ message: "steer now", target: "current" }), {
      params,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "RUN_NOTE_NO_LIVE_SESSION",
        message: "No live agent session; use next-step.",
      },
    });
  });

  it("returns 404 for an unknown run", async () => {
    mocks.getWorkflowRun.mockReturnValue(null);
    const response = await POST(noteRequest({ message: "steer" }), { params });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RUN_NOT_FOUND" },
    });
  });
});
