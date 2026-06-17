import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { createWorkflowFromScript } from "@/lib/db/workflows";
import { WorkflowScriptSyntaxError } from "@/lib/workflow/parser";

export async function POST(request: Request) {
  const body = (await request.json()) as { script?: string };
  if (!body.script?.trim()) {
    return NextResponse.json(
      apiError("SCRIPT_REQUIRED"),
      { status: 400 },
    );
  }

  try {
    const detail = createWorkflowFromScript(body.script);
    return NextResponse.json(detail, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      apiError(
        error instanceof WorkflowScriptSyntaxError
          ? "WORKFLOW_SCRIPT_INVALID"
          : "WORKFLOW_IMPORT_FAILED",
        {
          message: error instanceof Error ? error.message : undefined,
          diagnostics:
            error instanceof WorkflowScriptSyntaxError
              ? error.diagnostics
              : undefined,
        },
      ),
      { status: error instanceof WorkflowScriptSyntaxError ? 400 : 500 },
    );
  }
}
