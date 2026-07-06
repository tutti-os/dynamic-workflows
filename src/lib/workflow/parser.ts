import { parse } from "@babel/parser";
import type {
  EditableRange,
  ParsedWorkflow,
  WorkflowDiagnostic,
  WorkflowEdge,
  WorkflowInputDefinition,
  WorkflowInputSchema,
  WorkflowInputBinding,
  WorkflowLoopUntil,
  WorkflowLoopSpec,
  WorkflowLoopStep,
  WorkflowMeta,
  WorkflowNode,
  WorkflowPhase,
  WorkflowSessionSpec,
} from "./types";
import {
  listOptionalInputNames,
  listRequiredInputNames,
} from "./input-schema";
import {
  extractTemplateRefs,
  validateRuntimeOptionTemplate,
} from "./templates";

type AnyNode = {
  type: string;
  start?: number | null;
  end?: number | null;
  [key: string]: unknown;
};

type ParserErrorLike = {
  message?: string;
  reasonCode?: string;
  loc?: {
    index?: number;
    line?: number;
    column?: number;
  };
  pos?: number;
};

type ParserState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  phases: WorkflowPhase[];
  diagnostics: WorkflowDiagnostic[];
  variableToNodeId: Record<string, string>;
  currentPhase?: string;
  anonymousIndex: number;
};

const DEFAULT_META: WorkflowMeta = {
  name: "untitled_workflow",
  description: "Dynamic workflow",
};

const RESERVED_TEMPLATE_REFS = new Set(["iteration", "workflow.cwd"]);

export class WorkflowScriptSyntaxError extends Error {
  readonly diagnostics: WorkflowDiagnostic[];
  readonly parsed: ParsedWorkflow;

  constructor(diagnostics: WorkflowDiagnostic[], parsed: ParsedWorkflow) {
    super(formatDiagnosticsMessage(diagnostics));
    this.name = "WorkflowScriptSyntaxError";
    this.diagnostics = diagnostics;
    this.parsed = parsed;
  }
}

export function assertWorkflowScriptValid(script: string): ParsedWorkflow {
  const parsed = parseWorkflowScript(script);
  const errors = parsed.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (errors.length > 0) {
    throw new WorkflowScriptSyntaxError(errors, parsed);
  }
  return parsed;
}

export function parseWorkflowScript(script: string): ParsedWorkflow {
  const state: ParserState = {
    nodes: [],
    edges: [],
    phases: [],
    diagnostics: [],
    variableToNodeId: {},
    anonymousIndex: 1,
  };

  let ast: AnyNode;
  try {
    ast = parse(script, {
      sourceType: "module",
      plugins: ["typescript"],
      errorRecovery: true,
      ranges: true,
    }) as unknown as AnyNode;
  } catch (error) {
    return {
      meta: DEFAULT_META,
      nodes: [],
      edges: [],
      phases: [],
      inputSchema: {},
      requiredInputNames: [],
      optionalInputNames: [],
      diagnostics: [
        parseErrorToDiagnostic(error),
      ],
      variableToNodeId: {},
    };
  }

  state.diagnostics.push(...readRecoveredParserErrors(ast));

  const meta = readMeta(ast) ?? DEFAULT_META;
  const inputSchema = readInputSchema(ast, state);
  const body = getProgramBody(ast);

  for (const statement of body) {
    visitTopLevelStatement(statement, state);
  }

  addDuplicateNodeIdDiagnostics(state);
  addRuntimeOptionDiagnostics(state);
  connectTemplateRefs(state);
  addInputSchemaReferenceDiagnostics(state, inputSchema);

  return {
    meta,
    nodes: state.nodes,
    edges: state.edges,
    phases: state.phases,
    inputSchema,
    requiredInputNames: listRequiredInputNames(inputSchema),
    optionalInputNames: listOptionalInputNames(inputSchema),
    diagnostics: state.diagnostics,
    variableToNodeId: state.variableToNodeId,
  };
}

function parseErrorToDiagnostic(error: unknown): WorkflowDiagnostic {
  const parserError = error as ParserErrorLike;
  return {
    severity: "error",
    message:
      error instanceof Error
        ? error.message
        : parserError.message ?? "Could not parse script",
    range: parserErrorToRange(parserError),
  };
}

function readRecoveredParserErrors(ast: AnyNode): WorkflowDiagnostic[] {
  const errors = ast.errors;
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors.map((error) => parseErrorToDiagnostic(error));
}

function parserErrorToRange(error: ParserErrorLike): WorkflowDiagnostic["range"] {
  const position =
    typeof error.pos === "number"
      ? error.pos
      : typeof error.loc?.index === "number"
        ? error.loc.index
        : undefined;
  if (typeof position !== "number") {
    return undefined;
  }
  return { start: position, end: position };
}

function formatDiagnosticsMessage(diagnostics: WorkflowDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "Workflow script is invalid";
  }
  const [first] = diagnostics;
  const suffix = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : "";
  return `${first.message}${suffix}`;
}

function visitTopLevelStatement(statement: AnyNode, state: ParserState): void {
  if (statement.type === "ExportNamedDeclaration") {
    return;
  }

  const expression = unwrapExpression(statement);
  const variableName = readVariableName(statement);

  if (isCallExpression(expression, "phase")) {
    const title = readFirstStringArg(expression) ?? "Untitled phase";
    const previousPhase = state.currentPhase;
    enterPhase(title, state);
    const phaseBody = readPhaseCallbackBody(expression);
    if (phaseBody) {
      for (const phaseStatement of phaseBody) {
        visitTopLevelStatement(phaseStatement, state);
      }
      state.currentPhase = previousPhase;
    }
    return;
  }

  if (isCallExpression(expression, "log")) {
    addLogNode(expression, variableName, state);
    return;
  }

  if (isCallExpression(expression, "agent")) {
    addAgentNode(expression, variableName, state);
    return;
  }

  if (isCallExpression(expression, "loop")) {
    addLoopNode(expression, variableName, state);
    return;
  }

  if (isCallExpression(expression, "parallel")) {
    addParallelNodes(expression, variableName, state);
    return;
  }

  if (isCallExpression(expression, "pipeline")) {
    addDynamicNode(expression, variableName, "pipeline", state);
    return;
  }

  if (statement.type !== "EmptyStatement") {
    state.diagnostics.push({
      severity: "info",
      message: `Ignored unsupported top-level ${statement.type}. Only known workflow primitives affect the DAG.`,
      range: toRange(statement),
    });
  }
}

