import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { WorkflowCwdError } from "@/lib/workflow/cwd";
import { generateWorkflowScriptWithRepair } from "@/lib/workflow/generator";
import { WorkflowScriptSyntaxError } from "@/lib/workflow/parser";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    description?: string;
    provider?: string;
    model?: string;
    cwd?: string;
  };

  try {
    const generated = await generateWorkflowScriptWithRepair({
      description: body.description ?? "",
      provider: body.provider,
      model: body.model,
      cwd: body.cwd,
    });
    return NextResponse.json(generated);
  } catch (error) {
    const code =
      error instanceof WorkflowScriptSyntaxError
        ? "WORKFLOW_SCRIPT_INVALID"
        : error instanceof WorkflowCwdError
          ? "WORKFLOW_CWD_INVALID"
          : "WORKFLOW_GENERATION_FAILED";
    return NextResponse.json(
      apiError(code, {
        message: error instanceof Error ? error.message : undefined,
        diagnostics:
          error instanceof WorkflowScriptSyntaxError
            ? error.diagnostics
            : undefined,
      }),
      { status: error instanceof WorkflowCwdError ? 400 : 500 },
    );
  }
}
