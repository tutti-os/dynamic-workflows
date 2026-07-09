# Workflow Script DSL Reference

A workflow script is a single JavaScript module using only the workflow primitives: `meta`, `inputs`, `phase`, `agent`, and `loop`. Anything outside this contract either produces a validation diagnostic or is ignored — always run validate and treat any error diagnostic as a broken script.

## Hard constraints

- Plain JavaScript only. No imports, `require`, Node APIs, `fs`, network APIs, `Date`, or `Math.random`.
- Every prompt must be one plain string literal. Double quotes and backticks are both fine, but `+` concatenation and `${...}` interpolation are rejected by the validator — use `{{...}}` placeholders for dynamic values instead.
- Keep the workflow readable and editable in a UI: short ids, human labels, focused prompts.

## meta

```js
export const meta = {
  name: "my-workflow",
  description: "What this workflow does",
  requiresCwd: true, // only when the workflow must be launched from an explicit project directory
};
```

## inputs

Declare every run-provided value:

```js
export const inputs = {
  requirement: { type: "string", required: true, label: "Requirement", widget: "textarea" },
  reviewer_model: { type: "string", required: false, label: "Reviewer model" },
  mode: { type: "enum", options: ["fast", "thorough"], required: false, default: "fast" },
};
```

- Supported types: `"string"`, `"number"`, `"boolean"`, `"enum"`. Unknown fields on an input definition are validation errors.
- Give every input a `description` that tells the caller exactly what to provide and in what structure (for a requirement-style input, spell out the expected sections, e.g. background / scope / acceptance criteria / non-goals). Workflows are often launched by another agent that only sees the input schema — the description is the handoff contract, and context that is not requested there gets lost at the boundary.
- Fields shared by all types: `type`, `required`, `label`, `description`, `default`.
- `"string"` extras: `placeholder`, `widget` (`"text"` or `"textarea"` — use `"textarea"` for multi-line input like a requirement), `minLength`, `maxLength`, `pattern`.
- `"number"` extras: `min`, `max`, `step`.
- `"enum"` requires `options` as an array of strings; `default` must be one of the options. (The field is `options`, not `values`.)
- Any `{{name}}` prompt reference that is not an upstream node variable, loop step id, `iteration`, or a `workflow.*` value must be declared in `export const inputs`, or parsing fails.
- Inputs with a `default` (or a `{{name:default}}` runtime template) are optional; inputs without one and `required: true` are required at run time.

## phase

`phase("Title")` groups every following node under that title in the UI. The callback form scopes the grouping to its body instead:

```js
phase("Scan"); // flat form: applies to all nodes until the next phase(...)

phase("Deliver", () => {
  // callback form: only nodes created inside belong to this phase
  agent({ id: "ship", label: "Ship it", prompt: "..." });
});
```

Use a few descriptive phases; both forms parse to the same structure.

## agent nodes

```js
const inventory = agent({
  id: "inventory",
  label: "Inventory the repo",
  prompt: "List the main modules under {{workflow.cwd}}.",
});

agent({
  id: "report",
  label: "Write report",
  inputs: { inventory },
  prompt: "Summarize for the user:\n{{inventory}}",
});
```

- Every agent needs a non-empty `prompt`; a missing, empty, or non-literal prompt is a validation error.
- Put upstream values in `inputs` (for example `inputs: { inventory }`) and reference them in the prompt as `{{inventory}}`.
- Use `{{workflow.cwd}}` when an agent needs the actual run cwd; never declare a normal `{{cwd}}` input for this.
- Optional per-node fields: `agent`, `model`, `cwd`, `session`.
  - `agent` must be an agent target id such as `"local:codex"` or `"local:claude-code"`.
  - `cwd: "relative/path"` runs the agent in a directory relative to the run cwd.
- `appendPrompt` is only meaningful on loop steps (see below); it does nothing on a standalone agent node.

## Sessions

- `session: { mode: "inherit", key: "name" }` lets multiple steps share one agent conversation. Reuse the same key only for calls that must share context; keep independent agents sessionless.
- `session: { mode: "independent" }` only when a step must explicitly start a fresh session each time.
- Never reuse an inherited session key across different `cwd` values.
- Never use legacy string session values.
- Use `appendPrompt` on inherited loop steps when the first turn should initialize the role and later iterations should send only feedback or deltas. Apply this to every inherited loop step — a reviewer step repeating its full initial prompt each round wastes context and confuses the session.

## loop

```js
loop({
  id: "delivery",
  label: "Implement until accepted",
  maxIterations: 4,
  onMaxIterations: "fail",
  session: { mode: "inherit", key: "delivery_room", scope: "step" },
  steps: [
    agent({
      id: "coder",
      label: "Implement",
      prompt: "Implement {{requirement}}.",
      appendPrompt: "Iteration {{iteration}}. Reviewer feedback:\n{{reviewer}}\nRevise based on this feedback only.",
    }),
    agent({ id: "reviewer", label: "Review", prompt: "Review the work from {{coder}}. Put PASS or FAIL alone on the final non-empty line." }),
  ],
  until: { source: "reviewer", finalStatus: "PASS" },
});
```

- `maxIterations` must be an integer from 1 to 10.
- `onMaxIterations` decides what happens when the loop exhausts its iterations without the `until` status: `"fail"` (the default) fails the run, `"complete"` continues to the next node. Use `"complete"` only when downstream steps can safely run on unaccepted work.
- Steps must be `agent({ id, label, prompt })` calls; a step can override `agent`, `model`, `cwd`, `session`.
- A loop can set `agent`, `model`, and `cwd` as defaults for its steps; step values override loop values.
- Loop `session` scope: `"step"` derives per-step session keys; `"loop"` shares one loop-level session.
- `until` must be `{ source: "<step id>", finalStatus: "<literal status>" }`, and the source step's prompt must instruct that agent to put that status alone on the final non-empty line of its reply.
- Inside loop step prompts, reference other step ids with `{{step_id}}` (most recent output) and use `{{iteration}}` for the current 1-based iteration number.

## Runtime option templates for agent / model

`agent` and `model` may be run-configurable, but only as the entire field value:

```js
agent({ id: "coder", agent: "{{coder_agent:local:codex}}", model: "{{coder_model:gpt-5}}", prompt: "..." })
```

- Allowed forms: `"{{input_name}}"` (required input) or `"{{input_name:default_value}}"` (optional input).
- Partial or multiple templates are invalid: never `model: "gpt-{{m}}"` or `model: "{{a}}{{b}}"`.
- Templates resolve run inputs only, never upstream node or loop step outputs.
- Runtime option input names must not reuse workflow node ids, variable names, loop step ids, `iteration`, or `workflow.*` names. Multiple roles may intentionally share one input, such as `{{review_model:gpt-5}}`.

## Resolution order for agent / model

1. Loop step `agent` / `model`
2. Loop or normal node `agent` / `model`
3. Run-level `agent` / `model`
4. Runtime fallback (`mock` when nothing is provided)
