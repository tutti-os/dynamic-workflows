import { randomUUID } from "node:crypto";
import { runAgent } from "@/lib/agents/runtime";
import type { AgentRuntimeEvent } from "@/lib/agents/types";
import { resolveWorkflowCwd } from "./cwd";
import {
  assertWorkflowScriptValid,
  WorkflowScriptSyntaxError,
} from "./parser";
import { SAMPLE_WORKFLOW } from "./sample";

export type GeneratedWorkflowScript = {
  script: string;
  repaired: boolean;
  repairAttempts: number;
};

export type EditedWorkflowScript = GeneratedWorkflowScript;

export async function generateWorkflowScript(input: {
  description: string;
  provider?: string;
  model?: string;
  cwd?: string;
}): Promise<string> {
  return (await generateWorkflowScriptWithRepair(input)).script;
}

export async function generateWorkflowScriptWithRepair(input: {
  description: string;
  provider?: string;
  model?: string;
  cwd?: string;
}): Promise<GeneratedWorkflowScript> {
  if (!input.description.trim() || input.provider === "mock" || !input.provider) {
    const script = personalizeSample(input.description);
    assertWorkflowScriptValid(script);
    return {
      script,
      repaired: false,
      repairAttempts: 0,
    };
  }

  const prompt = `Create a dynamic workflow script for this request:

${input.description}

Rules:
- Return only JavaScript code, no markdown fences.
- Use "export const meta = { name, description }"; add requiresCwd: true when the workflow must be launched from an explicit project directory.
- Use phase("...") to group work.
- Use agent({ id, label, inputs, prompt }) for normal DAG steps, with optional session: { mode: "inherit", key: "name" } when multiple steps should reuse the same agent conversation.
- A normal agent can include provider and model to override the run defaults.
- Use cwd: "relative/path" on agent({...}) when that agent must run in a specific directory relative to the current run cwd.
- Use loop({ id, label, maxIterations, steps, until }) for bounded iterative workflows such as implementation/acceptance or multi-agent debate.
- A loop can include provider and model as defaults for its steps.
- Use cwd on loop({...}) as the default cwd for its steps; step cwd overrides loop cwd.
- loop maxIterations must be an integer from 1 to 10.
- loop steps must be agent({ id, label, prompt }) calls; use session: { mode: "inherit", key: "role_room" } when a role should keep its own conversation across iterations.
- A loop step agent can include provider and model to override the loop and run defaults for that role.
- A loop step can include cwd when that role must run in a specific directory.
- Use appendPrompt on inherited loop steps when the first turn should initialize the role and later iterations should send only feedback or deltas.
- Use session: { mode: "independent" } only when a step must explicitly start a fresh agent session each time.
- A loop can provide session: { mode: "inherit", key: "loop_room", scope: "step" } to derive per-step session keys, or scope: "loop" to share one loop-level session.
- loop until must be { source: "<step id>", includes: "<literal marker>" }.
- Put upstream values in inputs, for example inputs: { inventory }.
- Reference inputs inside prompts with {{inventory}}.
- Use {{workflow.cwd}} in prompts when agents need to know the actual run cwd; do not create a normal {{cwd}} input for this.
- Reuse the same inherited session key only for agent calls that must share conversation context; keep independent agents sessionless.
- Do not reuse the same inherited session key across different cwd values.
- Never use legacy string session values.
- Inside loop step prompts, reference other step ids with {{step_id}} to use the most recent output.
- Inside loop step prompts, use {{iteration}} for the current 1-based iteration number.
- Do not concatenate prompt strings with +.
- Do not use Node APIs, imports, require, fs, network APIs, Date, or Math.random.
- Keep the workflow readable and editable in a UI.`;

  const cwd = resolveWorkflowCwd(input.cwd);
  const generated = stripCodeFence(
    (await collectAgentText({
      provider: input.provider,
      model: input.model,
      cwd,
      prompt,
    })).trim(),
  ) || personalizeSample(input.description);

  try {
    assertWorkflowScriptValid(generated);
    return {
      script: generated,
      repaired: false,
      repairAttempts: 0,
    };
  } catch (error) {
    if (!(error instanceof WorkflowScriptSyntaxError)) {
      throw error;
    }

    const repaired = stripCodeFence(
      await collectAgentText({
        provider: input.provider,
        model: input.model,
        cwd,
        prompt: buildRepairPrompt({
          description: input.description,
          script: generated,
          error,
        }),
      }),
    );

    assertWorkflowScriptValid(repaired);
    return {
      script: repaired,
      repaired: true,
      repairAttempts: 1,
    };
  }
}

