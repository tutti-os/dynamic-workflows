import { NextResponse } from "next/server";
import { listAgentTargets } from "@/lib/agents/runtime";
import type { AgentTargetOption } from "@/lib/agents/types";
import {
  createWorkflowFromScript,
  getWorkflowDetail,
  listWorkflows,
} from "@/lib/db/workflows/workflow-repository";
import {
  getWorkflowVersion,
} from "@/lib/db/workflows/versions";
import type {
  WorkflowRunRecord,
} from "@/lib/db/workflows/types";
import { getWorkflowCwdRoot, resolveWorkflowCwd } from "@/lib/workflow/cwd";
import { createPendingWorkflowGeneration } from "@/lib/db/workflows/generations";
import {
  ensureWorkflowGenerationStarted,
  waitForWorkflowGenerationLaunch,
} from "@/lib/workflow/generation-jobs";
import {
  getWorkflowBlueprint,
  listWorkflowBlueprints,
  searchWorkflowBlueprints,
} from "@/lib/workflow/blueprint-catalog";
import {
  WORKFLOW_BLUEPRINT_CATEGORIES,
  isWorkflowBlueprintCategory,
} from "@/lib/workflow/blueprint-contract";
import {
  AuthoringSubmitError,
  submitAuthoringScript,
  validateAuthoringScript,
} from "@/lib/workflow/authoring/submit";
import {
  assertWorkflowScriptValid,
  parseWorkflowScript,
  WorkflowScriptSyntaxError,
} from "@/lib/workflow/parser";
import {
  readRunResult,
} from "@/lib/workflow/run-state";
import {
  normalizeWorkflowInputsForSchema,
  readWorkflowInputsObject,
} from "@/lib/workflow/input-schema";
import { compactWorkflowRunInput } from "@/lib/workflow/run-input";
import type { ParsedWorkflow, WorkflowInputValue } from "@/lib/workflow/types";
import { summarizeWorkflow } from "@/lib/workflow/executor";
import {
  hasWorkflowDiagnosticErrors,
  summarizeWorkflowDiagnostics,
} from "@/lib/workflow/validation";
import {
  resumeWorkflowRunJob,
  startWorkflowRunJob,
} from "@/lib/workflow/run-jobs";

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
      case "agents":
        return cliJson({ agents: await listAgentTargets() });
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
      case "resume":
        return cliJson(await resumeCommand(input));
      case "blueprints/list":
        return cliJson(blueprintsListCommand());
      case "blueprints/search":
        return cliJson(blueprintsSearchCommand(input));
      case "blueprints/get":
        return cliJson(blueprintsGetCommand(input));
      case "authoring/validate":
        return cliJson(authoringValidateCommand(input));
      case "authoring/submit":
        return cliJson(authoringSubmitCommand(input));
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
  const agents = await readAgentTargetsForStatus();
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
    agents,
  };
}

