import {
  createWorkflowVersion,
  getWorkflowDetail,
  getWorkflowRun,
  getWorkflowVersion,
} from "@/lib/db/workflows";
import { resolveWorkflowCwd } from "@/lib/workflow/cwd";
import { assertWorkflowScriptValid } from "@/lib/workflow/parser";
import type { WorkflowRunStreamOptions } from "@/lib/workflow/run-response";

type PreparedWorkflowRun = Omit<WorkflowRunStreamOptions, "request">;

type WorkflowRunRequestBody = {
  script?: string;
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

  const body = (await input.request.json()) as WorkflowRunRequestBody;
  const script = body.script ?? detail.currentVersion.script;
  const parsed = assertWorkflowScriptValid(script);
  const inputs = normalizeWorkflowInputs(body.inputs);
  assertRequiredWorkflowInputs(parsed.externalInputs, inputs);
  const cwd = resolveWorkflowCwd(body.cwd);
  const version =
    script === detail.currentVersion.script
      ? detail.currentVersion
      : createWorkflowVersion({ workflowId: input.workflowId, script });

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
      autoSavedVersion: version.id !== detail.currentVersion.id,
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