function addAgentNode(
  callExpression: AnyNode,
  variableName: string | undefined,
  state: ParserState,
): WorkflowNode {
  const options = firstArg(callExpression);
  const id =
    readObjectString(options, "id") ??
    variableName ??
    `agent_${state.anonymousIndex++}`;
  const label = readObjectString(options, "label") ?? humanize(id);
  const prompt = readObjectString(options, "prompt") ?? "";
  const inputs = readInputs(options, state);
  const templateRefs = extractTemplateRefs(prompt);
  const session = readSessionSpec(options, state, "agent");
  const node: WorkflowNode = {
    id,
    kind: "agent",
    label,
    phase: state.currentPhase,
    variableName,
    prompt,
    agent: readObjectString(options, "agent"),
    model: readObjectString(options, "model"),
    cwd: readObjectString(options, "cwd"),
    ...(session ? { session } : {}),
    inputs,
    templateRefs,
    sourceRange: toRange(callExpression),
    promptRange: readObjectPropertyValueRange(options, "prompt"),
    labelRange: readObjectPropertyValueRange(options, "label"),
  };

  state.nodes.push(node);
  addNodeToCurrentPhase(node.id, state);
  if (variableName) {
    state.variableToNodeId[variableName] = node.id;
  }
  addInputEdges(node, state);
  return node;
}

function addLoopNode(
  callExpression: AnyNode,
  variableName: string | undefined,
  state: ParserState,
): void {
  const options = firstArg(callExpression);
  const id =
    readObjectString(options, "id") ??
    variableName ??
    `loop_${state.anonymousIndex++}`;
  const label = readObjectString(options, "label") ?? humanize(id);
  const session = readSessionSpec(options, state, "loop");
  const maxIterations = readObjectNumber(options, "maxIterations");
  const onMaxIterations = readLoopOnMaxIterations(options, state);
  const steps = readLoopSteps(options, state);
  const stepIds = new Set(steps.map((step) => step.id));
  const until = readLoopUntil(options, state, stepIds);
  const templateRefs = [
    ...new Set(
      steps.flatMap((step) =>
        step.templateRefs.filter(
          (ref) => !stepIds.has(ref) && !isReservedTemplateRef(ref),
        ),
      ),
    ),
  ];
  const inputs = readInputs(options, state);

  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) {
    state.diagnostics.push({
      severity: "error",
      message: "loop(...) requires maxIterations as an integer from 1 to 10.",
      range:
        readObjectPropertyValueRange(options, "maxIterations") ??
        toRange(callExpression),
    });
  }

  if (steps.length === 0) {
    state.diagnostics.push({
      severity: "error",
      message: "loop(...) requires at least one agent step in steps.",
      range: readObjectPropertyValueRange(options, "steps") ?? toRange(callExpression),
    });
  }

  const loop: WorkflowLoopSpec = {
    maxIterations: Number.isInteger(maxIterations) ? maxIterations : 1,
    onMaxIterations,
    ...(session ? { session } : {}),
    steps,
    until,
  };
  const node: WorkflowNode = {
    id,
    kind: "loop",
    label,
    phase: state.currentPhase,
    variableName,
    agent: readObjectString(options, "agent"),
    model: readObjectString(options, "model"),
    cwd: readObjectString(options, "cwd"),
    ...(session ? { session } : {}),
    loop,
    inputs,
    templateRefs,
    sourceRange: toRange(callExpression),
    labelRange: readObjectPropertyValueRange(options, "label"),
  };

  state.nodes.push(node);
  addNodeToCurrentPhase(node.id, state);
  if (variableName) {
    state.variableToNodeId[variableName] = node.id;
  }
  addInputEdges(node, state);
}

function addLogNode(
  callExpression: AnyNode,
  variableName: string | undefined,
  state: ParserState,
): void {
  const id = variableName ?? `log_${state.anonymousIndex++}`;
  const message = readFirstStringArg(callExpression) ?? "";
  const node: WorkflowNode = {
    id,
    kind: "log",
    label: message || "Log",
    phase: state.currentPhase,
    variableName,
    message,
    inputs: [],
    templateRefs: extractTemplateRefs(message),
    sourceRange: toRange(callExpression),
  };
  state.nodes.push(node);
  addNodeToCurrentPhase(node.id, state);
}

function addParallelNodes(
  callExpression: AnyNode,
  variableName: string | undefined,
  state: ParserState,
): void {
  const arrayArg = firstArg(callExpression);
  if (!arrayArg || arrayArg.type !== "ArrayExpression") {
    addDynamicNode(callExpression, variableName, "dynamic", state);
    state.diagnostics.push({
      severity: "warning",
      message: "parallel(...) must receive an array literal to preview children.",
      range: toRange(callExpression),
    });
    return;
  }

  const elements = (arrayArg.elements as AnyNode[] | undefined) ?? [];
  elements.forEach((element, index) => {
    const body = unwrapFunctionBody(element);
    const expression = unwrapExpression(body);
    if (isCallExpression(expression, "agent")) {
      const node = addAgentNode(expression, undefined, state);
      if (variableName) {
        state.variableToNodeId[`${variableName}_${index}`] = node.id;
      }
      return;
    }

    addDynamicNode(element, undefined, "dynamic", state, {
      message: "Unsupported parallel child. It will be visible only at runtime.",
    });
  });
}

