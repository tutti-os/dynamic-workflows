import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  createPendingWorkflowGeneration,
} from "@/lib/db/workflows/generations";
import { listWorkflows } from "@/lib/db/workflows/workflow-repository";
import { ensureWorkflowGenerationStarted } from "@/lib/workflow/generation-jobs";
import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";
import { createFlowV1 } from "@/lib/flow-v1/flow-service";
import type {
  FlowV1BundleSourceFile,
  FlowV1JsonObject,
} from "@/lib/flow-v1/types";
import type { FlowV1SecretBinding } from "@/lib/flow-v1/runtime-config";

export async function GET() {
  return NextResponse.json({ workflows: listWorkflows() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    prompt?: string;
    agent?: string;
    model?: string;
    cwd?: string;
    bundle?: { files?: FlowV1BundleSourceFile[] };
    params?: FlowV1JsonObject;
    publish?: boolean;
    activate?: boolean;
    projectCwd?: string;
    defaultAgent?: string;
    defaultModel?: string;
    defaultPermissionMode?: string;
    secretBindings?: Record<string, FlowV1SecretBinding>;
  };

  if (body.bundle) {
    try {
      const bundle = createFlowV1Bundle(body.bundle.files ?? []);
      const created = createFlowV1({
        bundle,
        params: body.params,
        publish: body.publish,
        activate: body.activate,
        projectCwd: body.projectCwd,
        defaultAgent: body.defaultAgent,
        defaultModel: body.defaultModel,
        defaultPermissionMode: body.defaultPermissionMode,
        secretBindings: body.secretBindings,
      });
      return NextResponse.json(created, { status: 201 });
    } catch (error) {
      return toWorkflowApiErrorResponse(error, "WORKFLOW_SAVE_FAILED");
    }
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json(
      apiError("PROMPT_REQUIRED"),
      { status: 400 },
    );
  }

  try {
    const detail = createPendingWorkflowGeneration({
      prompt,
      agent: body.agent,
      model: body.model,
      cwd: body.cwd,
    });
    ensureWorkflowGenerationStarted(detail.workflow.id);
    return NextResponse.json(detail, { status: 202 });
  } catch (error) {
    return toWorkflowApiErrorResponse(error, "WORKFLOW_GENERATION_FAILED");
  }
}
