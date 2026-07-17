# Dynamic Fan-Out (`map`) Design

Status: proposal (2026-07-16). Owner: workflow runtime.

Today the workflow graph is fully static at authoring time: the number of agent executions is known before the run starts (loops vary depth, not width). This blocks the migration/audit/sweep class of workflows — "discover N work items, process each one" — where N only exists at runtime.

This document proposes a `map` node: one authoring-time node that expands into N child executions at runtime, mirroring how `loop` already expands into per-iteration step executions.

## Prior art

Claude Code's Workflow tool treats fan-out as ordinary code (`parallel(items.map(...))`, `pipeline(items, ...)`) rather than a primitive. Its runtime semantics are the part worth porting:

1. **Structured discovery.** The item list comes from an agent forced to return schema-validated JSON, never from parsing prose.
2. **Per-item failure isolation.** A failed item becomes `null` in the result set; the fan-out never rejects as a whole.
3. **Explicit caps, no silent truncation.** Exceeding an item cap is an error; concurrency is limited by the scheduler, not the script.
4. **Per-item progress.** Every child execution has a label and a phase group in the UI.
5. **Resumability.** Completed children are cached by (prompt, options); deterministic scripts make re-runs replayable.

Our parser already reserves the concept space: `parallel(...)` / `pipeline(...)` parse as preview-only dynamic nodes ("visible only at runtime", `addDynamicNode` in `parser.ts`), and the `loop_step_state` event plus `recovery.loopStates` already implement "static node, dynamic child executions".

## Phase 0 — structured agent outputs (prerequisite)

`map` needs a machine-readable item list from an upstream agent. Building it on final-line text parsing would be brittle, so structured outputs ship first. This phase is independently valuable: it also replaces fragile `until.finalStatus` matching.

- Agent nodes gain `output: "json"`. The executor extracts the last JSON block from the agent's final message, parses it, and stores the parsed value as the node output. Extraction failure fails the node with the raw output attached.
- Downstream dotted-path template resolution (`{{review.verdict}}`) already works for structured human outputs (`resolveWorkflowValuePath`); parsed agent outputs reuse the same path.
- `until` needs no new form: the existing dotted-source resolver (`resolveLoopStepOutput`) already resolves `{ source: "review.verdict", equals: "pass" }` against a parsed agent output, the same way it resolves `review.action` for human steps. The `{ source, path, equals }` shape floated earlier was not implemented — dotted sources suffice.
- Prompt contract guidance: a node with `output: "json"` must state the exact JSON shape in its prompt and end the message with only the JSON block.

Scope: parser field + validation, executor extraction, template/`until` resolution, dsl-reference + patterns.md updates, parser/executor tests.

## Phase 1 — `map` MVP

Status: implemented (2026-07-17). Parser, executor, run-event consumers, executor-level recovery, DB-backed checkpoint persistence, and the run/graph UI all ship. The rest of this section is the original proposal; deviations and the final implementation notes are recorded at the end.

### Syntax

```js
const sites = agent({
  id: "discover",
  label: "Discover call sites",
  output: "json",
  prompt: "... end with a JSON array: [{\"file\": \"...\", \"line\": 1, \"note\": \"...\"}, ...]",
});

const migrated = map({
  id: "migrate_all",
  label: "Migrate each call site",
  source: sites,             // upstream node whose output is a JSON array
  maxItems: 20,              // required, hard cap; more items than this fails the run
  onItemFailure: "skip",     // "skip" (default) or "fail"
  step: agent({
    id: "migrate_one",
    label: "Migrate {{item.file}}",
    prompt: "Migrate the call at {{item.file}}:{{item.line}}.\n\nItem:\n{{item}}",
  }),
});
```

### Parse rules

- `source` must bind an upstream executable node (same mechanics as `inputs`).
- `step` is a single `agent({...})` in v1 — no `human`, no nested `loop`/`map`.
- Inside the step prompt, `{{item}}` (whole item), `{{item.<path>}}`, and `{{item_index}}` (1-based) are reserved refs, mirroring `{{iteration}}`.
- Step sessions are always independent; declaring `session: { mode: "inherit" }` on a map step is a validation error (parallel same-role executions cannot share one conversation).
- `maxItems` is required, integer 1..50.
- Runtime `agent`/`model` option templates are allowed on the step, same as loop steps.

### Runtime semantics

