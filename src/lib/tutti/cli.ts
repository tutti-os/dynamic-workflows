import { NextResponse } from "next/server";
import { listAgentTargets } from "@/lib/agents/runtime";
import type { AgentTargetOption } from "@/lib/agents/types";
import {
  getWorkflowDetail,
  listWorkflows,
} from "@/lib/db/workflows/workflow-repository";
import {
  HumanTaskConflictError,
  HumanTaskValidationError,
  getWorkflowHumanTask,
} from "@/lib/db/workflows/human-tasks";
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
} from "@/lib/workflow/authoring/submit";
import {
  refreshAuthoringSemanticReview,
} from "@/lib/workflow/authoring/semantic-review";
import {
  submitAuthoringFlowBundle,
  validateAuthoringFlowBundleWithReview,
} from "@/lib/workflow/authoring/flow-bundle";
import {
  FlowV1ServiceError,
  cancelFlowV1Cycle,
  configureFlowV1,
  createFlowV1,
  dispatchFlowV1,
  publishFlowV1Version,
  setFlowV1Lifecycle,
  respondToFlowV1HumanTask,
} from "@/lib/flow-v1/flow-service";
import {
  getFlowV1BundleForVersion,
} from "@/lib/db/workflows/flow-bundles";
import {
  getFlowV1Cycle,
  getFlowV1CycleCheckpoint,
  getFlowV1Run,
} from "@/lib/db/workflows/flow-runtime";
import {
  listFlowV1Effects,
  listFlowV1NodeAttempts,
} from "@/lib/db/workflows/flow-attempts";
import { listFlowV1HumanTasks } from "@/lib/db/workflows/human-tasks";
import { getFlowV1DetailProjection } from "@/lib/flow-v1/projection";
import { getLatestFlowV1DraftReview } from "@/lib/flow-v1/version-projection";
import {
  readFlowV1BundleDirectory,
} from "@/lib/flow-v1/bundle";
import { parseFlowV1Bundle } from "@/lib/flow-v1/parser";
import type { FlowV1JsonObject } from "@/lib/flow-v1/types";
import type { FlowV1SecretBinding } from "@/lib/flow-v1/runtime-config";
import {
  hasWorkflowDiagnosticErrors,
  summarizeWorkflowDiagnostics,
} from "@/lib/workflow/validation";
import type { WorkflowValue } from "@/lib/workflow/types";

type CliOutput =
  | {
      kind: "json";
      value: unknown;
      continuation?: {
        state: "pending";
        retryAfterMs: number;
      };
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
  "publish",
  "run",
  "configure",
  "activate",
  "pause",
  "cancel-cycle",
  "runs/get",
  "runs/wait",
  "runs/respond",
  "blueprints/list",
  "blueprints/search",
  "blueprints/get",
  "blueprints/instantiate",
  "authoring/validate",
  "authoring/review/get",
  "authoring/review/wait",
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
        return envelope(() => validateCommand(input));
      case "create":
        return cliJson(await createCommand(input));
      case "import":
        return envelope(() => importCommand(input));
      case "publish":
        return envelope(() => publishCommand(input));
      case "run":
        return envelope(() => runCommand(input));
      case "configure":
        return envelope(() => configureCommand(input));
      case "activate":
        return envelope(() => lifecycleCommand(input, "active"));
      case "pause":
        return envelope(() => lifecycleCommand(input, "paused"));
      case "cancel-cycle":
        return envelope(() => cancelCycleCommand(input));
      case "runs/get":
        return envelope(() => runsGetCommand(input));
      case "runs/wait":
        return waitEnvelope(() => runsWaitCommand(input));
      case "runs/respond":
        return envelope(() => runsRespondCommand(input));
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
        return envelope(() => authoringValidateCommand(input));
      case "authoring/review/get":
        return envelope(() => authoringReviewGetCommand(input));
      case "authoring/review/wait":
        return waitEnvelope(() => authoringReviewWaitCommand(input));
      case "authoring/submit":
        return envelope(() => authoringSubmitCommand(input));
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
 * human_task_conflict, flow_bundle_invalid, ...).
 * So expected domain errors (a CliHttpError or WorkflowScriptSyntaxError with a
 * client-side 4xx status) are returned as HTTP 200 carrying a structured error
 * envelope `{ ok: false, error: { code, status, message, details? } }`, and
 * success payloads gain `ok: true`. Unexpected failures (5xx, unknown errors)
 * still bubble to `cliErrorResponse` and stay 5xx.
 */
