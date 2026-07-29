# Persistent Flow Runtime RFC

Status: accepted for implementation
Date: 2026-07-25
Owner: Dynamic Workflows runtime

## 1. Summary

Dynamic Workflows will become the single runtime for both one-shot agent
workflows and long-lived local automations. Tutloop will not continue as a
separate product or runtime.

The current single-script, run-scoped DAG evolves into an immutable Flow Bundle
executed as a persistent stateful graph:

```text
System
└── Flow
    ├── Versions (immutable Bundles)
    ├── Main Schedule
    ├── Canonical Markdown Memory
    ├── Cycles
    └── Runs / Ticks
```

A Flow remains the user-facing object. A Cycle is one complete business
journey, such as “find one large file, approve its plan, merge its PR, close the
Issue.” A Run, also called a Tick in runtime discussions, is one short-lived
execution caused by a direct invocation, a recurring schedule, recovery, or an
internal continuation.

The runtime runs a Tick until it reaches a quiescent point: a waiting Gate, a
Human Task, a terminal Cycle node, a failure, cancellation, or an explicit
budget. Waiting never sleeps inside a process. The Cycle checkpoint persists
the graph position, and the next Flow schedule or direct invocation advances
it.

## 2. Product principles

### 2.1 Agent-first authoring

The primary authoring input is a business requirement expressed to an Agent.
The Agent searches existing Blueprints, creates a complete Bundle, validates
it, responds to semantic review findings, and submits a Draft Version.

Users should not need to construct a complex graph by hand.

### 2.2 Bundle as the single source of truth

The graph, prompts, code-node declarations, memory section declarations, and
schedule definition come from the immutable Bundle. The visual graph is parsed
from the Bundle; it is not a second editable graph model.

### 2.3 Visual-first understanding

The Flow detail experience must support three views over the same graph:

- **Design:** whether the authored process is sensible.
- **Live:** the current Cycle, current node, waiting reason, and next schedule.
- **Review:** what happened in each historical Cycle, Tick, node attempt, and
  control path.

### 2.4 Explicit side effects and waits

All business actions must be visible as nodes. There is no automatically
executed, graph-external `controller.js`. Deterministic preparation, input
normalization, worktree setup, cleanup, external writes, and checks are
declared using Script, Gate, Effect, and Finally nodes.

### 2.5 One runtime, not two workflow types

A Flow without memory and a Flow with memory use the same executor. Memory is
an optional capability declared by the Bundle. Persistent Cycles are part of
the runtime model, not a second “loop product.”

## 3. Goals

- Support direct Agent/User invocation and unattended recurring execution.
- Persist a business Cycle across many scheduled Ticks.
- Show the exact graph location and waiting reason of a live Flow.
- Add graph-visible deterministic JS/Bash nodes.
- Add graph-visible waits and idempotent external effects.
- Preserve and reuse the existing Agent, Human, Loop, and Map capabilities.
- Support one canonical, sectioned Markdown memory per Flow.
- Make every execution attributable to a Bundle Version, input snapshot,
  params revision, memory snapshot, and invocation origin.
- Preserve enough structured node history for replay, diagnosis, and future
  dashboards.
- Keep Bundle authoring easy for Agents through strict schemas, stable
  diagnostics, and complete Blueprints.

## 4. Non-goals for the first release

- Continuing or sharing the Tutloop runtime.
- Runtime compatibility with the legacy single-file Workflow DSL.
- Keyed concurrent Cycles.
- Flow-scoped memory with concurrent Cycles.
- Per-Cycle memory.
- Typed user-programmable Flow State.
- Vector memory, embeddings, or automatic retrieval.
- Cross-Tick Agent Session continuation.
- Webhook, generic external-event, or GitHub polling Trigger providers.
- Gate-specific timers or polling loops.
- Runtime self-modification of cron schedules.
- Arbitrary npm dependency installation inside Flow Bundles.
- OS-level sandboxing for trusted local scripts.
- In-place migration of a live Cycle to another Bundle Version.
- Full drag-and-drop graph authoring.
- Runtime Blueprint inheritance.

## 5. Domain model

### 5.1 Flow

The existing Workflow record becomes the long-lived Flow entity. No separate
user-facing Instance is introduced.

```ts
type FlowLifecycle = "draft" | "active" | "paused" | "archived";

interface Flow {
  id: string;
  name: string;
  description: string;
  lifecycle: FlowLifecycle;
  currentVersionId: string | null;
  paramsRevision: number;
  createdAt: string;
  updatedAt: string;
}
```

