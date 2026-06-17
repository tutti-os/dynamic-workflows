import type { WorkflowNode } from "./types";

const TEMPLATE_REF_PATTERN = /\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g;

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

export function renderPrompt(
  node: WorkflowNode,
  outputs: Record<string, string>,
): string {
  const prompt = node.prompt ?? "";
  const bindings = new Map(
    node.inputs.map((input) => [input.name, input.sourceNodeId]),
  );

  return prompt.replace(TEMPLATE_REF_PATTERN, (_match, name: string) => {
    const sourceNodeId = bindings.get(name);
    if (!sourceNodeId) {
      return "";
    }
    return outputs[sourceNodeId] ?? "";
  });
}

export function quoteTemplateLiteral(value: string): string {
  return `\`${value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")}\``;
}
