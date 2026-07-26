import { builtinModules } from "node:module";
import path from "node:path";
import { parse } from "@babel/parser";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";
import {
  FLOW_V1_ENTRY_FILE,
  getFlowV1BundleFile,
} from "./bundle";
import {
  FLOW_V1_SCHEMA_VERSION,
  type FlowV1Bundle,
  type FlowV1ControlEdge,
  type FlowV1CycleDefinition,
  type FlowV1DataEdge,
  type FlowV1JsonObject,
  type FlowV1JsonValue,
  type FlowV1HumanSpec,
  type FlowV1CompositeAgentStep,
  type FlowV1CompositeHumanStep,
  type FlowV1MemoryDefinition,
  type FlowV1MemoryUpdateSpec,
  type FlowV1LoopSpec,
  type FlowV1MapSpec,
  type FlowV1Node,
  type FlowV1NodeKind,
  type FlowV1Reference,
  type FlowV1RetryPolicy,
  type FlowV1RuntimeDefinition,
  type FlowV1ScheduleDefinition,
  type FlowV1SchemaEntry,
  type ParsedFlowV1,
} from "./types";

type AstNode = {
  type: string;
  start?: number | null;
  end?: number | null;
  [key: string]: unknown;
};

type ParserState = {
  bundle: FlowV1Bundle;
  diagnostics: WorkflowDiagnostic[];
  nodes: FlowV1Node[];
  variableToNodeId: Record<string, string>;
  pendingRoutes: AstNode[];
};

const NODE_CALLS: Record<string, FlowV1NodeKind> = {
  agent: "agent",
  human: "human",
  script: "script",
  transform: "transform",
  gate: "gate",
  effect: "effect",
  finally: "finally",
  finalize: "finally",
  loop: "loop",
  map: "map",
  remember: "remember",
  completeCycle: "complete_cycle",
  cancelCycle: "cancel_cycle",
};

const CODE_NODE_EXPORTS: Partial<Record<FlowV1NodeKind, string[]>> = {
  script: ["run"],
  transform: ["run"],
  gate: ["check"],
  effect: ["apply", "reconcile"],
  finally: ["run"],
};

const RESERVED_REFERENCE_ROOTS = new Set([
  "params",
  "inputs",
  "secrets",
  "invocation",
  "cycle",
  "memory",
]);

const NODE_BUILTINS = new Set(
  builtinModules.flatMap((moduleName) => [
    moduleName,
    moduleName.startsWith("node:") ? moduleName : `node:${moduleName}`,
  ]),
);

const DEFAULT_META = {
  name: "untitled-flow",
  description: "",
  requiresCwd: false,
};

const DEFAULT_CYCLES: FlowV1CycleDefinition = {
  mode: "singleton",
};

const DEFAULT_RUNTIME: FlowV1RuntimeDefinition = {
  maxNodeExecutionsPerTick: 100,
  maxImmediateContinuations: 3,
  maxParallelNodes: 4,
};

export function parseFlowV1Bundle(bundle: FlowV1Bundle): ParsedFlowV1 {
  const state: ParserState = {
    bundle,
    diagnostics: [],
    nodes: [],
    variableToNodeId: {},
    pendingRoutes: [],
  };
  const entry = getFlowV1BundleFile(bundle, FLOW_V1_ENTRY_FILE);
  if (!entry) {
    return emptyParsedFlow([
      diagnostic(
        "bundle.entry_missing",
        `Flow Bundle must contain ${FLOW_V1_ENTRY_FILE}.`,
        FLOW_V1_ENTRY_FILE,
      ),
    ]);
  }

  const ast = parseModule(entry.content, FLOW_V1_ENTRY_FILE, state.diagnostics);
  if (!ast) {
    return emptyParsedFlow(state.diagnostics);
  }

  let schemaVersion: string | undefined;
  let meta = { ...DEFAULT_META };
  let params: Record<string, FlowV1SchemaEntry> = {};
  let inputs: Record<string, FlowV1SchemaEntry> = {};
  let secrets: Record<string, FlowV1SchemaEntry> = {};
  let cycles: FlowV1CycleDefinition = { ...DEFAULT_CYCLES };
  let schedule: FlowV1ScheduleDefinition | null = null;
  let memory: FlowV1MemoryDefinition | null = null;
  let runtime = { ...DEFAULT_RUNTIME };

  for (const statement of getProgramBody(ast)) {
    const declaration = unwrapExportDeclaration(statement);
    if (declaration?.type === "VariableDeclaration") {
      for (const variable of asNodeArray(declaration.declarations)) {
        const variableName = readIdentifierName(asNode(variable.id));
        const initializer = unwrapExpression(asNode(variable.init));
        if (!variableName || !initializer) {
          continue;
        }
        if (isExported(statement)) {
          switch (variableName) {
            case "schemaVersion":
              schemaVersion = readString(initializer);
              continue;
            case "meta":
              meta = readMeta(initializer, state);
              continue;
            case "params":
              params = readSchemaDeclaration(
                initializer,
                "defineParams",
                "params",
                state,
              );
              continue;
            case "inputs":
              inputs = readSchemaDeclaration(
                initializer,
                "defineInputs",
                "inputs",
                state,
              );
              continue;
            case "secrets":
              secrets = readSchemaDeclaration(
                initializer,
                "defineSecrets",
                "secrets",
                state,
              );
              continue;
            case "cycles":
              cycles = readCycles(initializer, state);
              continue;
            case "schedule":
              schedule = readSchedule(initializer, state);
              continue;
            case "memory":
              memory = readMemory(initializer, state);
              continue;
            case "runtime":
              runtime = readRuntime(initializer, state);
              continue;
            default:
              break;
          }
        }
        addNode(initializer, variableName, state);
      }
      continue;
    }

    const expression = unwrapExpression(
      statement.type === "ExpressionStatement"
        ? asNode(statement.expression)
        : undefined,
    );
    if (!expression) {
      continue;
    }
    if (isCall(expression, "route")) {
      state.pendingRoutes.push(expression);
    } else {
      addNode(expression, undefined, state);
    }
  }

  if (schemaVersion !== FLOW_V1_SCHEMA_VERSION) {
    state.diagnostics.push(
      diagnostic(
        "flow.schema_version_invalid",
        `schemaVersion must be "${FLOW_V1_SCHEMA_VERSION}".`,
        "schemaVersion",
      ),
    );
  }

  validateDuplicateNodes(state);
  const dataEdges = buildDataEdges(state);
  const controlEdges = buildControlEdges(state);
  const edges = [...dataEdges, ...controlEdges];
  validateSchemaReferences({ params, inputs, secrets, nodes: state.nodes }, state);
  validateSchedule(schedule, inputs, state);
  validateCycleAndMemory(cycles, memory, state);
  validateControlOutcomes(state.nodes, controlEdges, state);
  validateReachableTerminal(state.nodes, edges, state);
  validateBundleModules(state);

  return {
    schemaVersion,
    meta,
    params,
    inputs,
    secrets,
    cycles,
    schedule,
    memory,
    runtime,
    nodes: state.nodes,
    edges,
    variableToNodeId: state.variableToNodeId,
    diagnostics: state.diagnostics,
  };
}

function emptyParsedFlow(diagnostics: WorkflowDiagnostic[]): ParsedFlowV1 {
  return {
    meta: { ...DEFAULT_META },
    params: {},
    inputs: {},
    secrets: {},
    cycles: { ...DEFAULT_CYCLES },
    schedule: null,
    memory: null,
    runtime: { ...DEFAULT_RUNTIME },
    nodes: [],
    edges: [],
    variableToNodeId: {},
    diagnostics,
  };
}

function readMeta(initializer: AstNode, state: ParserState) {
  const properties = readObjectProperties(initializer);
  if (!properties) {
    state.diagnostics.push(
      diagnostic("flow.meta_invalid", "meta must be an object literal.", "meta"),
    );
    return { ...DEFAULT_META };
  }
  return {
    name: readString(properties.get("name")) ?? DEFAULT_META.name,
    description:
      readString(properties.get("description")) ?? DEFAULT_META.description,
    requiresCwd:
      readBoolean(properties.get("requiresCwd")) ?? DEFAULT_META.requiresCwd,
  };
}