function readLoopSteps(
  options: AnyNode | undefined,
  state: ParserState,
): WorkflowLoopStep[] {
  const stepsArray = readObjectPropertyValue(options, "steps");
  if (!stepsArray || stepsArray.type !== "ArrayExpression") {
    state.diagnostics.push({
      severity: "error",
      message: "loop(...) requires steps as an array literal.",
      range: readObjectPropertyValueRange(options, "steps"),
    });
    return [];
  }

  const seenIds = new Set<string>();
  const elements = (stepsArray.elements as AnyNode[] | undefined) ?? [];
  return elements.flatMap((element, index): WorkflowLoopStep[] => {
    const expression = unwrapExpression(unwrapFunctionBody(element));
    if (!isCallExpression(expression, "agent")) {
      state.diagnostics.push({
        severity: "error",
        message: "loop steps only support agent({...}) in this version.",
        range: toRange(element),
      });
      return [];
    }

    const step = readLoopAgentStep(expression, index, state);
    if (seenIds.has(step.id)) {
      state.diagnostics.push({
        severity: "error",
        message: `Duplicate loop step id "${step.id}". Step ids must be unique within a loop.`,
        range: step.sourceRange,
      });
    }
    seenIds.add(step.id);
    return [step];
  });
}

function readLoopAgentStep(
  callExpression: AnyNode,
  index: number,
  state: ParserState,
): WorkflowLoopStep {
  const options = firstArg(callExpression);
  const id = readObjectString(options, "id") ?? `step_${index + 1}`;
  const label = readObjectString(options, "label") ?? humanize(id);
  const prompt = readObjectString(options, "prompt") ?? "";
  const appendPrompt = readObjectString(options, "appendPrompt");
  const session = readSessionSpec(options, state, "loopStep");

  return {
    id,
    kind: "agent",
    label,
    prompt,
    ...(appendPrompt !== undefined ? { appendPrompt } : {}),
    agent: readObjectString(options, "agent"),
    model: readObjectString(options, "model"),
    cwd: readObjectString(options, "cwd"),
    ...(session ? { session } : {}),
    templateRefs: [
      ...new Set([
        ...extractTemplateRefs(prompt),
        ...extractTemplateRefs(appendPrompt),
      ]),
    ],
    sourceRange: toRange(callExpression),
    promptRange: readObjectPropertyValueRange(options, "prompt"),
    appendPromptRange: readObjectPropertyValueRange(options, "appendPrompt"),
    labelRange: readObjectPropertyValueRange(options, "label"),
  };
}

function readLoopUntil(
  options: AnyNode | undefined,
  state: ParserState,
  stepIds: Set<string>,
): WorkflowLoopUntil {
  const untilObject = readObjectPropertyValue(options, "until");
  const source = readObjectString(untilObject, "source") ?? "";
  const finalStatus = readObjectString(untilObject, "finalStatus");

  if (!untilObject || untilObject.type !== "ObjectExpression") {
    state.diagnostics.push({
      severity: "error",
      message:
        "loop(...) requires until: { source: <step id>, finalStatus: <status> }.",
      range: readObjectPropertyValueRange(options, "until"),
    });
  }
  if (!source || !stepIds.has(source)) {
    state.diagnostics.push({
      severity: "error",
      message: source
        ? `loop until.source "${source}" must match a loop step id.`
        : "loop until.source is required.",
      range: readObjectPropertyValueRange(untilObject, "source"),
    });
  }
  if (finalStatus === undefined) {
    state.diagnostics.push({
      severity: "error",
      message: "loop until.finalStatus is required.",
      range: readObjectPropertyValueRange(options, "until") ?? toRange(options),
    });
  } else if (!finalStatus.trim()) {
    state.diagnostics.push({
      severity: "error",
      message: "loop until.finalStatus must be non-empty.",
      range: readObjectPropertyValueRange(untilObject, "finalStatus"),
    });
  }

  return { source, finalStatus: finalStatus ?? "" };
}

function readLoopOnMaxIterations(
  options: AnyNode | undefined,
  state: ParserState,
): WorkflowLoopSpec["onMaxIterations"] {
  const value = readObjectString(options, "onMaxIterations")?.trim();
  if (!value) {
    return "fail";
  }
  if (value === "fail" || value === "complete") {
    return value;
  }
  state.diagnostics.push({
    severity: "error",
    message: 'loop onMaxIterations must be "fail" or "complete".',
    range: readObjectPropertyValueRange(options, "onMaxIterations"),
  });
  return "fail";
}

function addDynamicNode(
  expression: AnyNode,
  variableName: string | undefined,
  kind: "pipeline" | "dynamic",
  state: ParserState,
  diagnostic?: { message: string },
): void {
  const id = variableName ?? `${kind}_${state.anonymousIndex++}`;
  const node: WorkflowNode = {
    id,
    kind,
    label: kind === "pipeline" ? "Pipeline" : "Dynamic block",
    phase: state.currentPhase,
    variableName,
    inputs: [],
    templateRefs: [],
    sourceRange: toRange(expression),
    diagnostics: diagnostic ? [diagnostic.message] : undefined,
  };
  state.nodes.push(node);
  addNodeToCurrentPhase(node.id, state);
  if (variableName) {
    state.variableToNodeId[variableName] = node.id;
  }
}