- On map start, resolve the source output: it must be an array (Phase 0 `output: "json"` upstream, or an output that parses as a JSON array). Non-array → node fails with a clear error. Length > `maxItems` → node fails (explicit, never truncate).
- Each item becomes a child execution scheduled through the existing ready-batch loop (`ready.slice(0, 4)` in `executor.ts`), so map children compete fairly with other ready nodes and no new concurrency mechanism is added.
- `onItemFailure: "skip"`: a failed child records `{ status: "failed", error }` for that item and the map continues; `"fail"`: first child failure fails the map node.
- Map node output shape:

```json
{
  "items": [ { "index": 1, "item": { }, "status": "completed", "output": "..." } ],
  "failed": [ { "index": 3, "item": { }, "error": "..." } ],
  "total": 5
}
```

  Downstream synthesizers receive the full record via `{{migrate_all}}`; failures are always visible (no silent caps).

### Events and persistence

- Mirror the loop machinery: a `map_item_state` event shaped like `loop_step_state` (child ref = map node id + item index), `node_event` gains an optional `mapItem` ref alongside `loopStep`.
- Recovery mirrors `recovery.loopStates`: persist per-item completion so a crashed run resumes only unfinished items. The resolved item array is persisted at expansion time so recovery does not depend on re-resolving the source.

### UI

Reuse the loop step executions presentation: child executions grouped under the map node, labeled by the rendered step label (`Migrate src/foo.ts`), with per-item status badges and the failed-item list on the node detail.

### Deviations from this proposal (as implemented)