function readSchemaDeclaration(
  initializer: AstNode,
  expectedCall: string,
  namespace: string,
  state: ParserState,
): Record<string, FlowV1SchemaEntry> {
  if (!isCall(initializer, expectedCall)) {
    state.diagnostics.push(
      diagnostic(
        "flow.schema_declaration_invalid",
        `${namespace} must use ${expectedCall}({...}).`,
        namespace,
      ),
    );
    return {};
  }
  const object = readObjectProperties(firstArgument(initializer));
  if (!object) {
    state.diagnostics.push(
      diagnostic(
        "flow.schema_declaration_invalid",
        `${expectedCall} requires an object literal.`,
        namespace,
      ),
    );
    return {};
  }

  const entries: Record<string, FlowV1SchemaEntry> = {};
  for (const [name, value] of object) {
    const call = unwrapExpression(value);
    if (!call || call.type !== "CallExpression") {
      state.diagnostics.push(
        diagnostic(
          "flow.schema_entry_invalid",
          `${namespace}.${name} must use a typed schema helper.`,
          `${namespace}.${name}`,
          value,
        ),
      );
      continue;
    }
    const helper = readCalleeName(call);
    const configNode = firstArgument(call);
    const config = readStaticObject(configNode) ?? {};
    entries[name] = {
      name,
      helper: helper ?? "unknown",
      required: config.required === true,
      hasDefault: Object.hasOwn(config, "default"),
      config,
    };
  }
  return entries;
}

function readCycles(
  initializer: AstNode,
  state: ParserState,
): FlowV1CycleDefinition {
  if (!isCall(initializer, "defineCycles")) {
    state.diagnostics.push(
      diagnostic(
        "flow.cycles_invalid",
        "cycles must use defineCycles({...}).",
        "cycles",
      ),
    );
    return { ...DEFAULT_CYCLES };
  }
  const properties = readObjectProperties(firstArgument(initializer));
  const mode = readString(properties?.get("mode"));
  const key = readReference(properties?.get("key"));
  if (mode !== "singleton" && mode !== "keyed") {
    state.diagnostics.push(
      diagnostic(
        "flow.cycles_mode_invalid",
        'cycles.mode must be "singleton" or "keyed".',
        "cycles.mode",
      ),
    );
    return { ...DEFAULT_CYCLES };
  }
  return {
    mode,
    ...(key ? { key } : {}),
  };
}

function readSchedule(
  initializer: AstNode,
  state: ParserState,
): FlowV1ScheduleDefinition | null {
  if (!isCall(initializer, "cron")) {
    state.diagnostics.push(
      diagnostic(
        "flow.schedule_invalid",
        "schedule must use cron({...}).",
        "schedule",
      ),
    );
    return null;
  }
  const properties = readObjectProperties(firstArgument(initializer));
  if (!properties) {
    state.diagnostics.push(
      diagnostic(
        "flow.schedule_invalid",
        "cron requires an object literal.",
        "schedule",
      ),
    );
    return null;
  }
  const id = readString(properties.get("id")) ?? "main_schedule";
  const expression =
    readReference(properties.get("expression")) ??
    readString(properties.get("expression"));
  const timezone =
    readReference(properties.get("timezone")) ??
    readString(properties.get("timezone"));
  const catchUp = readString(properties.get("catchUp")) ?? "latest";
  const overlap =
    readString(properties.get("overlap")) ?? "coalesce-latest";
  const inputProperties = readObjectProperties(properties.get("inputs"));
  const scheduleInputs: Record<string, FlowV1Reference | FlowV1JsonValue> = {};
  for (const [name, value] of inputProperties ?? []) {
    const reference = readReference(value);
    const literal = readStaticValue(value);
    if (reference) {
      scheduleInputs[name] = reference;
    } else if (literal !== undefined) {
      scheduleInputs[name] = literal;
    } else {
      state.diagnostics.push(
        diagnostic(
          "flow.schedule_input_invalid",
          `schedule.inputs.${name} must be a ref(...) or JSON literal.`,
          `schedule.inputs.${name}`,
          value,
        ),
      );
    }
  }
  if (!expression || !timezone) {
    state.diagnostics.push(
      diagnostic(
        "flow.schedule_config_incomplete",
        "cron requires expression and timezone.",
        "schedule",
      ),
    );
    return null;
  }
  if (catchUp !== "latest") {
    state.diagnostics.push(
      diagnostic(
        "flow.schedule_catch_up_invalid",
        'schedule.catchUp must be "latest" in v1.',
        "schedule.catchUp",
      ),
    );
  }
  if (overlap !== "coalesce-latest" && overlap !== "skip") {
    state.diagnostics.push(
      diagnostic(
        "flow.schedule_overlap_invalid",
        'schedule.overlap must be "coalesce-latest" or "skip".',
        "schedule.overlap",
      ),
    );
  }
  return {
    id,
    expression,
    timezone,
    catchUp: "latest",
    overlap:
      overlap === "skip" ? "skip" : "coalesce-latest",
    inputs: scheduleInputs,
  };
}

function readMemory(
  initializer: AstNode,
  state: ParserState,
): FlowV1MemoryDefinition | null {
  if (!isCall(initializer, "defineMemory")) {
    state.diagnostics.push(
      diagnostic(
        "flow.memory_invalid",
        "memory must use defineMemory({...}).",
        "memory",
      ),
    );
    return null;
  }
  const root = readObjectProperties(firstArgument(initializer));
  const sectionProperties = readObjectProperties(root?.get("sections"));
  if (!sectionProperties || sectionProperties.size === 0) {
    state.diagnostics.push(
      diagnostic(
        "flow.memory_sections_missing",
        "memory.sections must declare at least one Markdown section.",
        "memory.sections",
      ),
    );
    return { sections: {} };
  }
  const sections: FlowV1MemoryDefinition["sections"] = {};
  for (const [id, value] of sectionProperties) {
    const config = readObjectProperties(value);
    const title = readString(config?.get("title"));
    const update = readString(config?.get("update"));
    if (!title || (update !== "replace" && update !== "append")) {
      state.diagnostics.push(
        diagnostic(
          "flow.memory_section_invalid",
          `Memory section ${id} requires title and update "replace" or "append".`,
          `memory.sections.${id}`,
          value,
        ),
      );
      continue;
    }
    sections[id] = { id, title, update };
  }
  return { sections };
}

function readRuntime(initializer: AstNode, state: ParserState) {
  const properties = readObjectProperties(initializer);
  if (!properties) {
    state.diagnostics.push(
      diagnostic(
        "flow.runtime_invalid",
        "runtime must be an object literal.",
        "runtime",
      ),
    );
    return { ...DEFAULT_RUNTIME };
  }
  return {
    maxNodeExecutionsPerTick: readBoundedInteger(
      properties.get("maxNodeExecutionsPerTick"),
      DEFAULT_RUNTIME.maxNodeExecutionsPerTick,
      "runtime.maxNodeExecutionsPerTick",
      state,
    ),
    maxImmediateContinuations: readBoundedInteger(
      properties.get("maxImmediateContinuations"),
      DEFAULT_RUNTIME.maxImmediateContinuations,
      "runtime.maxImmediateContinuations",
      state,
    ),
    maxParallelNodes: readBoundedInteger(
      properties.get("maxParallelNodes"),
      DEFAULT_RUNTIME.maxParallelNodes,
      "runtime.maxParallelNodes",
      state,
    ),
  };
}

