# Persistent Flow Runtime Implementation Plan

Status: proposed execution plan for the accepted RFC
Date: 2026-07-25
Depends on: [Persistent Flow Runtime RFC](./persistent-flow-runtime-rfc.md)

## 1. Delivery strategy

This is a breaking runtime replacement, not an incremental compatibility
feature. Work may land in small verified commits, but the completed product
must have one Bundle parser, one stateful graph model, one Cycle/Tick
supervisor, and one run-detail model.

The plan uses vertical slices. Every milestone must leave its new contracts
tested across the boundaries it owns; no milestone may introduce a second
permanent execution path.

The reference scenario is the large-file governance Flow:

```text
scan
→ plan
→ create Issue
→ wait approval
→ implement
→ create PR
→ wait merge
→ close Issue
→ update Memory
→ next Cycle
```

## 2. Existing assets to preserve

The rewrite should migrate, not discard, these mature capabilities:

- Agent target/model/permission resolution.
- Tutti Agent Session adapter and event translation.
- Structured Agent JSON output and repair.
- Human Tasks and response validation.
- Operator notes.
- Loop execution and loop checkpoints.
- Map fan-out, per-item attempts, and map checkpoints.
- Retry-from-node downstream invalidation.
- Run ownership claims and stale-run reconciliation patterns.
- Semantic authoring review.
- Blueprint catalog search.
- `run` immediate return and bounded `runs wait` CLI behavior.
- Live event streaming and historical graph rendering.

They currently live primarily under:

```text
src/lib/workflow/
src/lib/db/workflows/
src/lib/agents/
src/components/workflow/
src/lib/tutti/cli.ts
```

## 3. Workstream rules

### 3.1 Contract-first

Each milestone starts by adding or updating domain types and boundary tests.
Implementation follows only after the contract is executable in tests.

### 3.2 No legacy branching in the final state

Temporary scaffolding may exist on an implementation branch, but completion
requires removing:

- legacy single-script persistence;
- legacy parser/runtime selection;
- legacy Run-only checkpoint ownership;
- legacy UI assumptions that one Run is the whole workflow lifetime.

### 3.3 Static validation never executes Bundle code

Validator tests must prove that authoring validate/submit cannot execute JS,
Bash, Git commands, Agent calls, Effects, or network requests.

### 3.4 Cross-boundary verification

Every stateful feature needs tests across:

```text
Bundle
→ parser/validator
→ graph/runtime
→ SQLite
→ restart/recovery
→ API/CLI
→ UI projection
```

Pure unit tests are not sufficient for checkpoint, Schedule, Effect, Memory, or
Cycle lifecycle behavior.

## 4. Milestone 0 — freeze executable contracts

### Deliverables

- Add the accepted RFC and this plan.
- Introduce a `flow-v1` domain-types module without wiring it into production.
- Define stable enums and result unions for:
  - Flow lifecycle;
  - Flow Version lifecycle;
  - Cycle status;
  - Run/Tick status and stop reason;
  - Invocation origin/status;
  - node kinds/statuses;
  - data/control edges;
  - Script/Gate/Effect/Finally results;
  - Effect reconciliation;
  - Memory section/update policy.
- Define stable error-code names for the new boundaries.
- Add contract tests for JSON-serializable boundary values.

### Candidate files

```text
src/lib/flow-v1/types.ts
src/lib/flow-v1/contracts.ts
src/lib/flow-v1/contracts.test.ts
```

The temporary `flow-v1` directory is an implementation namespace, not a second
runtime. It is folded into `src/lib/workflow` when the cutover is complete.

### Exit criteria

- Typecheck passes.
- Contract tests pin all lifecycle and result unions.
- No production behavior changes.

## 5. Milestone 1 — immutable Bundle storage and static loading

### Deliverables

- Replace `workflow_versions.script` as the canonical Version payload with an
  immutable Bundle and manifest.
- Add `workflow_version_files` storage:
  - normalized relative path;
  - UTF-8 content;
  - SHA-256;
  - media kind;
  - executable/module role.
- Compute one deterministic Bundle hash over sorted path/hash pairs.
- Materialize a pinned Bundle into an App Data execution directory.
- Reject duplicate paths, absolute paths, `..`, symlink-like escape metadata,
  oversized files, and unsupported file kinds.
