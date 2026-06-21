import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import { createWorkflowFromScript } from "@/lib/db/workflows";

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
    return toWorkflowApiErrorResponse(error, "WORKFLOW_IMPORT_FAILED");
  }
}