export async function editWorkflowScriptWithRepair(input: {
  currentScript: string;
  instruction: string;
  provider?: string;
  model?: string;
  cwd?: string;
  onEvent?: (event: AgentRuntimeEvent) => void;
}): Promise<EditedWorkflowScript> {
  assertWorkflowScriptValid(input.currentScript);
  if (!input.instruction.trim()) {
    throw new Error("Instruction is required");
  }
  if (input.provider === "mock" || !input.provider) {
    return {
      script: input.currentScript,
      repaired: false,
      repairAttempts: 0,
    };
  }

  const cwd = resolveWorkflowCwd(input.cwd);
  const prompt = buildEditPrompt({
    currentScript: input.currentScript,
    instruction: input.instruction,
  });
  const edited = stripCodeFence(
    await collectAgentText({
      provider: input.provider,
      model: input.model,
      cwd,
      prompt,
      onEvent: input.onEvent,
    }),
  );

  try {
    assertWorkflowScriptValid(edited);
    return {
      script: edited,
      repaired: false,
      repairAttempts: 0,
    };
  } catch (error) {
    if (!(error instanceof WorkflowScriptSyntaxError)) {
      throw error;
    }

    const repaired = stripCodeFence(
      await collectAgentText({
        provider: input.provider,
        model: input.model,
        cwd,
        prompt: buildEditRepairPrompt({
          instruction: input.instruction,
          currentScript: input.currentScript,
          script: edited,
          error,
        }),
        onEvent: input.onEvent,
      }),
    );

    assertWorkflowScriptValid(repaired);
    return {
      script: repaired,
      repaired: true,
      repairAttempts: 1,
    };
  }
}

function personalizeSample(description: string): string {
  if (!description.trim()) {
    return SAMPLE_WORKFLOW;
  }
  return SAMPLE_WORKFLOW.replace(
    'description: "Inspect a codebase with focused local agents and synthesize the results"',
    `description: ${JSON.stringify(description.trim())}`,
  );
}

function stripCodeFence(value: string): string {
  const fenceMatch = value.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/i);
  return (fenceMatch?.[1] ?? value).trim();
}

async function collectAgentText(input: {
  provider: string;
  model?: string;
  cwd: string;
  prompt: string;
  onEvent?: (event: AgentRuntimeEvent) => void;
}): Promise<string> {
  let text = "";
  for await (const event of runAgent({
    runId: randomUUID(),
    provider: input.provider,
    cwd: input.cwd,
    prompt: input.prompt,
    model: input.model,
  })) {
    input.onEvent?.(event);
    if (event.type === "text_delta") {
      text += event.text;
    }
    if (event.type === "error") {
      throw new Error(event.message);
    }
  }
  return text.trim();
}

function buildRepairPrompt(input: {
  description: string;
  script: string;
  error: WorkflowScriptSyntaxError;
}) {
  const diagnostics = input.error.diagnostics
    .map((diagnostic) => {
      const range = diagnostic.range
        ? ` at ${diagnostic.range.start}-${diagnostic.range.end}`
        : "";
      return `- ${diagnostic.severity}${range}: ${diagnostic.message}`;
    })
    .join("\n");

  return `Repair this dynamic workflow script so it parses and follows the workflow primitives.

Original request:
${input.description}

Parser diagnostics:
${diagnostics}

Rules:
- Return only JavaScript code, no markdown fences.
- Use "export const meta = { name, description }"; add requiresCwd: true when the workflow must be launched from an explicit project directory.
- Use phase("...") to group work.
- Use agent({ id, label, inputs, prompt }) for normal DAG steps, with optional session: { mode: "inherit", key: "name" } when multiple steps should reuse the same agent conversation.
- A normal agent can include provider and model to override the run defaults.
- Use cwd: "relative/path" on agent({...}) when that agent must run in a specific directory relative to the current run cwd.
- Use loop({ id, label, maxIterations, steps, until }) for bounded iterative workflows such as implementation/acceptance or multi-agent debate.
- A loop can include provider and model as defaults for its steps.
- Use cwd on loop({...}) as the default cwd for its steps; step cwd overrides loop cwd.
- loop maxIterations must be an integer from 1 to 10.
- loop steps must be agent({ id, label, prompt }) calls; use session: { mode: "inherit", key: "role_room" } when a role should keep its own conversation across iterations.
- A loop step agent can include provider and model to override the loop and run defaults for that role.
- A loop step can include cwd when that role must run in a specific directory.
- Use appendPrompt on inherited loop steps when the first turn should initialize the role and later iterations should send only feedback or deltas.
- Use session: { mode: "independent" } only when a step must explicitly start a fresh agent session each time.
- A loop can provide session: { mode: "inherit", key: "loop_room", scope: "step" } to derive per-step session keys, or scope: "loop" to share one loop-level session.
- loop until must be { source: "<step id>", includes: "<literal marker>" }.
- Put upstream values in inputs, for example inputs: { inventory }.
- Reference inputs inside prompts with {{inventory}}.
- Use {{workflow.cwd}} in prompts when agents need to know the actual run cwd; do not create a normal {{cwd}} input for this.
- Reuse the same inherited session key only for agent calls that must share conversation context; keep independent agents sessionless.
- Do not reuse the same inherited session key across different cwd values.
- Never use legacy string session values.
- Inside loop step prompts, reference other step ids with {{step_id}} to use the most recent output.
- Inside loop step prompts, use {{iteration}} for the current 1-based iteration number.
- Do not concatenate prompt strings with +.
- Do not use Node APIs, imports, require, fs, network APIs, Date, or Math.random.

Broken script:
${input.script}`;
}