- Add Bundle import/export round-trip.
- Add `tutti.flow.v1` Schema version detection.
- Remove authoring assumptions that a Draft contains only one script string.

### Tests

- deterministic hash independent of input ordering;
- import/export round-trip;
- path escape and duplicate rejection;
- immutable Version files after publication;
- Bundle file corruption/hash mismatch;
- App Data materialization cannot escape its Version directory.

### Exit criteria

- A complete Bundle can be stored, loaded, hashed, exported, and materialized.
- No Bundle code executes.

## 6. Milestone 2 — Flow v1 parser and Validator

### Deliverables

- Parse `flow.js` into one `ParsedFlow`.
- Add Params, Inputs, Secrets, Cycle, Schedule, Memory, and runtime-budget
  declarations.
- Parse node declarations:
  - Agent;
  - Human;
  - Script;
  - Gate;
  - Effect;
  - Finally;
  - Loop;
  - Map;
  - Remember;
  - Complete Cycle;
  - Cancel Cycle.
- Parse data and control edges.
- Represent selected/non-selected control paths.
- Add stable range-aware diagnostics.
- Add Bundle-wide module/static import analysis.
- Reject arbitrary npm imports, `node_modules`, package installation, path
  escape, inline code, and invalid module protocols.
- Validate:
  - unique IDs;
  - edge references;
  - outcome coverage;
  - reachability;
  - Cycle terminal reachability;
  - Schedule required-input bindings;
  - Secret prompt references;
  - Effect idempotency/reconcile declaration;
  - Gate no-sleep contract declaration;
  - runtime/loop/map budgets;
  - Memory section/update compatibility;
  - Memory plus keyed Cycle;
  - keyed Cycle runtime unavailability.
- Update authoring skill materials and diagnostics prompts.

### Migration of existing primitives

Port Agent/Human/Loop/Map parsing behavior into `ParsedFlow`; do not call the
legacy parser from the new parser.

### Tests

- parser fixtures for every node and edge kind;
- invalid control graph and missing outcome routes;
- Secret prompt rejection;
- Schedule missing required input;
- import policy;
- keyed Cycle diagnostics;
- sectioned Memory declarations;
- static validate does not execute imported modules.

### Exit criteria

- The reference Flow Bundle parses to a complete graph.
- Static validation catches all RFC publication gates.
- Visual preview can consume `ParsedFlow` without execution.

## 7. Milestone 3 — persistence cutover

### Deliverables

