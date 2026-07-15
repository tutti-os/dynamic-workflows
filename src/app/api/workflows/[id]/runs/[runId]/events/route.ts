import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import {
  getWorkflowRun,
  isWorkflowRunExecutionClaimed,
} from "@/lib/db/workflows/runs";
import {
  readRunLogChunk,
  type RunLogEntry,
} from "@/lib/workflow/run-log";
import {
  isWorkflowRunJobActive,
  markWorkflowRunInterruptedIfStale,
  subscribeWorkflowRunJob,
} from "@/lib/workflow/run-jobs";
import { parseRunLogEntries } from "@/lib/workflow/run-state";
import type { WorkflowRunEvent } from "@/lib/workflow/types";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const existingRun = getWorkflowRun(runId);
  if (!existingRun || existingRun.workflowId !== id) {
    return NextResponse.json(apiError("RUN_NOT_FOUND"), { status: 404 });
  }
  const run = await markWorkflowRunInterruptedIfStale(existingRun);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let replaying = true;
      let logOffset = 0;
      let lastReplayedEvent: WorkflowRunEvent | undefined;
      const replayedEntryIds = new Set<string>();
      const bufferedLiveEntries: Array<RunLogEntry<WorkflowRunEvent>> = [];

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        if (pollTimer) {
          clearInterval(pollTimer);
        }
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // The browser may have disconnected before the stream closed.
        }
      };

      const enqueue = (event: WorkflowRunEvent) => {
        if (closed) {
          return;
        }
        const payload = JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        if (
          !replaying &&
          (event.type === "run_completed" || event.type === "run_waiting")
        ) {
          close();
        }
      };

      unsubscribe = subscribeWorkflowRunJob(runId, (event, entryId) => {
        if (replaying) {
          bufferedLiveEntries.push({ id: entryId, event });
          return;
        }
        enqueue(event);
      });

      const initialChunk = await readRunLogChunk(run.logPath, logOffset);
      logOffset = initialChunk.nextOffset;
      for (const entry of parseRunLogEntries(initialChunk.text)) {
        replayedEntryIds.add(entry.id);
        lastReplayedEvent = entry.event;
        enqueue(entry.event);
      }
      replaying = false;
      for (const entry of bufferedLiveEntries) {
        if (!replayedEntryIds.has(entry.id)) {
          enqueue(entry.event);
        }
      }
      bufferedLiveEntries.length = 0;
      replayedEntryIds.clear();
      if (
        !closed &&
        (lastReplayedEvent?.type === "run_completed" ||
          lastReplayedEvent?.type === "run_waiting")
      ) {
        close();
      }

      const currentRun = getWorkflowRun(runId);
      if (currentRun?.status !== "running") {
        close();
      } else if (
        !isWorkflowRunJobActive(runId) &&
        isWorkflowRunExecutionClaimed(runId)
      ) {
        let polling = false;
        pollTimer = setInterval(() => {
          if (polling || closed) {
            return;
          }
          polling = true;
          void (async () => {
            try {
              const nextChunk = await readRunLogChunk(run.logPath, logOffset);
              logOffset = nextChunk.nextOffset;
              for (const entry of parseRunLogEntries(nextChunk.text)) {
                enqueue(entry.event);
              }
              if (getWorkflowRun(runId)?.status !== "running") {
                close();
              }
            } catch {
              close();
            } finally {
              polling = false;
            }
          })();
        }, 500);
      } else if (!isWorkflowRunJobActive(runId)) {
        close();
      }
    },
    cancel() {
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
