# Flow v1 goal-preservation contract

Flow v1 is a runtime and storage breaking change. It is not permission to
remove useful product goals.

The cutover follows this rule:

- remove the legacy single-script parser, executor, run tables, and APIs;
- preserve user scenarios, authoring patterns, auditability, and recovery
  behavior by expressing them through Flow v1 Bundles and projections;
- replace hidden cross-Run Agent session state with explicit node outputs,
  Loop history, project state, or Markdown Memory;
- keep historical data visible as Cycles, Ticks, Node Attempts, Human
  decisions, Effect records, and Memory revisions.

## Preserved Blueprint goals

| Goal | Flow v1 shape |
| --- | --- |
| Human Feedback Loop | bounded Loop with Agent and durable Human step |
| RD Acceptance Delivery | isolated implementation/reviewer Loop plus commit, push, and PR Effects |
| RD Human-Gated Acceptance | Human alignment Loop, reviewer Loop, then isolated Git delivery |
| Parallel Review Synthesis | graph-level parallel Agents and fan-in |
| Dynamic Fan-Out | discovery Agent, Map pipeline, failure-visible synthesis |
| Repo Migration Sweep | discovery, isolated write Map, whole-change Loop, and Git delivery Effects |
| Research Fan-Out | planning, Map research/fact-check, cited synthesis |
| Release Readiness | static-list Map, summary, Human go/no-go, audit record |
| Epic Breakdown | Human approval Loop, extraction, Map, ordered plan |
| Large File Governance | Schedule, Script, Effect, Gate, Memory, continuation |

Every catalog entry is an immutable, standalone `tutti.flow.v1` Bundle. Tests
pin the catalog ids, validate every Bundle, assert each scenario's node shape,
and instantiate every Blueprint through the same service used by UI and CLI.

## Interaction preservation

The Flow detail UI keeps the original user outcomes on the new records:

- automatic refresh while a Tick or Cycle is running;
- current node, waiting reason, Cycle count, and Tick count;
- retry, resume, cancel, and Human response actions;
- historical Cycle selection;
- inspectable Node Attempt input, output, error, duration, control outcome,
  and Agent session reference;
- Human decision history, Effect ledger, and Markdown Memory.

Old route names and response shapes are intentionally not compatibility
contracts. The behavior above is.

## Deliberate semantic changes

- A completed Agent session is not hidden Memory for a later Tick.
- A later Loop iteration receives `previousIteration` and `history`
  explicitly.
- Waiting does not sleep or poll in-process.
- External writes must be idempotent Effects, not ordinary Agent prose.
- A Cycle is the persistent business journey; a Tick is one attempt to advance
  it to the next quiescent point.