The system homepage continues to list multiple Flows. Runtime position,
Cycle history, Memory, Schedule, Triggers, and dashboards live inside a Flow
detail view.

### 5.2 Flow Version

```ts
type FlowVersionStatus = "draft" | "published" | "superseded";

interface FlowVersion {
  id: string;
  flowId: string;
  version: number;
  status: FlowVersionStatus;
  schemaVersion: "tutti.flow.v1";
  bundleHash: string;
  semanticReview: SemanticReview | null;
  createdAt: string;
  publishedAt: string | null;
}
```

Every Cycle pins one published Flow Version. Publishing a new Version affects
future Cycles only.

The first release does not migrate an active Cycle to a new Version. A user may
continue the old Version or cancel the Cycle and start a new Cycle on the
latest Version.

### 5.3 Cycle

A Cycle spans one complete business objective and may contain many Runs.

```ts
type FlowCycleStatus =
  | "runnable"
  | "running"
  | "waiting_gate"
  | "waiting_human"
  | "paused_failed"
  | "paused_uncertain"
  | "paused_conflict"
  | "paused_budget"
  | "completed"
  | "canceled";

interface FlowCycle {
  id: string;
  flowId: string;
  sequence: number;
  flowVersionId: string;
  status: FlowCycleStatus;
  currentNodeId: string | null;
  inputSnapshot: JsonObject;
  paramsRevision: number;
  paramsSnapshot: JsonObject;
  memoryHashAtStart: string | null;
  createdAt: string;
  completedAt: string | null;
}
```

The database must model `Flow 1 -> N Cycles` even though the first runtime
release only permits one unfinished Cycle per Flow.

### 5.4 Run / Tick

A Run is one short-lived attempt to advance a Cycle to the next quiescent
point.

```ts
type FlowRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

type FlowRunStopReason =
  | "cycle_completed"
  | "cycle_canceled"
  | "waiting_gate"
  | "waiting_human"
  | "paused_failed"
  | "paused_uncertain"
  | "paused_conflict"
  | "paused_budget"
  | "canceled";

interface FlowRun {
  id: string;
  flowId: string;
  cycleId: string;
  flowVersionId: string;
  invocationId: string;
  status: FlowRunStatus;
  stopReason: FlowRunStopReason | null;
  startedAt: string | null;
  finishedAt: string | null;
}
```

A completed Run may leave its Cycle in `waiting_gate` or `waiting_human`.
Run terminality and Cycle terminality are deliberately separate.

### 5.5 Invocation

An Invocation records why the runtime attempted to start or advance a Flow.
Agent/User invocation is not a configured Trigger.

```ts
type InvocationOrigin =
  | { kind: "agent"; agentSessionId: string }
  | { kind: "user" }
  | { kind: "schedule"; scheduleId: string; scheduledAt: string }
  | { kind: "continuation"; previousCycleId: string }
  | { kind: "recovery"; reason: string };

type InvocationStatus =
  | "accepted"
  | "started"
  | "coalesced"
  | "ignored"
  | "rejected";

interface FlowInvocation {
  id: string;
  flowId: string;
  cycleId: string | null;
  runId: string | null;
  origin: InvocationOrigin;
  status: InvocationStatus;
  idempotencyKey: string;
  reason: string | null;
  createdAt: string;
}
```

## 6. Flow Bundle

### 6.1 Layout

```text
flow/
├── flow.js
├── memory.template.md       # optional
├── README.md                # optional authoring explanation
└── scripts/
    ├── scan.mjs
    ├── approval.gate.mjs
    ├── create-issue.effect.mjs
    ├── cleanup.sh
    └── shared/
        └── github.mjs
```

Every file is hashed into the immutable Version. The runtime executes only the
files from the Version pinned by the Cycle.

### 6.2 Dependency policy

The first release permits:

- Node.js built-in modules.
- The fixed-version `@tutti/flow-runtime` SDK.
- Relative imports that stay inside the Bundle.
- Global `fetch`.
- Explicitly declared local commands such as `git`.
- Bash scripts stored in the Bundle.

The first release rejects:

- `node_modules`.
- Per-Bundle dependency installation.
- Runtime `npm`, `pnpm`, or `yarn` install steps.
- Imports from arbitrary npm packages.
- Imports or file references escaping the Bundle.
- Inline script source embedded in `flow.js`.

