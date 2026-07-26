# tutti.flow.v1 Bundle reference

## Bundle layout

```text
draft.flow/
  flow.js
  memory.template.md       # only when Memory is declared
  scripts/
    precheck.mjs
    approval.mjs
    create-issue.mjs
```

`flow.js` is parsed statically and never executed. It must export:

```js
export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Repository maintenance",
  description: "One durable maintenance Cycle at a time.",
  requiresCwd: true,
};
```

## Configuration

```js
export const params = defineParams({
  cron: cronParam({ default: "0 9 * * *" }),
  timezone: stringParam({ default: "UTC" }),
  threshold: numberParam({ default: 1200 }),
});

export const inputs = defineInputs({
  target: stringInput({ required: false, default: "src" }),
});

export const secrets = defineSecrets({
  GH_TOKEN: connectionSecret({ provider: "github", required: true }),
});

export const cycles = defineCycles({ mode: "singleton" });
export const runtime = {
  maxNodeExecutionsPerTick: 100,
  maxImmediateContinuations: 1,
  maxParallelNodes: 4,
};
```

One optional recurring Schedule is supported:

```js
export const schedule = cron({
  id: "main",
  expression: ref("params.cron"),
  timezone: ref("params.timezone"),
  catchUp: "latest",
  overlap: "coalesce-latest",
  inputs: { target: ref("params.target") },
});
```

## References and dataflow

Node declarations return references. Use them directly in `inputs`, or use
`ref("node.path")`, `ref("params.name")`, `ref("inputs.name")`, and
`ref("cycle.id")`. Data dependencies determine readiness. `route()` adds
control dependencies.

## Agent and Human

```js
const plan = agent({
  id: "plan",
  inputs: { candidate },
  output: "json",
  prompt: "Plan the refactor for {{candidate.path}}.",
});

const decision = human({
  id: "decision",
  context: [{ label: "Plan", value: "{{plan}}", display: "json" }],
  actions: [
    { id: "approve", label: "Approve", intent: "primary", fields: [] },
    { id: "reject", label: "Reject", intent: "danger", fields: [] },
  ],
});
```

Agent prompts cannot reference Secrets. Human Tasks are durable and end the
current Tick while pending.

## Script and Gate

```js
const candidate = script({
  id: "candidate",
  file: "scripts/find.mjs",
  inputs: { threshold: ref("params.threshold") },
  retry: {
    maxAttempts: 3,
    errorCodes: ["flow_runner_timeout", "flow_runner_exit_nonzero"],
    backoffMs: 1000,
  },
});

const approval = gate({
  id: "approval",
  file: "scripts/approval.mjs",
  inputs: { issue },
  outcomes: ["approved", "rejected"],
});
```

JavaScript modules export `run(ctx)` for Script and `check(ctx)` for Gate.
Script returns JSON. Gate returns one of:

```js
{ status: "waiting", reason: "Not approved yet" }
{ status: "completed", outcome: "approved", output: { ... } }
```

A Gate checks once. It must not sleep or implement its own polling loop.

Script retry is optional and bounded. `maxAttempts` is 2–10,
`backoffMs` is 0–30000, and `errorCodes` must explicitly name stable
structural runner codes. The runtime never guesses retryability from error
message text. Each retry is stored as a separate Node Attempt.

## Effect

```js
const issue = effect({
  id: "issue",
  file: "scripts/create-issue.mjs",
  inputs: { plan },
  idempotencyKey: template("{{cycle.id}}:issue"),
});
```

The module exports:

```js
export async function apply(ctx) {
  return { externalRef: "https://...", output: { url: "https://..." } };
}

export async function reconcile(ctx) {
  return { status: "not_applied" };
  // or { status: "completed", externalRef, output }
  // or { status: "unknown", reason }
}
```

The Effect ledger is written before `apply()`. Uncertain execution always
reconciles before it may apply again.

## Loop and Map

```js
const review = loop({
  id: "review",
  maxIterations: 3,
  onMaxIterations: "fail",
  steps: [
    agent({ id: "repair", prompt: "Repair iteration {{iteration}}." }),
    human({
      id: "approve",
      context: [{ label: "Result", value: "{{previous}}", display: "markdown" }],
      actions: [{ id: "approve", label: "Approve", intent: "primary", fields: [] }],
    }),
  ],
  until: { source: "approve", equals: { action: "approve", values: {} } },
});

const migrated = map({
  id: "migrated",
  source: ref("discover.items"),
  maxItems: 50,
  onItemFailure: "skip",
  steps: [
    agent({ id: "migrate", prompt: "Migrate {{item}}.", output: "json" }),
    agent({ id: "verify", prompt: "Verify {{previous}}.", output: "json" }),
  ],
});
```

Loop supports Agent and Human steps, is bounded to 1..10 iterations, and
checkpoints its exact step. Map supports Agent pipelines, is bounded to 1..100
items, and uses `runtime.maxParallelNodes`.

## Memory

```js
export const memory = defineMemory({
  sections: {
    current: { title: "Current Understanding", update: "replace" },
    timeline: { title: "Timeline", update: "append" },
  },
});

const remembered = remember({
  id: "remembered",
  inputs: { result },
  updates: {
    current: { mode: "replace", value: ref("result.summary") },
    timeline: { mode: "append", value: ref("result.url") },
  },
});
```

The template uses exactly one pair of markers per section:

```md
<!-- flow-memory:section:current:start -->
Initial text.
<!-- flow-memory:section:current:end -->
```

## Finally and terminals

`finally` is a JavaScript keyword, so the DSL call is `finalize(...)`:

```js
finalize({
  id: "cleanup",
  file: "scripts/cleanup.mjs",
  runOn: ["completed", "failed", "canceled"],
});

const done = completeCycle({ id: "done", continue: "immediate" });
const rejected = cancelCycle({ id: "rejected", continue: "scheduled" });
route(approval, { approved: done, rejected });
```

Immediate continuation creates a new Cycle and Tick. It never loops by resetting
the same checkpoint.
