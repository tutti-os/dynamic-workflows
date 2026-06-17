import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { generateWorkflowScriptWithRepair } from "@/lib/workflow/generator";
import {
  createWorkflowFromScript,
  listWorkflows,
} from "@/lib/db/workflows";
import { WorkflowCwdError } from "@/lib/workflow/cwd";
import { WorkflowScriptSyntaxError } from "@/lib/workflow/parser";

export async function GET() {
  return NextResponse.json({ workflows: listWorkflows() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    prompt?: string;
    provider?: string;
    model?: string;
    cwd?: string;
  };

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json(
      apiError("PROMPT_REQUIRED"),
      { status: 400 },
    );
  }

  try {
    const generated = await generateWorkflowScriptWithRepair({
      description: prompt,
      provider: body.provider,
      model: body.model,
      cwd: body.cwd,
    });
    const detail = createWorkflowFromScript(generated.script);
    return NextResponse.json({ ...detail, generation: generated }, { status: 201 });
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