function addNode(
  initializer: AstNode,
  variableName: string | undefined,
  state: ParserState,
): void {
  const callName = readCalleeName(initializer);
  const kind = callName ? NODE_CALLS[callName] : undefined;
  if (!kind) {
    return;
  }
  const properties = readObjectProperties(firstArgument(initializer));
  const id = readString(properties?.get("id"));
  if (!id) {
    state.diagnostics.push(
      diagnostic(
        "flow.node_id_missing",
        `${callName} node requires a non-empty id.`,
        variableName ? `nodes.${variableName}` : "nodes",
        initializer,
      ),
    );
    return;
  }
  const inputs: Record<string, FlowV1Reference> = {};
  for (const [name, value] of readObjectProperties(properties?.get("inputs")) ??
    []) {
    const reference = readReference(value) ?? readIdentifierReference(value);
    if (reference) {
      inputs[name] = reference;
    }
  }
  const prompt = readString(properties?.get("prompt"));
  if (prompt) {
    for (const [index, expression] of extractTemplateReferences(prompt).entries()) {
      const reference = referenceFromExpression(expression);
      if (!inputs[reference.source]) {
        inputs[`$prompt.${index}`] = reference;
      }
    }
    if (extractTemplateReferences(prompt).some((entry) => entry.startsWith("secrets."))) {
      state.diagnostics.push(
        diagnostic(
          "flow.secret_prompt_forbidden",
          `Agent prompt for ${id} must not reference secrets.`,
          `nodes.${id}.prompt`,
          properties?.get("prompt"),
        ),
      );
    }
  }
  const human = kind === "human" ? readHumanSpec(properties, id, state) : undefined;
  if (human) {
    for (const [index, item] of human.context.entries()) {
      for (const [refIndex, expression] of extractTemplateReferences(
        item.value,
      ).entries()) {
        const reference = referenceFromExpression(expression);
        if (!inputs[reference.source]) {
          inputs[`$human.${index}.${refIndex}`] = reference;
        }
      }
    }
  }
  const memoryUpdates =
    kind === "remember"
      ? readMemoryUpdates(properties?.get("updates"), id, state)
      : undefined;
  for (const [sectionId, update] of Object.entries(memoryUpdates ?? {})) {
    if (typeof update.value !== "string") {
      inputs[`$memory.${sectionId}`] = update.value;
    }
  }
  const loop = kind === "loop" ? readLoopSpec(properties, id, state) : undefined;
  const map = kind === "map" ? readMapSpec(properties, id, state) : undefined;
  if (loop && typeof loop.maxIterations !== "number") {
    inputs["$loop.maxIterations"] = loop.maxIterations;
  }
  for (const step of [...(loop?.steps ?? []), ...(map?.steps ?? [])]) {
    if (step.kind !== "agent") continue;
    for (const [name, value] of [
      ["agent", step.agent],
      ["model", step.model],
      ["permissionMode", step.permissionMode],
    ] as const) {
      if (value && typeof value !== "string") {
        inputs[`$config.${step.id}.${name}`] = value;
      }
    }
  }
  if (map) {
    inputs["$map.source"] = map.source;
  }
  if (properties?.has("source") && kind !== "map") {
    state.diagnostics.push(
      diagnostic(
        "flow.inline_script_forbidden",
        `Node ${id} must reference a Bundle file; inline source is forbidden.`,
        `nodes.${id}.source`,
        properties.get("source"),
      ),
    );
  }
  const idempotencyNode = properties?.get("idempotencyKey");
  const idempotencyKey =
    readString(idempotencyNode) ??
    readReference(idempotencyNode) ??
    readSingleStringCall(idempotencyNode, "template");
  const retry = properties?.has("retry")
    ? readRetryPolicy(properties.get("retry"), id, kind, state)
    : undefined;
  const workspace =
    readReference(properties?.get("workspace")) ??
    readIdentifierReference(properties?.get("workspace"));
  if (workspace) {
    inputs["$workspace"] = workspace;
  }
  const execution = readExecutionContract(properties?.get("execution"));
  const agent = readResolvableString(properties?.get("agent"));
  const model = readResolvableString(properties?.get("model"));
  const permissionMode = readResolvableString(
    properties?.get("permissionMode"),
  );
  const output = readAgentOutput(
    properties?.get("output"),
    id,
    state,
  );
  for (const [name, value] of [
    ["agent", agent],
    ["model", model],
    ["permissionMode", permissionMode],
  ] as const) {
    if (value && typeof value !== "string") {
      inputs[`$config.${name}`] = value;
    }
  }
  const node: FlowV1Node = {
    id,
    ...(variableName ? { variableName } : {}),
    kind,
    label: readString(properties?.get("label")) ?? id,
    ...(readString(properties?.get("file"))
      ? { file: readString(properties?.get("file")) }
      : {}),
    ...(prompt ? { prompt } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(readString(properties?.get("cwd"))
      ? { cwd: readString(properties?.get("cwd")) }
      : {}),
    ...(workspace ? { workspace } : {}),
    ...(execution ? { execution } : {}),
    ...(human ? { human } : {}),
    ...(loop ? { loop } : {}),
    ...(map ? { map } : {}),
    ...(output ? { output } : {}),
    outcomes:
      kind === "human" && human
        ? human.actions.map((action) => action.id)
        : kind === "loop"
          ? ["matched", "exhausted"]
          : kind === "map"
            ? ["all_succeeded", "partial", "all_rejected"]
          : readStringArray(properties?.get("outcomes")),
    inputs,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(retry ? { retry } : {}),
    ...(readRunOn(properties?.get("runOn"))
      ? { runOn: readRunOn(properties?.get("runOn")) }
      : {}),
    ...(kind === "finally" &&
    readBoolean(properties?.get("retainOnFailure")) !== undefined
      ? {
          retainOnFailure:
            readBoolean(properties?.get("retainOnFailure")) ?? false,
        }
      : {}),
    ...(readMemoryIncludes(properties?.get("memory"))
      ? { memorySections: readMemoryIncludes(properties?.get("memory")) }
      : {}),
    ...(memoryUpdates ? { memoryUpdates } : {}),
    ...(kind === "complete_cycle" || kind === "cancel_cycle"
      ? readContinueMode(properties?.get("continue"))
        ? { continueMode: readContinueMode(properties?.get("continue")) }
        : {}
      : {}),
    ...(kind === "complete_cycle" || kind === "cancel_cycle"
      ? readString(properties?.get("outcome"))
        ? { terminalOutcome: readString(properties?.get("outcome")) }
        : {}
      : {}),
    ...(rangeOf(initializer) ? { sourceRange: rangeOf(initializer) } : {}),
  };
  state.nodes.push(node);
  if (variableName) {
    state.variableToNodeId[variableName] = id;
  }
  if (kind === "effect" && !idempotencyKey) {
    state.diagnostics.push(
      diagnostic(
        "flow.effect_idempotency_required",
        `Effect ${id} must declare idempotencyKey.`,
        `nodes.${id}.idempotencyKey`,
        initializer,
      ),
    );
  }
  if (kind === "agent" && !prompt) {
    state.diagnostics.push(
      diagnostic(
        "flow.agent_prompt_required",
        `Agent ${id} must declare a prompt.`,
        `nodes.${id}.prompt`,
        initializer,
      ),
    );
  }
  if (
    (kind === "complete_cycle" || kind === "cancel_cycle") &&
    properties?.has("continue") &&
    !readContinueMode(properties.get("continue"))
  ) {
    state.diagnostics.push(
      diagnostic(
        "flow.cycle_continue_invalid",
        `Node ${id} continue must be "immediate" or "scheduled".`,
        `nodes.${id}.continue`,
        properties.get("continue"),
      ),
    );
  }
}

function readRetryPolicy(
  node: AstNode | undefined,
  nodeId: string,
  kind: FlowV1NodeKind,
  state: ParserState,
): FlowV1RetryPolicy | undefined {
  const properties = readObjectProperties(node);
  const maxAttempts = readNumber(properties?.get("maxAttempts"));
  const errorCodes = readStringArray(properties?.get("errorCodes"));
  const backoffMs = readNumber(properties?.get("backoffMs")) ?? 0;
  const validCodes =
    errorCodes.length > 0 &&
    errorCodes.every((code) => /^[a-z][a-z0-9_.-]*$/u.test(code));
  if (
    kind !== "script" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts! < 2 ||
    maxAttempts! > 10 ||
    !validCodes ||
    !Number.isInteger(backoffMs) ||
    backoffMs < 0 ||
    backoffMs > 30_000
  ) {
    state.diagnostics.push(
      diagnostic(
        "flow.script_retry_invalid",
        `Script ${nodeId} retry requires maxAttempts 2..10, explicit structural errorCodes, and backoffMs 0..30000.`,
        `nodes.${nodeId}.retry`,
        node,
      ),
    );
    return undefined;
  }
  return {
    maxAttempts: maxAttempts!,
    errorCodes,
    backoffMs,
  };
}

function readContinueMode(
  node: AstNode | undefined,
): "immediate" | "scheduled" | undefined {
  const value = readString(node);
  return value === "immediate" || value === "scheduled" ? value : undefined;
}

function readExecutionContract(
  node: AstNode | undefined,
): FlowV1Node["execution"] | undefined {
  const properties = readObjectProperties(node);
  const access = readString(properties?.get("access"));
  const isolation = readString(properties?.get("isolation"));
  if (
    (access === "read" || access === "write" || access === "review") &&
    (isolation === "shared" || isolation === "required")
  ) {
    return { access, isolation };
  }
  return undefined;
}

function readMemoryUpdates(
  node: AstNode | undefined,
  nodeId: string,
  state: ParserState,
): Record<string, FlowV1MemoryUpdateSpec> | undefined {
  const properties = readObjectProperties(node);
  if (!properties || properties.size === 0) {
    state.diagnostics.push(
      diagnostic(
        "flow.memory_updates_missing",
        `Remember ${nodeId} must declare updates.`,
        `nodes.${nodeId}.updates`,
        node,
      ),
    );
    return undefined;
  }
  const updates: Record<string, FlowV1MemoryUpdateSpec> = {};
  for (const [sectionId, value] of properties) {
    const config = readObjectProperties(value);
    const mode = readString(config?.get("mode"));
    const updateValue =
      readReference(config?.get("value")) ??
      readIdentifierReference(config?.get("value")) ??
      readString(config?.get("value"));
    if (
      (mode !== "replace" && mode !== "append") ||
      updateValue === undefined
    ) {
      state.diagnostics.push(
        diagnostic(
          "flow.memory_update_invalid",
          `Remember ${nodeId} update ${sectionId} requires mode and a static string or ref value.`,
          `nodes.${nodeId}.updates.${sectionId}`,
          value,
        ),
      );
      continue;
    }
    updates[sectionId] = { mode, value: updateValue };
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
}

function readHumanSpec(
  properties: Map<string, AstNode> | null,
  nodeId: string,
  state: ParserState,
): FlowV1HumanSpec | undefined {
  const raw = readStaticValue({
    type: "ObjectExpression",
    properties: [
      ...["description", "context", "actions"]
        .filter((key) => properties?.has(key))
        .map((key) => ({
          type: "ObjectProperty",
          key: { type: "Identifier", name: key },
          value: properties!.get(key),
        })),
    ],
  } as AstNode);
  if (!isHumanSpec(raw)) {
    state.diagnostics.push(
      diagnostic(
        "flow.human_spec_invalid",
        `Human ${nodeId} requires static context and at least one valid action.`,
        `nodes.${nodeId}`,
      ),
    );
    return undefined;
  }
  return raw;
}

function readLoopSpec(
  properties: Map<string, AstNode> | null,
  nodeId: string,
  state: ParserState,
): FlowV1LoopSpec | undefined {
  const maxIterations =
    readNumber(properties?.get("maxIterations")) ??
    readReference(properties?.get("maxIterations"));
  const onMaxIterations =
    readString(properties?.get("onMaxIterations")) ?? "fail";
  const steps = readCompositeSteps(
    properties?.get("steps"),
    nodeId,
    true,
    state,
  );
  const untilProperties = readObjectProperties(properties?.get("until"));
  const source = readString(untilProperties?.get("source"));
  const finalStatus = readString(untilProperties?.get("finalStatus"));
  const equals = readStaticValue(untilProperties?.get("equals"));
  const firstIteration = readObjectProperties(
    properties?.get("firstIteration"),
  );
  const startAt = readString(firstIteration?.get("startAt"));
  if (
    (!isReference(maxIterations) &&
      (!Number.isInteger(maxIterations) ||
        maxIterations! < 1 ||
        maxIterations! > 10)) ||
    (onMaxIterations !== "fail" && onMaxIterations !== "complete") ||
    steps.length === 0 ||
    !source ||
    (finalStatus === undefined && equals === undefined) ||
    (finalStatus !== undefined && equals !== undefined) ||
    !steps.some((step) => step.id === source) ||
    (startAt !== undefined && !steps.some((step) => step.id === startAt))
  ) {
    state.diagnostics.push(
      diagnostic(
        "flow.loop_invalid",
        `Loop ${nodeId} requires 1..10 maxIterations, valid steps, and an until source.`,
        `nodes.${nodeId}`,
      ),
    );
    return undefined;
  }
  return {
    maxIterations: maxIterations!,
    onMaxIterations,
    ...(startAt ? { firstIterationStartAt: startAt } : {}),
    steps,
    until:
      finalStatus !== undefined
        ? { source, finalStatus }
        : { source, equals: equals! },
  };
}

function readMapSpec(
  properties: Map<string, AstNode> | null,
  nodeId: string,
  state: ParserState,
): FlowV1MapSpec | undefined {
  const source =
    readReference(properties?.get("source")) ??
    readIdentifierReference(properties?.get("source"));
  const maxItems = readNumber(properties?.get("maxItems"));
  const onItemFailure =
    readString(properties?.get("onItemFailure")) ?? "fail";
  const onItemRejected =
    readString(properties?.get("onItemRejected")) ?? "collect";
  const itemOutcomeProperties = readObjectProperties(
    properties?.get("itemOutcome"),
  );
  const itemOutcomeSource = readString(itemOutcomeProperties?.get("source"));
  const itemOutcomeSuccess = readStringArray(
    itemOutcomeProperties?.get("success"),
  );
  const itemOutcomeRejected = readStringArray(
    itemOutcomeProperties?.get("rejected"),
  );
  const executionProperties = readObjectProperties(
    properties?.get("execution"),
  );
  const executionAccess = readString(executionProperties?.get("access"));
  const executionIsolation = readString(
    executionProperties?.get("isolation"),
  );
  const steps = readCompositeSteps(
    properties?.get("steps") ?? properties?.get("step"),
    nodeId,
    false,
    state,
  ).filter(
    (step): step is FlowV1CompositeAgentStep => step.kind === "agent",
  );
  if (
    !source ||
    !Number.isInteger(maxItems) ||
    maxItems! < 1 ||
    maxItems! > 100 ||
    (onItemFailure !== "skip" && onItemFailure !== "fail") ||
    (onItemRejected !== "collect" && onItemRejected !== "fail") ||
    steps.length === 0
  ) {
    state.diagnostics.push(
      diagnostic(
        "flow.map_invalid",
        `Map ${nodeId} requires a source, 1..100 maxItems, and Agent steps.`,
        `nodes.${nodeId}`,
      ),
    );
    return undefined;
  }
  return {
    source,
    maxItems: maxItems!,
    onItemFailure,
    onItemRejected,
    ...(itemOutcomeSource &&
    itemOutcomeSuccess.length > 0 &&
    itemOutcomeRejected.length > 0
      ? {
          itemOutcome: {
            source: itemOutcomeSource,
            success: itemOutcomeSuccess,
            rejected: itemOutcomeRejected,
          },
        }
      : {}),
    ...(executionAccess &&
    executionIsolation &&
    ["read", "write", "review"].includes(executionAccess) &&
    ["shared", "required"].includes(executionIsolation)
      ? {
          execution: {
            access: executionAccess as "read" | "write" | "review",
            isolation: executionIsolation as "shared" | "required",
          },
        }
      : {}),
    steps,
  };
}

function readCompositeSteps(
  node: AstNode | undefined,
  nodeId: string,
  allowHuman: boolean,
  state: ParserState,
): Array<FlowV1CompositeAgentStep | FlowV1CompositeHumanStep> {
  const unwrapped = unwrapExpression(node);
  const entries =
    unwrapped?.type === "ArrayExpression"
      ? asNodeArray(unwrapped.elements)
      : unwrapped
        ? [unwrapped]
        : [];
  const steps: Array<
    FlowV1CompositeAgentStep | FlowV1CompositeHumanStep
  > = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const kind = readCalleeName(entry);
    const properties = readObjectProperties(firstArgument(entry));
    const id = readString(properties?.get("id"));
    if (
      !id ||
      seen.has(id) ||
      (kind !== "agent" && (kind !== "human" || !allowHuman))
    ) {
      state.diagnostics.push(
        diagnostic(
          "flow.composite_step_invalid",
          `Composite node ${nodeId} contains an invalid or duplicate step.`,
          `nodes.${nodeId}.steps`,
          entry,
        ),
      );
      continue;
    }
    seen.add(id);
    if (kind === "human") {
      const human = readHumanSpec(properties, `${nodeId}.${id}`, state);
      if (human) {
        steps.push({
          id,
          kind: "human",
          label: readString(properties?.get("label")) ?? id,
          human,
        });
      }
      continue;
    }
    const prompt = readString(properties?.get("prompt"));
    if (!prompt) {
      state.diagnostics.push(
        diagnostic(
          "flow.composite_agent_prompt_required",
          `Composite Agent ${nodeId}.${id} requires a prompt.`,
          `nodes.${nodeId}.steps.${id}.prompt`,
          entry,
        ),
      );
      continue;
    }
    const output = readAgentOutput(
      properties?.get("output"),
      `${nodeId}.${id}`,
      state,
    );
    steps.push({
      id,
      kind: "agent",
      label: readString(properties?.get("label")) ?? id,
      prompt,
      ...(readResolvableString(properties?.get("agent"))
        ? { agent: readResolvableString(properties?.get("agent")) }
        : {}),
      ...(readResolvableString(properties?.get("model"))
        ? { model: readResolvableString(properties?.get("model")) }
        : {}),
      ...(readResolvableString(properties?.get("permissionMode"))
        ? {
            permissionMode: readResolvableString(
              properties?.get("permissionMode"),
            ),
          }
        : {}),
      ...(readString(properties?.get("cwd"))
        ? { cwd: readString(properties?.get("cwd")) }
        : {}),
      ...(readReference(properties?.get("workspace")) ??
      readIdentifierReference(properties?.get("workspace"))
        ? {
            workspace:
              readReference(properties?.get("workspace")) ??
              readIdentifierReference(properties?.get("workspace"))!,
          }
        : {}),
      ...(readExecutionContract(properties?.get("execution"))
        ? { execution: readExecutionContract(properties?.get("execution")) }
        : {}),
      ...(output ? { output } : {}),
    });
  }
  return steps;
}

function isHumanSpec(value: FlowV1JsonValue | undefined): value is FlowV1HumanSpec {
  if (!isJsonObject(value) || !Array.isArray(value.context) || !Array.isArray(value.actions)) {
    return false;
  }
  if (
    value.description !== undefined &&
    typeof value.description !== "string"
  ) {
    return false;
  }
  const contextValid = value.context.every(
    (item) =>
      isJsonObject(item) &&
      typeof item.label === "string" &&
      typeof item.value === "string" &&
      (item.display === "text" ||
        item.display === "markdown" ||
        item.display === "json"),
  );
  const actionIds = new Set<string>();
  const actionsValid =
    value.actions.length > 0 &&
    value.actions.every((action) => {
      if (
        !isJsonObject(action) ||
        typeof action.id !== "string" ||
        !action.id.trim() ||
        actionIds.has(action.id) ||
        typeof action.label !== "string" ||
        (action.intent !== "primary" &&
          action.intent !== "default" &&
          action.intent !== "danger") ||
        !Array.isArray(action.fields)
      ) {
        return false;
      }
      actionIds.add(action.id);
      return action.fields.every(
        (field) =>
          isJsonObject(field) &&
          typeof field.id === "string" &&
          typeof field.label === "string" &&
          typeof field.required === "boolean" &&
          (field.type === "text" ||
            field.type === "textarea" ||
            field.type === "select") &&
          (field.placeholder === undefined ||
            typeof field.placeholder === "string") &&
          (field.defaultValue === undefined ||
            typeof field.defaultValue === "string") &&
          (field.options === undefined ||
            (Array.isArray(field.options) &&
              field.options.every(
                (option) =>
                  isJsonObject(option) &&
                  typeof option.label === "string" &&
                  typeof option.value === "string",
              ))),
      );
    });
  return contextValid && actionsValid;
}

function buildDataEdges(state: ParserState): FlowV1DataEdge[] {
  const edges: FlowV1DataEdge[] = [];
  const seen = new Set<string>();
  for (const node of state.nodes) {
    for (const [targetInput, reference] of Object.entries(node.inputs)) {
      const sourceNodeId = state.variableToNodeId[reference.source];
      if (!sourceNodeId) {
        continue;
      }
      const id = `data:${sourceNodeId}:${node.id}:${targetInput}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      edges.push({
        id,
        kind: "data",
        sourceNodeId,
        sourcePath: reference.path,
        targetNodeId: node.id,
        targetInput,
      });
    }
  }
  return edges;
}

function buildControlEdges(state: ParserState): FlowV1ControlEdge[] {
  const edges: FlowV1ControlEdge[] = [];
  for (const route of state.pendingRoutes) {
    const args = asNodeArray(route.arguments);
    const sourceVariable = readIdentifierName(args[0]);
    const sourceNodeId = sourceVariable
      ? state.variableToNodeId[sourceVariable]
      : undefined;
    if (!sourceNodeId) {
      state.diagnostics.push(
        diagnostic(
          "flow.route_source_unknown",
          "route source must reference a declared node variable.",
          "routes",
          args[0],
        ),
      );
      continue;
    }
    const routes = readObjectProperties(args[1]);
    if (!routes) {
      state.diagnostics.push(
        diagnostic(
          "flow.route_invalid",
          "route requires an outcome-to-node object.",
          `routes.${sourceNodeId}`,
          route,
        ),
      );
      continue;
    }
    for (const [outcome, target] of routes) {
      const targetVariable = readIdentifierName(target);
      const targetNodeId = targetVariable
        ? state.variableToNodeId[targetVariable]
        : undefined;
      if (!targetNodeId) {
        state.diagnostics.push(
          diagnostic(
            "flow.route_target_unknown",
            `Route outcome ${outcome} must reference a declared node variable.`,
            `routes.${sourceNodeId}.${outcome}`,
            target,
          ),
        );
        continue;
      }
      edges.push({
        id: `control:${sourceNodeId}:${outcome}:${targetNodeId}`,
        kind: "control",
        sourceNodeId,
        outcome,
        targetNodeId,
      });
    }
  }
  return edges;
}

function validateDuplicateNodes(state: ParserState): void {
  const seen = new Set<string>();
  for (const node of state.nodes) {
    if (seen.has(node.id)) {
      state.diagnostics.push(
        diagnostic(
          "flow.node_id_duplicate",
          `Duplicate node id: ${node.id}.`,
          `nodes.${node.id}`,
        ),
      );
    }
    seen.add(node.id);
  }
}

function validateSchemaReferences(
  input: {
    params: Record<string, FlowV1SchemaEntry>;
    inputs: Record<string, FlowV1SchemaEntry>;
    secrets: Record<string, FlowV1SchemaEntry>;
    nodes: FlowV1Node[];
  },
  state: ParserState,
): void {
  for (const node of input.nodes) {
    for (const reference of Object.values(node.inputs)) {
      if (state.variableToNodeId[reference.source]) {
        continue;
      }
      if (!RESERVED_REFERENCE_ROOTS.has(reference.source)) {
        state.diagnostics.push(
          diagnostic(
            "flow.reference_unknown",
            `Unknown reference root "${reference.source}" in ${reference.expression}.`,
            `nodes.${node.id}.inputs`,
          ),
        );
        continue;
      }
      const entryName = reference.path[0];
      const namespace =
        reference.source === "params"
          ? input.params
          : reference.source === "inputs"
            ? input.inputs
            : reference.source === "secrets"
              ? input.secrets
              : undefined;
      if (namespace && entryName && !namespace[entryName]) {
        state.diagnostics.push(
          diagnostic(
            "flow.reference_unknown",
            `Unknown ${reference.source} entry: ${entryName}.`,
            `nodes.${node.id}.inputs`,
          ),
        );
      }
    }
    if (node.memorySections) {
      // Section existence is checked after Memory is available by module
      // validation's caller; retain the explicit read declaration here.
      for (const section of node.memorySections) {
        if (!section.trim()) {
          state.diagnostics.push(
            diagnostic(
              "flow.memory_read_invalid",
              `Node ${node.id} contains an empty Memory section id.`,
              `nodes.${node.id}.memory`,
            ),
          );
        }
      }
    }
  }
}

function validateSchedule(
  schedule: FlowV1ScheduleDefinition | null,
  inputs: Record<string, FlowV1SchemaEntry>,
  state: ParserState,
): void {
  if (!schedule) {
    return;
  }
  for (const entry of Object.values(inputs)) {
    if (
      entry.required &&
      !entry.hasDefault &&
      !Object.hasOwn(schedule.inputs, entry.name)
    ) {
      state.diagnostics.push(
        diagnostic(
          "flow.schedule_required_input_unbound",
          `Schedule ${schedule.id} does not bind required Cycle input "${entry.name}".`,
          `schedule.inputs.${entry.name}`,
        ),
      );
    }
  }
}

function validateCycleAndMemory(
  cycles: FlowV1CycleDefinition,
  memory: FlowV1MemoryDefinition | null,
  state: ParserState,
): void {
  if (cycles.mode === "keyed") {
    state.diagnostics.push(
      diagnostic(
        memory
          ? "flow.memory.concurrent_cycles_not_supported"
          : "flow.cycles.keyed_not_available",
        memory
          ? "Canonical Flow Memory requires cycles.mode to be singleton."
          : "Keyed Cycle execution is not available in this runtime version.",
        "cycles.mode",
      ),
    );
  }
  if (memory) {
    const template = getFlowV1BundleFile(
      state.bundle,
      "memory.template.md",
    );
    if (!template) {
      state.diagnostics.push(
        diagnostic(
          "flow.memory_template_missing",
          "A Flow with Memory must include memory.template.md.",
          "memory",
        ),
      );
    } else {
      validateMemoryTemplate(template.content, memory, state);
    }
    for (const node of state.nodes) {
      for (const section of node.memorySections ?? []) {
        if (!memory.sections[section]) {
          state.diagnostics.push(
            diagnostic(
              "flow.memory_section_unknown",
              `Node ${node.id} references unknown Memory section "${section}".`,
              `nodes.${node.id}.memory`,
            ),
          );
        }
      }
      for (const [sectionId, update] of Object.entries(
        node.memoryUpdates ?? {},
      )) {
        const section = memory.sections[sectionId];
        if (!section) {
          state.diagnostics.push(
            diagnostic(
              "flow.memory_section_unknown",
              `Remember ${node.id} updates unknown Memory section "${sectionId}".`,
              `nodes.${node.id}.updates.${sectionId}`,
            ),
          );
        } else if (section.update !== update.mode) {
          state.diagnostics.push(
            diagnostic(
              "flow.memory_update_mode_mismatch",
              `Remember ${node.id} must use ${section.update} for Memory section "${sectionId}".`,
              `nodes.${node.id}.updates.${sectionId}.mode`,
            ),
          );
        }
      }
    }
  } else {
    for (const node of state.nodes) {
      if ((node.memorySections?.length ?? 0) > 0 || node.kind === "remember") {
        state.diagnostics.push(
          diagnostic(
            "flow.memory_not_declared",
            `Node ${node.id} uses Memory, but the Flow has no memory declaration.`,
            `nodes.${node.id}`,
          ),
        );
      }
    }
  }
}

function validateMemoryTemplate(
  template: string,
  memory: FlowV1MemoryDefinition,
  state: ParserState,
): void {
  const markerPattern =
    /<!--\s*flow-memory:section:([^:\s]+):(start|end)\s*-->/gu;
  const markers = [...template.matchAll(markerPattern)].map((match) => ({
    section: match[1]!,
    boundary: match[2] as "start" | "end",
    index: match.index,
  }));

  for (const marker of markers) {
    if (!memory.sections[marker.section]) {
      state.diagnostics.push(
        diagnostic(
          "flow.memory_template_section_unknown",
          `memory.template.md contains a marker for undeclared section "${marker.section}".`,
          "memory.template.md",
        ),
      );
    }
  }

  for (const section of Object.values(memory.sections)) {
    const sectionMarkers = markers.filter(
      (marker) => marker.section === section.id,
    );
    const starts = sectionMarkers.filter(
      (marker) => marker.boundary === "start",
    );
    const ends = sectionMarkers.filter((marker) => marker.boundary === "end");
    if (starts.length !== 1 || ends.length !== 1) {
      state.diagnostics.push(
        diagnostic(
          "flow.memory_template_marker_count_invalid",
          `Memory section "${section.id}" requires exactly one start marker and one end marker.`,
          `memory.sections.${section.id}`,
        ),
      );
      continue;
    }
    if (starts[0]!.index >= ends[0]!.index) {
      state.diagnostics.push(
        diagnostic(
          "flow.memory_template_marker_order_invalid",
          `Memory section "${section.id}" must place its start marker before its end marker.`,
          `memory.sections.${section.id}`,
        ),
      );
    }
  }
}

function validateControlOutcomes(
  nodes: FlowV1Node[],
  edges: FlowV1ControlEdge[],
  state: ParserState,
): void {
  for (const node of nodes) {
    if (node.kind !== "gate" && node.kind !== "human") {
      continue;
    }
    const routed = new Set(
      edges
        .filter((edge) => edge.sourceNodeId === node.id)
        .map((edge) => edge.outcome),
    );
    for (const outcome of node.outcomes) {
      if (!routed.has(outcome)) {
        state.diagnostics.push(
          diagnostic(
            "flow.gate_outcome_unrouted",
            `Gate ${node.id} outcome "${outcome}" has no control route.`,
            `nodes.${node.id}.outcomes`,
          ),
        );
      }
    }
    for (const outcome of routed) {
      if (!node.outcomes.includes(outcome)) {
        state.diagnostics.push(
          diagnostic(
            "flow.route_outcome_unknown",
            `Route from Gate ${node.id} uses undeclared outcome "${outcome}".`,
            `routes.${node.id}.${outcome}`,
          ),
        );
      }
    }
  }
}

function validateReachableTerminal(
  nodes: FlowV1Node[],
  edges: Array<FlowV1DataEdge | FlowV1ControlEdge>,
  state: ParserState,
): void {
  const terminalIds = new Set(
    nodes
      .filter(
        (node) =>
          node.kind === "complete_cycle" || node.kind === "cancel_cycle",
      )
      .map((node) => node.id),
  );
  if (terminalIds.size === 0) {
    state.diagnostics.push(
      diagnostic(
        "flow.cycle_terminal_missing",
        "Flow must contain completeCycle(...) or cancelCycle(...).",
        "nodes",
      ),
    );
    return;
  }
  const incoming = new Set(edges.map((edge) => edge.targetNodeId));
  const roots = nodes
    .filter((node) => !incoming.has(node.id) && node.kind !== "finally")
    .map((node) => node.id);
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    adjacency.set(edge.sourceNodeId, targets);
  }
  const visited = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    queue.push(...(adjacency.get(nodeId) ?? []));
  }
  if (![...terminalIds].some((nodeId) => visited.has(nodeId))) {
    state.diagnostics.push(
      diagnostic(
        "flow.cycle_terminal_unreachable",
        "No Cycle terminal is reachable from a Flow root.",
        "nodes",
      ),
    );
  }
}

function validateBundleModules(state: ParserState): void {
  for (const file of state.bundle.files) {
    if (!/\.(?:mjs|js)$/u.test(file.path)) {
      continue;
    }
    const moduleDiagnostics: WorkflowDiagnostic[] = [];
    const ast = parseModule(file.content, file.path, moduleDiagnostics);
    state.diagnostics.push(...moduleDiagnostics);
    if (!ast) {
      continue;
    }
    for (const specifier of collectModuleSpecifiers(ast)) {
      validateModuleSpecifier(file.path, specifier, state);
    }
  }

  for (const node of state.nodes) {
    const requiredExports = CODE_NODE_EXPORTS[node.kind];
    if (!requiredExports) {
      continue;
    }
    if (!node.file) {
      state.diagnostics.push(
        diagnostic(
          "flow.code_file_missing",
          `${node.kind} node ${node.id} must reference a Bundle file.`,
          `nodes.${node.id}.file`,
        ),
      );
      continue;
    }
    const module = getFlowV1BundleFile(state.bundle, node.file);
    if (!module) {
      state.diagnostics.push(
        diagnostic(
          "flow.code_file_not_found",
          `Node ${node.id} references missing Bundle file ${node.file}.`,
          `nodes.${node.id}.file`,
        ),
      );
      continue;
    }
    if (module.path.endsWith(".sh")) {
      continue;
    }
    if (!/\.(?:mjs|js)$/u.test(module.path)) {
      state.diagnostics.push(
        diagnostic(
          "flow.code_file_type_invalid",
          `Node ${node.id} requires a .mjs, .js, or .sh module.`,
          `nodes.${node.id}.file`,
        ),
      );
      continue;
    }
    const moduleDiagnostics: WorkflowDiagnostic[] = [];
    const ast = parseModule(module.content, module.path, moduleDiagnostics);
    state.diagnostics.push(...moduleDiagnostics);
    if (!ast) {
      continue;
    }
    if (
      node.kind === "transform" &&
      collectModuleSpecifiers(ast).length > 0
    ) {
      state.diagnostics.push(
        diagnostic(
          "flow.transform_import_forbidden",
          `Transform ${node.id} must be a pure Bundle-local JSON projection and cannot import modules.`,
          `nodes.${node.id}.file`,
        ),
      );
    }
    const exports = collectNamedExports(ast);
    for (const exportName of requiredExports) {
      if (!exports.has(exportName)) {
        state.diagnostics.push(
          diagnostic(
            "flow.code_export_missing",
            `${node.kind} module ${module.path} must export ${exportName}().`,
            `nodes.${node.id}.file`,
          ),
        );
      }
    }
  }
}

function validateModuleSpecifier(
  importer: string,
  specifier: string,
  state: ParserState,
): void {
  if (importer === FLOW_V1_ENTRY_FILE) {
    state.diagnostics.push(
      diagnostic(
        "flow.entry_import_forbidden",
        "flow.js must use the declarative DSL globals and cannot import modules.",
        importer,
      ),
    );
    return;
  }
  if (specifier === "@tutti/flow-runtime" || NODE_BUILTINS.has(specifier)) {
    return;
  }
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    state.diagnostics.push(
      diagnostic(
        "bundle.script_external_dependency_forbidden",
        `${importer} imports unsupported dependency "${specifier}".`,
        importer,
      ),
    );
    return;
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  if (resolved.startsWith("../") || !resolved.startsWith("scripts/")) {
    state.diagnostics.push(
      diagnostic(
        "bundle.script_import_escape",
        `${importer} import escapes the Bundle scripts directory: ${specifier}.`,
        importer,
      ),
    );
    return;
  }
  if (!getFlowV1BundleFile(state.bundle, resolved)) {
    state.diagnostics.push(
      diagnostic(
        "bundle.script_import_missing",
        `${importer} imports missing Bundle file ${resolved}.`,
        importer,
      ),
    );
  }
}

function parseModule(
  source: string,
  filePath: string,
  diagnostics: WorkflowDiagnostic[],
): AstNode | null {
  try {
    const ast = parse(source, {
      sourceType: "module",
      plugins: ["typescript"],
      errorRecovery: true,
      ranges: true,
    }) as unknown as AstNode;
    for (const error of Array.isArray(ast.errors) ? ast.errors : []) {
      const message =
        typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "Invalid JavaScript syntax.";
      diagnostics.push(
        diagnostic("flow.syntax", message, filePath, error as AstNode),
      );
    }
    return ast;
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "flow.syntax",
        error instanceof Error ? error.message : "Invalid JavaScript syntax.",
        filePath,
      ),
    );
    return null;
  }
}

function collectModuleSpecifiers(ast: AstNode): string[] {
  const specifiers: string[] = [];
  walkAst(ast, (node) => {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration"
    ) {
      const value = readString(asNode(node.source));
      if (value) {
        specifiers.push(value);
      }
    }
    if (node.type === "CallExpression") {
      const callee = asNode(node.callee);
      const name = readIdentifierName(callee);
      if (name === "require") {
        const value = readString(asNodeArray(node.arguments)[0]);
        if (value) {
          specifiers.push(value);
        }
      }
      if (callee?.type === "Import") {
        const value = readString(asNodeArray(node.arguments)[0]);
        if (value) {
          specifiers.push(value);
        }
      }
    }
    if (node.type === "ImportExpression") {
      const value = readString(asNode(node.source));
      if (value) {
        specifiers.push(value);
      }
    }
  });
  return specifiers;
}

function collectNamedExports(ast: AstNode): Set<string> {
  const exports = new Set<string>();
  for (const statement of getProgramBody(ast)) {
    if (statement.type !== "ExportNamedDeclaration") {
      continue;
    }
    const declaration = asNode(statement.declaration);
    if (
      declaration?.type === "FunctionDeclaration" ||
      declaration?.type === "ClassDeclaration"
    ) {
      const name = readIdentifierName(asNode(declaration.id));
      if (name) {
        exports.add(name);
      }
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const variable of asNodeArray(declaration.declarations)) {
        const name = readIdentifierName(asNode(variable.id));
        if (name) {
          exports.add(name);
        }
      }
    }
    for (const specifier of asNodeArray(statement.specifiers)) {
      const name =
        readIdentifierName(asNode(specifier.exported)) ??
        readString(asNode(specifier.exported));
      if (name) {
        exports.add(name);
      }
    }
  }
  return exports;
}

function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const child = asNode(entry);
        if (child) {
          walkAst(child, visit);
        }
      }
    } else {
      const child = asNode(value);
      if (child) {
        walkAst(child, visit);
      }
    }
  }
}

function readObjectProperties(node: AstNode | undefined): Map<string, AstNode> | null {
  const value = unwrapExpression(node);
  if (!value || value.type !== "ObjectExpression") {
    return null;
  }
  const properties = new Map<string, AstNode>();
  for (const property of asNodeArray(value.properties)) {
    if (
      property.type !== "ObjectProperty" &&
      property.type !== "ObjectMethod"
    ) {
      continue;
    }
    const key =
      readIdentifierName(asNode(property.key)) ??
      readString(asNode(property.key));
    const propertyValue =
      property.type === "ObjectMethod" ? property : asNode(property.value);
    if (key && propertyValue) {
      properties.set(key, propertyValue);
    }
  }
  return properties;
}

function readStaticObject(node: AstNode | undefined): FlowV1JsonObject | null {
  const value = readStaticValue(node);
  return isJsonObject(value) ? value : null;
}

function readStaticValue(node: AstNode | undefined): FlowV1JsonValue | undefined {
  const value = unwrapExpression(node);
  if (!value) {
    return undefined;
  }
  if (value.type === "StringLiteral") {
    return typeof value.value === "string" ? value.value : undefined;
  }
  if (value.type === "NumericLiteral") {
    return typeof value.value === "number" && Number.isFinite(value.value)
      ? value.value
      : undefined;
  }
  if (value.type === "BooleanLiteral") {
    return typeof value.value === "boolean" ? value.value : undefined;
  }
  if (value.type === "NullLiteral") {
    return null;
  }
  if (value.type === "ArrayExpression") {
    const result: FlowV1JsonValue[] = [];
    for (const element of asNodeArray(value.elements)) {
      const entry = readStaticValue(element);
      if (entry === undefined) {
        return undefined;
      }
      result.push(entry);
    }
    return result;
  }
  const properties = readObjectProperties(value);
  if (properties) {
    const result: FlowV1JsonObject = {};
    for (const [key, property] of properties) {
      const entry = readStaticValue(property);
      if (entry === undefined) {
        return undefined;
      }
      result[key] = entry;
    }
    return result;
  }
  return undefined;
}

function readReference(node: AstNode | undefined): FlowV1Reference | undefined {
  const call = unwrapExpression(node);
  if (!call || !isCall(call, "ref")) {
    return undefined;
  }
  const expression = readString(firstArgument(call));
  return expression ? referenceFromExpression(expression) : undefined;
}

function isReference(
  value: number | FlowV1Reference | undefined,
): value is FlowV1Reference {
  return typeof value === "object" && value !== null && "source" in value;
}

function readResolvableString(
  node: AstNode | undefined,
): string | FlowV1Reference | undefined {
  return readString(node) ?? readReference(node);
}

function readAgentOutput(
  node: AstNode | undefined,
  nodeId: string,
  state: ParserState,
): FlowV1Node["output"] | undefined {
  if (readString(node) === "json") {
    return { kind: "json" };
  }
  if (readString(node) === "text") {
    return { kind: "text" };
  }
  if (!node || readCalleeName(node) !== "json") {
    return undefined;
  }
  const properties = readObjectProperties(firstArgument(node));
  const schema = readStaticValue(properties?.get("schema"));
  const validationMaxAttempts = readNumber(
    properties?.get("validationMaxAttempts"),
  );
  if (
    properties?.has("validationMaxAttempts") &&
    (!Number.isInteger(validationMaxAttempts) ||
      validationMaxAttempts! < 1 ||
      validationMaxAttempts! > 3)
  ) {
    state.diagnostics.push(
      diagnostic(
        "flow.agent_output_validation_attempts_invalid",
        `Agent ${nodeId} validationMaxAttempts must be an integer from 1 to 3.`,
        `nodes.${nodeId}.output.validationMaxAttempts`,
        properties.get("validationMaxAttempts"),
      ),
    );
  }
  return {
    kind: "json",
    ...(schema && typeof schema === "object" && !Array.isArray(schema)
      ? { schema }
      : {}),
    ...(Number.isInteger(validationMaxAttempts) &&
    validationMaxAttempts! >= 1 &&
    validationMaxAttempts! <= 3
      ? { validationMaxAttempts: validationMaxAttempts! }
      : {}),
  };
}

function readIdentifierReference(
  node: AstNode | undefined,
): FlowV1Reference | undefined {
  const name = readIdentifierName(unwrapExpression(node));
  return name ? referenceFromExpression(name) : undefined;
}

function referenceFromExpression(expression: string): FlowV1Reference {
  const [source = "", ...referencePath] = expression.split(".");
  return { expression, source, path: referencePath };
}

function readMemoryIncludes(node: AstNode | undefined): string[] | undefined {
  const properties = readObjectProperties(node);
  const values = readStringArray(properties?.get("include"));
  return values.length > 0 ? values : undefined;
}

function readRunOn(
  node: AstNode | undefined,
): Array<"completed" | "failed" | "canceled"> | undefined {
  const values = readStringArray(node).filter(
    (value): value is "completed" | "failed" | "canceled" =>
      value === "completed" || value === "failed" || value === "canceled",
  );
  return values.length > 0 ? values : undefined;
}

function readStringArray(node: AstNode | undefined): string[] {
  const value = unwrapExpression(node);
  if (!value || value.type !== "ArrayExpression") {
    return [];
  }
  return asNodeArray(value.elements)
    .map(readString)
    .filter((entry): entry is string => entry !== undefined);
}

function extractTemplateReferences(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/gu)].map((match) =>
    match[1]!.trim(),
  );
}

function readBoundedInteger(
  node: AstNode | undefined,
  fallback: number,
  diagnosticPath: string,
  state: ParserState,
): number {
  const value = readNumber(node);
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    state.diagnostics.push(
      diagnostic(
        "flow.runtime_budget_invalid",
        `${diagnosticPath} must be an integer from 1 to 10000.`,
        diagnosticPath,
        node,
      ),
    );
    return fallback;
  }
  return value;
}

function readSingleStringCall(
  node: AstNode | undefined,
  callee: string,
): string | undefined {
  const call = unwrapExpression(node);
  return call && isCall(call, callee)
    ? readString(firstArgument(call))
    : undefined;
}

function isCall(node: AstNode | undefined, name: string): boolean {
  return node?.type === "CallExpression" && readCalleeName(node) === name;
}

function readCalleeName(node: AstNode): string | undefined {
  return readIdentifierName(asNode(node.callee));
}

function firstArgument(node: AstNode): AstNode | undefined {
  return asNodeArray(node.arguments)[0];
}

function unwrapExportDeclaration(node: AstNode): AstNode | undefined {
  return node.type === "ExportNamedDeclaration"
    ? asNode(node.declaration)
    : node;
}

function isExported(node: AstNode): boolean {
  return node.type === "ExportNamedDeclaration";
}

function unwrapExpression(node: AstNode | undefined): AstNode | undefined {
  let current = node;
  while (
    current &&
    (current.type === "AwaitExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "ParenthesizedExpression")
  ) {
    current = asNode(current.argument ?? current.expression);
  }
  return current;
}

function getProgramBody(ast: AstNode): AstNode[] {
  const program = ast.type === "File" ? asNode(ast.program) : ast;
  return asNodeArray(program?.body);
}

function readIdentifierName(node: AstNode | undefined): string | undefined {
  return node?.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;
}

function readString(node: AstNode | undefined): string | undefined {
  const value = unwrapExpression(node);
  return value?.type === "StringLiteral" && typeof value.value === "string"
    ? value.value
    : undefined;
}

function readBoolean(node: AstNode | undefined): boolean | undefined {
  const value = unwrapExpression(node);
  return value?.type === "BooleanLiteral" && typeof value.value === "boolean"
    ? value.value
    : undefined;
}

function readNumber(node: AstNode | undefined): number | undefined {
  const value = unwrapExpression(node);
  return value?.type === "NumericLiteral" && typeof value.value === "number"
    ? value.value
    : undefined;
}

function rangeOf(
  node: AstNode | undefined,
): { start: number; end: number } | undefined {
  return typeof node?.start === "number" && typeof node.end === "number"
    ? { start: node.start, end: node.end }
    : undefined;
}

function diagnostic(
  code: string,
  message: string,
  diagnosticPath: string,
  node?: AstNode,
): WorkflowDiagnostic {
  return {
    severity: "error",
    code,
    message,
    path: diagnosticPath,
    ...(rangeOf(node) ? { range: rangeOf(node) } : {}),
  };
}

function asNode(value: unknown): AstNode | undefined {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
    ? (value as AstNode)
    : undefined;
}

function asNodeArray(value: unknown): AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((entry): entry is AstNode => Boolean(entry))
    : [];
}

function isJsonObject(
  value: FlowV1JsonValue | undefined,
): value is FlowV1JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
