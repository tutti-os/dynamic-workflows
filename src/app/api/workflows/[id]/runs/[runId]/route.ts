import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowDetail, getWorkflowRun } from "@/lib/db/workflows";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  if (!getWorkflowDetail(id)) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const run = getWorkflowRun(runId);
  if (!run || run.workflowId !== id) {
    return NextResponse.json(apiError("RUN_NOT_FOUND"), { status: 404 });
  }

  let log = "";
  if (run.logPath) {
    try {
      log = await fs.readFile(run.logPath, "utf8");
    } catch {
      log = "";
    }
  }

  return NextResponse.json({ run, log });
}
