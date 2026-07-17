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
import {
  HumanTaskConflictError,
  HumanTaskValidationError,
  getWorkflowHumanTask,
  listWorkflowHumanTasks,
  resolveWorkflowHumanTask,
} from "@/lib/db/workflows/human-tasks";
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
  BlueprintNotFoundError,
  instantiateWorkflowBlueprint,
} from "@/lib/workflow/blueprint-instantiate";
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
  resumeWorkflowRunAfterHumanTask,
  resumeWorkflowRunJob,
  startWorkflowRunJob,
} from "@/lib/workflow/run-jobs";
import {
  RunNoteError,
  listWorkflowRunNotes,
  recordRunNote,
} from "@/lib/workflow/run-notes";
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
  "import",
  "run",
  "runs/get",
  "runs/wait",
  "runs/respond",
  "runs/note",
  "blueprints/list",
  "blueprints/search",
  "blueprints/get",
  "blueprints/instantiate",
  "authoring/validate",
  "authoring/submit",
  "resume",
] as const;

export async function handleDynamicWorkflowsCliRequest(
  path: string[],
  body: unknown,
  request?: Request,
): Promise<NextResponse<CliOutput | CliErrorResponse>> {
  const normalizedPath = path.map((segment) => segment.trim()).filter(Boolean);
  const context = readCliContext(body);
  const input = readCliInput(body);

  try {
    switch (normalizedPath.join("/")) {
      case "status":
        return cliJson(await statusCommand(request));
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
      case "import":
        return envelope(() => importCommand(input));
      case "run":
        return envelope(() => runCommand(input));
      case "runs/get":
        return envelope(() => runsGetCommand(input));
      case "runs/wait":
        return envelope(() => runsWaitCommand(input));
      case "runs/respond":
        return envelope(() => runsRespondCommand(input));
      case "runs/note":
        return envelope(() => runsNoteCommand(input));
      case "resume":
        return cliJson(await resumeCommand(input));
      case "blueprints/list":
        return cliJson(blueprintsListCommand());
      case "blueprints/search":
        return cliJson(blueprintsSearchCommand(input));
      case "blueprints/get":
        return cliJson(blueprintsGetCommand(input));
      case "blueprints/instantiate":
        return envelope(() => instantiateCommand(input));
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

/**
 * Run a command whose EXPECTED domain errors must survive the daemon's CLI
 * proxy. The proxy flattens any non-2xx handler response into a generic
 * `workspace_operation_failed`, destroying domain codes (run_cwd_conflict,
 * run_note_no_live_session, human_task_conflict, workflow_script_invalid, ...).
 * So expected domain errors (a CliHttpError or WorkflowScriptSyntaxError with a
 * client-side 4xx status) are returned as HTTP 200 carrying a structured error
 * envelope `{ ok: false, error: { code, status, message, details? } }`, and
 * success payloads gain `ok: true`. Unexpected failures (5xx, unknown errors)
 * still bubble to `cliErrorResponse` and stay 5xx.
 */
async function envelope(
  run: () => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<NextResponse<CliOutput>> {
  let value: Record<string, unknown>;
  try {
    value = await run();
  } catch (error) {
    const domain = readDomainError(error);
    if (domain) {
      return cliJson({ ok: false, error: domain });
    }
    throw error;
  }
  return cliJson({ ok: true, ...value });
}

function readDomainError(error: unknown):
  | { code: string; status: number; message: string; details?: unknown }
  | undefined {
  if (error instanceof CliHttpError && error.status < 500) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof WorkflowScriptSyntaxError) {
    return {
      code: "workflow_script_invalid",
      status: 400,
      message: error.message,
      details: { diagnostics: error.diagnostics },
    };
  }
  return undefined;
}

async function statusCommand(request?: Request) {
  const workflows = listWorkflows();
  const agents = await readAgentTargetsForStatus();
  const latestRuns = workflows.flatMap((item) =>
    item.latestRun ? [item.latestRun] : [],
  );
  const baseUrl = readBaseUrl(request);

  return {
    ok: true,
    app: {
      scope: "dynamic-workflows",
      cwdRoot: getWorkflowCwdRoot(),
      // The app's HTTP origin, derived from the incoming request, so a caller
      // never has to discover the port from process listening tables. Any HTTP
      // fallback (if ever needed) targets this.
      ...(baseUrl ? { baseUrl } : {}),
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

/**
 * Instantiate a blueprint as a saved, runnable workflow. Wraps the SAME service
 * the UI instantiate route uses, so the created workflow is identical. Use this
 * only when the blueprint matches the requirement as-is; otherwise read its
 * script (`blueprints get --include-script`), adapt it, and `import`.
 */
function instantiateCommand(input: CliInput) {
  const blueprintId = readRequiredString(input, ["blueprint-id", "blueprintId"]);
  const name = readOptionalString(input, ["name"]);
  let detail;
  try {
    detail = instantiateWorkflowBlueprint(blueprintId, { name });
  } catch (error) {
    if (error instanceof BlueprintNotFoundError) {
      throw new CliHttpError(
        "workflow_blueprint_not_found",
        error.message,
        404,
      );
    }
    throw error;
  }
  return {
    workflow: detail.workflow,
    currentVersion: detail.currentVersion,
  };
}

/**
 * Import a workflow script string as a new saved workflow. Wraps the SAME
 * service the UI import route uses. This is the backbone of the adaptation path
 * (edit a blueprint's script, then import) and the self-authored path (write the
 * DSL yourself, `validate`, then import).
 */
function importCommand(input: CliInput) {
  const script = readRequiredString(input, ["script"]);
  let detail;
  try {
    detail = createWorkflowFromScript(script);
  } catch (error) {
    if (error instanceof WorkflowScriptSyntaxError) {
      throw new CliHttpError("workflow_script_invalid", error.message, 400, {
        diagnostics: error.diagnostics,
      });
    }
    throw error;
  }
  return {
    workflow: detail.workflow,
    currentVersion: detail.currentVersion,
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
// the daemon CLI proxy's own budget. In production the app-CLI handler cuts the
// request at ~16s (app_cli_handler_timeout), so a longer hold dies with a proxy
// error instead of returning a clean timedOut. Default AND cap to 10s — safely
// under that budget — and let callers re-issue `runs wait` until they see a
// terminal or waiting reason.
const RUNS_WAIT_DEFAULT_TIMEOUT_MS = 10_000;
const RUNS_WAIT_MAX_TIMEOUT_MS = 10_000;
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

/**
 * Respond to a pending human task from an agent caller, then resume the run.
 *
 * This is a thin surface over the exact service the UI uses
 * (`resolveWorkflowHumanTask` + `resumeWorkflowRunAfterHumanTask`), so the
 * revision check, response validation, and run resumption behave identically.
 * `--revision` is optional: when omitted we read the task's current revision
 * (read-modify-write). That is safe because the service performs the resolve
 * inside a transaction guarded by `revision = ?`; a concurrent resolve makes our
 * read stale and surfaces as a conflict rather than a silent wrong write. When
 * `--revision` is supplied we honor it verbatim (strict optimistic concurrency,
 * matching the UI). On success the response carries the resolved task plus the
 * refreshed `runs get` payload so the caller can loop straight back into
 * `runs wait`.
 */
async function runsRespondCommand(input: CliInput) {
  const runId = readRequiredString(input, ["run-id", "runId"]);
  const taskId = readRequiredString(input, ["task-id", "taskId"]);
  const action = readRequiredString(input, ["action", "action-id", "actionId"]);
  const values = readHumanTaskValues(input);
  const providedRevision = readOptionalInteger(input, ["revision"]);

  const run = getWorkflowRun(runId);
  if (!run) {
    throw new CliHttpError("run_not_found", "Run not found.", 404);
  }
  const task = getWorkflowHumanTask(taskId);
  if (!task || task.runId !== runId) {
    throw new CliHttpError("human_task_not_found", "Human task not found.", 404);
  }
  const revision = providedRevision ?? task.revision;

  let resolved;
  try {
    resolved = resolveWorkflowHumanTask({
      runId,
      taskId,
      action,
      values,
      revision,
      resolvedBy: "agent-cli",
    });
  } catch (error) {
    if (error instanceof HumanTaskConflictError) {
      throw new CliHttpError("human_task_conflict", error.message, 409);
    }
    if (error instanceof HumanTaskValidationError) {
      if (error.message === "Human task not found.") {
        throw new CliHttpError("human_task_not_found", error.message, 404);
      }
      throw new CliHttpError("human_task_invalid", error.message, 400);
    }
    throw error;
  }

  const resumedRun = await resumeWorkflowRunAfterHumanTask({
    workflowId: run.workflowId,
    runId,
  });

  return {
    task: resolved,
    ...buildRunDetail(resumedRun),
  };
}

/**
 * Record an operator note steering a run. `next-step` (default) injects the
 * note into the next agent execution's rendered prompt; `current` delegates it
 * to the live agent session. Either way the note is recorded as a run event
 * first, so run review and replay stay truthful. Returns the recorded note and,
 * for current delivery, the live-delivery result.
 */
async function runsNoteCommand(input: CliInput) {
  const runId = readRequiredString(input, ["run-id", "runId"]);
  const message = readRequiredString(input, ["message"]);
  const nodeId = readOptionalString(input, ["node-id", "nodeId"]);
  const targetRaw = readOptionalString(input, ["target"]) ?? "next-step";
  if (targetRaw !== "current" && targetRaw !== "next-step") {
    throw new CliHttpError(
      "invalid_input",
      'target must be "current" or "next-step".',
      400,
    );
  }

  if (!getWorkflowRun(runId)) {
    throw new CliHttpError("run_not_found", "Run not found.", 404);
  }

  try {
    const result = await recordRunNote({
      runId,
      message,
      target: targetRaw,
      nodeId,
    });
    return {
      note: result.note,
      ...(result.delivery ? { delivery: result.delivery } : {}),
    };
  } catch (error) {
    if (error instanceof RunNoteError) {
      throw new CliHttpError(
        error.code === "RUN_NOT_FOUND" ? "run_not_found" : error.code.toLowerCase(),
        error.message,
        error.status,
      );
    }
    throw error;
  }
}

function readHumanTaskValues(input: CliInput): Record<string, WorkflowValue> {
  const rawValues = readOptionalString(input, ["values", "values-json", "valuesJson"]);
  if (!rawValues) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValues);
  } catch (error) {
    throw new CliHttpError(
      "invalid_input",
      `values must be a JSON object: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
      400,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliHttpError("invalid_input", "values must be a JSON object.", 400);
  }

  return parsed as Record<string, WorkflowValue>;
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
    notes: listWorkflowRunNotes(run.id),
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

/**
 * Derive the app's HTTP origin from the incoming request so `status` can report
 * a `baseUrl`. Honors reverse-proxy headers, then falls back to the request's
 * own host/URL. Returns undefined when no request is available (e.g. direct
 * unit-test dispatch).
 */
function readBaseUrl(request?: Request): string | undefined {
  if (!request) {
    return undefined;
  }
  let url: URL | undefined;
  try {
    url = new URL(request.url);
  } catch {
    url = undefined;
  }
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    url?.host;
  if (!host) {
    return undefined;
  }
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (url ? url.protocol.replace(/:$/, "") : "http");
  return `${proto}://${host}`;
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
