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
import { generateWorkflowScriptWithRepair } from "@/lib/workflow/generator";
import {
  assertWorkflowScriptValid,
  parseWorkflowScript,
  WorkflowScriptSyntaxError,
} from "@/lib/workflow/parser";
import {
  readRunResult,
} from "@/lib/workflow/run-state";
import type { ParsedWorkflow } from "@/lib/workflow/types";
import { summarizeWorkflow } from "@/lib/workflow/executor";
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
  const agent = readOptionalString(input, ["agent"]);
  const model = readOptionalString(input, ["model"]);
  const cwd = readOptionalString(input, ["cwd"]);
  const generated = await generateWorkflowScriptWithRepair({
    description: prompt,
    agent,
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
  inputs: Record<string, string>;
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
  assertRequiredWorkflowInputs(parsed.externalInputs, input.inputs);
  assertRequiredWorkflowCwd(parsed, input.cwd);
  const cwd = resolveWorkflowCwd(input.cwd);
  const run = startWorkflowRunJob({
    workflowId: input.workflowId,
    version,
    executorKind: input.agent === "mock" ? "mock" : "local-agent",
    agent: input.agent,
    model: input.model,
    cwd,
    inputs: input.inputs,
    input: {
      inputs: input.inputs,
      agent: input.agent,
      model: input.model,
      cwd,
    },
  });

  return {
    run,
  };
}

function parsedSummary(parsed: ParsedWorkflow) {
  return {
    meta: parsed.meta,
    nodeCount: parsed.nodes.length,
    phaseCount: parsed.phases.length,
    externalInputs: parsed.externalInputs,
    optionalExternalInputs: parsed.optionalExternalInputs,
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