These are static Validator errors, not runtime warnings.

### 6.3 Illustrative top-level DSL

The exact parser grammar is delivered by the Bundle/DSL implementation phase,
but the following semantics are normative:

```js
export const schemaVersion = "tutti.flow.v1";

export const meta = {
  name: "large-file-governance",
  description: "Continuously split approved large files",
  requiresCwd: true,
};

export const params = defineParams({
  repository: stringParam({ required: true }),
  baseBranch: stringParam({ default: "main" }),
  targetDirectory: stringParam({ default: "src" }),
  largeFileLines: numberParam({ default: 1500, min: 100 }),
  scanCron: cronParam({ default: "0 9 * * *" }),
  timezone: stringParam({ default: "Asia/Singapore" }),
});

export const inputs = defineInputs({
  targetDirectory: stringInput({ required: true }),
});

export const secrets = defineSecrets({
  githubConnection: connectionSecret({
    provider: "github",
    required: true,
  }),
});

export const cycles = defineCycles({
  mode: "singleton",
});

export const schedule = cron({
  id: "main_schedule",
  expression: ref("params.scanCron"),
  timezone: ref("params.timezone"),
  catchUp: "latest",
  overlap: "coalesce-latest",
  inputs: {
    targetDirectory: ref("params.targetDirectory"),
  },
});
```

## 7. Params, inputs, secrets, and runtime context

The namespaces are deliberately separate:

| Namespace | Lifetime | Purpose |
| --- | --- | --- |
| `params` | Flow configuration | Stable non-secret template bindings |
| `inputs` | Cycle | Immutable values supplied when a Cycle starts |
| `secrets` | Flow binding | Vault or Connection references |
| `invocation` | Run | Agent/User/Schedule/Continuation provenance |
| node outputs | Cycle | Data produced by graph execution |
| `memory` | Flow | Explicitly selected Markdown sections |

Source-text substitution such as `${param.repo}` is not used. Values are
resolved as typed references.

Secrets are never legal prompt template values. Each Script, Transform, Gate,
Effect, or Finally node must declare the Secret names it can access with
`secrets: ["NAME"]`; Code nodes receive none by default. A structured result
containing an injected Secret is rejected before checkpointing. Secret values
are not written to inputs, outputs, events, logs, Memory, or semantic review
payloads.

`connectionSecret` bindings persist only a provider connection reference. For
GitHub, the local runtime discovers accounts authenticated by GitHub CLI,
stores the selected host and login, and resolves the token from the CLI
credential store immediately before execution. Environment-variable bindings
remain an advanced fallback and persist only the variable name. Values that
look like credentials must be rejected instead of being accepted as variable
names. Migration removes legacy token-shaped bindings with SQLite secure-delete
enabled and truncates the WAL as a best-effort local scrub. Because previously
exposed credentials may also exist in backups, logs, or copied databases, the
credential must still be rotated.

A recurring Schedule must bind every required Cycle input to a Param, literal,
or default. A Flow cannot be enabled if its Schedule cannot start unattended.

When a Cycle is created it snapshots:

- the published Bundle Version;
- the current params revision and resolved params;
- the resolved Cycle inputs;
- the starting Memory hash, if Memory is enabled.

Those snapshots do not change during the Cycle.

## 8. Stateful graph

### 8.1 Edge kinds

The graph supports data and control edges:

```ts
type FlowEdge =
  | {
      kind: "data";
      sourceNodeId: string;
      sourcePath?: string;
      targetNodeId: string;
      targetInput: string;
    }
  | {
      kind: "control";
      sourceNodeId: string;
      outcome: string;
      targetNodeId: string;
    };
```

Data edges move values. Control edges activate paths.

Nodes on a non-selected control branch become `not_selected`, not merely idle.
Their state is visible in Design, Live, and Review views.

### 8.2 Run-to-quiescence

After invocation, the executor repeatedly schedules ready nodes until:

- all reachable work completes and a Cycle terminal node runs;
- no branch can advance because a Gate is waiting;
- a Human Task is pending;
- a failure pauses the Cycle;
- an Effect is uncertain;
- the Run is canceled;
- an explicit execution budget is reached.

Independent ready nodes continue to run concurrently. Existing Loop and Map
internal concurrency remains bounded and explicit.

No hidden limit may turn an incomplete Run into success. Reaching a declared
budget produces `paused_budget`.

