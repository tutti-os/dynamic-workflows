import {
  createWorkflowVersion,
  getWorkflowDetail,
  getWorkflowRun,
  getWorkflowVersion,
} from "@/lib/db/workflows";
import { resolveWorkflowCwd } from "@/lib/workflow/cwd";
import { assertWorkflowScriptValid } from "@/lib/workflow/parser";
import type { WorkflowRunJobOptions } from "@/lib/workflow/run-jobs";

type PreparedWorkflowRun = WorkflowRunJobOptions;

type WorkflowRunRequestBody = {
  script?: string;
  versionId?: string;
  provider?: string;
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
    throw new Error("Workflow not found");
  }
  if (!detail.currentVersion) {
    throw new Error("Workflow version not found");
  }

  const body = (await input.request.json()) as WorkflowRunRequestBody;
  const requestedVersion = body.versionId
    ? getWorkflowVersion(body.versionId)
    : detail.currentVersion;
  if (
    !requestedVersion ||
    requestedVersion.workflowId !== input.workflowId
  ) {
    throw new Error("Workflow version not found");
  }

  const script = body.script ?? requestedVersion.script;
  const parsed = assertWorkflowScriptValid(script);
  const inputs = normalizeWorkflowInputs(body.inputs);
  assertRequiredWorkflowInputs(parsed.externalInputs, inputs);
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
    executorKind: body.provider === "mock" ? "mock" : "local-agent",
    provider: body.provider,
    model: body.model,
    cwd,
    inputs,
    input: {
      inputs,
      provider: body.provider,
      model: body.model,
      cwd,
      autoSavedVersion: script !== requestedVersion.script,
      requestedVersionId: requestedVersion.id,
    },
  };
}

export function prepareRetryWorkflowRun(input: {
  workflowId: string;
  runId: string;
}): PreparedWorkflowRun {
  const detail = getWorkflowDetail(input.workflowId);
  if (!detail) {
    throw new Error("Workflow not found");
  }

  const sourceRun = getWorkflowRun(input.runId);
  if (!sourceRun || sourceRun.workflowId !== input.workflowId) {
    throw new Error("Run not found");
  }

  const version = getWorkflowVersion(sourceRun.workflowVersionId);
  if (!version || version.workflowId !== input.workflowId) {
    throw new Error("Workflow version not found");
  }

  const cwd = resolveWorkflowCwd(sourceRun.cwd ?? undefined);
  const inputs = readRunInputs(sourceRun.input);
  const parsed = assertWorkflowScriptValid(version.script);
  assertRequiredWorkflowInputs(parsed.externalInputs, inputs);
  assertRequiredWorkflowCwd(parsed, sourceRun.cwd ?? undefined);

  return {
    workflowId: input.workflowId,
    version,
    executorKind: sourceRun.executorKind,
    provider: sourceRun.provider ?? undefined,
    model: sourceRun.model ?? undefined,
    cwd,
    inputs,
    input: {
      inputs,
      retryOfRunId: sourceRun.id,
      provider: sourceRun.provider,
      model: sourceRun.model,
      cwd,
    },
  };
}

function normalizeWorkflowInputs(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return readStringableRecord(value);
}

function readRunInputs(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const maybeInputs = (value as { inputs?: unknown }).inputs;
  if (!maybeInputs || typeof maybeInputs !== "object" || Array.isArray(maybeInputs)) {
    return {};
  }

  return readStringableRecord(maybeInputs);
}

function readStringableRecord(value: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, inputValue]) => {
      if (typeof inputValue === "string") {
        return [[key, inputValue]];
      }
      if (typeof inputValue === "number" || typeof inputValue === "boolean") {
        return [[key, String(inputValue)]];
      }
      return [];
    }),
  );
}

function assertRequiredWorkflowInputs(
  requiredInputs: string[],
  inputs: Record<string, string>,
) {
  const missingInputs = requiredInputs.filter((name) => !inputs[name]?.trim());
  if (missingInputs.length > 0) {
    throw new Error(`Missing workflow input(s): ${missingInputs.join(", ")}`);
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
