import {
  createWorkflowVersion,
  getWorkflowVersion,
} from "@/lib/db/workflows/versions";
import {
  getWorkflowDetail,
} from "@/lib/db/workflows/workflow-repository";
import {
  getWorkflowRun,
} from "@/lib/db/workflows/runs";
import {
  workflowNotFoundError,
  workflowInputsInvalidError,
  workflowRunNotFoundError,
  workflowVersionNotFoundError,
} from "@/lib/api/app-error";
import { resolveWorkflowCwd } from "@/lib/workflow/cwd";
import {
  normalizeWorkflowInputsForSchema,
  readWorkflowInputsObject,
} from "@/lib/workflow/input-schema";
import { assertWorkflowScriptValid } from "@/lib/workflow/parser";
import { compactWorkflowRunInput } from "@/lib/workflow/run-input";
import type { WorkflowRunJobOptions } from "@/lib/workflow/run-jobs";

type PreparedWorkflowRun = WorkflowRunJobOptions;

type WorkflowRunRequestBody = {
  script?: string;
  versionId?: string;
  agent?: string;
  model?: string;
  cwd?: string;
  inputs?: unknown;
};

export async function prepareCurrentWorkflowRun(input: {
  workflowId: string;
  request: Request;
}): Promise<PreparedWorkflowRun> {
  const detail = getWorkflowDetail(input.workflowId);
  if (!detail) {
    throw workflowNotFoundError();
  }
  if (!detail.currentVersion) {
    throw workflowVersionNotFoundError();
  }

  const body = (await input.request.json()) as WorkflowRunRequestBody;
  const requestedVersion = body.versionId
    ? getWorkflowVersion(body.versionId)
    : detail.currentVersion;
  if (
    !requestedVersion ||
    requestedVersion.workflowId !== input.workflowId
  ) {
    throw workflowVersionNotFoundError();
  }

  const script = body.script ?? requestedVersion.script;
  const parsed = assertWorkflowScriptValid(script);
  const inputs = normalizeRunInputs(parsed.inputSchema, body.inputs);
  assertRequiredWorkflowCwd(parsed, body.cwd);
  const cwd = resolveWorkflowCwd(body.cwd);
  const version =
    script === requestedVersion.script
      ? requestedVersion
      : createWorkflowVersion({
          workflowId: input.workflowId,
          script,
          publish: false,
          source: "run_draft",
          baseVersionId: requestedVersion.id,
          note: "Auto-saved for workflow run",
        });

  return {
    workflowId: input.workflowId,
    version,
    executorKind: body.agent === "mock" ? "mock" : "local-agent",
    agent: body.agent,
    model: body.model,
    cwd,
    inputs,
    input: compactWorkflowRunInput({
      inputs,
      cwd,
      autoSavedVersion: script !== requestedVersion.script,
      requestedVersionId: requestedVersion.id,
      agent: body.agent,
      model: body.model,
    }),
  };
}

export function prepareRetryWorkflowRun(input: {
  workflowId: string;
  runId: string;
}): PreparedWorkflowRun {
  const detail = getWorkflowDetail(input.workflowId);
  if (!detail) {
    throw workflowNotFoundError();
  }

  const sourceRun = getWorkflowRun(input.runId);
  if (!sourceRun || sourceRun.workflowId !== input.workflowId) {
    throw workflowRunNotFoundError();
  }

  const version = getWorkflowVersion(sourceRun.workflowVersionId);
  if (!version || version.workflowId !== input.workflowId) {
    throw workflowVersionNotFoundError();
  }

  const cwd = resolveWorkflowCwd(sourceRun.cwd ?? undefined);
  const parsed = assertWorkflowScriptValid(version.script);
  const inputs = normalizeRunInputs(
    parsed.inputSchema,
    readRunInputs(sourceRun.input),
  );
  assertRequiredWorkflowCwd(parsed, sourceRun.cwd ?? undefined);

  return {
    workflowId: input.workflowId,
    version,
    executorKind: sourceRun.executorKind,
    agent: sourceRun.agent ?? undefined,
    model: sourceRun.model ?? undefined,
    cwd,
    inputs,
    input: compactWorkflowRunInput({
      inputs,
      retryOfRunId: sourceRun.id,
      agent: sourceRun.agent ?? undefined,
      model: sourceRun.model ?? undefined,
      cwd,
    }),
  };
}

function readRunInputs(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const maybeInputs = (value as { inputs?: unknown }).inputs;
  return readWorkflowInputsObject(maybeInputs);
}

function normalizeRunInputs(
  schema: Parameters<typeof normalizeWorkflowInputsForSchema>[0],
  inputs: unknown,
) {
  try {
    return normalizeWorkflowInputsForSchema(schema, inputs);
  } catch (error) {
    throw workflowInputsInvalidError(error);
  }
}

function assertRequiredWorkflowCwd(
  parsed: { meta: { requiresCwd?: boolean } },
  cwd: string | undefined,
) {
  if (parsed.meta.requiresCwd && !cwd?.trim()) {
    throw new Error("Workflow cwd is required.");
  }
}