```js
export const runtime = {
  maxNodeExecutionsPerTick: 100,
  maxImmediateContinuations: 3,
  maxParallelNodes: 4,
};
```

### 8.3 Trigger flow

Configured Triggers do not select arbitrary entry nodes. The first release has
one optional main recurring Schedule. Direct Agent/User calls are not Trigger
definitions.

A new Cycle begins at graph roots. An existing Cycle resumes from its
checkpoint. There is no `startAt`.

### 8.4 Cycle checkpoint

The checkpoint stores enough durable state to resume the graph without
rerunning completed work:

```ts
interface FlowCycleCheckpoint {
  completedNodeIds: string[];
  selectedControlEdges: string[];
  notSelectedNodeIds: string[];
  outputs: Record<string, JsonValue>;
  waitingNodeId: string | null;
  pendingHumanTaskIds: string[];
  loopStates: Record<string, WorkflowLoopRecoveryState>;
  mapStates: Record<string, WorkflowMapRecoveryState>;
  revision: number;
}
```

Checkpoint updates are atomic and compare-and-set by revision.

## 9. Node kinds

### 9.1 Agent

Agent nodes retain the existing target/model/permission, structured JSON
output, prompt rendering, notes, and session recovery capabilities.

An Agent Session may continue only for the same node attempt's transient
continuation, JSON repair, or recovery. A completed Agent Session does not
provide hidden context to a later Tick. Cross-Tick information flows through
node outputs, project state, and explicitly selected Memory sections.

### 9.2 Human

Human nodes remain product-native tasks. They are distinct from Gates that
check external state. A pending Human Task ends the Tick and leaves the Cycle
in `waiting_human`.

### 9.3 Script

A Script performs repeatable deterministic computation and returns JSON.

```js
const candidate = script({
  id: "find_large_file",
  label: "Find the next large file",
  file: "scripts/find-large-file.mjs",
  inputs: {
    threshold: ref("params.largeFileLines"),
  },
  output: "json",
});
```

Module protocol:

```js
export async function run(ctx) {
  return { path: "src/example.ts", lines: 1800 };
}
```

Scripts that declare external-write capabilities receive a diagnostic
directing the author to use an Effect.

### 9.4 Gate

A Gate checks a condition and either completes with an outcome or waits.

```js
const approval = gate({
  id: "wait_issue_approval",
  label: "Wait for Issue approval",
  file: "scripts/check-approval.gate.mjs",
  outcomes: ["approved", "rejected"],
});
```

Protocol:

```ts
type GateResult =
  | {
      status: "completed";
      outcome: string;
      output?: JsonValue;
    }
  | {
      status: "waiting";
      reason: string;
    };
```

A Gate that returns `waiting` ends the current Tick when no other branch can
advance. It is checked again on the Flow's next main Schedule or a direct
Agent/User invocation.

The first release has no Gate-specific timer and does not permit sleeping or
polling inside the Gate script.

An external API failure is a node failure, not `waiting`.

### 9.5 Effect

An Effect is an explicit external side effect backed by an Effect ledger.

```js
const issue = effect({
  id: "create_issue",
  label: "Create planning Issue",
  file: "scripts/create-issue.effect.mjs",
  idempotencyKey: template("{{cycle.id}}:create_issue"),
});
```

Protocol:

```js
export async function apply(ctx) {
  return {
    externalRef: "issue:328",
    output: { number: 328, url: "..." },
  };
}

export async function reconcile(ctx) {
  return {
    status: "completed",
    externalRef: "issue:328",
    output: { number: 328, url: "..." },
  };
}
```

An interrupted Effect becomes `uncertain`. The runtime calls `reconcile`
before any retry:

- `completed`: restore the result;
- `not_applied`: retry may apply according to policy;
- unknown or no reconciliation support: `paused_uncertain`.

Native Git/GitHub Effect providers are deferred. The first release provides the
generic protocol and complete Blueprint examples.

### 9.6 Finally

Finally nodes clean up resources or perform declared terminal compensation.
They are graph-visible and declare their terminal conditions.

```js
finalize({
  id: "cleanup_workspace",
  file: "scripts/cleanup.sh",
  runOn: ["completed", "canceled"],
  retainOnFailure: true,
});
```

### 9.7 Loop and Map

Loop and Map remain bounded, graph-visible composite nodes within a Tick/Cycle.
They do not represent the persistent cross-Schedule Cycle.

