import type {
  WorkflowInputDefinition,
  WorkflowInputSchema,
  WorkflowInputValue,
} from "@/lib/workflow/types";

export function listRequiredInputNames(schema: WorkflowInputSchema): string[] {
  return Object.entries(schema)
    .filter(([, definition]) => isInputRequired(definition))
    .map(([name]) => name);
}

export function listOptionalInputNames(schema: WorkflowInputSchema): string[] {
  return Object.entries(schema)
    .filter(([, definition]) => !isInputRequired(definition))
    .map(([name]) => name);
}

export function normalizeWorkflowInputsForSchema(
  schema: WorkflowInputSchema,
  rawInputs: unknown,
): Record<string, WorkflowInputValue> {
  const source =
    rawInputs && typeof rawInputs === "object" && !Array.isArray(rawInputs)
      ? (rawInputs as Record<string, unknown>)
      : {};
  const normalized: Record<string, WorkflowInputValue> = {};

  for (const [name, definition] of Object.entries(schema)) {
    const rawValue = source[name];
    const value = normalizeWorkflowInputValue(name, definition, rawValue);
    if (value !== undefined) {
      normalized[name] = value;
    }
  }

  return normalized;
}

export function stringifyWorkflowInputs(
  inputs: Record<string, WorkflowInputValue> | undefined,
): Record<string, string> {
  if (!inputs) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [key, String(value)]),
  );
}

export function readWorkflowInputsObject(
  value: unknown,
): Record<string, WorkflowInputValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, inputValue]) =>
      isWorkflowInputValue(inputValue) ? [[key, inputValue]] : [],
    ),
  );
}

function normalizeWorkflowInputValue(
  name: string,
  definition: WorkflowInputDefinition,
  rawValue: unknown,
): WorkflowInputValue | undefined {
  const hasValue = !isBlankInputValue(rawValue);
  const value = hasValue ? rawValue : definition.default;

  if (value === undefined) {
    if (isInputRequired(definition)) {
      throw new Error(`Missing required input: ${name}`);
    }
    return undefined;
  }

  switch (definition.type) {
    case "string":
      return normalizeStringInput(name, definition, value);
    case "number":
      return normalizeNumberInput(name, definition, value);
    case "boolean":
      return normalizeBooleanInput(name, value);
    case "enum":
      return normalizeEnumInput(name, definition, value);
  }
}

function normalizeStringInput(
  name: string,
  definition: Extract<WorkflowInputDefinition, { type: "string" }>,
  value: unknown,
): string {
  const normalized =
    typeof value === "string" ? value : String(value);
  if (definition.minLength !== undefined && normalized.length < definition.minLength) {
    throw new Error(`Input ${name} must be at least ${definition.minLength} characters.`);
  }
  if (definition.maxLength !== undefined && normalized.length > definition.maxLength) {
    throw new Error(`Input ${name} must be at most ${definition.maxLength} characters.`);
  }
  if (definition.pattern !== undefined) {
    const pattern = new RegExp(definition.pattern);
    if (!pattern.test(normalized)) {
      throw new Error(`Input ${name} does not match the required pattern.`);
    }
  }
  return normalized;
}

function normalizeNumberInput(
  name: string,
  definition: Extract<WorkflowInputDefinition, { type: "number" }>,
  value: unknown,
): number {
  const normalized =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(normalized)) {
    throw new Error(`Input ${name} must be a number.`);
  }
  if (definition.min !== undefined && normalized < definition.min) {
    throw new Error(`Input ${name} must be at least ${definition.min}.`);
  }
  if (definition.max !== undefined && normalized > definition.max) {
    throw new Error(`Input ${name} must be at most ${definition.max}.`);
  }
  return normalized;
}

function normalizeBooleanInput(name: string, value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  throw new Error(`Input ${name} must be a boolean.`);
}

function normalizeEnumInput(
  name: string,
  definition: Extract<WorkflowInputDefinition, { type: "enum" }>,
  value: unknown,
): string {
  const normalized = typeof value === "string" ? value : String(value);
  if (!definition.options.includes(normalized)) {
    throw new Error(
      `Input ${name} must be one of: ${definition.options.join(", ")}`,
    );
  }
  return normalized;
}

function isInputRequired(definition: WorkflowInputDefinition): boolean {
  return definition.required === true && definition.default === undefined;
}

function isBlankInputValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  );
}

function isWorkflowInputValue(value: unknown): value is WorkflowInputValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