Create the durable v1 schema. Exact names may change during implementation, but
the relationships must cover:

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
workflow_run_human_tasks
workflow_memory_updates
```

Add repositories and mappers for:

- atomic Cycle creation with Version/params/input snapshots;
- one unfinished singleton Cycle claim per Flow;
- Run/Tick ownership claims;
- compare-and-set Cycle checkpoints;
- Invocation idempotency;
- Node Attempt lifecycle;
- Effect ledger lifecycle;
- Schedule next-fire/coalesced-fire state;
- current Cycle and aggregate counts for Flow detail.

Because there are no production users, prefer a clean schema migration/reset
over compatibility columns that preserve legacy runtime shapes.

### Tests

- foreign keys and cascade behavior;
- unique singleton Cycle claim;
- Invocation idempotency;
- checkpoint CAS conflict;
- one active Tick per Flow;
- Node Attempt sequence;
- Effect idempotency key uniqueness;
- transactional Cycle + Run creation;
- restart-open database round-trip.

### Exit criteria

- The new domain can be persisted without legacy Run checkpoint tables being
  authoritative.
- Repository tests cover every lifecycle transition.

## 8. Milestone 4 — CodeRunner and module protocols

### Deliverables

- Add the fixed-version `@tutti/flow-runtime` SDK available to Bundle modules.
- Implement Bundle module resolution:
  - Node built-ins;
  - SDK;
  - relative Bundle modules only.
- Implement child-process CodeRunner with:
  - materialized pinned Bundle cwd;
  - explicit project cwd;
  - structured context/result IPC;
  - AbortSignal;
  - timeouts;
  - stdout/stderr draining and bounds;
  - environment sanitization;
  - explicit Secret injection;
  - source/command/exit/duration events.
- Implement Script, Gate, Effect, and Finally module result validation.
- Implement Bash wrapper protocol using input/result files rather than shell
  interpolation.
- Add required-command preflight.

### Effect ledger

- `starting` before external apply;
- `completed` only after durable result;
- `uncertain` when process outcome is unknown;
- reconcile-before-retry;
- `paused_uncertain` when no authoritative decision is possible.

### Tests

- JS success/failure/timeout/abort;
- Bash success/failure/timeout/abort;
- noisy output cannot corrupt structured result;
- output bounds;
- Secret injection and redaction;
- invalid result protocol;
- disallowed import never executes;
- Effect crash before/after external marker;
- reconcile completed/not-applied/unknown;
- child process cleanup.

### Exit criteria

- Each code-node kind can run from a pinned materialized Bundle.
- An uncertain Effect is never blindly applied twice.

## 9. Milestone 5 — stateful graph executor

### Deliverables

- Replace the legacy Run-only scheduler with Cycle-aware execution.
- Schedule ready nodes using both data and control prerequisites.
- Preserve parallel execution of independent ready nodes.
- Mark non-selected control branches explicitly.
- Persist node outputs and control choices in the Cycle checkpoint.
- Run until quiescence.
- Implement:
  - Gate waiting;
  - Human waiting;
  - node failure pause;
  - uncertain Effect pause;
  - explicit budget pause;
  - Complete/Cancel Cycle;
  - Finally execution policies.
- Port Agent/Human/Loop/Map execution to Node Attempts.
- Port retry-from-node invalidation to Cycle checkpoints.
- Enforce no cross-Tick completed Agent Session inheritance.

### Tests

- approved/rejected control routes;
- unselected branch projection;
- waiting Gate ends Tick but not Cycle;
- next Tick resumes Gate without rerunning upstream;
- Human task ends Tick and response resumes Cycle;
- Script failure preserves upstream;
- Effect uncertain pauses Cycle;
- Finally by terminal reason;
- Loop/Map checkpoint survives Tick/restart boundary;
- run-to-quiescence with parallel branches;
- budget pause is not success;
- complete Cycle terminality.

### Exit criteria

- The reference Flow advances manually across at least three Ticks:
  plan/Issue, approval/PR, merge/completion.
- Completed upstream nodes do not rerun.

## 10. Milestone 6 — Invocation supervisor and CLI cutover

### Deliverables

- Implement direct Agent/User Invocation.
- Enforce singleton semantics:
  - no Cycle -> create;
  - existing Cycle + no inputs -> resume;
  - identical inputs -> idempotent resume;
  - conflicting inputs -> stable error;
  - active Tick -> return current Run.
- Implement idempotency keys and ownership claims.
- Cut CLI to the new semantics:

```text
flow run
flow show
flow cycles get
flow runs get
flow runs wait
flow runs respond
flow cancel-cycle
```

- Preserve bounded continuation behavior for `runs wait`.
- Return Flow/Cycle/Run together from direct invocation.
- Return Tick stop reason and current Cycle position from wait.
- Add restart reconciler for Runs, Agent Sessions, and Effects.

### Tests

- every direct invocation branch;
- input conflict;
- duplicate agent call;
- active Tick return;
- wait completed/waiting_gate/waiting_human/failed/uncertain;
- stale Run recovery;
- Agent session recovery;
- Effect recovery;
- stable CLI domain errors.

### Exit criteria

- An Agent can invoke a Flow, wait only for the current Tick, and receive a
  precise Cycle status without babysitting future schedules.

## 11. Milestone 7 — recurring Schedule

### Deliverables

- Persist zero/one main recurring Schedule per Flow.
- Validate 5-field cron and IANA timezone.
- Compute/persist `nextFireAt`.
- Implement:
  - active/paused Flow lifecycle;
  - catch-up latest;
  - `coalesce-latest`;
  - optional skip;
  - one active Tick per Flow;
  - Runtime failure backoff;
  - missed-fire reconstruction on boot;
  - immediate Cycle continuation with idempotency and explicit cap.
- Reject runtime cron modification.
- Bind/validate required Cycle inputs before enablement.

### Tests

- exact-time fire;
- timezone;
- boot catch-up;
- multiple missed fires coalesce;
- active Tick coalesce;
- Flow pause/resume;
- failed Cycle does not auto-retry on schedule;
- waiting Gate resumes on next Schedule;
- Schedule cannot enable with missing inputs/commands/Secrets;
- immediate continuation creates a new Tick and respects cap.

### Exit criteria

- The reference Flow can run unattended using only its main Schedule.
- Gate checks consume no Agent tokens when no intelligent node is reached.

## 12. Milestone 8 — canonical Markdown Memory

### Deliverables

- Materialize `memory.template.md` on Flow initialization.
- Implement canonical `MEMORY.md` location and marker format.
- Parse and validate declared sections.
- Inject explicitly selected sections into Agent prompts with provenance.
- Implement graph-visible Remember node:
  - replace;
  - append;
  - idempotency;
  - base-hash optimistic concurrency;
  - candidate diff on conflict.
- Record Memory update history and section hashes used by attempts.
- Reject Secret-like values at known injection boundaries and always apply log
  redaction.
- Enforce Memory plus singleton Cycle.

### Tests

- initialize once;
- publish new Version does not overwrite Memory;
- section selection;
- replace/append;
- unknown/missing/duplicate markers;
- reserved marker injection;
- same update idempotency;
- user edit conflict retains both canonical and candidate;
- no implicit Agent memory;
- no cross-Tick Session memory.

### Exit criteria

- A completed reference Cycle updates Current Understanding and Timeline.
- A concurrent manual edit is never overwritten.

## 13. Milestone 9 — Authoring and Blueprint cutover

### Deliverables

- Authoring workspace produces complete Bundles.
- Validate/submit accept a Draft directory, not a script string.
- Update Agent authoring skill and examples.
- Expand semantic review to:
  - control paths;
  - waiting behavior;
  - Effect ordering;
  - Schedule/input closure;
  - Memory boundaries;
  - permission/capability disclosure.
- Keep semantic review keyed by intent and Bundle hashes.
- Add reasoned waiver.
- Rebuild Blueprint catalog:
  - Scenario Blueprints as complete Bundles;
  - Pattern Blueprints as Agent-copyable materials;
  - metadata for capabilities, node kinds, required Connections, Effects,
    waiting modes, and use cases.
- Record authoring provenance without runtime inheritance.
- Rewrite all retained built-in Blueprints to v1 Bundles.
- Add the large-file governance Scenario Blueprint.

### Tests

- Bundle authoring validate/submit;
- no code executes during validate/review;
- semantic review stale/hash behavior;
- Blueprint search by capability;
- Blueprint instantiate produces standalone Bundle;
- no runtime Blueprint dependency;
- Agent-facing diagnostics repair fixtures.

### Exit criteria

- An Authoring Agent can create and submit the reference Flow from a business
  requirement and catalog materials.

## 14. Milestone 10 — UI cutover and observability

### Deliverables

### Flow list

- lifecycle;
- current high-level status;
- latest Run;
- Cycle/Run counts;
- next Schedule;
- attention state.

The homepage remains a list of Flows; detailed runtime information belongs
inside the Flow.

### Flow detail

- Design, Live, Review modes over one parsed graph.
- Current Cycle/node/waiting reason.
- selected/non-selected control branches.
- node kind and status.
- Schedule state.
- Memory viewer/editor and candidate conflict diff.
- Params/Secret binding status.
- publish/enable/pause/resume.
- current and historical Cycle list.
- Run/Tick list within a Cycle.
- Node Attempt inspector.
- Agent Session open action.
- Effect ledger/reconcile history.
- Script logs and outputs.
- retry node/cancel Cycle.

### Authoring

- complete Bundle file editor;
- graph preview;
- structured diagnostics;
- semantic review findings;
- capability and side-effect review;
- publish-and-enable confirmation.

### Tests

- reducers/projections for Cycle and Attempt events;
- current-node calculation;
- non-selected branch display;
- waiting/failed/uncertain/conflict/budget states;
- historical Cycle selection;
- live versus reloaded terminal consistency;
- empty/zero states;
- layout tests for new node kinds.

### Visual acceptance

Perform a real browser pass for:

- reference Flow Design graph;
- waiting Issue Gate;
- failed Agent node with preserved upstream state;
- uncertain Effect;
- completed Cycle and immediate next Cycle;
- Memory conflict;
- historical Run/Attempt review.

### Exit criteria

- A user can understand design, current position, and historical execution
  without reading Bundle source or raw logs.

## 15. Milestone 11 — remove legacy runtime

### Deliverables

- Delete legacy single-script parser and types not used by Flow v1.
- Delete legacy Run-only executor paths.
- Delete legacy checkpoint codecs/tables after data reset/migration.
- Delete compatibility UI selectors.
- Rename temporary `flow-v1` implementation namespaces into the canonical
  workflow modules.
- Update all docs and CLI command guides.
- Remove obsolete built-in Blueprints and tests.
- Run full typecheck, tests, build, and packaged Tutti app checks.

### Exit criteria

- Repository search finds no production legacy runtime selector.
- One canonical parser, graph, executor, checkpoint, and UI projection remain.
- `npm run check:full` passes.
- Tutti package smoke test passes.

## 16. Reference Flow acceptance matrix

| Scenario | Expected result |
| --- | --- |
| First schedule, no candidate | Gate waits; no Agent token use |
| Candidate found | Plan Agent runs; Issue Effect records external ref |
| Issue not approved | Later Tick checks Gate; upstream does not rerun |
| Issue approved | Implement Agent and PR Effect run |
| PR not merged | Cycle waits at merge Gate |
| PR merged | Close/cleanup/Remember complete the Cycle |
| Immediate continuation | New Cycle and new Tick are created idempotently |
| Duplicate Issue apply | Existing marker is reconciled, no duplicate Issue |
| Effect process crashes | Effect becomes uncertain and reconciles |
| Agent fails | Cycle pauses at Agent; upstream remains complete |
| User retries Agent | Failed node and downstream reset only |
| App restarts while waiting | Cycle remains waiting and next Schedule resumes |
| App restarts during Agent | Session is inspected/recovered or Cycle pauses |
| User edits Memory concurrently | Candidate conflict is shown; canonical not overwritten |
| New Version published mid-Cycle | Current Cycle remains pinned |
| Direct call during active Tick | Current Tick returned, no duplicate |
| Cron overlaps active Tick | Latest fire coalesced once |

## 17. Verification commands

Use the repository's existing gates:

```bash
npm run typecheck
npm run check:quick
npm run check:full
npm run package:tutti-dev
```

During implementation, prefer focused Vitest files plus
`npm run check:changed`, then run the full gate at milestone boundaries.

## 18. Major risks and controls

### Runtime rewrite breadth

Control: migrate stable Agent/Human/Loop/Map internals behind the new Node
Attempt interface; do not reimplement provider adapters.

### State explosion

Control: singleton Cycle only, one main Schedule, no Gate timers, no event
Triggers, and no Version migration in v1.

### Duplicate external effects

Control: Effect ledger, mandatory idempotency key, reconcile-before-retry, and
`paused_uncertain`.

### Hidden business logic

Control: no automatic Controller hooks; all preparation and cleanup are
graph-visible.

### Agent-authored unsafe code

Control: immutable Bundle, static import/capability validation, semantic review,
explicit publish/enable, trusted local execution disclosure, bounded/redacted
CodeRunner.

### Dashboard queries becoming log replay

Control: append audit events plus normalized Cycle/Run/Attempt/Effect records.

### Memory becoming an implicit state machine

Control: Markdown Memory is Agent context only; graph checkpoint and Effect
ledger remain the runtime authority.

## 19. First implementation checkpoint

The first coding checkpoint should stop after Milestones 0–2:

- v1 domain contracts;
- immutable Bundle storage/loader;
- Flow v1 parser/static Validator;
- reference Bundle parses and previews;
- no production execution changes yet.

This checkpoint creates a reviewable language and safety boundary before
database and runtime replacement. After approval, continue through persistence,
CodeRunner, and the stateful executor.
