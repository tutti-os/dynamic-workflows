import { resumeWorkflowRunJob } from "@/lib/workflow/run-jobs";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  try {
    const run = await resumeWorkflowRunJob({ workflowId: id, runId });
    return Response.json({ run });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_RUN_FAILED");
  }
}
