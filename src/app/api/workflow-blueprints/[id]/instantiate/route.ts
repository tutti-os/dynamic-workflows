import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  BlueprintNotFoundError,
  instantiateWorkflowBlueprint,
} from "@/lib/workflow/blueprint-instantiate";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    const detail = instantiateWorkflowBlueprint(id);
    return NextResponse.json(detail, { status: 201 });
  } catch (error) {
    if (error instanceof BlueprintNotFoundError) {
      return NextResponse.json(
        apiError("WORKFLOW_BLUEPRINT_NOT_FOUND"),
        { status: 404 },
      );
    }
    return toWorkflowApiErrorResponse(error, "WORKFLOW_IMPORT_FAILED");
  }
}

