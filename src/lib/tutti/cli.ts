import { NextResponse } from "next/server";
import { listAgentTargets } from "@/lib/agents/runtime";
import type { AgentTargetOption } from "@/lib/agents/types";
import { isAppError } from "@/lib/api/app-error";
import {
  createWorkflowFromScript,
  getWorkflowDetail,
  listWorkflows,
} from "@/lib/db/workflows/workflow-repository";
import {
  getWorkflowVersion,
} from "@/lib/db/workflows/versions";
import {
  getWorkflowRun,
} from "@/lib/db/workflows/runs";
import { listWorkflowHumanTasks } from "@/lib/db/workflows/human-tasks";
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
import { createWorkflowExecutionPlan } from "@/lib/workflow/execution-plan";
import { stringifyWorkflowValue } from "@/lib/workflow/templates";
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
  markWorkflowRunInterruptedIfStale,
  resumeWorkflowRunJob,
  startWorkflowRunJob,
} from "@/lib/workflow/run-jobs";
import type { WorkflowValue } from "@/lib/workflow/types";

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

export const DYNAMIC_WORKFLOWS_CLI_COMMAND_PATHS = [
  "status",
  "agents",
  "list",
  "show",
  "validate",
  "create",
  "run",
  "runs/get",
  "runs/wait",
  "blueprints/list",
  "blueprints/search",
  "blueprints/get",
  "authoring/validate",
  "authoring/submit",
  "resume",
] as const;

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
      case "runs/get":
        return cliJson(await runsGetCommand(input));
      case "runs/wait":
        return cliJson(await runsWaitCommand(input));
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
  const force = readOptionalBoolean(input, ["force"]) ?? false;
  const inputs = readWorkflowInputs(input);
  const result = await runWorkflowForCli({
    workflowId,
    versionId,
    agent,
    model,
    cwd,
    force,
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

// A wait caller loops on bounded waits; keep the server-side hold well under
// any HTTP timeout the daemon CLI proxy might impose. The proxy's own timeout
// is not observable from this repo, so cap conservatively at 120s and let
// callers re-issue `runs wait` until they see a terminal or waiting reason.
const RUNS_WAIT_DEFAULT_TIMEOUT_MS = 120_000;
const RUNS_WAIT_MAX_TIMEOUT_MS = 120_000;
const RUNS_WAIT_POLL_INTERVAL_MS = 500;

async function runsGetCommand(input: CliInput) {
  const runId = readRequiredString(input, ["run-id", "runId"]);
  const existing = getWorkflowRun(runId);
  if (!existing) {
    throw new CliHttpError("run_not_found", "Run not found.", 404);
  }
  const run = await markWorkflowRunInterruptedIfStale(existing);
  return buildRunDetail(run);
}

async function runsWaitCommand(input: CliInput) {
  const runId = readRequiredString(input, ["run-id", "runId"]);
  const timeoutMs = clampInteger(
    readOptionalInteger(input, ["timeout-ms", "timeoutMs"]) ??
      RUNS_WAIT_DEFAULT_TIMEOUT_MS,
    0,
    RUNS_WAIT_MAX_TIMEOUT_MS,
  );
  if (!getWorkflowRun(runId)) {
    throw new CliHttpError("run_not_found", "Run not found.", 404);
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const existing = getWorkflowRun(runId);
    if (!existing) {
      throw new CliHttpError("run_not_found", "Run not found.", 404);
    }
    // Reconcile first so a crashed "running" zombie resolves to `interrupted`
    // (a real stop point) instead of spinning until the deadline.
    const run = await markWorkflowRunInterruptedIfStale(existing);
    const reason = runStopReason(run);
    if (reason) {
      return { reason, timedOut: false, ...buildRunDetail(run) };
    }
    if (Date.now() >= deadline) {
      return { reason: "timeout" as const, timedOut: true, ...buildRunDetail(run) };
    }
    await delay(
      Math.min(RUNS_WAIT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
    );
  }
}

type RunStopReason =
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted"
  | "waiting_human";

/**
 * A run reaches a stop point when it is terminal (completed/failed/canceled/
 * interrupted) or has persisted the `waiting_for_human` status — the executor
 * transitions running -> waiting_for_human (markWorkflowRunWaitingOwned) only
 * once its pending human tasks are recorded, so that status is the reliable
 * "blocked on human input, no active job" signal. A still-`running` run has not
 * reached a stop point.
 */
function runStopReason(run: WorkflowRunRecord): RunStopReason | undefined {
  switch (run.status) {
    case "completed":
    case "failed":
    case "canceled":
    case "interrupted":
      return run.status;
    case "waiting_for_human":
      return "waiting_human";
    default:
      return undefined;
  }
}

/**
 * The structured, agent-facing view of a run returned by `runs get` and nested
 * into `runs wait`: the persisted run record, its structured result (outputs,
 * node statuses, rendered node inputs, error), the pending human tasks with
 * their rendered context so a caller can relay them, and a convenience `report`
 * built from the run's terminal node outputs.
 */
function buildRunDetail(run: WorkflowRunRecord) {
  const result = readRunResult(run.result);
  return {
    run,
    result,
    humanTasks: listWorkflowHumanTasks(run.id, "pending"),
    report: buildRunReport(run, result.outputs),
  };
}

/**
 * The delivery report an agent caller reads without knowing node ids: the
 * outputs of the run's terminal nodes (executable nodes that no other node
 * consumes). `text` concatenates their stringified outputs for convenience.
 */
function buildRunReport(
  run: WorkflowRunRecord,
  outputs: Record<string, WorkflowValue>,
) {
  const terminalNodeIds = terminalNodeIdsForRun(run);
  const reportOutputs: Record<string, WorkflowValue> = {};
  const texts: string[] = [];
  for (const nodeId of terminalNodeIds) {
    if (Object.prototype.hasOwnProperty.call(outputs, nodeId)) {
      reportOutputs[nodeId] = outputs[nodeId];
      texts.push(stringifyWorkflowValue(outputs[nodeId]));
    }
  }
  return {
    nodeIds: terminalNodeIds,
    outputs: reportOutputs,
    text: texts.join("\n\n"),
  };
}

function terminalNodeIdsForRun(run: WorkflowRunRecord): string[] {
  const version = getWorkflowVersion(run.workflowVersionId);
  if (!version) {
    return [];
  }
  let executableNodes;
  try {
    executableNodes = createWorkflowExecutionPlan(
      assertWorkflowScriptValid(version.script),
    ).executableNodes;
  } catch {
    return [];
  }
  const consumed = new Set<string>();
  for (const node of executableNodes) {
    for (const nodeInput of node.inputs) {
      if (nodeInput.sourceNodeId) {
        consumed.add(nodeInput.sourceNodeId);
      }
    }
  }
  return executableNodes
    .filter((node) => !consumed.has(node.id))
    .map((node) => node.id);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runWorkflowForCli(input: {
  workflowId: string;
  versionId?: string;
  agent: string;
  model?: string;
  cwd?: string;
  force: boolean;
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
  let run: WorkflowRunRecord;
  try {
    run = startWorkflowRunJob({
      workflowId: input.workflowId,
      version,
      executorKind: input.agent === "mock" ? "mock" : "local-agent",
      agent: input.agent,
      model: input.model,
      cwd,
      force: input.force,
      inputs,
      input: compactWorkflowRunInput({
        inputs,
        agent: input.agent,
        model: input.model,
        cwd,
      }),
    });
  } catch (error) {
    if (isAppError(error) && error.code === "WORKFLOW_RUN_CWD_CONFLICT") {
      throw new CliHttpError("run_cwd_conflict", error.message, 409, error.details);
    }
    throw error;
  }

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
      human: node.human,
      inputs: node.inputs,
      loop: node.loop
        ? {
            maxIterations: node.loop.maxIterations,
            onMaxIterations: node.loop.onMaxIterations,
            firstIteration: node.loop.firstIteration,
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
              human: step.kind === "human" ? step.human : undefined,
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