### 9.8 Cycle terminal nodes

```js
completeCycle({
  id: "complete",
  continue: "immediate",
});

cancelCycle({
  id: "rejected",
  reason: ref("approval.reason"),
  continue: "scheduled",
});
```

Immediate continuation creates a new, idempotent Invocation and a new Tick. It
never resets and loops inside the same Tick.

## 10. Failure, retry, and recovery

### 10.1 Default failure

A node failure ends the Tick and pauses the existing Cycle. Completed upstream
nodes, outputs, selected control paths, Effects, and worktree information
remain durable.

The next recurring Schedule does not automatically retry a
`paused_failed`/`paused_uncertain` Cycle. Runtime-owned bounded retries happen
inside the active Tick before the Cycle is paused.

### 10.2 Script retry

Scripts receive a bounded default retry policy for runner timeouts, spawn
failures, and non-zero exits. A Script may declare an explicit policy to
override the defaults. The runtime never classifies retryability by matching
provider prose.

### 10.3 Agent retry

Typed JSON output is extracted and schema-validated deterministically. Invalid
output receives bounded repair attempts (two by default, configurable from one
to three); each attempt is durable and the exact validation failure is added
to the repair prompt. Retrying a failed node invalidates that node and its
transitive downstream dependents while retaining unaffected upstream state.

### 10.4 Effect retry

Effects always reconcile uncertain executions before re-applying. The runtime
performs bounded same-Tick retries: `completed` restores the result,
`not_applied` permits another `apply`, and `unknown` pauses the Cycle as
`paused_uncertain`. Effects are not executed in parallel while they are using
this shared retry and reconciliation policy.

### 10.5 Restart recovery

On application start, the reconciler scans active Runs:

- live in-process work cannot survive restart, so code-node attempts without a
  committed result become interrupted;
- Agent attempts use their persisted Session references to determine whether
  they can be recovered;
- Effect attempts become uncertain and reconcile;
- completed checkpoint state remains authoritative;
- a Running Run with no recoverable owner is finalized as interrupted and its
  Cycle is paused at the affected node;
- pending Schedules are reconstructed from durable timestamps.

## 11. Schedule semantics

The first release supports zero or one main recurring Schedule per Flow. The
storage model should not prevent adding multiple schedule definitions later.

Required behavior:

- 5-field cron;
- IANA timezone;
- `catchUp: "latest"`;
- persisted `nextFireAt`;
- Flow pause/resume;
- one active Tick per Flow;
- overlap policy `coalesce-latest` by default, optional `skip`;
- bounded failure backoff owned by Runtime;
- no runtime `setCron` or `nextRunAt`;
- no Gate-specific timer.

With `coalesce-latest`, overlapping schedule fires are recorded but at most one
pending wake is retained. When the active Tick ends, the runtime performs one
latest compensation if the Flow and Cycle remain eligible.

Flow pause prevents new scheduled Invocations but does not forcibly cancel an
already running Tick. Cancel is a separate explicit action.

## 12. Direct invocation semantics

For a singleton Flow:

- no active Cycle: create a Cycle using the current published Version, params
  revision, and supplied/default inputs;
- active waiting/runnable Cycle and no new inputs: create a Tick that continues
  the existing checkpoint;
- active Cycle and identical inputs: treat as idempotent resume;
- active Cycle and different inputs: reject with
  `FLOW_ACTIVE_CYCLE_INPUT_CONFLICT`;
- active Tick: return the current Cycle and Run rather than starting a second
  Tick.

`run` returns immediately. `runs wait` waits only for the current Tick to reach
a stop reason. It never waits through future schedules for the entire Cycle.

## 13. Markdown memory

### 13.1 Canonical file

An optional Flow memory is stored outside the immutable Bundle:

```text
$APP_DATA/flows/<flow-id>/MEMORY.md
```

The Bundle may provide `memory.template.md`, used once when the Flow is
initialized.

### 13.2 Sections

The Bundle declares named Markdown sections and their allowed update mode:

```js
export const memory = defineMemory({
  sections: {
    currentUnderstanding: {
      title: "Current Understanding",
      update: "replace",
    },
    decisions: {
      title: "Decisions",
      update: "append",
    },
    openItems: {
      title: "Open Items",
      update: "replace",
    },
    timeline: {
      title: "Timeline",
      update: "append",
    },
  },
});
```