function connectTemplateRefs(state: ParserState): void {
  for (const node of state.nodes) {
    for (const ref of node.templateRefs) {
      if (isReservedTemplateRef(ref)) {
        continue;
      }
      if (node.inputs.some((input) => input.name === ref)) {
        continue;
      }
      const sourceNodeId = state.variableToNodeId[ref];
      if (!sourceNodeId || sourceNodeId === node.id) {
        continue;
      }
      node.inputs.push({
        name: ref,
        sourceVariable: ref,
        sourceNodeId,
      });
      addEdge(sourceNodeId, node.id, ref, state);
    }
  }
}

function addDuplicateNodeIdDiagnostics(state: ParserState): void {
  const firstNodeById = new Map<string, WorkflowNode>();
  for (const node of state.nodes) {
    const firstNode = firstNodeById.get(node.id);
    if (!firstNode) {
      firstNodeById.set(node.id, node);
      continue;
    }

    state.diagnostics.push({
      severity: "error",
      message: `Duplicate workflow node id "${node.id}". Node ids must be unique.`,
      range: node.sourceRange,
    });
  }
}

function addRuntimeOptionDiagnostics(state: ParserState): void {
  const workflowNames = new Set<string>();
  for (const node of state.nodes) {
    workflowNames.add(node.id);
    if (node.variableName) {
      workflowNames.add(node.variableName);
    }
  }
  for (const name of Object.keys(state.variableToNodeId)) {
    workflowNames.add(name);
  }

  for (const node of state.nodes) {
    validateRuntimeOptionField({
      value: node.agent,
      fieldName: "agent",
      ownerLabel: `node "${node.id}"`,
      range: node.sourceRange,
      disallowedInputNames: workflowNames,
      state,
    });
    validateRuntimeOptionField({
      value: node.model,
      fieldName: "model",
      ownerLabel: `node "${node.id}"`,
      range: node.sourceRange,
      disallowedInputNames: workflowNames,
      state,
    });

    if (!node.loop) {
      continue;
    }
    const loopStepNames = new Set(node.loop.steps.map((step) => step.id));
    for (const step of node.loop.steps) {
      const disallowedInputNames = new Set([
        ...workflowNames,
        ...loopStepNames,
      ]);
      validateRuntimeOptionField({
        value: step.agent,
        fieldName: "agent",
        ownerLabel: `loop step "${node.id}.${step.id}"`,
        range: step.sourceRange,
        disallowedInputNames,
        state,
      });
      validateRuntimeOptionField({
        value: step.model,
        fieldName: "model",
        ownerLabel: `loop step "${node.id}.${step.id}"`,
        range: step.sourceRange,
        disallowedInputNames,
        state,
      });
    }
  }
}

function validateRuntimeOptionField(input: {
  value: string | undefined;
  fieldName: "agent" | "model";
  ownerLabel: string;
  range?: EditableRange;
  disallowedInputNames: Set<string>;
  state: ParserState;
}): void {
  const validation = validateRuntimeOptionTemplate(input.value);
  for (const message of validation.diagnostics) {
    input.state.diagnostics.push({
      severity: "error",
      message: `${input.ownerLabel} ${input.fieldName}: ${message}`,
      range: input.range,
    });
  }
  for (const ref of validation.refs) {
    if (!input.disallowedInputNames.has(ref.name)) {
      continue;
    }
    input.state.diagnostics.push({
      severity: "error",
      message: `${input.ownerLabel} ${input.fieldName} runtime input "${ref.name}" conflicts with a workflow node, variable, or loop step id. Runtime option templates resolve run inputs only; choose a distinct input name.`,
      range: input.range,
    });
  }
}

function addInputSchemaReferenceDiagnostics(
  state: ParserState,
  inputSchema: WorkflowInputSchema,
): void {
  const declaredInputs = new Set(Object.keys(inputSchema));
  const usedInputs = new Set<string>();

  for (const node of state.nodes) {
    for (const ref of node.templateRefs) {
      if (isReservedTemplateRef(ref)) {
        continue;
      }
      const boundInput = node.inputs.find((input) => input.name === ref);
      if (boundInput?.sourceNodeId) {
        continue;
      }
      if (declaredInputs.has(ref)) {
        usedInputs.add(ref);
        continue;
      }
      state.diagnostics.push({
        severity: "error",
        message: `Workflow input "${ref}" is used in a template but is not declared in export const inputs.`,
        range: node.promptRange ?? node.sourceRange,
      });
    }
    const runtimeOptionRefs = collectRuntimeOptionRefs(node);
    for (const ref of [...runtimeOptionRefs.required, ...runtimeOptionRefs.optional]) {
      if (isReservedTemplateRef(ref) || declaredInputs.has(ref)) {
        if (declaredInputs.has(ref)) {
          usedInputs.add(ref);
        }
        continue;
      }
      state.diagnostics.push({
        severity: "error",
        message: `Runtime option input "${ref}" is not declared in export const inputs.`,
        range: node.sourceRange,
      });
    }
  }

  for (const name of declaredInputs) {
    if (usedInputs.has(name)) {
      continue;
    }
    state.diagnostics.push({
      severity: "warning",
      message: `Workflow input "${name}" is declared but not used by any template or runtime option.`,
    });
  }
}

function collectRuntimeOptionRefs(node: WorkflowNode): {
  required: string[];
  optional: string[];
} {
  const refs = [
    ...collectRuntimeOptionFieldRefs(node.agent),
    ...collectRuntimeOptionFieldRefs(node.model),
    ...(node.loop?.steps.flatMap((step) => [
      ...collectRuntimeOptionFieldRefs(step.agent),
      ...collectRuntimeOptionFieldRefs(step.model),
    ]) ?? []),
  ];
  return {
    required: [
      ...new Set(
        refs
          .filter((ref) => ref.required)
          .map((ref) => ref.name),
      ),
    ],
    optional: [
      ...new Set(
        refs
          .filter((ref) => !ref.required)
          .map((ref) => ref.name),
      ),
    ],
  };
}