- **Concurrency lives inside the node, not the global ready batch.** The proposal had map children "compete fairly in the global `ready.slice(0, 4)` loop." The global `executableNodes` set is fixed for the run and expanding it mid-run to inject dynamic children would be invasive. Instead, `runMapNode` runs its children through an internal concurrency pool of up to 4 (mirroring `streamNodeBatch`'s merge mechanics). Map children therefore contend for the pool among themselves, not with sibling nodes; the map node still occupies one slot of the outer batch while it runs.
- **`onItemFailure: "fail"` lets in-flight children finish.** On the first item failure the pool stops scheduling new items and, once the already-running children settle, the map node fails with the first failure's message. Running children are not aborted mid-flight.
- **Output shape.** `items` holds only the completed entries (`{ index, item, status: "completed", output }`); failures live in `failed` (`{ index, item, error }`); `total` is the resolved item count. `failed` is always populated for failures, satisfying "failures always visible."
- **Step prompts may reference upstream node outputs.** The proposal restricted v1 step prompts to item refs plus workflow inputs. Because loop steps already auto-bind cross-node refs cheaply (via `connectTemplateRefs` → node `inputs` → edges), map reuses that exact machinery: a step prompt referencing another node's variable auto-binds it as a map input. Item refs (`item`, `item.<path>`, `item_index`) and `workflow.cwd` never require declaration.
- **Events and recovery are wired at the executor layer.** A `map_item_state` event mirrors `loop_step_state` (child ref `map:<nodeId>:<index>:<stepId>`), and `node_event` carries an optional `mapItem` ref alongside `loopStep`. Recovery mirrors `recovery.loopStates` via `recovery.mapStates` (the resolved item array plus per-item completions), and the executor emits `onCheckpoint({ kind: "map", ... })` at expansion time and after each item.

### DB checkpoint persistence (closed)

The persistence layer now forwards map checkpoints end to end, so a crashed/stopped run resumes only unfinished map items across the DB boundary (not just in-memory):

- The stored checkpoint type widened from `WorkflowLoopRecoveryState` to the tagged `WorkflowRunCheckpointState = { kind: "loop"; state } | { kind: "map"; state }` (mirrors `WorkflowRunCheckpoint`). `WorkflowRunCheckpointRecord.checkpoint`, `upsertWorkflowRunCheckpoint`, and the JSON column codec all use the union.
- No SQLite migration is needed: `workflow_run_checkpoints.checkpoint_json` is opaque JSON. On write we persist `{ kind, state }`; on read, `parseWorkflowRunCheckpointStateColumn` accepts the tagged shape and normalizes any legacy untagged row (a bare loop recovery state) to `{ kind: "loop", state }`, so pre-existing loop checkpoints keep resuming.
- `run-jobs.ts` `onCheckpoint` now forwards both kinds, and `readRecoveryCheckpoints` splits stored checkpoints into `recovery.loopStates` / `recovery.mapStates` by `kind`.
- Cross-boundary coverage: `run-jobs.test.ts` "persists a map checkpoint and resumes only unfinished items" (map checkpoint → DB → `recovery.mapStates` on resume), `workflows.test.ts` persists a loop+map checkpoint pair, and `json-schemas.test.ts` covers map round-trip plus legacy untagged-loop normalization.

### UI (implemented)

Map children render like loop step executions:

- The graph node renders a `MapMiniFlow` container (loop-style width/badges) for any node with `node.map`; `getFlowNodeDimensions` reserves loop-style width and height for `map` nodes so the mini-flow is not clipped, and the lane width / layout key handle `map` alongside `loop`. A map node no longer renders blank.
- `mapItemRuns` is threaded from `run-state` through the run-event hooks (`useWorkflowRunEvents`, `useWorkflowRunPreview`, `useWorkflowRunController`) and `useWorkflowFlowLayout` into `FlowNodeData`, mirroring `loopStepRuns` (live streaming and historical run preview).
- The inspector shows per-item executions: `run-detail.ts` builds `mapItem.items` (sorted by 1-based index) and `RunDetailPanel` renders a "Map item executions" section. The loop-attempt card was generalized into a shared `RunExecutionAttempt` (heading + copy-key prefix) reused by both loop and map, showing each item's label, status badge, agent, and expandable input/output/error/timeline.
- Not visually verified in a browser here (no runtime). Compensated with typecheck, the run-state map reducer test, and the map-node layout dimension test. A visual pass in a running app is still worth doing to confirm map-node spacing and the item-badge wrap look right; the layout math is conservative but only eyeballing confirms no clipping.

## Phase 2 — spec (approved 2026-07-17)

Three independent pieces, shipped as two batches: A = multi-step items + static list sources (DSL/runtime), B = failed-item retry (persistence/API/UI, depends on A's event shapes).

### Multi-step items (pipeline semantics)

- `steps: [agent({...}), agent({...})]` (1..N agent steps) replaces `step` for multi-stage items; `step: agent({...})` stays as sugar for a single-entry `steps`. Declaring both is a validation error.
- Within one item, steps run sequentially in declared order; across items there is NO barrier — item 3 may be on its verify step while item 7 is still on its first step. This is the per-item quality-gate shape (migrate → verify) without serializing the batch.
- A later step's prompt may reference earlier step ids of the same item (`{{migrate_one}}`), plus the item refs (`{{item}}`, `{{item.<path>}}`, `{{item_index}}`); referencing a later or same step is a validation error. Step ids must be unique within the map.
- Sessions stay independent for every step of every item (inherit remains rejected). Cross-step context flows through dataflow, which keeps verify steps adversarially clean.
- Failure: the first failing step fails the item; remaining steps of that item are skipped. The item's failure record carries the failing step id (`failed: [{ index, item, step, error }]`).
- The LAST step's output is the item's `output` in `items[]`; each step's execution is individually visible through `map_item_state` (the execution key already carries the step id).
- `output: "json"` is allowed per step; on the last step it shapes the item output.
- Recovery granularity stays item-level: a resumed run re-runs an unfinished item from its first step. Mutating steps must therefore be written idempotently, same as Phase 1.

### Static list sources

- `source` may be an inline array literal of plain JSON data (objects/arrays/strings/numbers/booleans; no template refs resolved inside items): `source: [{ env: "dev" }, { env: "staging" }, { env: "prod" }]`.
- For literal sources `maxItems` is optional (defaults to the literal length); a literal longer than 50, or longer than an explicit `maxItems`, is a parse-time validation ERROR — statically knowable violations fail early instead of at run time.
- For dynamic (node-bound) sources everything stays as in Phase 1, `maxItems` required.
- Executor skips source resolution and checkpoints the literal items exactly like resolved ones, so recovery and retry behave identically for both source kinds.
- Scenario: fixed checklists — per-environment deploy checks, fixed audit dimensions — gaining map's per-item badges and failure isolation without hand-writing N parallel nodes.

### Failed-item retry (batch B)

- Built on the existing recovery machinery rather than a parallel path: retrying failed items = restore the run's checkpoints with the failed map completions REMOVED, mark the map node and every node downstream of it as not-completed, and resume execution. Recovery then re-runs only the cleared items; downstream nodes (synthesis) re-run on the corrected map output. Upstream completed nodes keep their outputs.
- Precondition: run in a terminal state with at least one failed map item. Exposed as a variant of the existing run retry (`{ mapNodeId }` scope), surfaced in the UI on the map node's failed-item list.
- Scenario: a 20-item, 40-minute fan-out with 2 transient failures gets patched in minutes instead of rerun wholesale.

### Batch B — as implemented (2026-07-17)

Shipped as specified; no behavioral deviations from the design. The executor gained NO retry mode — retry is pure checkpoint rewriting + completed-set computation + resume wiring. Notes for maintainers:

- **Entry point.** `retryFailedMapItems({ workflowId, runId, mapNodeId })` in `run-jobs.ts`. It validates the precondition (terminal run, no active job, `mapNodeId` resolves to a `map` node in the run's parsed script, the stored map checkpoint has ≥1 `status: "failed"` completion), then rides the SAME run (checkpoints + log belong to it) — it does not create a new run like the full run-retry does.
- **Checkpoint rewrite.** The map checkpoint is re-upserted with `completions` filtered to drop the failed entries (`items` unchanged). On resume `runMapNode` sees the cleared items as pending and re-runs ONLY those; kept completions are restored, so healthy items and upstream nodes never re-run.
- **Downstream invalidation.** The map node plus its transitive dataflow dependents (BFS over `node.inputs[].sourceNodeId`) are reset to `queued` in the reconstructed run summary and their `outputs` entries are deleted. Recovery is then derived from that summary via the existing `createRecoveryStateFromSummary`, so `completedNodeIds` excludes exactly the reset set and `recovery.outputs` no longer carries their stale values — this is what prevents stale downstream outputs from leaking into re-run prompts. Because the executor only runs a node once its dataflow inputs are `completed`, each reset node re-runs and refreshes its own output before any dependent reads it.
- **Terminal → running transition.** A new atomic DB claim `claimWorkflowRunForRetry` (mirrors `claimWorkflowRunForResume` but matches `completed`/`failed`/`canceled` rows) flips the run back to `running` with a fresh execution token and guards against concurrent retries. Relaunch reuses `executeWorkflowRunJob` — the same resume execution path.
- **API.** The existing `POST /api/workflows/[id]/runs/[runId]/retry` route now branches on an optional `{ mapNodeId }` body; absent it, the pre-existing full-retry path is unchanged. Status codes: unknown run → 404 (`RUN_NOT_FOUND`); non-terminal run or no failed items → 409 (`WORKFLOW_MAP_RETRY_INVALID`); unknown / non-map node id → 400 (`WORKFLOW_MAP_NODE_INVALID`).
- **UI.** `RunDetailPanel`'s "Map item executions" section shows a failed-item count badge and a "Retry failed items" button, enabled only when the run is terminal and the selected map node has failed items, disabled while a run action is pending (mirrors the header retry/resume affordances). It calls a new `retryMapItems(runId, mapNodeId)` controller action that reuses `executeRunJob` (same-run resume + event streaming) with a `{ mapNodeId }` body.
- **Tests.** `map-retry.test.ts` drives the real executor through run-jobs (mocking only the `runAgent` boundary) across the SQLite persistence boundary: a 3-item map with 1 failed (skip mode) completes, retry re-runs only the failed item, discover/healthy items do not re-run, synthesis re-runs on the corrected output, and the item moves from `failed[]` to `items[]`; plus precondition rejections (non-terminal, no-failures, non-map node). `retry/route.test.ts` covers dispatch + status-code mapping.

### Authoring assets (rides with batch A)

- dsl-reference: document `steps`, static list sources, and the failure-record `step` field.
- patterns.md: extend the fan-out pattern with the per-item pipeline shape and when to choose static lists.
- Extend `map-fan-out-demo-v1` with a per-item verify step so the demo (and the acceptance fixture) exercises the pipeline shape.

### Batch A — as implemented (2026-07-17)

Shipped as specified; no behavioral deviations. Notes for maintainers:

- **`WorkflowMapSpec.step` became `steps: WorkflowAgentLoopStep[]`.** The single-step form (`step:`) is parsed into a one-entry `steps` array; there is no longer a `step` field on the spec. All consumers (parser diagnostics, executor, run-detail/run-state, `MapMiniFlow`, layout key) read `steps`. `step` remains only as DSL sugar.
- **Failure attribution.** `WorkflowMapItemCompletion` gained an optional `step?: string`, set to the failing step id on a failed item and absent on success and on legacy single-step checkpoints. It flows into the map output's `failed: [{ index, item, step, error }]` and into the DB checkpoint JSON guard (`isWorkflowMapItemCompletion` accepts records with or without `step`; a non-string `step` is rejected). Recovery stays item-level: a resumed item re-runs from its first step.
- **Static list sources.** A literal `source` is stored as `map.items` with `source` set to the marker string `"inline list"` (no `sourceNodeId`, no input binding/edge). `maxItems` defaults to the literal length when omitted; over-limit literals fail at parse time. The executor uses `map.items` directly and checkpoints them identically to a resolved source, so recovery/retry are uniform.
- **Cross-step references** resolve inside the item runner by step id (against the item's earlier step outputs), ahead of node-input and workflow-input lookup; sibling step ids are excluded from the map node's `templateRefs`, so they never auto-bind as inputs or create edges.

## Testing strategy

- Parser: syntax, reserved refs, session/step restrictions, cap validation.
- Executor with mock adapter: expansion, concurrency interleaving with sibling nodes, skip-vs-fail semantics, output shape, recovery mid-map.
- Behavioral fixture (see improvement backlog item 2): a scripted mock run that discovers 3 items, fails 1, and synthesizes — asserting the failed item appears in the map output and downstream prompt.

## Retry-from-node (approved 2026-07-17)

Generalize batch B's machinery: re-run a terminal run from an arbitrary node. Failed-item retry stays as-is (it preserves completed items); retry-from-node is the fresh-re-execution variant.

- **Semantics**: given `{ fromNodeId }` on a terminal run, reset node X plus its transitive dataflow dependents — statuses to queued, outputs and nodeSessions dropped (the stale-attach lesson), and the checkpoints of EVERY node in the reset set deleted (loop iterations and map expansions are stale once an upstream re-runs; a map downstream of X must re-resolve its source). Atomically claim the run back to running and resume through the normal execution path. Upstream nodes keep outputs, never re-run, and inherited session keys they established survive — a reset continuing-role node (e.g. rd_fix) correctly resumes the kept upstream session.
- **Preconditions**: run terminal; X exists and is executable; every transitive upstream input source of X is `completed` in the reconstructed summary (otherwise the resume would stall on unresolved deps — 409).
- **v1 restriction — human nodes**: if X is a human node, or the reset set contains one, reject with an explicit error naming the nodes. Re-running a human gate raises response-reuse questions (the old resolved task would satisfy the same executionKey instantly, approving content the human never saw). Superseding old tasks with a new revision is the designed follow-up, out of scope here.
- **API**: the existing retry route gains `{ fromNodeId }`, mutually exclusive with `{ mapNodeId }` (both → 400). Codes mirror the map variant: 404 unknown run, 409 non-terminal/unmet preconditions, 400 invalid node.
- **UI**: a "Retry from this node" action on the node detail section of a terminal run, using the same pending/disabled affordances; server-side rejections surface through the existing error path.

### Implemented (2026-07-17) — no semantic deviations

- **Shared core**: `retryFailedMapItems` and `retryWorkflowRunFromNode` are now two thin entries over one core in `run-jobs.ts`: `loadTerminalRunForRetry` (run/version/terminal/active validation), `reconstructTerminalRunSummary` (log + persisted result → summary, the source of truth), and `relaunchWorkflowRunFromReset` (reset summary → claim → per-entry checkpoint mutation → recovery snapshot → resume). Failed-item retry's checkpoint mutation REWRITES the map checkpoint keeping completed items; retry-from-node's DELETES the checkpoint of every reset node via the new `deleteWorkflowRunCheckpoint` DB helper. The stale-attach lesson (drop `nodeSessions` on reset nodes) lives in the shared `resetSummaryForRetry`.
- **Error codes**: `WORKFLOW_RETRY_NODE_INVALID` (400, unknown/non-executable node), `WORKFLOW_RETRY_FROM_NODE_INVALID` (409, non-terminal / active / human-in-reset-set / upstream-incomplete), `WORKFLOW_RETRY_REQUEST_INVALID` (400, `mapNodeId` and `fromNodeId` both present).
- **UI refinement**: the button is rendered only for executable node kinds (`agent`/`loop`/`map`) on a terminal run. This is a static `node.kind` gate, not a client-side precondition computation — the human-node, upstream-completed, and node-existence rejections still come from the server. Human nodes therefore never show the action.

## Open questions

- Should the child agent receive the item as a labeled context block only (current proposal) or also as pre-bound individual inputs?
- Cap default: is 50 the right ceiling for `maxItems`, and should it be configurable per deployment?
- Should map children appear in `{{...}}` template space individually (e.g. `{{migrate_all.items.2.output}}`)? Deferred until a concrete need appears.
