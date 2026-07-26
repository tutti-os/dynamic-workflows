---
name: workflow-authoring
description: Create a standalone tutti.flow.v1 Bundle from a business request and existing Blueprint patterns.
---

# Persistent Flow authoring

Create a complete Flow Bundle in `draft.flow/`. A Bundle is an authoring
template output and must be standalone at runtime; it never inherits code from
a Blueprint.

Read `dsl-reference.md`, `patterns.md`, and `blueprint-guide.md` before writing.

## Working loop

1. Translate the request into one persistent Cycle: roots, waiting points,
   terminal outcomes, and the next Cycle.
2. Search Blueprints once by capability and inspect the closest complete
   Bundle with `blueprints get --include-script`.
3. Decide which work is deterministic (`script`), externally mutating
   (`effect`), externally observed (`gate`), intelligent (`agent`), or a
   product-native decision (`human`).
4. Write `draft.flow/flow.js` plus referenced files under `scripts/`. Add
   `memory.template.md` only when Memory is declared.
5. Validate without executing any Bundle code:

   `tutti --json dynamic-workflows authoring validate --job-id <job-id> --directory draft.flow --review-mode agent`

6. Repair every error, wait for the independent review, and address any
   findings:

   `tutti --json dynamic-workflows authoring review wait --job-id <job-id>`

7. Submit the reviewed Bundle as an immutable Draft:

   `tutti --json dynamic-workflows authoring submit --job-id <job-id> --directory draft.flow`

8. Delivery is complete only when the response contains `accepted: true` and
   `versionStatus: "draft"`. The user owns Publish and Activate; do not perform
   either action.

## Non-negotiable rules

- `flow.js` is declarative and has no imports or runtime execution.
- Script, Gate, Effect, and Finally code lives in Bundle files.
- Every Effect has a stable idempotency key and exports both `apply()` and
  `reconcile()`.
- Gates check once and return `waiting`; they never sleep or poll.
- Schedule resumes the Cycle from its checkpoint; it does not select a node.
- Cross-Cycle knowledge is only Markdown Memory. Completed Agent sessions are
  not hidden Memory.
- Loop and Map are bounded composite nodes inside one Cycle.
- Every control outcome closes honestly at `completeCycle` or `cancelCycle`.
- Secrets are declared, bound to provider connections or environment variable
  names, and injected only into Code nodes that explicitly list them with
  `secrets: ["NAME"]`. They are never interpolated into Agent prompts or
  accepted in node output.
- If `meta.requiresCwd` is true, the caller must configure a project cwd before
  activation.
- Prefer clear node ids and labels: the graph, current position, Attempts, and
  review history are user-facing product surfaces.
