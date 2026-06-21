import type { ApiErrorCode } from "@/lib/api/errors";
import { getWorkflowApiErrorCode } from "@/lib/api/server-errors";
import {
  createWorkflowRun,
  updateWorkflowRun,
  type WorkflowVersionRecord,
} from "@/lib/db/workflows";
import { WorkflowCwdError } from "@/lib/workflow/cwd";
import { runWorkflow } from "@/lib/workflow/executor";
import { WorkflowScriptSyntaxError } from "@/lib/workflow/parser";
import {
  appendRunLogEvent,
  ensureRunLogDirectory,
} from "@/lib/workflow/run-log";
import {
  applyWorkflowRunEvent,
  createInitialRunSummary,
  toWorkflowRunResult,
} from "@/lib/workflow/run-state";
import type { WorkflowRunEvent } from "@/lib/workflow/types";

export type WorkflowRunStreamOptions = {
  request: Request;
  workflowId: string;
  version: WorkflowVersionRecord;
  provider?: string;
  model?: string;
  cwd: string;
  executorKind: string;
  inputs: Record<string, string>;
  input: unknown;
};

export function createWorkflowRunStreamResponse(
  options: WorkflowRunStreamOptions,
): Response {
  const run = createWorkflowRun({
    workflowId: options.workflowId,
    workflowVersionId: options.version.id,
    executorKind: options.executorKind,
    provider: options.provider,
    model: options.model,
    cwd: options.cwd,
    request: options.input,
  });

  ensureRunLogDirectory(run.logPath);

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  const abortFromRequest = () => abortController.abort();
  options.request.signal.addEventListener("abort", abortFromRequest, { once: true });
  if (options.request.signal.aborted) {
    abortController.abort();
  }

  let summary = createInitialRunSummary(undefined, {
    status: "running",
    queueExecutableNodes: false,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const enqueueEvent = (event: unknown) => {
        if (abortController.signal.aborted) {
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const event of runWorkflow({
          runId: run.id,
          script: options.version.script,
          provider: options.provider,
          model: options.model,
          cwd: options.cwd,
          inputs: options.inputs,
          signal: abortController.signal,
        })) {
          appendRunLogEvent(run.logPath, event);
          summary = applyWorkflowRunEvent(summary, event);

          enqueueEvent(event);
        }
      } catch (error) {
        const finalStatus = abortController.signal.aborted ? "canceled" : "failed";
        const finalError = abortController.signal.aborted
          ? "Run canceled."
          : formatRunError(error);
        const finalErrorCode = abortController.signal.aborted
          ? "WORKFLOW_RUN_FAILED"
          : getRunErrorCode(error);
        const failedEvent: WorkflowRunEvent = {
          type: "run_completed",
          runId: run.id,
          status: finalStatus,
          outputs: summary.outputs,
          error: finalError,
          errorCode: finalErrorCode,
        };
        appendRunLogEvent(run.logPath, failedEvent);
        summary = applyWorkflowRunEvent(summary, failedEvent);
        enqueueEvent(failedEvent);
      } finally {
        updateWorkflowRun({
          runId: run.id,
          status: summary.status,
          result: toWorkflowRunResult(summary),
        });
        options.request.signal.removeEventListener("abort", abortFromRequest);
        try {
          controller.close();
        } catch {
          // The client may have disconnected before the run cleanup finished.
        }
      }
    },
    cancel() {
      abortController.abort();
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

export function createWorkflowRunErrorStream(
  error: unknown,
  code = getRunErrorCode(error),
): Response {
  return jsonStream([
    {
      type: "run_completed",
      runId: "unknown",
      status: "failed",
      outputs: {},
      error: formatRunError(error),
      errorCode: code,
    },
  ]);
}

export function formatRunError(error: unknown): string {
  if (
    error instanceof WorkflowScriptSyntaxError ||
    error instanceof WorkflowCwdError
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : "Workflow run failed";
}

export function getRunErrorCode(error: unknown): ApiErrorCode {
  return getWorkflowApiErrorCode(error, "WORKFLOW_RUN_FAILED");
}

function jsonStream(events: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    },
  );
}
