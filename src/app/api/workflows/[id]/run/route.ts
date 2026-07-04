import { prepareCurrentWorkflowRun } from "@/lib/workflow/run-request";
import { startWorkflowRunJob } from "@/lib/workflow/run-jobs";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const options = await prepareCurrentWorkflowRun({ workflowId: id, request });
    const run = startWorkflowRunJob(options);
    return Response.json({ run });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_RUN_FAILED");
  }
}
