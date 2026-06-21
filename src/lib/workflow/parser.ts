import { parse } from "@babel/parser";
import type {
  ParsedWorkflow,
  WorkflowDiagnostic,
  WorkflowEdge,
  WorkflowInputBinding,
  WorkflowMeta,
  WorkflowNode,
  WorkflowPhase,
} from "./types";
import { extractTemplateRefs } from "./templates";

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
      externalInputs: [],
      diagnostics: [
        parseErrorToDiagnostic(error),
      ],
      variableToNodeId: {},
    };
  }

  state.diagnostics.push(...readRecoveredParserErrors(ast));

  const meta = readMeta(ast) ?? DEFAULT_META;
  const body = getProgramBody(ast);

  for (const statement of body) {
    visitTopLevelStatement(statement, state);
  }

  addDuplicateNodeIdDiagnostics(state);
  connectTemplateRefs(state);
  const externalInputs = collectExternalInputs(state);

  return {
    meta,
    nodes: state.nodes,
    edges: state.edges,
    phases: state.phases,
    externalInputs,
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
    enterPhase(title, state);
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
  const node: WorkflowNode = {
    id,
    kind: "agent",
    label,
    phase: state.currentPhase,
    variableName,
    prompt,
    provider: readObjectString(options, "provider"),
    model: readObjectString(options, "model"),
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

function collectExternalInputs(state: ParserState): string[] {
  const refs = new Set<string>();

  for (const node of state.nodes) {
    for (const ref of node.templateRefs) {
      const boundInput = node.inputs.find((input) => input.name === ref);
      if (boundInput?.sourceNodeId) {
        continue;
      }
      refs.add(ref);
    }
  }

  return [...refs];
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
    const metaDeclaration = declarations?.find(
      (item) => readIdentifierName(item.id as AnyNode) === "meta",
    );
    const value = metaDeclaration?.init as AnyNode | undefined;
    if (!value || value.type !== "ObjectExpression") {
      continue;
    }
    return {
      name: readObjectString(value, "name") ?? DEFAULT_META.name,
      description:
        readObjectString(value, "description") ?? DEFAULT_META.description,
    };
  }
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