function collectRuntimeOptionFieldRefs(value: string | undefined): Array<{
  name: string;
  required: boolean;
}> {
  return validateRuntimeOptionTemplate(value).refs.map((ref) => ({
    name: ref.name,
    required: ref.defaultValue === undefined,
  }));
}

function isReservedTemplateRef(ref: string): boolean {
  return RESERVED_TEMPLATE_REFS.has(ref) || ref.startsWith("workflow.");
}

function addInputEdges(node: WorkflowNode, state: ParserState): void {
  for (const input of node.inputs) {
    if (input.sourceNodeId) {
      addEdge(input.sourceNodeId, node.id, input.name, state);
    }
  }
}

function addEdge(
  source: string,
  target: string,
  label: string,
  state: ParserState,
): void {
  const id = `${source}->${target}:${label}`;
  if (state.edges.some((edge) => edge.id === id)) {
    return;
  }
  state.edges.push({ id, source, target, label });
}

function enterPhase(title: string, state: ParserState): void {
  state.currentPhase = title;
  if (!state.phases.some((phase) => phase.title === title)) {
    state.phases.push({
      id: createUniquePhaseId(title, state.phases),
      title,
      nodeIds: [],
    });
  }
}

function addNodeToCurrentPhase(nodeId: string, state: ParserState): void {
  if (!state.currentPhase) {
    enterPhase("Workflow", state);
  }
  const phase = state.phases.find((item) => item.title === state.currentPhase);
  phase?.nodeIds.push(nodeId);
}

function readMeta(ast: AnyNode): WorkflowMeta | undefined {
  const value = readExportedConstValue(ast, "meta");
  if (!value || value.type !== "ObjectExpression") {
    return undefined;
  }
  return {
    name: readObjectString(value, "name") ?? DEFAULT_META.name,
    description:
      readObjectString(value, "description") ?? DEFAULT_META.description,
    ...(readObjectBoolean(value, "requiresCwd")
      ? { requiresCwd: true }
      : {}),
  };
}

function readInputSchema(ast: AnyNode, state: ParserState): WorkflowInputSchema {
  const value = readExportedConstValue(ast, "inputs");
  if (!value) {
    return {};
  }
  if (value.type !== "ObjectExpression") {
    state.diagnostics.push({
      severity: "error",
      message: "export const inputs must be an object literal.",
      range: toRange(value),
    });
    return {};
  }

  const properties = (value.properties as AnyNode[] | undefined) ?? [];
  const schema: WorkflowInputSchema = {};
  for (const property of properties) {
    if (property.type !== "ObjectProperty") {
      state.diagnostics.push({
        severity: "error",
        message: "Workflow inputs only support object properties.",
        range: toRange(property),
      });
      continue;
    }
    const name = readKeyName(property.key as AnyNode);
    const definitionObject = property.value as AnyNode | undefined;
    if (!name) {
      state.diagnostics.push({
        severity: "error",
        message: "Workflow input names must be identifiers or string keys.",
        range: toRange(property),
      });
      continue;
    }
    if (!definitionObject || definitionObject.type !== "ObjectExpression") {
      state.diagnostics.push({
        severity: "error",
        message: `Workflow input "${name}" must be an object literal.`,
        range: toRange(property),
      });
      continue;
    }
    const definition = readInputDefinition(name, definitionObject, state);
    if (definition) {
      schema[name] = definition;
    }
  }
  return schema;
}

function readInputDefinition(
  name: string,
  objectExpression: AnyNode,
  state: ParserState,
): WorkflowInputDefinition | undefined {
  const type = readObjectString(objectExpression, "type");
  const common = {
    ...(readOptionalObjectBoolean(objectExpression, "required", state, name) === true
      ? { required: true }
      : {}),
    ...readOptionalStringProperty(objectExpression, "label", state, name),
    ...readOptionalStringProperty(objectExpression, "description", state, name),
  };

  if (!type) {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${name}" requires type.`,
      range: readObjectPropertyValueRange(objectExpression, "type") ??
        toRange(objectExpression),
    });
    return undefined;
  }

  if (type === "string") {
    addUnknownInputDefinitionFieldDiagnostics(
      objectExpression,
      name,
      [
        "type",
        "required",
        "label",
        "description",
        "default",
        "placeholder",
        "widget",
        "minLength",
        "maxLength",
        "pattern",
      ],
      state,
    );
    const definition: WorkflowInputDefinition = {
      type,
      ...common,
      ...readOptionalStringProperty(objectExpression, "default", state, name),
      ...readOptionalStringProperty(objectExpression, "placeholder", state, name),
      ...readStringWidgetProperty(objectExpression, state, name),
      ...readOptionalNumberProperty(objectExpression, "minLength", state, name),
      ...readOptionalNumberProperty(objectExpression, "maxLength", state, name),
      ...readPatternProperty(objectExpression, state, name),
    };
    addStringInputConstraintDiagnostics(definition, objectExpression, name, state);
    return definition;
  }

  if (type === "number") {
    addUnknownInputDefinitionFieldDiagnostics(
      objectExpression,
      name,
      ["type", "required", "label", "description", "default", "min", "max", "step"],
      state,
    );
    const definition: WorkflowInputDefinition = {
      type,
      ...common,
      ...readOptionalNumberProperty(objectExpression, "default", state, name),
      ...readOptionalNumberProperty(objectExpression, "min", state, name),
      ...readOptionalNumberProperty(objectExpression, "max", state, name),
      ...readOptionalNumberProperty(objectExpression, "step", state, name),
    };
    addNumberInputConstraintDiagnostics(definition, objectExpression, name, state);
    return definition;
  }

  if (type === "boolean") {
    addUnknownInputDefinitionFieldDiagnostics(
      objectExpression,
      name,
      ["type", "required", "label", "description", "default"],
      state,
    );
    return {
      type,
      ...common,
      ...readOptionalBooleanProperty(objectExpression, "default", state, name),
    };
  }

  if (type === "enum") {
    addUnknownInputDefinitionFieldDiagnostics(
      objectExpression,
      name,
      ["type", "required", "label", "description", "default", "options"],
      state,
    );
    const options = readStringArrayProperty(objectExpression, "options", state, name);
    const defaultValue = readObjectString(objectExpression, "default");
    if (defaultValue !== undefined && !options.includes(defaultValue)) {
      state.diagnostics.push({
        severity: "error",
        message: `Workflow input "${name}" default must be one of its options.`,
        range: readObjectPropertyValueRange(objectExpression, "default"),
      });
    }
    return {
      type,
      ...common,
      options,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    };
  }

  state.diagnostics.push({
    severity: "error",
    message: `Workflow input "${name}" type must be "string", "number", "boolean", or "enum".`,
    range: readObjectPropertyValueRange(objectExpression, "type"),
  });
  return undefined;
}

