import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunEvent } from "@/lib/workflow/types";

const mocks = vi.hoisted(() => ({
  getWorkflowDetail: vi.fn(),
  getWorkflowRun: vi.fn(),
  isWorkflowRunExecutionClaimed: vi.fn(),
  isWorkflowRunJobActive: vi.fn(),
  markWorkflowRunInterruptedIfStale: vi.fn(),
  readRunLogChunk: vi.fn(),
  subscribeWorkflowRunJob: vi.fn(),
}));

vi.mock("@/lib/db/workflows/workflow-repository", () => ({
  getWorkflowDetail: mocks.getWorkflowDetail,
}));
vi.mock("@/lib/db/workflows/runs", () => ({
  getWorkflowRun: mocks.getWorkflowRun,
  isWorkflowRunExecutionClaimed: mocks.isWorkflowRunExecutionClaimed,
}));
vi.mock("@/lib/workflow/run-log", async () => {
  const actual = await vi.importActual("@/lib/workflow/run-log");
  return { ...actual, readRunLogChunk: mocks.readRunLogChunk };
});
vi.mock("@/lib/workflow/run-jobs", () => ({
  isWorkflowRunJobActive: mocks.isWorkflowRunJobActive,
  markWorkflowRunInterruptedIfStale: mocks.markWorkflowRunInterruptedIfStale,
  subscribeWorkflowRunJob: mocks.subscribeWorkflowRunJob,
}));

import { GET } from "./route";

describe("workflow run events route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays historical events before buffered live events without collapsing duplicates", async () => {
    const run = {
      id: "run-1",
      workflowId: "workflow-1",
      status: "running",
      logPath: "/tmp/run-1.jsonl",
    };
    const first: WorkflowRunEvent = {
      type: "node_completed",
      runId: run.id,
      nodeId: "first",
      output: "same",
    };
    const terminal: WorkflowRunEvent = {
      type: "run_completed",
      runId: run.id,
      status: "completed",
      outputs: { first: "same" },
    };
    let publishLive: ((event: WorkflowRunEvent, entryId: string) => void) | undefined;
    let resolveReplay: ((value: { text: string; nextOffset: number }) => void) | undefined;
    const replay = new Promise<{ text: string; nextOffset: number }>((resolve) => {
      resolveReplay = resolve;
    });

    mocks.getWorkflowDetail.mockReturnValue({ workflow: { id: "workflow-1" } });
    mocks.getWorkflowRun.mockReturnValue(run);
    mocks.markWorkflowRunInterruptedIfStale.mockResolvedValue(run);
    mocks.isWorkflowRunJobActive.mockReturnValue(true);
    mocks.isWorkflowRunExecutionClaimed.mockReturnValue(true);
    mocks.subscribeWorkflowRunJob.mockImplementation(
      (_runId: string, subscriber: typeof publishLive) => {
        publishLive = subscriber;
        return () => {};
      },
    );
    mocks.readRunLogChunk.mockReturnValue(replay);

    const response = await GET(new Request("http://localhost/events"), {
      params: Promise.resolve({
        id: "workflow-1",
        runId: run.id,
      }),
    });
    await vi.waitFor(() => expect(publishLive).toBeTypeOf("function"));

    publishLive?.(terminal, "entry-2");
    resolveReplay?.({
      text: [
        JSON.stringify({ id: "entry-1", event: first }),
        JSON.stringify({ id: "entry-2", event: terminal }),
      ].join("\n") + "\n",
      nextOffset: 100,
    });

    const events = (await response.text())
      .trim()
      .split("\n\n")
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
    expect(events).toEqual([first, terminal]);
  });
});
