# Dynamic Workflows CLI

This app supports only standalone `tutti.flow.v1` Bundles. A Flow owns durable Cycles; each dispatch or Schedule fire creates one bounded Tick.

## Core commands

- `tutti --json dynamic-workflows list` — list Flows and runtime state.
- `tutti --json dynamic-workflows show --workflow-id <id> --include-script` — inspect graph, configuration, history, and Bundle.
- `tutti --json dynamic-workflows validate --directory ./my.flow` — static validation only.
- `tutti --json dynamic-workflows import --directory ./my.flow --activate` — create a Flow from a Bundle.
- `tutti --json dynamic-workflows run --workflow-id <id> --inputs '{}'` — start or resume one Cycle Tick.
- `tutti --json dynamic-workflows runs wait --run-id <tick-id>` — wait for a durable stop point.

## Authoring

The Agent writes `draft.flow/`, searches Blueprints as templates, validates without executing modules, obtains an independent semantic review, and submits the exact reviewed Bundle.

1. `tutti --json dynamic-workflows create --prompt '<business scenario>' --agent <agent-id>`
2. `tutti --json dynamic-workflows authoring validate --job-id <job-id> --directory draft.flow --review-mode agent`
3. `tutti --json dynamic-workflows authoring review wait --job-id <job-id>`
4. `tutti --json dynamic-workflows authoring submit --job-id <job-id> --directory draft.flow`

## Runtime rules

- Script and Gate nodes must be deterministic checks; external mutations belong in Effect nodes with idempotency keys and reconcile handlers.
- Recurring schedules re-check waiting Gates without Agent token use.
- Params are revisioned configuration; Inputs are immutable per Cycle; Secrets store only environment variable bindings.
- Human responses and failed-node retries create new Ticks in the same Cycle.
- `runs get` exposes Checkpoint, Attempts, Effect ledger, and pending Human tasks for audit.
- Blueprints are copied authoring templates, never runtime dependencies.

## Command index

- `status` — Show runtime status.
- `agents` — List agent targets.
- `list` — List Flows.
- `show` — Show one Flow.
- `validate` — Validate a Flow Bundle.
- `create` — Launch Flow authoring.
- `import` — Import a Flow Bundle.
- `run` — Dispatch a Flow Tick.
- `configure` — Configure a Flow.
- `activate` — Activate a Flow.
- `pause` — Pause a Flow.
- `cancel-cycle` — Cancel a Cycle.
- `runs get` — Inspect a Tick.
- `runs wait` — Wait for a Tick stop point.
- `runs respond` — Respond to a Human node.
- `blueprints list` — List Blueprints.
- `blueprints search` — Search Blueprints.
- `blueprints get` — Get a Blueprint.
- `blueprints instantiate` — Instantiate a Blueprint.
- `authoring validate` — Validate an authored Bundle.
- `authoring review get` — Get semantic review.
- `authoring review wait` — Wait for semantic review.
- `authoring submit` — Submit an authored Bundle.
- `resume` — Resume a waiting Flow.
