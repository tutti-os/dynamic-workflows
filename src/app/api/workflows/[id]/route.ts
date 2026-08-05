import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import {
  deleteWorkflow,
  getWorkflowDetail,
  updateWorkflowMetadata,
} from "@/lib/db/workflows/workflow-repository";
import { getFlowV1DetailProjection } from "@/lib/flow-v1/projection";
import {
  getFlowV1VersionReview,
  getLatestFlowV1DraftReview,
} from "@/lib/flow-v1/version-projection";
import {
  configureFlowV1,
  FlowV1ServiceError,
  setFlowV1Lifecycle,
} from "@/lib/flow-v1/flow-service";
import { getFlowV1BundleForVersion } from "@/lib/db/workflows/flow-bundles";
import { parseFlowV1SecretBindings } from "@/lib/flow-v1/secret-bindings";
import type { FlowV1JsonObject } from "@/lib/flow-v1/types";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const detail = getWorkflowDetail(id);
  if (!detail) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }

  const searchParams = new URL(request.url).searchParams;
  const cycleId = searchParams.get("cycleId") ?? undefined;
  const versionId = searchParams.get("versionId") ?? undefined;
  const flowV1 = getFlowV1DetailProjection(id, cycleId);
  if (detail.currentVersion && !flowV1) {
    return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), { status: 404 });
  }
  const versionReview = getFlowV1VersionReview(id, versionId);
  const latestDraftId = detail.versions.find(
    (version) => version.status === "draft",
  )?.id;
  const draftReview = latestDraftId
    ? versionReview?.version.id === latestDraftId
      ? versionReview
      : getLatestFlowV1DraftReview(id)
    : null;
  return NextResponse.json({
    ...detail,
    flowV1,
    draftReview,
    versionReview,
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json()) as {
    name?: string;
    description?: string;
    lifecycle?: "active" | "paused" | "archived";
    params?: FlowV1JsonObject;
    expectedParamsRevision?: number;
    projectCwd?: string | null;
    defaultAgent?: string | null;
    defaultModel?: string | null;
    defaultPermissionMode?: string | null;
    defaultReasoningEffort?: string | null;
    secretBindings?: unknown;
  };
  const parsedSecretBindings =
    body.secretBindings === undefined
      ? undefined
      : parseFlowV1SecretBindings(body.secretBindings);
  if (body.secretBindings !== undefined && !parsedSecretBindings) {
    return NextResponse.json(
      apiError("WORKFLOW_UPDATE_FAILED", {
        message: "Secret bindings must use a supported binding shape.",
      }),
      { status: 400 },
    );
  }
  const secretBindings = parsedSecretBindings ?? undefined;

  if (
    body.params ||
    body.projectCwd !== undefined ||
    body.defaultAgent !== undefined ||
    body.defaultModel !== undefined ||
    body.defaultPermissionMode !== undefined ||
    body.defaultReasoningEffort !== undefined ||
    body.secretBindings !== undefined
  ) {
    try {
      const config = configureFlowV1({
        flowId: id,
        params: body.params,
        expectedParamsRevision: body.expectedParamsRevision,
        projectCwd: body.projectCwd,
        defaultAgent: body.defaultAgent,
        defaultModel: body.defaultModel,
        defaultPermissionMode: body.defaultPermissionMode,
        defaultReasoningEffort: body.defaultReasoningEffort,
        secretBindings,
      });
      return NextResponse.json({
        config,
        flowV1: getFlowV1DetailProjection(id),
      });
    } catch (error) {
      return toWorkflowApiErrorResponse(error, "WORKFLOW_UPDATE_FAILED", {
        status:
          error instanceof FlowV1ServiceError &&
          error.code === "flow_secret_binding_invalid"
            ? 400
            : undefined,
      });
    }
  }

  if (body.lifecycle) {
    const detail = getWorkflowDetail(id);
    if (
      !detail?.currentVersion ||
      !getFlowV1BundleForVersion(detail.currentVersion.id)
    ) {
      return NextResponse.json(apiError("WORKFLOW_NOT_FOUND"), {
        status: 404,
      });
    }
    if (!["active", "paused", "archived"].includes(body.lifecycle)) {
      return NextResponse.json(
        { error: { code: "FLOW_LIFECYCLE_INVALID" } },
        { status: 400 },
      );
    }
    try {
      setFlowV1Lifecycle({ flowId: id, lifecycle: body.lifecycle });
      return NextResponse.json({
        ...getWorkflowDetail(id),
        flowV1: getFlowV1DetailProjection(id),
      });
    } catch (error) {
      return toWorkflowApiErrorResponse(error, "WORKFLOW_UPDATE_FAILED");
    }
  }

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
