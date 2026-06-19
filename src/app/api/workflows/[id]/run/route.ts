import { prepareCurrentWorkflowRun } from "@/lib/workflow/run-request";
import {
  createWorkflowRunErrorStream,
  createWorkflowRunStreamResponse,
} from "@/lib/workflow/run-response";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const run = await prepareCurrentWorkflowRun({ workflowId: id, request });
    return createWorkflowRunStreamResponse({ request, ...run });
  } catch (error) {
    return createWorkflowRunErrorStream(error);
  }
}
