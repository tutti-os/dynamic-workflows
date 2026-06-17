import {
  getWorkflowDetail,
  getWorkflowRun,
  getWorkflowVersion,
} from "@/lib/db/workflows";
import { resolveWorkflowCwd } from "@/lib/workflow/cwd";
import {
  createWorkflowRunErrorStream,
  createWorkflowRunStreamResponse,
} from "@/lib/workflow/run-response";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  const detail = getWorkflowDetail(id);
  if (!detail) {
    return createWorkflowRunErrorStream(new Error("Workflow not found"));
  }

  const sourceRun = getWorkflowRun(runId);
  if (!sourceRun || sourceRun.workflowId !== id) {
    return createWorkflowRunErrorStream(new Error("Run not found"));
  }

  const version = getWorkflowVersion(sourceRun.workflowVersionId);
  if (!version || version.workflowId !== id) {
    return createWorkflowRunErrorStream(new Error("Workflow version not found"));
  }

  try {
    const cwd = resolveWorkflowCwd(sourceRun.cwd ?? undefined);
    return createWorkflowRunStreamResponse({
      request,
      workflowId: id,
      version,
      executorKind: sourceRun.executorKind,
      provider: sourceRun.provider ?? undefined,
      model: sourceRun.model ?? undefined,
      cwd,
      input: {
        retryOfRunId: sourceRun.id,
        provider: sourceRun.provider,
        model: sourceRun.model,
        cwd,
      },
    });
  } catch (error) {
    return createWorkflowRunErrorStream(error);
  }
}
