import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  createWorkflowFromScript,
} from "@/lib/db/workflows/workflow-repository";
import { getWorkflowBlueprint } from "@/lib/workflow/blueprint-catalog";

export async function POST(
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

  try {
    const detail = createWorkflowFromScript(blueprint.script, {
      source: "blueprint",
      note: blueprint.id,
    });
    return NextResponse.json(detail, { status: 201 });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_IMPORT_FAILED");
  }
}

