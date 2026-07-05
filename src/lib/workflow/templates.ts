import type { WorkflowNode } from "./types";

const TEMPLATE_REF_PATTERN =
  /\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}\}/g;
const VALUE_TEMPLATE_REF_PATTERN =
  /\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\s*:\s*([^}]*?))?\s*\}\}/g;
const WHOLE_VALUE_TEMPLATE_PATTERN =
  /^\s*\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\s*:\s*([^}]*?))?\s*\}\}\s*$/;

export type ValueTemplateRef = {
  name: string;
  defaultValue?: string;
};

export type RuntimeOptionTemplateValidation = {
  refs: ValueTemplateRef[];
  diagnostics: string[];
};

export function extractTemplateRefs(prompt: string | undefined): string[] {
  if (!prompt) {
    return [];
  }

  const refs = new Set<string>();
  for (const match of prompt.matchAll(TEMPLATE_REF_PATTERN)) {
    refs.add(match[1]);
  }
  return [...refs];
}

export function extractValueTemplateRefs(
  template: string | undefined,
): ValueTemplateRef[] {
  if (!template) {
    return [];
  }

  const refs = new Map<string, ValueTemplateRef>();
  for (const match of template.matchAll(VALUE_TEMPLATE_REF_PATTERN)) {
    const name = match[1];
    const defaultValue = match[2]?.trim();
    if (!refs.has(name)) {
      refs.set(name, {
        name,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
      });
    }
  }
  return [...refs.values()];
}

export function extractRequiredValueTemplateRefs(
  template: string | undefined,
): string[] {
  return validateRuntimeOptionTemplate(template).refs
    .filter((ref) => ref.defaultValue === undefined)
    .map((ref) => ref.name);
}

export function validateRuntimeOptionTemplate(
  template: string | undefined,
): RuntimeOptionTemplateValidation {
  if (!template) {
    return {
      refs: [],
      diagnostics: [],
    };
  }

  const refs = extractValueTemplateRefs(template);
  if (refs.length === 0) {
    if (template.includes("{{") || template.includes("}}")) {
      return {
        refs: [],
        diagnostics: [
          'agent/model runtime templates must use {{input_name}} or {{input_name:default_value}}.',
        ],
      };
    }
    return {
      refs: [],
      diagnostics: [],
    };
  }

  const wholeMatch = template.match(WHOLE_VALUE_TEMPLATE_PATTERN);
  if (!wholeMatch) {
    return {
      refs,
      diagnostics: [
        "agent/model runtime templates must be exactly one placeholder with no surrounding text or additional placeholders.",
      ],
    };
  }

  const name = wholeMatch[1];
  const defaultValue = wholeMatch[2]?.trim();
  const diagnostics: string[] = [];
  if (defaultValue !== undefined && !defaultValue) {
    diagnostics.push(
      "agent/model runtime template defaults must be non-empty when provided.",
    );
  }
  if (name === "iteration" || name.startsWith("workflow.")) {
    diagnostics.push(
      `agent/model runtime template "{{${name}}}" is invalid because runtime options resolve run inputs only.`,
    );
  }

  return {
    refs: [
      {
        name,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
      },
    ],
    diagnostics,
  };
}

export function renderPrompt(
  node: WorkflowNode,
  outputs: Record<string, string>,
  workflowInputs: Record<string, string> = {},
  context: { cwd?: string } = {},
): string {
  const bindings = new Map(
    node.inputs.map((input) => [input.name, input.sourceNodeId]),
  );

  return renderTemplate(node.prompt ?? "", (name) => {
    if (name === "workflow.cwd") {
      return context.cwd ?? "";
    }
    const sourceNodeId = bindings.get(name);
    if (!sourceNodeId) {
      return workflowInputs[name] ?? "";
    }
    return outputs[sourceNodeId] ?? "";
  });
}

export function renderTemplate(
  template: string,
  resolveValue: (name: string) => string | undefined,
): string {
  return template.replace(TEMPLATE_REF_PATTERN, (_match, name: string) => {
    return resolveValue(name) ?? "";
  });
}

export function renderValueTemplate(
  template: string,
  resolveValue: (name: string) => string | undefined,
): string {
  return template.replace(
    VALUE_TEMPLATE_REF_PATTERN,
    (_match, name: string, defaultValue: string | undefined) => {
      const value = resolveValue(name);
      if (value?.trim()) {
        return value;
      }
      return defaultValue?.trim() ?? "";
    },
  );
}

export function quoteTemplateLiteral(value: string): string {
  return `\`${value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")}\``;
}
