import { prepareRetryWorkflowRun } from "@/lib/workflow/run-request";
import {
  retryFailedMapItems,
  retryWorkflowRunFromNode,
  startWorkflowRunJob,
} from "@/lib/workflow/run-jobs";
import { workflowRetryRequestInvalidError } from "@/lib/api/app-error";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";

type RetryRequestBody = {
  mapNodeId?: unknown;
  fromNodeId?: unknown;
};

function readNodeId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  try {
    const body = (await request
      .json()
      .catch(() => ({}))) as RetryRequestBody;
    const mapNodeId = readNodeId(body?.mapNodeId);
    const fromNodeId = readNodeId(body?.fromNodeId);

    if (mapNodeId && fromNodeId) {
      throw workflowRetryRequestInvalidError(
        "Provide either mapNodeId or fromNodeId, not both.",
      );
    }

    if (mapNodeId) {
      const run = await retryFailedMapItems({
        workflowId: id,
        runId,
        mapNodeId,
      });
      return Response.json({ run });
    }

    if (fromNodeId) {
      const run = await retryWorkflowRunFromNode({
        workflowId: id,
        runId,
        fromNodeId,
      });
      return Response.json({ run });
    }

    const options = prepareRetryWorkflowRun({ workflowId: id, runId });
    const run = startWorkflowRunJob(options);
    return Response.json({ run });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_RUN_FAILED");
  }
}
