# Workflow Script Runtime Options

Workflow scripts can set `agent` and `model` on normal `agent({...})` nodes, `loop({...})` defaults, and loop step `agent({...})` calls.

Agent values are exact target ids from `tutti --json agent list`. The catalog is
daemon-owned and may include multiple targets backed by the same provider, so do
not derive an agent id from a provider name or assume a fixed product list. The
examples below use `local:codex` only as an example target id.

Resolution order:

1. Loop step `agent` / `model`
2. Loop or normal node `agent` / `model`
3. Run-level `agent` / `model`
4. Runtime fallback, currently `mock` for agent when no value is provided

## Dynamic Inputs

`agent` and `model` may be runtime-configurable with a single run input placeholder:

```js
agent({
  id: "coder",
  agent: "{{coder_agent:local:codex}}",
  model: "{{coder_model:gpt-5}}",
  prompt: "Implement {{requirement}}",
})
```

At run time:

```json
{
  "requirement": "fix login",
  "coder_model": "gpt-5.5"
}
```

If `coder_model` is omitted, the workflow uses the default `gpt-5`. Inputs with defaults are optional and are shown as optional in the run dialog so they can still be overridden. If no default is provided, as in `model: "{{coder_model}}"`, `coder_model` is a required workflow input.

## Constraints

- `agent` and `model` runtime templates must be the entire field value: `{{input_name}}` or `{{input_name:default_value}}`.
- Partial templates are invalid: do not write `model: "gpt-{{coder_model}}"`.
- Multiple placeholders are invalid: do not write `model: "{{a}}{{b}}"`.
- Runtime option templates resolve run inputs only; they do not resolve upstream node outputs or loop step outputs.
- Runtime option input names must not reuse workflow node ids, variable names, loop step ids, `iteration`, or `workflow.*` names.
- Multiple roles may intentionally share the same runtime option input, such as `{{review_model:gpt-5}}`.

For role-specific loop models, prefer descriptive input names instead of engine-level role names:

```js
const delivery = loop({
  id: "delivery",
  agent: "{{loop_agent:local:codex}}",
  model: "{{loop_model:gpt-5}}",
  maxIterations: 4,
  steps: [
    agent({ id: "coder", model: "{{coder_model:gpt-5.5}}", prompt: "Code {{requirement}}" }),
    agent({ id: "reviewer", model: "{{reviewer_model:gpt-5}}", prompt: "Review {{coder}}. Put PASS or FAIL on the final non-empty line." }),
  ],
  until: { source: "reviewer", finalStatus: "PASS" },
});
```

## Human Tasks

Use `human({...})` as a top-level node or loop step to persist a request for user input. The dependent branch waits without keeping the runner process alive; unrelated branches may continue and a run can contain multiple pending tasks.

Human responses are structured as `{ action, values }` and support dotted template paths such as `{{review.action}}` and `{{review.values.comment}}`. In loops, prefer an exact condition:

```js
until: { source: "review.action", equals: "pass" }
```

The v1 form controls are text, textarea, and select. Context can be displayed as text, Markdown, or JSON. Submitted responses are immutable and remain attached to the run history.
