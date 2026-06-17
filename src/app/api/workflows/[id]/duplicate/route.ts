import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { duplicateWorkflow } from "@/lib/db/workflows";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    versionId?: string;
  };

  try {
    const detail = duplicateWorkflow({
      workflowId: id,
      versionId: body.versionId,
      name: body.name,
    });
    return NextResponse.json(detail, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      apiError(
        error instanceof Error && error.message.includes("not found")
          ? "WORKFLOW_NOT_FOUND"
          : "WORKFLOW_DUPLICATE_FAILED",
        { message: error instanceof Error ? error.message : undefined },
      ),
      { status: 404 },
    );
  }
}
