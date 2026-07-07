import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowBlueprint } from "@/lib/workflow/blueprint-catalog";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const blueprint = getWorkflowBlueprint(id);
  if (!blueprint) {
    return NextResponse.json(
      apiError("WORKFLOW_BLUEPRINT_NOT_FOUND"),
      { status: 404 },
    );
  }

  return NextResponse.json({ blueprint });
}

