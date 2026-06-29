import { NextResponse } from "next/server";
import { listAgentProviders } from "@/lib/agents/runtime";
import type { AgentProviderOption } from "@/lib/agents/types";
import {
  createWorkflowFromScript,
  createWorkflowRun,
  getWorkflowDetail,
  getWorkflowRun,
  listWorkflows,
  updateWorkflowRun,
  type WorkflowRunRecord,
} from "@/lib/db/workflows";
import { getWorkflowCwdRoot, resolveWorkflowCwd } from "@/lib/workflow/cwd";
import { generateWorkflowScriptWithRepair } from "@/lib/workflow/generator";
import {
  assertWorkflowScriptValid,
  parseWorkflowScript,
  WorkflowScriptSyntaxError,
} from "@/lib/workflow/parser";
import {
  appendRunLogEvent,
  ensureRunLogDirectory,
} from "@/lib/workflow/run-log";
import {
  applyWorkflowRunEvent,
  createInitialRunSummary,
  readRunResult,
  toWorkflowRunResult,
  type WorkflowRunSummary,
} from "@/lib/workflow/run-state";
import type { ParsedWorkflow, WorkflowRunEvent } from "@/lib/workflow/types";
import { runWorkflow, summarizeWorkflow } from "@/lib/workflow/executor";
import { formatRunError, getRunErrorCode } from "@/lib/workflow/run-response";

type CliOutput =
  | {
      kind: "json";
      value: unknown;
    }
  | {
      kind: "table";
      columns: Array<{ key: string; label: string }>;
      rows: Array<Record<string, unknown>>;
    }
  | {
      kind: "text";
      text: string;
    };

type CliErrorResponse = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

type CliInvokeBody = {
  input?: unknown;
  outputMode?: unknown;
};

type CliContext = {
  outputMode?: string;
};

type CliInput = Record<string, unknown>;

const DEFAULT_RUN_TIMEOUT_MS = 600_000;
const MAX_RUN_TIMEOUT_MS = 3_600_000;

export async function handleDynamicWorkflowsCliRequest(
  path: string[],
  body: unknown,
): Promise<NextResponse<CliOutput | CliErrorResponse>> {
  const normalizedPath = path.map((segment) => segment.trim()).filter(Boolean);
  const context = readCliContext(body);
  const input = readCliInput(body);

  try {
    switch (normalizedPath.join("/")) {
      case "status":
        return cliJson(await statusCommand());
      case "providers":
        return cliJson({ providers: await listAgentProviders() });
      case "list":
        return listCommand(input, context);
      case "show":
        return cliJson(showCommand(input));
      case "validate":
        return cliJson(validateCommand(input));
      case "create":
        return cliJson(await createCommand(input));
      case "run":
        return cliJson(await runCommand(input));
      default:
        throw new CliHttpError(
          "unknown_command",
          `Unknown Dynamic Workflows CLI command: ${normalizedPath.join(" ")}`,
          404,
        );
    }
  } catch (error) {
    return cliErrorResponse(error);
  }
}

async function statusCommand() {
  const workflows = listWorkflows();
  const providers = await readProvidersForStatus();
  const latestRuns = workflows.flatMap((item) =>
    item.latestRun ? [item.latestRun] : [],
  );

  return {
    ok: true,
    app: {
      scope: "dynamic-workflows",
      cwdRoot: getWorkflowCwdRoot(),
    },
    workflows: {
      count: workflows.length,
      latestRunningCount: latestRuns.filter((run) => run.status === "running")
        .length,
    },
    providers,
  };
}

async function readProvidersForStatus(): Promise<{
  ok: boolean;
  items: AgentProviderOption[];
  error?: string;
}> {
  try {
    return {
      ok: true,
      items: await listAgentProviders(),
    };
  } catch (error) {
    return {
      ok: false,
      items: [],
      error:
        error instanceof Error ? error.message : "Provider detection failed.",
    };
  }
}

function listCommand(input: CliInput, context: CliContext) {
  const limit = clampInteger(readOptionalInteger(input, ["limit"]) ?? 50, 1, 200);
  const rows = listWorkflows()
    .slice(0, limit)
    .map((item) => ({
      id: item.workflow.id,
      name: item.workflow.name,
      description: item.workflow.description,
      version: item.currentVersion?.version ?? null,
      runCount: item.runCount,
      latestRunStatus: item.latestRun?.status ?? null,
      updatedAt: item.workflow.updatedAt,
    }));

  if (context.outputMode === "table") {
    return NextResponse.json({
      kind: "table",
      columns: [
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
        { key: "version", label: "Version" },
        { key: "runCount", label: "Runs" },
        { key: "latestRunStatus", label: "Latest" },
        { key: "updatedAt", label: "Updated" },
      ],
      rows,
    } satisfies CliOutput);
  }

  return cliJson({
    workflows: rows,
    count: rows.length,
  });
}