function buildEditPrompt(input: {
  currentScript: string;
  instruction: string;
}) {
  return `Edit this dynamic workflow script according to the user's request.

User request:
${input.instruction}

Current workflow script:
${input.currentScript}

Rules:
- Return the complete updated JavaScript workflow script only, no markdown fences.
- Preserve unrelated behavior and structure where possible.
- Keep "export const meta = { name, description }"; update meta only when useful for the requested edit.
- Use phase("...") to group work.
- Use agent({ id, label, inputs, prompt }) for normal DAG steps, with optional session: { mode: "inherit", key: "name" } when multiple steps should reuse the same agent conversation.
- A normal agent can include provider and model to override the run defaults.
- Use cwd: "relative/path" on agent({...}) when that agent must run in a specific directory relative to the current run cwd.
- Use loop({ id, label, maxIterations, steps, until }) for bounded iterative workflows.
- A loop can include provider and model as defaults for its steps.
- Use cwd on loop({...}) as the default cwd for its steps; step cwd overrides loop cwd.
- loop maxIterations must be an integer from 1 to 10.
- loop steps must be agent({ id, label, prompt }) calls.
- A loop step agent can include provider and model to override the loop and run defaults for that role.
- Use appendPrompt on inherited loop steps only when later iterations should send deltas.
- Put upstream values in inputs, for example inputs: { inventory }.
- Reference inputs inside prompts with {{inventory}}.
- Use {{workflow.cwd}} in prompts when agents need to know the actual run cwd; do not create a normal {{cwd}} input for this.
- Do not reuse the same inherited session key across different cwd values.
- Never use legacy string session values.
- Do not concatenate prompt strings with +.
- Do not use Node APIs, imports, require, fs, network APIs, Date, or Math.random.
- Do not modify files in the working directory; only return the updated workflow script.`;
}

function buildEditRepairPrompt(input: {
  instruction: string;
  currentScript: string;
  script: string;
  error: WorkflowScriptSyntaxError;
}) {
  const diagnostics = input.error.diagnostics
    .map((diagnostic) => {
      const range = diagnostic.range
        ? ` at ${diagnostic.range.start}-${diagnostic.range.end}`
        : "";
      return `- ${diagnostic.severity}${range}: ${diagnostic.message}`;
    })
    .join("\n");

  return `Repair this edited dynamic workflow script so it parses and follows the workflow primitives.

User request:
${input.instruction}

Parser diagnostics:
${diagnostics}

Original workflow script:
${input.currentScript}

Broken edited script:
${input.script}

Rules:
- Return the complete updated JavaScript workflow script only, no markdown fences.
- Preserve the requested edit and unrelated existing behavior.
- Use only supported workflow primitives: meta, phase, agent, loop.
- Preserve or add provider and model on agent or loop step objects when the user asks for role-specific agent targets.
- Do not use Node APIs, imports, require, fs, network APIs, Date, or Math.random.
- Do not modify files in the working directory; only return the updated workflow script.`;
}
