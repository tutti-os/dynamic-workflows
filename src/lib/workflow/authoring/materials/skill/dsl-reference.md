# Workflow Script DSL Reference

A workflow script is a single JavaScript module using only the workflow primitives: `meta`, `inputs`, `phase`, `agent`, `human`, `loop`, and `log`. Anything outside this contract either produces a validation diagnostic or is ignored — always run validate and treat any error diagnostic as a broken script.

## Hard constraints

- Plain JavaScript only. No imports, `require`, Node APIs, `fs`, network APIs, `Date`, or `Math.random`.
- Every prompt must be one plain string literal. Double quotes and backticks are both fine, but `+` concatenation and `${...}` interpolation are rejected by the validator — use `{{...}}` placeholders for dynamic values instead.
- Keep the workflow readable and editable in a UI: short ids, human labels, focused prompts.

## Execution model

Scheduling is dataflow-driven: a node runs once every node referenced in its `inputs` (and any session predecessor) has completed, and independent ready nodes run concurrently. Declaration order does not serialize execution — only `inputs`, session continuity, and loop membership create ordering. Wire dependencies deliberately: an unused input both serializes branches that could run in parallel and leaks context across role boundaries (see `patterns.md`).

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

## log

`log("Milestone message")` adds a display-only annotation node: it appears in the workflow graph with the message as its label, but it never executes and produces no output. Never bind a log node as an input to another node — an executable node depending on a log node is a validation error. Use it sparingly to mark milestones in the graph.

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
- An agent's final message is the node's output value: downstream prompts receive it verbatim and `until` matchers test it directly. Prompt for the deliverable itself, and when the output feeds a matcher, state the exact required token and position (for example "Put PASS or FAIL alone on the final non-empty line") in the prompt.
- Put upstream values in `inputs` (for example `inputs: { inventory }`) and reference them in the prompt as `{{inventory}}`.
- Use `{{workflow.cwd}}` when an agent needs the actual run cwd; never declare a normal `{{cwd}}` input for this. A workflow whose prompts reference `{{workflow.cwd}}` should also set `meta.requiresCwd: true` — without it, the reference renders as an empty string when the run provides no cwd.
- Optional per-node fields: `agent`, `model`, `cwd`, `session`.
  - `agent` must be an exact agent target id discovered through `tutti --json agent list`; never derive it from provider metadata. `"local:codex"` is only an example and the available catalog is dynamic.
  - `cwd: "relative/path"` runs the agent in a directory relative to the run cwd.
- `appendPrompt` is only meaningful on loop steps (see below); it does nothing on a standalone agent node.

## Sessions

- `session: { mode: "inherit", key: "name" }` lets multiple steps share one agent conversation. Reuse the same key only for calls that must share context; keep independent agents sessionless.
- A key identifies the conversation, not the node or loop. The same continuing role may reuse one key across different step ids and different loops when its agent target and effective `cwd` remain compatible. Different roles must use different keys.
- `session: { mode: "independent" }` only when a step must explicitly start a fresh session each time — the right default for reviewer-style loop steps that should re-judge from scratch (see `patterns.md` on long-running roles). Independent steps re-run their full `prompt` every iteration; `appendPrompt` does not apply.
- Never reuse an inherited session key across different `cwd` values.
- Never use legacy string session values.
- Use `appendPrompt` on inherited loop steps when the first turn should initialize the role and later iterations should send only feedback or deltas. Apply this to every inherited loop step — a reviewer step repeating its full initial prompt each round wastes context and confuses the session.
- If a step reuses a key established by an earlier node or loop, its first execution is already a continuation and therefore uses `appendPrompt`. Put the actionable delta in `appendPrompt`; treat `prompt` as the fallback for a genuinely new session.

## human tasks

`human(...)` pauses the dependent branch, persists a task, and returns a structured response. Independent branches may continue and one run may have multiple pending Human Tasks.

