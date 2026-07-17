import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  deleteWorkflow,
  getWorkflowDetail,
  updateWorkflowMetadata,
} from "@/lib/db/workflows/workflow-repository";
import { reconcileStaleRunningRuns } from "@/lib/workflow/run-jobs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const detail = getWorkflowDetail(id);
  if (!detail) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  // Reconcile zombie "running" runs (crash/old-bug leftovers) that never get
  // reopened individually, so the runs list stops showing them as running.
  const runs = await reconcileStaleRunningRuns(detail.runs);
  return NextResponse.json({ ...detail, runs });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json()) as {
    name?: string;
    description?: string;
  };

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json(
      apiError("WORKFLOW_NAME_REQUIRED"),
      { status: 400 },
    );
  }

  if (name.length > 120) {
    return NextResponse.json(
      apiError("WORKFLOW_NAME_TOO_LONG"),
      { status: 400 },
    );
  }

  const description = body.description?.trim() ?? "";
  if (description.length > 500) {
    return NextResponse.json(
      apiError("WORKFLOW_DESCRIPTION_TOO_LONG"),
      { status: 400 },
    );
  }

  try {
    const detail = updateWorkflowMetadata({
      workflowId: id,
      name,
      description,
    });
    return NextResponse.json(detail);
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_UPDATE_FAILED");
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const deleted = deleteWorkflow(id);
  if (!deleted) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