The canonical document uses reserved, section-aware markers. Updates cannot
remove, duplicate, reorder, or write unknown markers.

### 13.3 Read

Agent nodes explicitly select Memory sections:

```js
agent({
  id: "plan",
  memory: {
    include: [
      "currentUnderstanding",
      "decisions",
      "openItems",
    ],
  },
  prompt: "Create the next plan using the supplied Flow memory.",
});
```

Memory is not implicitly sent to every Agent.

### 13.4 Update

Memory is updated by a graph-visible `remember` node:

```js
remember({
  id: "record_cycle",
  updates: {
    currentUnderstanding: {
      mode: "replace",
      value: ref("summary.currentUnderstanding"),
    },
    timeline: {
      mode: "append",
      value: ref("summary.timelineEntry"),
    },
  },
});
```

The write is idempotent and uses an optimistic file-hash check. A conflicting
manual or concurrent edit is never overwritten. The candidate diff is
retained and the Cycle becomes `paused_conflict`.

### 13.5 Concurrency rule

Flow-scoped canonical Memory is incompatible with keyed concurrent Cycles. The
Validator must reject that combination. The first runtime release is singleton
only regardless.

## 14. Trusted local code model

The product is local. Published JS/Bash is user-reviewed trusted code. The
first release does not claim to provide an OS security sandbox.

The CodeRunner still provides operational isolation:

- child process per attempt;
- fixed cwd;
- AbortSignal;
- timeout;
- bounded stdout/stderr;
- structured input/output;
- environment sanitization;
- explicit Secret injection;
- command/exit/duration audit;
- Bundle-pinned source.

Capability declarations are used for validation, review, UI disclosure, and
future sandbox compatibility. They are not represented as an unbypassable
security boundary in v1.

## 15. Authoring and Blueprints

### 15.1 Blueprint role

Blueprints are always Authoring templates. They are never runtime dependencies.

Two catalog kinds are supported:

- **Scenario:** a complete runnable Bundle.
- **Pattern:** a validated local pattern for Agents to copy and compose.

The final Flow Bundle is standalone. It records Blueprint provenance for
explanation and future upgrade suggestions only.

### 15.2 Authoring loop

```text
business requirement
  → Blueprint search
  → complete Bundle generation
  → static validate
  → semantic review
  → Agent repair
  → submit Draft Version
  → user review
  → publish and enable
```

Agent `submit` cannot enable a Schedule.

### 15.3 Validation

Static validation is a non-negotiable publication gate and never executes
Bundle code.

It covers at least:

- Bundle layout, hashes, file references, and imports;
- DSL syntax and Schema version;
- node IDs, data edges, control edges, and outcome coverage;
- unreachable nodes and unreachable Cycle terminals;
- Trigger/Schedule configuration;
- required scheduled input bindings;
- Params/Inputs/Secrets schemas;
- Secret prompt prohibition;
- Script/Gate/Effect/Finally module exports;
- Effect idempotency/reconcile contract;
- Gate waiting reachability;
- Finally resource references;
- explicit loop/map/runtime budgets;
- Memory section declarations and marker template;
- Memory/concurrent-Cycle incompatibility;
- unsupported keyed Cycle diagnostics;
- declared command availability before Schedule enablement.

Semantic Review is required by default but may be waived by a user with a
durable reason. It is keyed by intent hash and Bundle hash.

### 15.4 Test Runs

Test Runs are explicit user actions:

- no Schedule activation;
- isolated test Cycle;
- no canonical Memory commit;
- no internal continuation;
- Effects disabled unless the user separately confirms test side effects;
- excluded from production dashboard aggregates by default.

## 16. Persistence and provenance

The exact migration DDL is owned by the implementation plan, but the durable
model must include:

```text
workflows
workflow_versions
workflow_version_files
workflow_params
workflow_secret_bindings
workflow_schedules
workflow_cycles
workflow_cycle_checkpoints
workflow_invocations
workflow_runs
workflow_node_attempts
workflow_effects
workflow_human_tasks
workflow_memory_updates
```

Every node attempt records:

- Flow, Cycle, Run, node, and attempt number;
- Bundle Version/hash;
- status, outcome, start/end/duration;
- bounded, redacted input and output;
- bounded, redacted stdout/stderr;
- error code and details;
- Agent Session reference;
- Effect ledger reference;
- Memory section hashes used;
- retry/resume/cancel provenance.