function showCommand(input: CliInput) {
  const workflowId = readRequiredString(input, ["workflow-id", "workflowId"]);
  const includeScript =
    readOptionalBoolean(input, ["include-script", "includeScript"]) ?? false;
  const detail = getWorkflowDetail(workflowId);
  if (!detail) {
    throw new CliHttpError("workflow_not_found", "Workflow not found.", 404);
  }
  if (!detail.currentVersion) {
    throw new CliHttpError(
      "workflow_version_not_found",
      "Workflow version not found.",
      404,
    );
  }

  const parsed = assertWorkflowScriptValid(detail.currentVersion.script);
  return {
    workflow: detail.workflow,
    currentVersion: {
      id: detail.currentVersion.id,
      version: detail.currentVersion.version,
      meta: detail.currentVersion.meta,
      createdAt: detail.currentVersion.createdAt,
      ...(includeScript ? { script: detail.currentVersion.script } : {}),
    },
    versions: detail.versions.map((version) => ({
      id: version.id,
      version: version.version,
      meta: version.meta,
      createdAt: version.createdAt,
    })),
    runs: detail.runs,
    parsed: parsedSummary(parsed),
  };
}

function validateCommand(input: CliInput) {
  const script = readRequiredString(input, ["script"]);
  const parsed = parseWorkflowScript(script);
  const diagnostics = parsed.diagnostics;
  const valid = !diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );

  return {
    valid,
    ...parsedSummary(parsed),
    diagnostics,
    summary: summarizeWorkflow(parsed),
  };
}

async function createCommand(input: CliInput) {
  const prompt = readRequiredString(input, ["prompt"]);
  const provider = readOptionalString(input, ["provider"]);
  const model = readOptionalString(input, ["model"]);
  const cwd = readOptionalString(input, ["cwd"]);
  const generated = await generateWorkflowScriptWithRepair({
    description: prompt,
    provider,
    model,
    cwd,
  });
  const detail = createWorkflowFromScript(generated.script);
  const parsed = assertWorkflowScriptValid(generated.script);

  return {
    workflow: detail.workflow,
    currentVersion: detail.currentVersion,
    generation: generated,
    parsed: parsedSummary(parsed),
  };
}

async function runCommand(input: CliInput) {
  const workflowId = readRequiredString(input, ["workflow-id", "workflowId"]);
  const provider = readOptionalString(input, ["provider"]) ?? "mock";
  const model = readOptionalString(input, ["model"]);
  const cwd = readOptionalString(input, ["cwd"]);
  const timeoutMs = clampInteger(
    readOptionalInteger(input, ["timeout-ms", "timeoutMs"]) ??
      DEFAULT_RUN_TIMEOUT_MS,
    1,
    MAX_RUN_TIMEOUT_MS,
  );
  const inputs = readWorkflowInputs(input);
  const result = await runWorkflowForCli({
    workflowId,
    provider,
    model,
    cwd,
    inputs,
    timeoutMs,
  });

  return {
    run: result.run,
    result: readRunResult(result.run.result),
    timedOut: result.timedOut,
  };
}

