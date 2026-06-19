import { prepareRetryWorkflowRun } from "@/lib/workflow/run-request";
import {
  createWorkflowRunErrorStream,
  createWorkflowRunStreamResponse,
} from "@/lib/workflow/run-response";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  try {
    const run = prepareRetryWorkflowRun({ workflowId: id, runId });
    return createWorkflowRunStreamResponse({ request, ...run });
  } catch (error) {
    return createWorkflowRunErrorStream(error);
  }
}
