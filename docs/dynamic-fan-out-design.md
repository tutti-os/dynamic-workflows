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

Status: runtime implemented (2026-07-17). Parser, executor, run-event consumers, and executor-level recovery ship; the UI and DB-backed checkpoint persistence are deliberately deferred (see "Deviations from this proposal" below). The rest of this section is the original proposal; deviations are recorded at the end.

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
- **Events and recovery are wired at the executor layer.** A `map_item_state` event mirrors `loop_step_state` (child ref `map:<nodeId>:<index>:<stepId>`), and `node_event` carries an optional `mapItem` ref alongside `loopStep`. Recovery mirrors `recovery.loopStates` via `recovery.mapStates` (the resolved item array plus per-item completions), and the executor emits `onCheckpoint({ kind: "map", ... })` at expansion time and after each item. Persisting those map checkpoints through the DB checkpoint store (currently typed to `WorkflowLoopRecoveryState`, and the job runner only forwards `kind: "loop"` checkpoints) is left as a follow-up; the executor honors `recovery.mapStates` today, which is what the recovery test exercises.

## Phase 2 — polish

- Multi-step items: allow `steps: [agent, agent]` with per-item sequential order (pipeline semantics — items do not wait for each other between steps).
- Per-item retry from the run detail (mirrors existing run retry).
- Authoring assets: dsl-reference section, patterns.md fan-out pattern upgraded to use `map`, one blueprint (e.g. discover-and-migrate), validator warnings for map-specific mistakes.
- Consider `map` over a static declared list (array literal in the script) as a degenerate case.

## Testing strategy

- Parser: syntax, reserved refs, session/step restrictions, cap validation.
- Executor with mock adapter: expansion, concurrency interleaving with sibling nodes, skip-vs-fail semantics, output shape, recovery mid-map.
- Behavioral fixture (see improvement backlog item 2): a scripted mock run that discovers 3 items, fails 1, and synthesizes — asserting the failed item appears in the map output and downstream prompt.

## Open questions

- Should the child agent receive the item as a labeled context block only (current proposal) or also as pre-bound individual inputs?
- Cap default: is 50 the right ceiling for `maxItems`, and should it be configurable per deployment?
- Should map children appear in `{{...}}` template space individually (e.g. `{{migrate_all.items.2.output}}`)? Deferred until a concrete need appears.
