import {
  createWorkflowVersion,
  getWorkflowDetail,
} from "@/lib/db/workflows";
import { resolveWorkflowCwd } from "@/lib/workflow/cwd";
import { assertWorkflowScriptValid } from "@/lib/workflow/parser";
import {
  createWorkflowRunErrorStream,
  createWorkflowRunStreamResponse,
} from "@/lib/workflow/run-response";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const detail = getWorkflowDetail(id);
  if (!detail) {
    return createWorkflowRunErrorStream(new Error("Workflow not found"));
  }

  let body: {
    script?: string;
    provider?: string;
    model?: string;
    cwd?: string;
  };
  let script: string;
  let cwd: string;
  let version = detail.currentVersion;

  try {
    body = (await request.json()) as typeof body;
    script = body.script ?? detail.currentVersion.script;
    assertWorkflowScriptValid(script);
    cwd = resolveWorkflowCwd(body.cwd);
    if (script !== detail.currentVersion.script) {
      version = createWorkflowVersion({ workflowId: id, script });
    }
  } catch (error) {
    return createWorkflowRunErrorStream(error);
  }

  return createWorkflowRunStreamResponse({
    request,
    workflowId: id,
    version,
    executorKind: body.provider === "mock" ? "mock" : "local-agent",
    provider: body.provider,
    model: body.model,
    cwd,
    input: {
      provider: body.provider,
      model: body.model,
      cwd,
      autoSavedVersion: version.id !== detail.currentVersion.id,
    },
  });
}
