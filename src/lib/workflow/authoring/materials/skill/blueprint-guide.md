# Blueprint Guide

Blueprints are immutable authoring templates, never runtime dependencies.
Every public Blueprint is a complete `tutti.flow.v1` Bundle. Copy the closest
Bundle into `draft.flow/`, adapt it to the request, and submit the resulting
standalone Flow.

The catalog is intentionally small. Search once by capability and inspect the
closest result. If it is not structurally close, draft directly from
`dsl-reference.md`; do not force an unrelated template.

## Commands

```bash
tutti --json dynamic-workflows blueprints list
tutti --json dynamic-workflows blueprints search \
  --query "scheduled issue approval pull request" \
  --category coding
tutti --json dynamic-workflows blueprints get \
  --blueprint-id <id> \
  --include-script
```

`get --include-script` returns `bundle.files`, including `flow.js`, code-node
modules, Memory templates, and documentation.

## Choose by execution shape

Compare the user's request with:

- Cycle boundary and completion condition;
- recurring Schedule versus direct invocation;
- Script, Gate, Effect, Agent, and Human responsibility;
- waiting points that end a Tick without ending the Cycle;
- side-effect idempotency and reconciliation;
- bounded Loop/Map work and parallelism;
- Params, Inputs, Secrets, project cwd, and Memory requirements;
- completed, rejected, failed, and canceled terminal paths.

Matching words are not enough. A single-repository maintenance loop is not a
safe template for a cross-repository release merely because both mention pull
requests.

## Adaptation checklist

1. Copy the complete Bundle, not only `flow.js`.
2. Rewrite metadata, schema declarations, node ids, labels, prompts, code
   modules, and terminal behavior for the actual scenario.
3. Keep deterministic work in Script, observation in Gate, and every external
   mutation in an idempotent Effect with `reconcile()`.
4. Ensure each waiting Gate can observe state that may change between scheduled
   Ticks. Never sleep or poll inside the Gate.
5. Rebuild references deliberately. Secrets cannot enter prompts, outputs,
   logs, or Memory.
6. Preserve bounded runtime budgets and make every control outcome reach a
   truthful terminal.
7. Remove all template-specific names and assumptions.
8. Validate the full Bundle and run independent semantic review before submit.

## Current scenario template

`large-file-governance-v1` demonstrates the reference persistent automation:
scheduled repository sync, deterministic large-file discovery, Agent planning,
idempotent Issue creation, approval Gate, Agent implementation, idempotent PR
creation, merge Gate, Issue close, Markdown Memory update, and immediate
creation of the next Cycle. Adapt its structure for other Issue-to-PR
governance loops; replace its GitHub modules entirely when the target system or
approval model differs.
