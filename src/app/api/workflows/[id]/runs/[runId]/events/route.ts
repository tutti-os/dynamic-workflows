import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import {
  getWorkflowRun,
} from "@/lib/db/workflows/runs";
import { readRunLog } from "@/lib/workflow/run-log";
import {
  isWorkflowRunJobActive,
  markWorkflowRunInterruptedIfStale,
  subscribeWorkflowRunJob,
} from "@/lib/workflow/run-jobs";
import { parseRunLogEvents } from "@/lib/workflow/run-state";
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

  const stream = new ReadableStream({
    async start(controller) {
      const seenEvents = new Set<string>();
      let closed = false;

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
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
        if (seenEvents.has(payload)) {
          return;
        }
        seenEvents.add(payload);
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        if (event.type === "run_completed") {
          close();
        }
      };

      unsubscribe = subscribeWorkflowRunJob(runId, enqueue);

      const log = await readRunLog(run.logPath);
      for (const event of parseRunLogEvents(log)) {
        enqueue(event);
      }

      const currentRun = getWorkflowRun(runId);
      if (!isWorkflowRunJobActive(runId) || currentRun?.status !== "running") {
        close();
      }
    },
    cancel() {
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