function addUnknownInputDefinitionFieldDiagnostics(
  objectExpression: AnyNode,
  inputName: string,
  allowedFields: string[],
  state: ParserState,
): void {
  const allowed = new Set(allowedFields);
  const properties = (objectExpression.properties as AnyNode[] | undefined) ?? [];
  for (const property of properties) {
    if (property.type !== "ObjectProperty") {
      continue;
    }
    const key = readKeyName(property.key as AnyNode);
    if (!key || allowed.has(key)) {
      continue;
    }
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" has unsupported field "${key}".`,
      range: toRange(property.key as AnyNode),
    });
  }
}

function addStringInputConstraintDiagnostics(
  definition: Extract<WorkflowInputDefinition, { type: "string" }>,
  objectExpression: AnyNode,
  inputName: string,
  state: ParserState,
): void {
  if (
    definition.minLength !== undefined &&
    definition.maxLength !== undefined &&
    definition.minLength > definition.maxLength
  ) {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" minLength must be at most maxLength.`,
      range: readObjectPropertyValueRange(objectExpression, "maxLength"),
    });
  }

  if (definition.default === undefined) {
    return;
  }

  if (
    definition.minLength !== undefined &&
    definition.default.length < definition.minLength
  ) {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" default must be at least ${definition.minLength} characters.`,
      range: readObjectPropertyValueRange(objectExpression, "default"),
    });
  }
  if (
    definition.maxLength !== undefined &&
    definition.default.length > definition.maxLength
  ) {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" default must be at most ${definition.maxLength} characters.`,
      range: readObjectPropertyValueRange(objectExpression, "default"),
    });
  }
  if (definition.pattern !== undefined) {
    try {
      const pattern = new RegExp(definition.pattern);
      if (!pattern.test(definition.default)) {
        state.diagnostics.push({
          severity: "error",
          message: `Workflow input "${inputName}" default does not match the required pattern.`,
          range: readObjectPropertyValueRange(objectExpression, "default"),
        });
      }
    } catch {
      // readPatternProperty already reports invalid regex syntax.
    }
  }
}

function addNumberInputConstraintDiagnostics(
  definition: Extract<WorkflowInputDefinition, { type: "number" }>,
  objectExpression: AnyNode,
  inputName: string,
  state: ParserState,
): void {
  if (
    definition.min !== undefined &&
    definition.max !== undefined &&
    definition.min > definition.max
  ) {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" min must be at most max.`,
      range: readObjectPropertyValueRange(objectExpression, "max"),
    });
  }

  if (definition.default === undefined) {
    return;
  }

  if (definition.min !== undefined && definition.default < definition.min) {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" default must be at least ${definition.min}.`,
      range: readObjectPropertyValueRange(objectExpression, "default"),
    });
  }
  if (definition.max !== undefined && definition.default > definition.max) {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" default must be at most ${definition.max}.`,
      range: readObjectPropertyValueRange(objectExpression, "default"),
    });
  }
}

function readOptionalStringProperty(
  objectExpression: AnyNode,
  key: string,
  state: ParserState,
  inputName: string,
): Record<string, string> {
  const value = readObjectPropertyValue(objectExpression, key);
  if (!value) {
    return {};
  }
  const stringValue = readStringLike(value);
  if (stringValue === undefined) {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" ${key} must be a string.`,
      range: toRange(value),
    });
    return {};
  }
  return { [key]: stringValue };
}

function readOptionalNumberProperty(
  objectExpression: AnyNode,
  key: string,
  state: ParserState,
  inputName: string,
): Record<string, number> {
  const value = readObjectPropertyValue(objectExpression, key);
  if (!value) {
    return {};
  }
  const numberValue = readNumberLike(value);
  if (numberValue === undefined) {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" ${key} must be a number.`,
      range: toRange(value),
    });
    return {};
  }
  return { [key]: numberValue };
}

function readOptionalBooleanProperty(
  objectExpression: AnyNode,
  key: string,
  state: ParserState,
  inputName: string,
): Record<string, boolean> {
  const value = readObjectPropertyValue(objectExpression, key);
  if (!value) {
    return {};
  }
  if (value.type !== "BooleanLiteral" || typeof value.value !== "boolean") {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" ${key} must be a boolean.`,
      range: toRange(value),
    });
    return {};
  }
  return { [key]: value.value as boolean };
}

function readOptionalObjectBoolean(
  objectExpression: AnyNode,
  key: string,
  state: ParserState,
  inputName: string,
): boolean | undefined {
  const value = readObjectPropertyValue(objectExpression, key);
  if (!value) {
    return undefined;
  }
  if (value.type !== "BooleanLiteral" || typeof value.value !== "boolean") {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" ${key} must be a boolean.`,
      range: toRange(value),
    });
    return undefined;
  }
  return value.value as boolean;
}

