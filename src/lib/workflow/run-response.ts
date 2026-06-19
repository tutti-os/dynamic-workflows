import type { ApiErrorCode } from "@/lib/api/errors";
import {
  createWorkflowRun,
  updateWorkflowRun,
  type WorkflowRunStatus,
  type WorkflowVersionRecord,
} from "@/lib/db/workflows";
import { WorkflowCwdError } from "@/lib/workflow/cwd";
import { runWorkflow } from "@/lib/workflow/executor";
import { WorkflowScriptSyntaxError } from "@/lib/workflow/parser";
import {
  appendRunLogEvent,
  ensureRunLogDirectory,
} from "@/lib/workflow/run-log";
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

  const nodeStatuses: Record<string, string> = {};
  let outputs: Record<string, string> = {};
  let finalStatus: WorkflowRunStatus = "completed";
  let finalError: string | undefined;
  let finalErrorCode: ApiErrorCode | undefined;

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
          captureRunSummary(event, nodeStatuses, (nextOutputs) => {
            outputs = nextOutputs;
          });

          if (event.type === "node_failed") {
            finalStatus = abortController.signal.aborted ? "canceled" : "failed";
            finalError = event.error;
            finalErrorCode = "WORKFLOW_RUN_FAILED";
          }
          if (event.type === "run_completed") {
            finalStatus = event.status;
            outputs = event.outputs;
            finalError = event.error ?? finalError;
            finalErrorCode = event.errorCode ?? finalErrorCode;
          }

          enqueueEvent(event);
        }
      } catch (error) {
        finalStatus = abortController.signal.aborted ? "canceled" : "failed";
        finalError = abortController.signal.aborted
          ? "Run canceled."
          : formatRunError(error);
        finalErrorCode = abortController.signal.aborted
          ? "WORKFLOW_RUN_FAILED"
          : getRunErrorCode(error);
        const eventStatus = finalStatus === "canceled" ? "canceled" : "failed";
        const failedEvent: WorkflowRunEvent = {
          type: "run_completed",
          runId: run.id,
          status: eventStatus,
          outputs,
          error: finalError,
          errorCode: finalErrorCode,
        };
        appendRunLogEvent(run.logPath, failedEvent);
        enqueueEvent(failedEvent);
      } finally {
        updateWorkflowRun({
          runId: run.id,
          status: finalStatus,
          result: {
            outputs,
            nodeStatuses,
            error: finalError,
            errorCode: finalErrorCode,
          },
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

function getRunErrorCode(error: unknown): ApiErrorCode {
  if (error instanceof WorkflowScriptSyntaxError) {
    return "WORKFLOW_SCRIPT_INVALID";
  }
  if (error instanceof WorkflowCwdError) {
    return "WORKFLOW_CWD_INVALID";
  }
  if (error instanceof Error) {
    if (error.message === "Workflow not found") {
      return "WORKFLOW_NOT_FOUND";
    }
    if (error.message === "Run not found") {
      return "RUN_NOT_FOUND";
    }
    if (error.message === "Workflow version not found") {
      return "WORKFLOW_VERSION_NOT_FOUND";
    }
  }
  return "WORKFLOW_RUN_FAILED";
}

function captureRunSummary(
  event: WorkflowRunEvent,
  nodeStatuses: Record<string, string>,
  setOutputs: (outputs: Record<string, string>) => void,
) {
  if (event.type === "node_started") {
    nodeStatuses[event.nodeId] = "running";
  }
  if (event.type === "node_completed") {
    nodeStatuses[event.nodeId] = "completed";
  }
  if (event.type === "node_failed") {
    nodeStatuses[event.nodeId] = "failed";
  }
  if (event.type === "run_completed") {
    setOutputs(event.outputs);
  }
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