async function readAgentTargetsForStatus(): Promise<{
  ok: boolean;
  items: AgentTargetOption[];
  error?: string;
}> {
  try {
    return {
      ok: true,
      items: await listAgentTargets(),
    };
  } catch (error) {
    return {
      ok: false,
      items: [],
      error:
        error instanceof Error ? error.message : "Agent target detection failed.",
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

  return {
    valid: !hasWorkflowDiagnosticErrors(diagnostics),
    ...parsedSummary(parsed),
    diagnosticSummary: summarizeWorkflowDiagnostics(diagnostics),
    diagnostics,
    summary: summarizeWorkflow(parsed),
  };
}

async function createCommand(input: CliInput) {
  const prompt = readRequiredString(input, ["prompt"]);
  const agent = readOptionalString(input, ["agent"]);
  const model = readOptionalString(input, ["model"]);
  const cwd = readOptionalString(input, ["cwd"]);

  const pending = createPendingWorkflowGeneration({ prompt, agent, model, cwd });
  ensureWorkflowGenerationStarted(pending.workflow.id);
  // Decoupled authoring: wait only for the session launch. The workflow fills
  // in whenever the authoring agent submits (possibly after clarification
  // turns in AgentGUI); poll `show` to observe versions landing.
  const generation = await waitForWorkflowGenerationLaunch(pending.workflow.id);
  if (!generation || generation.status === "failed") {
    throw new CliHttpError(
      "workflow_generation_failed",
      generation?.error?.message ?? "Workflow generation failed to launch.",
      500,
      generation?.error ?? undefined,
    );
  }

  const detail = getWorkflowDetail(pending.workflow.id);
  if (!detail) {
    throw new CliHttpError("workflow_not_found", "Workflow not found.", 404);
  }

  return {
    workflow: detail.workflow,
    currentVersion: detail.currentVersion,
    generation,
    ...(detail.currentVersion
      ? {
          parsed: parsedSummary(
            assertWorkflowScriptValid(detail.currentVersion.script),
          ),
        }
      : {}),
  };
}

function blueprintsListCommand() {
  const blueprints = listWorkflowBlueprints();
  return {
    blueprints,
    count: blueprints.length,
  };
}

function blueprintsSearchCommand(input: CliInput) {
  const category = readOptionalString(input, ["category"]);
  if (category && !isWorkflowBlueprintCategory(category)) {
    throw new CliHttpError(
      "invalid_input",
      `category must be one of: ${WORKFLOW_BLUEPRINT_CATEGORIES.join(", ")}`,
      400,
    );
  }

  const tags = readOptionalString(input, ["tags"])
    ?.split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const results = searchWorkflowBlueprints({
    query: readOptionalString(input, ["query"]),
    category: category && isWorkflowBlueprintCategory(category)
      ? category
      : undefined,
    tags,
    requiresCwd: readOptionalBoolean(input, ["requires-cwd", "requiresCwd"]),
    includeScript:
      readOptionalBoolean(input, ["include-script", "includeScript"]) ?? false,
    limit: readOptionalInteger(input, ["limit"]),
  });

  return {
    blueprints: results,
    count: results.length,
  };
}

function blueprintsGetCommand(input: CliInput) {
  const blueprintId = readRequiredString(input, ["blueprint-id", "blueprintId"]);
  const includeScript =
    readOptionalBoolean(input, ["include-script", "includeScript"]) ?? false;
  const blueprint = getWorkflowBlueprint(blueprintId);
  if (!blueprint) {
    throw new CliHttpError(
      "workflow_blueprint_not_found",
      "Workflow blueprint not found.",
      404,
    );
  }

  const { script, ...summary } = blueprint;
  return {
    blueprint: includeScript ? { ...summary, script } : summary,
  };
}

function authoringSubmitCommand(input: CliInput) {
  const jobId = readRequiredString(input, ["job-id", "jobId"]);
  const file = readOptionalString(input, ["file"]);
  const script = readOptionalString(input, ["script"]);

  try {
    return submitAuthoringScript({ jobId, file, script });
  } catch (error) {
    if (error instanceof AuthoringSubmitError) {
      throw new CliHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

function authoringValidateCommand(input: CliInput) {
  const jobId = readRequiredString(input, ["job-id", "jobId"]);
  const file = readRequiredString(input, ["file"]);

  try {
    return validateAuthoringScript({ jobId, file });
  } catch (error) {
    if (error instanceof AuthoringSubmitError) {
      throw new CliHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

async function runCommand(input: CliInput) {
  const workflowId = readRequiredString(input, ["workflow-id", "workflowId"]);
  const agent = readOptionalString(input, ["agent"]) ?? "mock";
  const model = readOptionalString(input, ["model"]);
  const cwd = readOptionalString(input, ["cwd"]);
  const versionId = readOptionalString(input, ["version-id", "versionId"]);
  const inputs = readWorkflowInputs(input);
  const result = await runWorkflowForCli({
    workflowId,
    versionId,
    agent,
    model,
    cwd,
    inputs,
  });

  return {
    run: result.run,
    result: readRunResult(result.run.result),
  };
}

async function resumeCommand(input: CliInput) {
  const workflowId = readRequiredString(input, ["workflow-id", "workflowId"]);
  const runId = readRequiredString(input, ["run-id", "runId"]);
  const run = await resumeWorkflowRunJob({ workflowId, runId });

  return {
    run,
    result: readRunResult(run.result),
  };
}

async function runWorkflowForCli(input: {
  workflowId: string;
  versionId?: string;
  agent: string;
  model?: string;
  cwd?: string;
  inputs: Record<string, WorkflowInputValue>;
}): Promise<{
  run: WorkflowRunRecord;
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

  const version = input.versionId
    ? getWorkflowVersion(input.versionId)
    : detail.currentVersion;
  if (!version || version.workflowId !== input.workflowId) {
    throw new CliHttpError(
      "workflow_version_not_found",
      "Workflow version not found.",
      404,
    );
  }

  const parsed = assertWorkflowScriptValid(version.script);
  const inputs = normalizeCliWorkflowInputs(parsed, input.inputs);
  assertRequiredWorkflowCwd(parsed, input.cwd);
  const cwd = resolveWorkflowCwd(input.cwd);
  const run = startWorkflowRunJob({
    workflowId: input.workflowId,
    version,
    executorKind: input.agent === "mock" ? "mock" : "local-agent",
    agent: input.agent,
    model: input.model,
    cwd,
    inputs,
    input: compactWorkflowRunInput({
      inputs,
      agent: input.agent,
      model: input.model,
      cwd,
    }),
  });

  return {
    run,
  };
}

function parsedSummary(parsed: ParsedWorkflow) {
  return {
    meta: parsed.meta,
    inputSchema: parsed.inputSchema,
    requiredInputNames: parsed.requiredInputNames,
    optionalInputNames: parsed.optionalInputNames,
    nodeCount: parsed.nodes.length,
    phaseCount: parsed.phases.length,
    nodes: parsed.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      phase: node.phase,
      agent: node.agent,
      model: node.model,
      cwd: node.cwd,
      session: node.session,
      inputs: node.inputs,
      loop: node.loop
        ? {
            maxIterations: node.loop.maxIterations,
            onMaxIterations: node.loop.onMaxIterations,
            cwd: node.cwd,
            session: node.loop.session,
            until: node.loop.until,
            steps: node.loop.steps.map((step) => ({
              id: step.id,
              kind: step.kind,
              label: step.label,
              agent: step.agent,
              model: step.model,
              cwd: step.cwd,
              session: step.session,
              hasAppendPrompt: Boolean(step.appendPrompt),
            })),
          }
        : undefined,
    })),
  };
}

function readWorkflowInputs(input: CliInput): Record<string, WorkflowInputValue> {
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

  return readWorkflowInputsObject(parsed);
}

function normalizeCliWorkflowInputs(
  parsed: ParsedWorkflow,
  inputs: Record<string, WorkflowInputValue>,
): Record<string, WorkflowInputValue> {
  try {
    return normalizeWorkflowInputsForSchema(parsed.inputSchema, inputs);
  } catch (error) {
    throw new CliHttpError(
      "invalid_workflow_inputs",
      error instanceof Error ? error.message : "Invalid workflow inputs.",
      400,
    );
  }
}

function assertRequiredWorkflowCwd(
  parsed: ParsedWorkflow,
  cwd: string | undefined,
) {
  if (parsed.meta.requiresCwd && !cwd?.trim()) {
    throw new CliHttpError(
      "missing_workflow_inputs",
      "Workflow cwd is required.",
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