function readStringWidgetProperty(
  objectExpression: AnyNode,
  state: ParserState,
  inputName: string,
): Partial<Extract<WorkflowInputDefinition, { type: "string" }>> {
  const widget = readObjectString(objectExpression, "widget");
  if (widget === undefined) {
    return {};
  }
  if (widget !== "text" && widget !== "textarea") {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" widget must be "text" or "textarea".`,
      range: readObjectPropertyValueRange(objectExpression, "widget"),
    });
    return {};
  }
  return { widget };
}

function readPatternProperty(
  objectExpression: AnyNode,
  state: ParserState,
  inputName: string,
): Partial<Extract<WorkflowInputDefinition, { type: "string" }>> {
  const pattern = readObjectString(objectExpression, "pattern");
  if (pattern === undefined) {
    return {};
  }
  try {
    new RegExp(pattern);
  } catch {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" pattern must be a valid regular expression.`,
      range: readObjectPropertyValueRange(objectExpression, "pattern"),
    });
  }
  return { pattern };
}

function readStringArrayProperty(
  objectExpression: AnyNode,
  key: string,
  state: ParserState,
  inputName: string,
): string[] {
  const value = readObjectPropertyValue(objectExpression, key);
  if (!value || value.type !== "ArrayExpression") {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" ${key} must be a string array.`,
      range: readObjectPropertyValueRange(objectExpression, key) ??
        toRange(objectExpression),
    });
    return [];
  }
  const elements = (value.elements as AnyNode[] | undefined) ?? [];
  const strings = elements.flatMap((element) => {
    const stringValue = readStringLike(element);
    if (stringValue === undefined) {
      state.diagnostics.push({
        severity: "error",
        message: `Workflow input "${inputName}" ${key} must contain only strings.`,
        range: toRange(element),
      });
      return [];
    }
    return [stringValue];
  });
  if (strings.length === 0) {
    state.diagnostics.push({
      severity: "error",
      message: `Workflow input "${inputName}" ${key} must contain at least one option.`,
      range: toRange(value),
    });
  }
  return strings;
}

function readSessionSpec(
  objectExpression: AnyNode | undefined,
  state: ParserState,
  owner: "agent" | "loop" | "loopStep",
): WorkflowSessionSpec | undefined {
  const value = readObjectPropertyValue(objectExpression, "session");
  if (!value) {
    return undefined;
  }
  const range = toRange(value);

  if (readStringLike(value) !== undefined) {
    state.diagnostics.push({
      severity: "error",
      message:
        'session must be an object, for example { mode: "inherit", key: "room" } or { mode: "independent" }.',
      range,
    });
    return undefined;
  }

  if (value.type !== "ObjectExpression") {
    state.diagnostics.push({
      severity: "error",
      message: "session must be an object.",
      range,
    });
    return undefined;
  }

  const mode = readObjectString(value, "mode")?.trim();
  if (mode === "independent") {
    const scope = readObjectString(value, "scope")?.trim();
    if (scope) {
      state.diagnostics.push({
        severity: "error",
        message: "session.scope is only valid with mode: \"inherit\".",
        range: readObjectPropertyValueRange(value, "scope"),
      });
    }
    return { mode: "independent" };
  }

  if (mode === "inherit") {
    const key = readObjectString(value, "key")?.trim();
    if (!key) {
      state.diagnostics.push({
        severity: "error",
        message: 'session with mode: "inherit" requires a non-empty key.',
        range: readObjectPropertyValueRange(value, "key") ?? range,
      });
      return undefined;
    }

    const rawScope = readObjectString(value, "scope")?.trim();
    if (rawScope && rawScope !== "loop" && rawScope !== "step") {
      state.diagnostics.push({
        severity: "error",
        message: 'session.scope must be "loop" or "step".',
        range: readObjectPropertyValueRange(value, "scope"),
      });
      return { mode: "inherit", key };
    }
    const scope = rawScope as "loop" | "step" | undefined;
    if (scope && owner !== "loop") {
      state.diagnostics.push({
        severity: "error",
        message: "session.scope is only valid on loop({...}) session defaults.",
        range: readObjectPropertyValueRange(value, "scope"),
      });
      return { mode: "inherit", key };
    }

    return {
      mode: "inherit",
      key,
      ...(scope ? { scope } : {}),
    };
  }

  state.diagnostics.push({
    severity: "error",
    message: 'session.mode must be "independent" or "inherit".',
    range: readObjectPropertyValueRange(value, "mode") ?? range,
  });
  return undefined;
}

function readInputs(
  options: AnyNode | undefined,
  state: ParserState,
): WorkflowInputBinding[] {
  const inputsObject = readObjectPropertyValue(options, "inputs");
  if (!inputsObject || inputsObject.type !== "ObjectExpression") {
    return [];
  }
  const properties = (inputsObject.properties as AnyNode[] | undefined) ?? [];
  return properties.flatMap((property) => {
    if (property.type !== "ObjectProperty") {
      return [];
    }
    const name = readKeyName(property.key as AnyNode);
    const sourceVariable = readIdentifierName(property.value as AnyNode);
    if (!name || !sourceVariable) {
      return [];
    }
    return [
      {
        name,
        sourceVariable,
        sourceNodeId: state.variableToNodeId[sourceVariable],
      },
    ];
  });
}

function unwrapExpression(statement: AnyNode | undefined): AnyNode | undefined {
  if (!statement) {
    return undefined;
  }
  if (statement.type === "ExpressionStatement") {
    return unwrapExpression(statement.expression as AnyNode);
  }
  if (statement.type === "VariableDeclaration") {
    const declaration = (statement.declarations as AnyNode[] | undefined)?.[0];
    return unwrapExpression(declaration?.init as AnyNode | undefined);
  }
  if (statement.type === "AwaitExpression") {
    return unwrapExpression(statement.argument as AnyNode);
  }
  if (statement.type === "ReturnStatement") {
    return unwrapExpression(statement.argument as AnyNode);
  }
  return statement;
}

