import { prepareRetryWorkflowRun } from "@/lib/workflow/run-request";
import {
  retryFailedMapItems,
  startWorkflowRunJob,
} from "@/lib/workflow/run-jobs";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";

type RetryRequestBody = {
  mapNodeId?: unknown;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  try {
    const body = (await request
      .json()
      .catch(() => ({}))) as RetryRequestBody;
    if (typeof body?.mapNodeId === "string" && body.mapNodeId.trim()) {
      const run = await retryFailedMapItems({
        workflowId: id,
        runId,
        mapNodeId: body.mapNodeId,
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