Full Agent transcripts remain owned by Tutti Agent Sessions. The Flow database
stores Session references and final structured outputs, not duplicate
transcripts.

Structured Cycle/Run/Attempt history is retained by default for future
dashboards. Artifact and raw-log retention are separate future policies.

## 17. CLI contract

The existing immediate-run and bounded-wait pattern is preserved conceptually.

Expected surface:

```text
tutti flow list
tutti flow show
tutti flow run
tutti flow pause
tutti flow resume
tutti flow cancel-cycle
tutti flow cycles get
tutti flow runs get
tutti flow runs wait
tutti flow runs respond
tutti flow authoring validate
tutti flow authoring submit
```

`flow run` returns Flow, Cycle, and Run references immediately. `runs wait`
returns when the current Tick reaches a stop reason:

```json
{
  "reason": "waiting_gate",
  "run": {
    "status": "completed"
  },
  "cycle": {
    "status": "waiting_gate",
    "currentNodeId": "wait_pr_merge"
  },
  "nextScheduleAt": "2026-07-26T09:00:00+08:00"
}
```

CLI responses continue to use stable structural error codes and bounded
continuations.

## 18. UI contract

The system homepage remains a list of Flows.

Inside a Flow, the primary summary includes:

```text
Status: Waiting for Issue approval
Current node: wait_issue_approval
Current Cycle: #12
Total Runs: 47
Completed Cycles: 11
Next schedule: tomorrow 09:00
```

The graph must render:

- node kind;
- current node;
- completed nodes;
- selected and non-selected control branches;
- waiting reason;
- failed/uncertain/budget/conflict states;
- child Loop/Map executions;
- node attempt history;
- Schedule source and direct invocation provenance.

The same graph supports Design, Live, and Review modes. Version editing and
limited property editing produce new Bundle Drafts; the graph itself is not an
independent source of truth.

## 19. Reference scenario

The first end-to-end Blueprint is a large-file governance Flow:

```text
Schedule / direct invocation
  → Script/Gate: find next large monolithic file
  → Agent: produce a structured refactoring plan
  → Effect: idempotently create planning Issue
  → Gate: wait for Issue approval
  → Effect: prepare a per-Cycle worktree
  → Agent: implement the approved plan
  → Effect: commit, push, and idempotently create PR
  → Gate: wait for PR merge
  → Effect: close Issue and clean resources
  → Remember: update Markdown memory
  → Complete Cycle with immediate continuation
```

The Issue and PR Gates are checked only on the main Flow Schedule or direct
invocation. External state reads do not use Agent tokens.

Agent planning and external creation are separated so external writes can be
idempotent and recoverable.

## 20. Acceptance criteria

The RFC is considered implemented when:

1. An Agent can create a complete Bundle from the reference scenario and
   existing Blueprints.
2. Static validation catches broken control paths, unsafe imports, missing
   schedule inputs, Secret prompt references, invalid Effects, and unsupported
   concurrency.
3. A user can review the graph and publish/enable the Flow.
4. A recurring Schedule starts or advances a singleton Cycle.
5. A Gate can end one Tick in `waiting_gate` and resume from the same node on a
   later Tick without rerunning completed upstream nodes.
6. A completed Cycle can idempotently create the next Cycle via immediate
   continuation.
7. Script, Gate, Effect, Finally, Agent, Human, Loop, and Map attempts are
   visible and durable.
8. An interrupted Effect reconciles before retry.
9. A Flow with Memory can explicitly read and update marked Markdown sections,
   and conflicting edits are never overwritten.
10. A Flow without Memory runs through the same runtime.
11. `flow run` returns immediately and `runs wait` stops at the current Tick's
    quiescent reason.
12. The UI shows current position, waiting reason, Cycle count, Run count, and
    historical node attempts.
13. The legacy single-script execution path is removed from the final runtime.

## 21. Deferred decisions

These require new evidence rather than speculative implementation:

- keyed Cycle execution and UI;
- per-Cycle Memory;
- multiple recurring schedules per Flow;
- Gate-specific timers;
- Tutti-hosted event-bus Trigger providers;
- webhook and GitHub event delivery;
- native Git/GitHub Effect providers;
- immutable third-party dependency bundles;
- OS-level script sandboxing;
- explicit live-Cycle Version migration;
- vector retrieval over Memory or historical Runs;
- complete drag-and-drop authoring;
- runtime Blueprint upgrade relationships.