async function runWorkflowForCli(input: {
  workflowId: string;
  provider: string;
  model?: string;
  cwd?: string;
  inputs: Record<string, string>;
  timeoutMs: number;
}): Promise<{
  run: WorkflowRunRecord;
  timedOut: boolean;
}> {
  const detail = getWorkflowDetail(input.workflowId);
  if (!detail) {
    throw new CliHttpError("workflow_not_found", "Workflow not found.", 404);
  }
  if (!detail.currentVersion) {
    throw new CliHttpError(
      "workflow_version_not_found",
      "Workflow version not found.",
      404,
    );
  }

  const parsed = assertWorkflowScriptValid(detail.currentVersion.script);
  assertRequiredWorkflowInputs(parsed.externalInputs, input.inputs);
  const cwd = resolveWorkflowCwd(input.cwd);
  const run = createWorkflowRun({
    workflowId: input.workflowId,
    workflowVersionId: detail.currentVersion.id,
    executorKind: input.provider === "mock" ? "mock" : "local-agent",
    provider: input.provider,
    model: input.model,
    cwd,
    request: {
      inputs: input.inputs,
      provider: input.provider,
      model: input.model,
      cwd,
    },
  });
  ensureRunLogDirectory(run.logPath);

  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, input.timeoutMs);
  let summary = createInitialRunSummary(undefined, {
    status: "running",
    queueExecutableNodes: false,
  });

  try {
    for await (const event of runWorkflow({
      runId: run.id,
      script: detail.currentVersion.script,
      provider: input.provider,
      model: input.model,
      cwd,
      inputs: input.inputs,
      signal: abortController.signal,
    })) {
      appendRunLogEvent(run.logPath, event);
      summary = applyWorkflowRunEvent(summary, event);
    }
    if (timedOut && summary.status === "canceled") {
      summary = {
        ...summary,
        error: `Run timed out after ${input.timeoutMs}ms.`,
        errorCode: "WORKFLOW_RUN_FAILED",
      };
    }
  } catch (error) {
    const finalEvent: WorkflowRunEvent = {
      type: "run_completed",
      runId: run.id,
      status: abortController.signal.aborted ? "canceled" : "failed",
      outputs: summary.outputs,
      error: timedOut
        ? `Run timed out after ${input.timeoutMs}ms.`
        : formatRunError(error),
      errorCode: getRunErrorCode(error),
    };
    appendRunLogEvent(run.logPath, finalEvent);
    summary = applyWorkflowRunEvent(summary, finalEvent);
  } finally {
    clearTimeout(timeout);
    updateStoredRun(run.id, summary);
  }

  return {
    run: getWorkflowRun(run.id) ?? run,
    timedOut,
  };
}

function updateStoredRun(runId: string, summary: WorkflowRunSummary) {
  updateWorkflowRun({
    runId,
    status: summary.status,
    result: toWorkflowRunResult(summary),
  });
}

function parsedSummary(parsed: ParsedWorkflow) {
  return {
    meta: parsed.meta,
    nodeCount: parsed.nodes.length,
    phaseCount: parsed.phases.length,
    externalInputs: parsed.externalInputs,
    nodes: parsed.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      phase: node.phase,
      provider: node.provider,
      model: node.model,
      session: node.session,
      inputs: node.inputs,
    })),
  };
}

function readWorkflowInputs(input: CliInput): Record<string, string> {
  const rawInputs =
    readOptionalString(input, ["inputs", "inputs-json", "inputsJson"]) ??
    undefined;
  if (!rawInputs) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInputs);
  } catch (error) {
    throw new CliHttpError(
      "invalid_input",
      `inputs must be a JSON object: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
      400,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliHttpError("invalid_input", "inputs must be a JSON object.", 400);
  }

  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, value]) => {
      if (typeof value === "string") {
        return [[key, value]];
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return [[key, String(value)]];
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
    throw new CliHttpError(
      "missing_workflow_inputs",
      `Missing workflow input(s): ${missingInputs.join(", ")}`,
      400,
    );
  }
}

function readCliContext(body: unknown): CliContext {
  const envelope = readRecord(body) as CliInvokeBody | undefined;
  return {
    outputMode:
      typeof envelope?.outputMode === "string" ? envelope.outputMode : undefined,
  };
}

function readCliInput(body: unknown): CliInput {
  const envelope = readRecord(body) as CliInvokeBody | undefined;
  const rawInput = envelope && "input" in envelope ? envelope.input : body;
  return readRecord(rawInput) ?? {};
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readRequiredString(input: CliInput, keys: string[]): string {
  const value = readOptionalString(input, keys);
  if (!value) {
    throw new CliHttpError(
      "invalid_input",
      `Missing required input: ${keys[0]}`,
      400,
    );
  }
  return value;
}

function readOptionalString(input: CliInput, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readOptionalBoolean(
  input: CliInput,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      if (value === "true") {
        return true;
      }
      if (value === "false") {
        return false;
      }
    }
  }
  return undefined;
}

function readOptionalInteger(
  input: CliInput,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (Number.isInteger(value)) {
      return value as number;
    }
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      return Number(value);
    }
  }
  return undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cliJson(value: unknown) {
  return NextResponse.json({
    kind: "json",
    value,
  } satisfies CliOutput);
}

function cliErrorResponse(error: unknown) {
  if (error instanceof CliHttpError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      { status: error.status },
    );
  }

  if (error instanceof WorkflowScriptSyntaxError) {
    return NextResponse.json(
      {
        error: {
          code: "workflow_script_invalid",
          message: error.message,
          details: {
            diagnostics: error.diagnostics,
          },
        },
      },
      { status: 400 },
    );
  }

  return NextResponse.json(
    {
      error: {
        code: "command_failed",
        message: error instanceof Error ? error.message : "Command failed.",
      },
    },
    { status: 500 },
  );
}

class CliHttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "CliHttpError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