function unwrapFunctionBody(node: AnyNode | undefined): AnyNode | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    const body = node.body as AnyNode | undefined;
    if (body?.type === "BlockStatement") {
      const statements = (body.body as AnyNode[] | undefined) ?? [];
      return statements.find((statement) => statement.type === "ReturnStatement");
    }
    return body;
  }
  return node;
}

function readPhaseCallbackBody(callExpression: AnyNode): AnyNode[] | undefined {
  const callback = ((callExpression.arguments as AnyNode[] | undefined) ?? [])[1];
  if (
    callback?.type !== "ArrowFunctionExpression" &&
    callback?.type !== "FunctionExpression"
  ) {
    return undefined;
  }
  const body = callback.body as AnyNode | undefined;
  if (body?.type !== "BlockStatement") {
    return undefined;
  }
  return (body.body as AnyNode[] | undefined) ?? [];
}

function isCallExpression(
  node: AnyNode | undefined,
  calleeName: string,
): node is AnyNode {
  if (!node || node.type !== "CallExpression") {
    return false;
  }
  return readIdentifierName(node.callee as AnyNode) === calleeName;
}

function firstArg(node: AnyNode): AnyNode | undefined {
  return ((node.arguments as AnyNode[] | undefined) ?? [])[0];
}

function readFirstStringArg(node: AnyNode): string | undefined {
  return readStringLike(firstArg(node));
}

function readVariableName(statement: AnyNode): string | undefined {
  if (statement.type !== "VariableDeclaration") {
    return undefined;
  }
  const declaration = (statement.declarations as AnyNode[] | undefined)?.[0];
  return readIdentifierName(declaration?.id as AnyNode | undefined);
}

function readObjectString(
  objectExpression: AnyNode | undefined,
  key: string,
): string | undefined {
  return readStringLike(readObjectPropertyValue(objectExpression, key));
}

function readObjectNumber(
  objectExpression: AnyNode | undefined,
  key: string,
): number {
  const value = readObjectPropertyValue(objectExpression, key);
  return readNumberLike(value) ?? Number.NaN;
}

function readObjectBoolean(
  objectExpression: AnyNode | undefined,
  key: string,
): boolean {
  const value = readObjectPropertyValue(objectExpression, key);
  return value?.type === "BooleanLiteral" && value.value === true;
}

function readObjectPropertyValue(
  objectExpression: AnyNode | undefined,
  key: string,
): AnyNode | undefined {
  if (!objectExpression || objectExpression.type !== "ObjectExpression") {
    return undefined;
  }
  const properties = (objectExpression.properties as AnyNode[] | undefined) ?? [];
  const property = properties.find(
    (item) =>
      item.type === "ObjectProperty" &&
      readKeyName(item.key as AnyNode) === key,
  );
  return property?.value as AnyNode | undefined;
}

function readObjectPropertyValueRange(
  objectExpression: AnyNode | undefined,
  key: string,
) {
  return toRange(readObjectPropertyValue(objectExpression, key));
}

function readExportedConstValue(
  ast: AnyNode,
  exportName: string,
): AnyNode | undefined {
  const body = getProgramBody(ast);
  for (const statement of body) {
    if (statement.type !== "ExportNamedDeclaration") {
      continue;
    }
    const declaration = statement.declaration as AnyNode | undefined;
    if (declaration?.type !== "VariableDeclaration") {
      continue;
    }
    const declarations = declaration.declarations as AnyNode[] | undefined;
    const found = declarations?.find(
      (item) => readIdentifierName(item.id as AnyNode) === exportName,
    );
    if (found) {
      return found.init as AnyNode | undefined;
    }
  }
  return undefined;
}

function readStringLike(node: AnyNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "StringLiteral") {
    return node.value as string;
  }
  if (node.type === "TemplateLiteral") {
    const expressions = (node.expressions as AnyNode[] | undefined) ?? [];
    if (expressions.length > 0) {
      return undefined;
    }
    const quasis = (node.quasis as AnyNode[] | undefined) ?? [];
    return quasis.map((quasi) => {
      const value = quasi.value as { cooked?: string; raw?: string } | undefined;
      return value?.cooked ?? value?.raw ?? "";
    }).join("");
  }
  return undefined;
}

function readNumberLike(node: AnyNode | undefined): number | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "NumericLiteral" && typeof node.value === "number") {
    return node.value;
  }
  if (node.type === "UnaryExpression") {
    const operator = node.operator;
    const argument = node.argument as AnyNode | undefined;
    if (
      (operator === "-" || operator === "+") &&
      argument?.type === "NumericLiteral" &&
      typeof argument.value === "number"
    ) {
      return operator === "-" ? -argument.value : argument.value;
    }
  }
  return undefined;
}

function readIdentifierName(node: AnyNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "Identifier") {
    return node.name as string;
  }
  return undefined;
}

function readKeyName(node: AnyNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "Identifier") {
    return node.name as string;
  }
  if (node.type === "StringLiteral") {
    return node.value as string;
  }
  return undefined;
}

function getProgramBody(ast: AnyNode): AnyNode[] {
  const program = ast.program as AnyNode | undefined;
  return (program?.body as AnyNode[] | undefined) ?? [];
}

function toRange(node: AnyNode | undefined) {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") {
    return undefined;
  }
  return { start: node.start, end: node.end };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function createUniquePhaseId(title: string, phases: WorkflowPhase[]): string {
  const baseId = slugify(title) || `phase-${phases.length + 1}`;
  const existingIds = new Set(phases.map((phase) => phase.id));
  let id = baseId;
  let suffix = 2;

  while (existingIds.has(id)) {
    id = `${baseId}-${suffix++}`;
  }

  return id;
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