```js
const decision = human({
  id: "decision",
  label: "Confirm result",
  description: "Accept the result or request another iteration.",
  context: [
    { label: "Result", value: "{{worker}}", display: "markdown" },
  ],
  actions: [
    { id: "pass", label: "Accept", intent: "primary" },
    {
      id: "revise",
      label: "Request changes",
      fields: [
        { id: "comment", type: "textarea", label: "Feedback", required: true },
      ],
    },
  ],
});
```

- Context display modes are `"text"`, `"markdown"`, and `"json"`.
- Action intents are `"primary"`, `"default"`, and `"danger"`.
- Field types are `"text"`, `"textarea"`, and `"select"`; select fields require `{ label, value }` options.
- Human output is `{ action, values }`. Use nested paths such as `{{decision.action}}` and `{{decision.values.comment}}` downstream.
- A submitted task is immutable. Repeated input is modeled by another Human node or another loop iteration.

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
- `firstIteration: { startAt: "<step id>" }` optionally starts only the first iteration at a later step. Every subsequent iteration runs all steps in their declared order. The `until.source` step must not be skipped by this entry point. This is useful for `[repair, reviewer]`: review immediately, then repair and re-review only after a failure. `maxIterations` counts these evaluation cycles, including the initial review.
- `onMaxIterations` decides what happens when the loop exhausts its iterations without the `until` status: `"fail"` (the default) fails the run, `"complete"` continues to the next node. Use `"complete"` only when downstream steps can safely run on unaccepted work.
- Steps may be `agent({...})` or `human({...})`. Agent steps can override `agent`, `model`, `cwd`, and `session`.
- A loop can set `agent`, `model`, and `cwd` as defaults for its steps; step values override loop values.
- Loop `session` scope: `"step"` derives per-step session keys; `"loop"` shares one loop-level session.
- `until` may use the legacy text matcher `{ source: "<agent step>", finalStatus: "PASS" }` or an exact structured matcher such as `{ source: "review.action", equals: "pass" }`. When a human step supplies the decision, prefer the structured matcher; when an agent supplies it, the text matcher only works if the step prompt pins the same token to the final non-empty line.
- Inside loop step prompts, reference other step ids with `{{step_id}}` (most recent output) and use `{{iteration}}` for the current 1-based iteration number. A step may also reference its own id, which resolves to its previous-iteration output and renders as an empty string on the step's first run — this lets an independent-session step receive its own history through dataflow instead of session memory.
- A first-iteration step should not require output from a skipped prefix step. For an initial reviewer entry, instruct the reviewer to inspect the current repository; on later iterations, `{{reviewer}}` resolves to the previous review and can drive the preceding repair step.

## Runtime option templates for agent / model

`agent` and `model` may be run-configurable, but only as the entire field value:

```js
agent({ id: "coder", agent: "{{coder_agent:local:codex}}", model: "{{coder_model:gpt-5}}", prompt: "..." })
```

- Allowed forms: `"{{input_name}}"` or `"{{input_name:default_value}}"`. The referenced input must be declared in `export const inputs`; whether it is required at run time follows that declaration (`required: true` with no `default` means required).
- A declared optional input left empty at run time makes the field fall back to the run-level `agent`/`model` value. Declaring `reviewer_model: { type: "string", required: false, ... }` and setting `model: "{{reviewer_model}}"` is therefore the way to offer a per-role override without forcing a value or baking in a provider-specific default.
- Partial or multiple templates are invalid: never `model: "gpt-{{m}}"` or `model: "{{a}}{{b}}"`.
- Templates resolve run inputs only, never upstream node or loop step outputs.
- Runtime option input names must not reuse workflow node ids, variable names, loop step ids, `iteration`, or `workflow.*` names. Multiple roles may intentionally share one input, such as `{{review_model:gpt-5}}`.

## Resolution order for agent / model

1. Loop step `agent` / `model`
2. Loop or normal node `agent` / `model`
3. Run-level `agent` / `model`
4. Runtime fallback (`mock` when nothing is provided)