async function envelope(
  run: () => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<NextResponse<CliOutput>> {
  return domainEnvelope(run, (value) => cliJson({ ok: true, ...value }));
}

type WaitCommandResult = {
  value: Record<string, unknown>;
  continuation?: {
    state: "pending";
    retryAfterMs: number;
  };
};

async function waitEnvelope(
  run: () => WaitCommandResult | Promise<WaitCommandResult>,
): Promise<NextResponse<CliOutput>> {
  return domainEnvelope(run, (result) =>
    cliJson({ ok: true, ...result.value }, result.continuation),
  );
}

async function domainEnvelope<T>(
  run: () => T | Promise<T>,
  success: (value: T) => NextResponse<CliOutput>,
): Promise<NextResponse<CliOutput>> {
  try {
    return success(await run());
  } catch (error) {
    const domain = readDomainError(error);
    if (domain) {
      return cliJson({ ok: false, error: domain });
    }
    throw error;
  }
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
  return undefined;
}

async function statusCommand(request?: Request) {
  const workflows = listWorkflows();
  const agents = await readAgentTargetsForStatus();
  const latestRuns = workflows.flatMap((item) =>
    item.flowV1Runtime?.latestRun ? [item.flowV1Runtime.latestRun] : [],
  );
  const baseUrl = readBaseUrl(request);

  return {
    ok: true,
    app: {
      scope: "dynamic-workflows",
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
    .map((item) => {
      const latestVersion = item.latestVersion;
      const flowV1 =
        item.currentVersion &&
        getFlowV1BundleForVersion(item.currentVersion.id)
          ? getFlowV1DetailProjection(item.workflow.id)?.runtime
          : null;
      return {
        id: item.workflow.id,
        name:
          latestVersion?.status === "draft"
            ? latestVersion.meta.name
            : item.workflow.name,
        description:
          latestVersion?.status === "draft"
            ? latestVersion.meta.description
            : item.workflow.description,
        version: latestVersion?.version ?? null,
        versionStatus: latestVersion?.status ?? null,
        lifecycle: flowV1?.lifecycle ?? null,
        cycleStatus: flowV1?.activeCycle?.status ?? null,
        cycleCount: flowV1?.cycleCount ?? null,
        runCount: flowV1?.runCount ?? 0,
        latestRunStatus: flowV1?.latestRun?.status ?? null,
        nextFireAt: flowV1?.schedule?.nextFireAt ?? null,
        attention: (flowV1?.attentionCycleCount ?? 0) > 0,
        updatedAt: item.workflow.updatedAt,
      };
    });

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
  const selectedVersion = detail.currentVersion ?? detail.versions[0];
  if (!selectedVersion) {
    throw new CliHttpError(
      "workflow_version_not_found",
      "Workflow version not found.",
      404,
    );
  }
  const bundle = getFlowV1BundleForVersion(selectedVersion.id);
  if (!bundle) {
    throw new CliHttpError(
      "flow_bundle_not_found",
      "Flow v1 Bundle not found.",
      404,
    );
  }
  const parsed = parseFlowV1Bundle(bundle);
  return {
    workflow: detail.workflow,
    currentVersion: detail.currentVersion
      ? {
      id: detail.currentVersion.id,
      version: detail.currentVersion.version,
      meta: parsed.meta,
      bundleHash: bundle.hash,
      createdAt: detail.currentVersion.createdAt,
      ...(includeScript
        ? {
            bundle: {
              schemaVersion: bundle.schemaVersion,
              hash: bundle.hash,
              files: bundle.files.map(({ path, content }) => ({
                path,
                content,
              })),
            },
          }
        : {}),
    }
      : null,
    draftReview: getLatestFlowV1DraftReview(workflowId),
    versions: detail.versions.map((version) => ({
      id: version.id,
      version: version.version,
      status: version.status,
      bundleHash: version.bundleHash,
      publishedAt: version.publishedAt,
      meta: version.meta,
      createdAt: version.createdAt,
    })),
    flow: getFlowV1DetailProjection(workflowId),
    diagnostics: parsed.diagnostics,
  };
}

function publishCommand(input: CliInput) {
  const workflowId = readRequiredString(input, [
    "workflow-id",
    "workflowId",
  ]);
  const versionId = readRequiredString(input, ["version-id", "versionId"]);
  const published = publishFlowV1Version({
    flowId: workflowId,
    versionId,
    params: readFlowV1JsonObject(input, [
      "params",
      "params-json",
      "paramsJson",
    ]),
  });
  return {
    published,
    workflow: getWorkflowDetail(workflowId),
    runtime: getFlowV1DetailProjection(workflowId)?.runtime ?? null,
  };
}

function validateCommand(input: CliInput) {
  const directory = readRequiredString(input, [
    "directory",
    "bundle-dir",
    "bundleDir",
  ]);
  const bundle = readFlowV1BundleDirectory(directory);
  const parsed = parseFlowV1Bundle(bundle);
  return {
    valid: !hasWorkflowDiagnosticErrors(parsed.diagnostics),
    schemaVersion: bundle.schemaVersion,
    bundleHash: bundle.hash,
    files: bundle.files.map((file) => file.path),
    meta: parsed.meta,
    nodes: parsed.nodes,
    edges: parsed.edges,
    diagnosticSummary: summarizeWorkflowDiagnostics(parsed.diagnostics),
    diagnostics: parsed.diagnostics,
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
    flow: detail.currentVersion
      ? getFlowV1DetailProjection(detail.workflow.id)
      : null,
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

  const { bundle, ...summary } = blueprint;
  return {
    blueprint: includeScript
      ? {
          ...summary,
          bundle,
        }
      : summary,
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
  const directory = readRequiredString(input, [
    "directory",
    "bundle-dir",
    "bundleDir",
  ]);
  const created = createFlowV1({
    bundle: readFlowV1BundleDirectory(directory),
    params: readFlowV1JsonObject(input, ["params", "params-json", "paramsJson"]),
    projectCwd: readOptionalString(input, ["cwd", "project-cwd", "projectCwd"]),
    defaultAgent: readOptionalString(input, ["agent", "default-agent", "defaultAgent"]),
    defaultModel: readOptionalString(input, ["model", "default-model", "defaultModel"]),
    defaultPermissionMode: readOptionalString(input, [
      "permission-mode",
      "permissionMode",
      "default-permission-mode",
      "defaultPermissionMode",
    ]),
    secretBindings: readSecretBindings(input),
    publish: readOptionalBoolean(input, ["publish"]) ?? true,
    activate: readOptionalBoolean(input, ["activate"]) ?? false,
  });
  return {
    flow: created,
    runtime: getFlowV1DetailProjection(created.flowId)?.runtime ?? null,
  };
}

async function authoringSubmitCommand(input: CliInput) {
  const jobId = readRequiredString(input, ["job-id", "jobId"]);
  const directory = readRequiredString(input, [
    "directory",
    "bundle-dir",
    "bundleDir",
  ]);
  const skipSemanticReview =
    readOptionalBoolean(input, [
      "skip-semantic-review",
      "skipSemanticReview",
    ]) ?? false;
  const reason = readOptionalString(input, ["reason"]);

  try {
    return await submitAuthoringFlowBundle({
      jobId,
      directory,
      skipSemanticReview,
      reason,
    });
  } catch (error) {
    if (error instanceof AuthoringSubmitError) {
      throw new CliHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

async function authoringValidateCommand(input: CliInput) {
  const jobId = readRequiredString(input, ["job-id", "jobId"]);
  const directory = readRequiredString(input, [
    "directory",
    "bundle-dir",
    "bundleDir",
  ]);
  const reviewMode = readOptionalString(input, ["review-mode", "reviewMode"]);
  const reviewerAgent = readOptionalString(input, [
    "reviewer-agent",
    "reviewerAgent",
  ]);
  const reviewerModel = readOptionalString(input, [
    "reviewer-model",
    "reviewerModel",
  ]);
  if (reviewMode !== undefined && reviewMode !== "none" && reviewMode !== "agent") {
    throw new CliHttpError(
      "invalid_input",
      'review-mode must be "none" or "agent".',
      400,
    );
  }

  try {
    const validation = await validateAuthoringFlowBundleWithReview({
      jobId,
      directory,
      reviewMode: reviewMode ?? "none",
      reviewerAgent,
      reviewerModel,
    });
    return {
      ...validation,
      bundle: validation.bundle
        ? {
            schemaVersion: validation.bundle.schemaVersion,
            hash: validation.bundle.hash,
            files: validation.bundle.files.map((entry) => entry.path),
          }
        : null,
    };
  } catch (error) {
    if (error instanceof AuthoringSubmitError) {
      throw new CliHttpError(error.code, error.message, error.status);
    }
    throw error;
  }
}

async function authoringReviewGetCommand(input: CliInput) {
  const jobId = readRequiredString(input, ["job-id", "jobId"]);
  return { review: await refreshAuthoringSemanticReview(jobId) };
}

async function authoringReviewWaitCommand(input: CliInput) {
  const jobId = readRequiredString(input, ["job-id", "jobId"]);
  const review = await refreshAuthoringSemanticReview(jobId);
  if (!review) {
    throw new CliHttpError(
      "semantic_review_not_found",
      "No semantic review exists for this authoring job.",
      404,
    );
  }
  if (review.status === "running") {
    return {
      value: { review },
      continuation: {
        state: "pending" as const,
        retryAfterMs: RUNS_WAIT_CONTINUATION_RETRY_MS,
      },
    };
  }
  return { value: { review } };
}

async function runCommand(input: CliInput) {
  const workflowId = readRequiredString(input, ["workflow-id", "workflowId"]);
  const agent = readOptionalString(input, ["agent"]);
  const model = readOptionalString(input, ["model"]);
  const permissionMode = readOptionalString(input, [
    "permission-mode",
    "permissionMode",
  ]);
  const cwd = readOptionalString(input, ["cwd"]);
  const detail = getWorkflowDetail(workflowId);
  if (
    !detail?.currentVersion ||
    !getFlowV1BundleForVersion(detail.currentVersion.id)
  ) {
    throw new CliHttpError(
      "flow_bundle_not_found",
      "Flow v1 Bundle not found.",
      404,
    );
  }
  try {
    const result = await dispatchFlowV1({
      flowId: workflowId,
      invocationInput: readFlowV1JsonObject(input, [
        "inputs",
        "inputs-json",
        "inputsJson",
      ]),
      idempotencyKey: readOptionalString(input, [
        "idempotency-key",
        "idempotencyKey",
      ]),
      projectCwd: cwd,
      defaultAgent: agent,
      defaultModel: model,
      defaultPermissionMode: permissionMode,
    });
    return {
      action: result.action,
      cycle: result.tick.cycle,
      run: result.tick.run,
    };
  } catch (error) {
    if (error instanceof FlowV1ServiceError) {
      throw new CliHttpError(error.code, error.message, 409);
    }
    throw error;
  }
}

function lifecycleCommand(
  input: CliInput,
  lifecycle: "active" | "paused",
) {
  const flowId = readRequiredString(input, ["workflow-id", "workflowId"]);
  try {
    setFlowV1Lifecycle({ flowId, lifecycle });
  } catch (error) {
    if (error instanceof FlowV1ServiceError) {
      throw new CliHttpError(error.code, error.message, 404);
    }
    throw error;
  }
  return {
    runtime: getFlowV1DetailProjection(flowId)?.runtime ?? null,
  };
}

function cancelCycleCommand(input: CliInput) {
  const flowId = readRequiredString(input, ["workflow-id", "workflowId"]);
  const runId = readOptionalString(input, ["run-id", "runId"]);
  const cycleId = readOptionalString(input, ["cycle-id", "cycleId"]);
  let resolvedCycleId = cycleId;
  if (runId) {
    const run = getFlowV1Run(runId);
    if (!run || run.flowId !== flowId) {
      throw new CliHttpError("run_not_found", "Tick not found.", 404);
    }
    if (cycleId && cycleId !== run.cycleId) {
      throw new CliHttpError(
        "invalid_input",
        "The supplied Tick and Cycle do not belong together.",
        400,
      );
    }
    resolvedCycleId = run.cycleId;
  }
  try {
    return {
      cancellation: cancelFlowV1Cycle({
        flowId,
        ...(resolvedCycleId ? { cycleId: resolvedCycleId } : {}),
      }),
    };
  } catch (error) {
    if (error instanceof FlowV1ServiceError) {
      throw new CliHttpError(error.code, error.message, 409);
    }
    throw error;
  }
}

function configureCommand(input: CliInput) {
  const flowId = readRequiredString(input, ["workflow-id", "workflowId"]);
  try {
    return {
      config: configureFlowV1({
        flowId,
        params: readFlowV1JsonObject(input, [
          "params",
          "params-json",
          "paramsJson",
        ]),
        expectedParamsRevision: readOptionalInteger(input, [
          "expected-params-revision",
          "expectedParamsRevision",
        ]),
        projectCwd: readOptionalString(input, [
          "cwd",
          "project-cwd",
          "projectCwd",
        ]),
        defaultAgent: readOptionalString(input, [
          "agent",
          "default-agent",
          "defaultAgent",
        ]),
        defaultModel: readOptionalString(input, [
          "model",
          "default-model",
          "defaultModel",
        ]),
        defaultPermissionMode: readOptionalString(input, [
          "permission-mode",
          "permissionMode",
          "default-permission-mode",
          "defaultPermissionMode",
        ]),
        secretBindings: readSecretBindings(input),
      }),
    };
  } catch (error) {
    if (
      error instanceof FlowV1ServiceError ||
      (error instanceof Error && "code" in error)
    ) {
      const code =
        "code" in error && typeof error.code === "string"
          ? error.code
          : "flow_configuration_invalid";
      throw new CliHttpError(code, error.message, 400);
    }
    throw error;
  }
}

async function resumeCommand(input: CliInput) {
  const workflowId = readRequiredString(input, ["workflow-id", "workflowId"]);
  const runId = readRequiredString(input, ["run-id", "runId"]);
  const flowRun = getFlowV1Run(runId);
  if (!flowRun || flowRun.flowId !== workflowId) {
    throw new CliHttpError("run_not_found", "Tick not found.", 404);
  }
  const result = await dispatchFlowV1({ flowId: workflowId });
  return {
    cycle: result.tick.cycle,
    run: result.tick.run,
  };
}

// The terminal CLI owns the durable wait loop. A pending response is compact
// and asks it to check again after the protocol's longest supported delay,
// keeping long-running workflows cheap while hiding retries from callers.
const RUNS_WAIT_CONTINUATION_RETRY_MS = 60_000;

async function runsGetCommand(input: CliInput) {
  const runId = readRequiredString(input, ["run-id", "runId"]);
  const flowRun = getFlowV1Run(runId);
  if (!flowRun) {
    throw new CliHttpError("run_not_found", "Tick not found.", 404);
  }
  return buildFlowV1RunDetail(flowRun);
}

async function runsWaitCommand(input: CliInput) {
  const runId = readRequiredString(input, ["run-id", "runId"]);
  const flowRun = getFlowV1Run(runId);
  if (!flowRun) {
    throw new CliHttpError("run_not_found", "Tick not found.", 404);
  }
  if (
    flowRun.status !== "pending" &&
    flowRun.status !== "running"
  ) {
    return {
      value: {
        reason: flowRun.stopReason ?? flowRun.status,
        ...buildFlowV1RunDetail(flowRun),
      },
    };
  }
  return {
    value: {
      run: flowRun,
      cycle: getFlowV1Cycle(flowRun.cycleId),
    },
    continuation: {
      state: "pending" as const,
      retryAfterMs: RUNS_WAIT_CONTINUATION_RETRY_MS,
    },
  };
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

  const run = getFlowV1Run(runId);
  if (!run) {
    throw new CliHttpError("run_not_found", "Tick not found.", 404);
  }
  const task = getWorkflowHumanTask(taskId);
  if (!task || task.runId !== runId) {
    throw new CliHttpError("human_task_not_found", "Human task not found.", 404);
  }
  const revision = providedRevision ?? task.revision;

  try {
    const result = await respondToFlowV1HumanTask({
      flowId: run.flowId,
      runId,
      taskId,
      action,
      values,
      revision,
      resolvedBy: "agent-cli",
    });
    return {
      task: result.task,
      run: result.tick.run,
      execution: result.execution,
    };
  } catch (error) {
    if (error instanceof FlowV1ServiceError) {
      throw new CliHttpError(
        error.code,
        error.message,
        error.code === "flow_human_task_not_found" ? 404 : 409,
      );
    }
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

function buildFlowV1RunDetail(
  run: NonNullable<ReturnType<typeof getFlowV1Run>>,
) {
  return {
    run,
    cycle: getFlowV1Cycle(run.cycleId),
    checkpoint: getFlowV1CycleCheckpoint(run.cycleId),
    attempts: listFlowV1NodeAttempts(run.cycleId),
    effects: listFlowV1Effects(run.cycleId),
    humanTasks: listFlowV1HumanTasks(run.cycleId),
  };
}

function readFlowV1JsonObject(
  input: CliInput,
  keys: string[],
): FlowV1JsonObject | undefined {
  let raw: unknown;
  for (const key of keys) {
    if (input[key] !== undefined) {
      raw = input[key];
      break;
    }
  }
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      throw new CliHttpError(
        "invalid_input",
        `${keys[0]} must be a JSON object: ${
          error instanceof Error ? error.message : "invalid JSON"
        }`,
        400,
      );
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliHttpError(
      "invalid_input",
      `${keys[0]} must be a JSON object.`,
      400,
    );
  }
  return raw as FlowV1JsonObject;
}

function readSecretBindings(
  input: CliInput,
): Record<string, FlowV1SecretBinding> | undefined {
  const raw = readFlowV1JsonObject(input, [
    "secret-bindings",
    "secretBindings",
    "secret-bindings-json",
    "secretBindingsJson",
  ]);
  if (!raw) {
    return undefined;
  }
  const bindings: Record<string, FlowV1SecretBinding> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.kind !== "environment" ||
      typeof value.env !== "string"
    ) {
      throw new CliHttpError(
        "invalid_input",
        `Secret binding ${name} must be {"kind":"environment","env":"ENV_NAME"}.`,
        400,
      );
    }
    bindings[name] = { kind: "environment", env: value.env };
  }
  return bindings;
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

function cliJson(
  value: unknown,
  continuation?: { state: "pending"; retryAfterMs: number },
) {
  return NextResponse.json({
    kind: "json",
    value,
    ...(continuation ? { continuation } : {}),
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
