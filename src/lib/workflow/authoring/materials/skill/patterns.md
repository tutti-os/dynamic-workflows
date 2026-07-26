# Persistent Flow Design Patterns

Patterns are structural choices, not runtime dependencies. Search the
Blueprint catalog first, copy the closest complete Bundle, then adapt it.

## Declare the durable loop

A Flow owns many Cycles. A Tick is only one bounded scheduler activation.
Waiting never means sleeping inside a node: end the Tick at a Gate or Human
node, then let a later Schedule, manual dispatch, or Human response resume the
same Cycle.

Use `completeCycle({ continue: "immediate" })` only when the next Cycle must
start immediately. Use `"scheduled"` for normal recurring work.

## Separate checks from mutations

- Script: deterministic local computation with `run(ctx)`.
- Transform: pure JSON-to-JSON projection with no workspace or network writes.
- Gate: one external-state check with `check(ctx)`; return `waiting` or a
  declared outcome.
- Effect: external mutation with an idempotency key, `apply(ctx)`, and
  `reconcile(ctx)`.
- Finally: terminal cleanup or compensation.

Never create Issues, push branches, or write remote state from Script or Gate.
Never poll or sleep inside Gate. The recurring Trigger provides polling.

## Approval-driven automation

```js
const issue = effect({
  id: "create_issue",
  file: "scripts/create-issue.mjs",
  inputs: { plan },
  idempotencyKey: template("{{cycle.id}}:issue"),
});
const approval = gate({
  id: "wait_approval",
  file: "scripts/check-approval.mjs",
  inputs: { issue },
  outcomes: ["approved", "rejected"],
});
const implement = agent({
  id: "implement",
  inputs: { plan, approval },
  prompt: "Implement the approved plan: {{plan}}",
});
const rejected = cancelCycle({ id: "rejected", continue: "scheduled" });
route(approval, { approved: implement, rejected });
```

The Gate can only depend on evidence already produced. A downstream result can
never be an approval criterion for an upstream Gate.

## Fan-out and fan-in

Independent ready graph nodes run concurrently. Give parallel reviewers the
same source input and no dependencies on each other, then pass all outputs to
one synthesizer. Avoid false inputs: every unused dependency serializes work
and leaks narrative between independent judges.

Use Map when width is discovered at runtime:

```js
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
    agent({ id: "migrate", prompt: "Migrate {{item}}.", output: "json" }),
    agent({ id: "verify", prompt: "Verify {{previous}}.", output: "json" }),
  ],
});
```

Any capped or skipped coverage must be reported downstream. Never let a
partial scan look complete.

Blueprints declare whether shared mutable state is allowed. The host chooses
worktrees, containers, or safe serialization. Isolated items still require a
visible fan-in/merge result before the Map is business-successful.

## Bounded repair loops

Loop is for work the next iteration can actually change:

```js
const review = loop({
  id: "review",
  maxIterations: 3,
  onMaxIterations: "fail",
  steps: [
    agent({
      id: "repair",
      prompt:
        "Repair iteration {{iteration}} using the blockers in {{previousIteration}}.",
    }),
    human({
      id: "approve",
      context: [
        { label: "Result", value: "{{previous}}", display: "markdown" },
      ],
      actions: [
        { id: "approve", label: "Approve", intent: "primary", fields: [] },
      ],
    }),
  ],
  until: { source: "approve", equals: { action: "approve", values: {} } },
});
```

Do not increase the iteration budget for an external blocker. External state
belongs in a Gate checked by later Ticks.

`previousIteration` is explicit durable data, so a Human response or reviewer
finding survives a Tick boundary without depending on an inherited Agent
session.

## Human decisions

Human nodes are durable. Put the evidence in `context`, expose explicit action
ids, and use typed fields for required rationale or parameters. The UI and CLI
render the same task specification and enforce optimistic revision checks.

Do not ask an Agent to impersonate a Human approver.

## Per-Cycle worktrees

Create mutable workspace resources in an Effect before the implementation
Agent. Bind the Agent with `workspace: workspace` and declare
`execution: { access: "write", isolation: "required" }`; do not rely on a
prompt telling the Agent to change directories. Commit, push, and PR creation
use separate Effects.

Independent repository reviewers should declare
`execution: { access: "review", isolation: "required" }`. The local host gives
the reviewer a disposable Git snapshot containing the current tracked and
untracked change set. Reviewer writes are discarded and cannot modify the
implementation workspace.

Declare cleanup as a Finally node. Use `retainOnFailure: true` when the failed
workspace is required for retry or inspection; successful and canceled Cycles
should still clean it.

## Markdown Memory

Memory is optional and explicit. Use stable sections for compact knowledge:

- replace `currentUnderstanding`;
- append a short `timeline`;
- update only through Remember nodes.

Do not use Memory as hidden control state. Checkpoint, Params, Inputs, node
outputs, and the Effect ledger remain the authoritative runtime state.

## Terminal closure

Every control outcome must reach `completeCycle` or `cancelCycle`. Terminal
nodes declare a business `outcome`; completion status alone is not business
success. Every
resource must have a matching Finally policy. Every external mutation must
have an Effect reconciliation story.

Before submission, trace:

1. each user goal to its output node;
2. each waiting condition to the Trigger that can re-check it;
3. each side effect to its idempotency key and reconcile handler;
4. each terminal route to continuation and cleanup behavior;
5. each required Params, Inputs, and Secrets value to its consumer.

The independent semantic reviewer sees the exact serialized Bundle and returns
one PASS/FAIL result. Any Bundle change invalidates that review.
