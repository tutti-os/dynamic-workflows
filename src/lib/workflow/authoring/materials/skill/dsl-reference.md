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

Schema helpers are strict contracts:

- Params: `stringParam`, `numberParam`, `booleanParam`, `jsonParam`,
  `cronParam`.
- Inputs: `stringInput`, `numberInput`, `booleanInput`, `jsonInput`.
- Secrets: `stringSecret`, `connectionSecret`.
- Number helpers accept `min`, `max`, and `integer`.
- String helpers accept `minLength`, `maxLength`, and `pattern`.
- `connectionSecret` requires a non-empty `provider`.

Unknown helpers, unknown configuration keys, wrong defaults, out-of-range
Params, and undeclared Cycle input fields are rejected before execution.

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
  output: json({
    validationMaxAttempts: 2,
    schema: {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" } },
    },
  }),
  prompt: "请为 {{candidate.path}} 规划重构方案。",
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

Agent prompts cannot reference Secrets. `output: "json"` remains shorthand for
untyped JSON. A schema enables deterministic extraction and validation before
the output can drive Loop or Map control. Typed JSON defaults to two validation
attempts; `validationMaxAttempts` may explicitly set 1–3. A rejected response
is recorded as a failed Node Attempt and its exact validation error is passed
to the next attempt. Human Tasks are durable and end the current Tick while
pending.

Agent nodes and Loop Agent steps may declare an explicit Session policy:

```js
const implement = agent({
  id: "implement",
  session: { mode: "inherit", key: "rd_room" },
  prompt: "请实现需求。",
});

const acceptance = loop({
  id: "acceptance",
  maxIterations: 3,
  steps: [
    agent({
      id: "repair",
      session: { mode: "inherit", key: "rd_room" },
      prompt: "请根据完整的后备上下文进行修复。",
      appendPrompt: "请只修复 {{previousIteration.outputs.review.blockers}}。",
    }),
    agent({
      id: "review",
      session: { mode: "independent" },
      prompt: "请审查代码仓库的实际状态。上一轮标准：{{previousStep.criteria}}。",
    }),
  ],
  until: { source: "review", finalStatus: "PASS" },
});
```

- `inherit` resumes the latest Agent session with that key in the current Cycle.
  A key may cross Agent node and Loop-step boundaries when agent target,
  permission mode, model, and effective cwd remain compatible.
- On an inherited Loop step, `prompt` is used when there is no completed
  previous Loop iteration, even if the session was inherited from an upstream
  Agent. On later iterations, `appendPrompt` is the incremental turn sent when
  that session already exists.
- `independent` always creates a fresh session. Reviewer roles should normally
  use it and carry only compact structured criteria/blockers through Loop data.
- Session keys are durable runtime state within a Cycle, not cross-Cycle Memory.
  Declare data/control ordering between all users of one key; do not race the
  same conversation from parallel nodes.
- Map steps cannot declare `session` or `appendPrompt`: items must not leak
  conversation state into one another.

## Transform, Script, and Gate

Transform is a pure, replayable JSON projection:

```js
const record = transform({
  id: "record",
  file: "scripts/build-record.mjs",
  inputs: { summary, decision },
});
```

```js
const candidate = script({
  id: "candidate",
  file: "scripts/find.mjs",
  secrets: ["GH_TOKEN"],
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
Code nodes receive no Secrets by default. A Script, Transform, Gate, Effect, or
Finally node must list every Secret it needs in `secrets: ["NAME"]`; undeclared
or unknown names are rejected. Secret values are injected only into that
node's environment. A structured result containing an injected Secret is
rejected before it can be checkpointed.
Script returns JSON. A Script with declared `outcomes` returns
`{ outcome, output }` and can be routed like a Gate. Gate returns one of:

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

One Effect must represent one independently reconcilable external intent.
Commit, push, and pull-request creation are separate Effects.

## Loop and Map

```js
const review = loop({
  id: "review",
  maxIterations: ref("params.maxRounds"),
  onMaxIterations: "complete",
  steps: [
    agent({ id: "repair", prompt: "请修复第 {{iteration}} 轮。" }),
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
  execution: { access: "write", isolation: "required" },
  onItemFailure: "skip",
  onItemRejected: "collect",
  itemOutcome: {
    source: "verify.status",
    success: ["VERIFIED"],
    rejected: ["REJECTED"],
  },
  steps: [
    agent({ id: "migrate", prompt: "请迁移 {{item}}。", output: "json" }),
    agent({ id: "verify", prompt: "请验证 {{previous}}。", output: "json" }),
  ],
});
```

Loop supports Agent and Human steps, is bounded to 1..10 iterations, and
checkpoints its exact step. Map supports Agent pipelines, is bounded to 1..100
items, and uses `runtime.maxParallelNodes`.

Loop produces `matched` or `exhausted` outcomes. Map produces
`all_succeeded`, `partial`, or `all_rejected` and returns separate
`succeeded`, `rejected`, and `failed` collections. A host that cannot isolate
a write Map must safely serialize it.

Loop step templates receive `iteration`, `previous` (the preceding step in the
current iteration), `steps` (current-iteration outputs), `previousIteration`
(the complete preceding iteration record, or `null`), and `history` (all
completed iteration records). Use these explicit values for repair feedback and
independent roles. An explicitly inherited Agent session may resume in a later
Tick of the same Cycle; completed sessions never become implicit cross-Cycle
Memory.

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

const done = completeCycle({
  id: "done",
  outcome: "delivered",
  continue: "immediate",
});
const rejected = completeCycle({
  id: "rejected",
  outcome: "not_accepted",
  continue: "scheduled",
});
route(approval, { approved: done, rejected });
```

Immediate continuation creates a new Cycle and Tick. It never loops by resetting
the same checkpoint.
