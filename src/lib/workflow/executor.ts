import { randomUUID } from "node:crypto";
import { runAgent } from "@/lib/agents/runtime";
import { resolveWorkflowCwd } from "./cwd";
import { assertWorkflowScriptValid } from "./parser";
import { renderPrompt } from "./templates";
import type {
  ParsedWorkflow,
  WorkflowNode,
  WorkflowRunEvent,
  WorkflowRunRequest,
} from "./types";

export async function* runWorkflow(
  request: WorkflowRunRequest,
): AsyncGenerator<WorkflowRunEvent> {
  const runId = request.runId ?? randomUUID();
  const parsed = assertWorkflowScriptValid(request.script);
  const normalizedRequest = {
    ...request,
    cwd: resolveWorkflowCwd(request.cwd),
  };
  const executableNodes = parsed.nodes.filter((node) => node.kind === "agent");
  const outputs: Record<string, string> = {};
  const failed = new Set<string>();
  const completed = new Set<string>();
  const running = new Set<string>();
  let canceled = false;

  yield { type: "run_started", runId, parsed };

  while (completed.size + failed.size < executableNodes.length) {
    if (isSignalAborted(normalizedRequest.signal)) {
      canceled = true;
      break;
    }

    const ready = executableNodes.filter((node) => {
      if (completed.has(node.id) || failed.has(node.id) || running.has(node.id)) {
        return false;
      }
      return node.inputs.every((input) =>
        input.sourceNodeId ? completed.has(input.sourceNodeId) : true,
      );
    });

    if (ready.length === 0) {
      for (const node of executableNodes) {
        if (!completed.has(node.id) && !failed.has(node.id)) {
          failed.add(node.id);
          yield {
            type: "node_failed",
            runId,
            nodeId: node.id,
            error: "Node dependencies could not be resolved.",
          };
        }
      }
      break;
    }

    const batch = ready.slice(0, 4);
    for (const node of batch) {
      running.add(node.id);
    }

    for await (const event of streamNodeBatch({
      runId,
      nodes: batch,
      request: normalizedRequest,
      outputs,
    })) {
      yield event;

      if (event.type === "node_completed") {
        running.delete(event.nodeId);
        completed.add(event.nodeId);
        outputs[event.nodeId] = event.output;
      }

      if (event.type === "node_failed") {
        running.delete(event.nodeId);
        failed.add(event.nodeId);
      }

      if (isSignalAborted(normalizedRequest.signal)) {
        canceled = true;
      }
    }
  }

  const status = canceled
    ? "canceled"
    : failed.size > 0
      ? "failed"
      : "completed";

  yield {
    type: "run_completed",
    runId,
    status,
    outputs,
    ...(status === "canceled" ? { error: "Run canceled." } : {}),
  };
}

async function* streamNodeBatch(input: {
  runId: string;
  nodes: WorkflowNode[];
  request: WorkflowRunRequest;
  outputs: Record<string, string>;
}): AsyncGenerator<WorkflowRunEvent> {
  type QueueItem =
    | {
        event: WorkflowRunEvent;
      }
    | {
        error: unknown;
      };

  const queue: QueueItem[] = [];
  let pending = input.nodes.length;
  let notify: (() => void) | undefined;

  const wake = () => {
    notify?.();
    notify = undefined;
  };
  const wait = () =>
    new Promise<void>((resolve) => {
      notify = resolve;
    });
  const push = (item: QueueItem) => {
    queue.push(item);
    wake();
  };

  for (const node of input.nodes) {
    void (async () => {
      try {
        for await (const event of runNode({
          runId: input.runId,
          node,
          request: input.request,
          outputs: input.outputs,
        })) {
          push({ event });
        }
      } catch (error) {
        push({ error });
      } finally {
        pending -= 1;
        wake();
      }
    })();
  }

  while (pending > 0 || queue.length > 0) {
    if (queue.length === 0) {
      await wait();
      continue;
    }

    const item = queue.shift();
    if (!item) {
      continue;
    }
    if ("error" in item) {
      throw item.error;
    }
    yield item.event;
  }
}

async function* runNode(input: {
  runId: string;
  node: WorkflowNode;
  request: WorkflowRunRequest;
  outputs: Record<string, string>;
}): AsyncGenerator<WorkflowRunEvent> {
  const prompt = renderPrompt(input.node, input.outputs);
  const nodeRunId = `${input.runId}:${input.node.id}`;
  const provider = input.node.provider ?? input.request.provider ?? "mock";
  const model = input.node.model ?? input.request.model;
  const cwd = input.request.cwd ?? process.cwd();
  let output = "";

  yield {
    type: "node_started",
    runId: input.runId,
    nodeId: input.node.id,
    node: input.node,
    provider,
    model,
  };

  try {
    throwIfAborted(input.request.signal);

    for await (const event of runAgent({
      runId: nodeRunId,
      provider,
      cwd,
      prompt,
      model,
      signal: input.request.signal,
    })) {
      throwIfAborted(input.request.signal);

      if (event.type === "text_delta") {
        output += event.text;
      }
      if (event.type === "error") {
        throw new Error(event.message);
      }
      if (event.type === "done" && event.status === "canceled") {
        throw new WorkflowRunCanceledError();
      }
      if (event.type === "done" && event.status === "failed") {
        throw new Error(event.reason ?? "Agent run failed");
      }
      yield {
        type: "node_event",
        runId: input.runId,
        nodeId: input.node.id,
        event,
      };
    }

    throwIfAborted(input.request.signal);

    yield {
      type: "node_completed",
      runId: input.runId,
      nodeId: input.node.id,
      output,
    };
  } catch (error) {
    yield {
      type: "node_failed",
      runId: input.runId,
      nodeId: input.node.id,
      error: toRunErrorMessage(error),
    };
  }
}

class WorkflowRunCanceledError extends Error {
  constructor() {
    super("Run canceled.");
    this.name = "WorkflowRunCanceledError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (isSignalAborted(signal)) {
    throw new WorkflowRunCanceledError();
  }
}

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function isCancellationError(error: unknown): boolean {
  return (
    error instanceof WorkflowRunCanceledError ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.message.toLowerCase().includes("abort") ||
        error.message.toLowerCase().includes("cancel")))
  );
}

function toRunErrorMessage(error: unknown): string {
  if (isCancellationError(error)) {
    return "Run canceled.";
  }
  return error instanceof Error ? error.message : "Unknown agent error";
}

export function summarizeWorkflow(parsed: ParsedWorkflow): string {
  return [
    `${parsed.meta.name}: ${parsed.meta.description}`,
    ...parsed.nodes.map(
      (node) =>
        `- ${node.id} (${node.kind}) in ${node.phase ?? "Workflow"}: ${node.label}`,
    ),
  ].join("\n");
}
