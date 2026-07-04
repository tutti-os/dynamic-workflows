import { NextResponse } from "next/server";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import { generateWorkflowScriptWithRepair } from "@/lib/workflow/generator";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    description?: string;
    agent?: string;
    model?: string;
    cwd?: string;
  };

  try {
    const generated = await generateWorkflowScriptWithRepair({
      description: body.description ?? "",
      agent: body.agent,
      model: body.model,
      cwd: body.cwd,
    });
    return NextResponse.json(generated);
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_GENERATION_FAILED");
  }
}
