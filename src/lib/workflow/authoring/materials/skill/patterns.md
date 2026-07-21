# Workflow Design Patterns

Patterns are structural choices, not templates. Pick by what the task needs and compose freely; the blueprint library shows full worked examples, this file explains the mechanics to reuse.

Execution model that makes them work: the scheduler is dataflow-driven. A node runs as soon as every node referenced in its `inputs` (and any session predecessor) has completed, and independent ready nodes run concurrently. Dependencies exist only where you declare them — the graph you wire is the parallelism you get.

## Outputs are data, not narrative

An agent's final message IS the node's output: downstream prompts receive it verbatim through `{{node_id}}`, and `until` matchers test it directly. Nobody reads it as chat.

- Prompt for the deliverable itself (the list, the diff summary, the verdict), not a report about producing it.
- When a loop matches a verdict, pin the contract: one exact token alone on the final non-empty line, stated in the prompt with the same spelling `until.finalStatus` expects.
- When a human node supplies the decision, prefer the structured matcher (`{ source: "gate.action", equals: "pass" }`) over parsing text.
- When an agent supplies a verdict or a machine-readable list, prefer `output: "json"` plus a structured matcher (`{ source: "review.verdict", equals: "pass" }`) over `until.finalStatus` token-matching: the agent ends its message with only the JSON block, the executor stores the parsed value, and downstream reads fields by dotted path.
- Terminal delivery records are load-bearing outputs too — when the final node reports facts (PR links, branches, statuses, verdicts, unverified lists), give it an `output: "json"` contract so a malformed or truncated final message fails that node (recoverable via retry-from-node) instead of completing the run green with a junk record. Prose deliverables meant for human readers (research reports, review syntheses, plans) stay prose — wrapping long-form writing in JSON degrades it for no enforcement gain.

## Node prompt anatomy

Order prompt sections by stability — durable identity and rules first, per-run variable context last:

1. **Identity** — one opening line: the role, its mission, and what the deliverable is.
2. **Instructions** — numbered rules: authority, required actions, side-effect gates, failure honesty.
3. **Output contract** — the exact sections to emit and any matched verdict token.
4. **Context** — every injected `{{...}}` value in its own labeled block at the end.

Two more rules from hard experience:

- Delivery roles need a persistence line ("complete the implementation and verification within this turn; do not end on a plan or an open question list") — without it, agents yield control after analysis.
- Prompts run on whatever agent target the run selects. State the contract precisely — role, constraints, output — but do not script internal steps a capable runtime should decide itself, and phrase runtime-specific abilities conditionally ("if your runtime supports subagents, …").

## Fan-out / fan-in

Independent perspectives are separate agent nodes with no edges between them; a downstream synthesizer takes all of them via `inputs`.

```js
const security = agent({ id: "security", label: "Security review", prompt: "Review the change in {{workflow.cwd}} for security issues only. Output the issue list, nothing else." });
const correctness = agent({ id: "correctness", label: "Correctness review", prompt: "Review the change in {{workflow.cwd}} for correctness bugs only. Output the bug list, nothing else." });
agent({
  id: "verdict",
  label: "Synthesize verdict",
  inputs: { security, correctness },
  prompt: "Merge and dedupe these findings.\nSecurity:\n{{security}}\nCorrectness:\n{{correctness}}",
});
```

- Do not pass a node an output its prompt never uses: a false dependency serializes branches that could run concurrently and leaks one role's narrative into another that should judge independently.
- Fan-in is the only place cross-branch context belongs.
- The examples above are static fan-out: the branches are known at authoring time. When the width is only known at run time (process each of N discovered items), use `map` — an upstream node emits a JSON array, and `map({ source, maxItems, step: agent({...}) })` runs the step per item, fanning the `{ items, failed, total }` record into a downstream synthesizer.
- Per-item quality gate: give a map `steps: [migrate, verify]` instead of one step to run a pipeline per item — `migrate` produces the deliverable, then `verify` (a second step reading `{{migrate}}`) adversarially checks that one item's output. There is no batch barrier: each item advances through its own steps independently, so a slow item never holds up the others, and a failing step fails only its item (attributed by `step` in `failed`). This is fan-out's answer to the adversarial-verify pattern below, applied item by item. Keep verify sessionless so it judges the artifact, not the migrator's narrative.
- Choose a static list source (`source: [{ env: "dev" }, { env: "staging" }, { env: "prod" }]`) when the items are a fixed checklist known at authoring time — per-environment deploy checks, fixed audit dimensions. You get map's per-item badges and failure isolation without a discovery node or hand-writing N parallel nodes; `maxItems` is optional and defaults to the list length. Use a node source only when the width is genuinely discovered at run time.

## Adversarial verify

A reviewer asked "is this good?" tends to agree. Prompt the reviewer to REFUTE — find a concrete reason the work fails — and to fail when uncertain. This kills plausible-but-wrong acceptance.

- The independent reviewer inspects the actual artifact (repository state, produced file), never the implementer's self-assessment; a prior Human approval is not acceptance evidence either.
- Pair with a machine-checkable verdict contract (see above) so the loop gate cannot be satisfied by success-shaped prose.

## Semantic closure review

DSL validation proves that a script can execute; it does not prove that the graph can satisfy the user's goal. The authoring pipeline can review the validated script once in a fresh independent agent context. A small, clearly local edit may use the explicit review-waiver path when the main author judges that review adds little value; the system does not classify changes automatically.

First make two compact authoring records:

- **Goal trace:** each user-visible goal → artifact → owner node → reviewer → terminal result.
- **Phase contract:** editable scope, produced artifact, blocking criteria, downstream exclusions, and failure result for each phase.

A phase gate may block only on work produced before that gate and changeable by its preceding repair role. A loop is valid only when every possible `CONTINUE` blocker can be changed in the next iteration. If a blocker belongs to a downstream phase, read-only scope, missing authority, or unchanged external state, exit honestly instead of retrying. Do not increase `maxIterations` to compensate for a blocker the loop cannot repair.

The built-in reviewer receives the visible authoring conversation through the latest user message, the current script, and the DSL execution semantics. Its contract is concise:

```text
Review graph semantics against the user's goal. Do not edit, execute, repair, submit, or ask questions. Check end-to-end closure, gate locality, loop repairability, dependency order, truthful termination/status, session boundaries, and side-effect timing. For every failure, give one concrete node path proving it. Pass only if all checks close; uncertainty fails.

Return only JSON:
{"verdict":"pass|fail","summary":"...","findings":[{"reason":"...","nodePath":["node ids in order"],"suggestion":"..."}]}
```

The reviewer stops after this single result. It does not repair, re-run, or start a review loop. The main author decides whether to revise the workflow, ask the user, review a new candidate, submit a PASS, or explicitly waive review with a reason.

## Perspective-diverse review

When work can fail in more than one way, run parallel reviewers with distinct lenses (correctness, security, regressions, requirements coverage) instead of one generalist or N identical copies — diversity catches failure modes redundancy cannot. Fan the verdicts into a synthesizer or a Human gate.

## Judge panel

For wide solution spaces (design, naming, architecture), fan out N independent attempts from different angles, then a judge node scores them and synthesizes from the winner. Expensive — reserve it for requests that ask for exploration or comparison.

## Acceptance loop

The core delivery shape: `[worker, reviewer]` with `until` on the reviewer and a bounded `maxIterations`.

- Evaluate-first variant: order steps `[fix, reviewer]` and set `firstIteration.startAt: "reviewer"` so the existing state is judged before any repair runs.
- Keep `onMaxIterations: "fail"` unless downstream steps can genuinely run on unaccepted work.
- A continuing role keeps one inherited session key across iterations and sends only the delta via `appendPrompt`; repeating the full initial prompt each round wastes context and confuses the session.
- Freeze the phase criteria after the first review. Later rounds may add only regressions caused by the repair; downstream requirements and new optional concerns become risks or suggestions, not new loop blockers.
- Normalize repeated blockers. If the same blocker appears twice while the responsible scope is unchanged, stop with an orchestration/external blocker instead of spending the remaining iteration budget.

## Long-running roles

An inherited session accumulates every iteration's exploration dumps, check logs, and summaries. By late iterations most of that context is stale, and the role drifts: it edits from memory of old file contents, repeats abandoned approaches, and buries its own decisions. Counter drift in this order — the steps compose:

1. **Delegation discipline** (in the role prompt): if the runtime supports subagents or background tasks, delegate bulk conclusion-shaped work — exploration returns "file:line + key finding", check runs return "pass/fail + minimal failure excerpt" — and never keep whole files or full logs in the main conversation. Phrase it conditionally; agent targets vary. Without subagents, focused searches and excerpt reads approximate the same effect.
2. **Re-anchoring** (in `appendPrompt`): every iteration starts from actual state — `git status`, `git diff`, targeted re-reads of files about to change — and when session memory conflicts with the repository, the repository wins.
3. **Stateless variant**: when the durable state lives outside the session (the repository, upstream outputs), switch the step to `session: { mode: "independent" }` and pass what it needs through dataflow — a loop step may reference its own id to receive its previous-iteration output (empty on the first round). A fresh context cannot drift. Reviewer roles are the natural candidates: they are supposed to re-judge from scratch anyway, and an inherited reviewer that has failed several rounds tends to anchor on its old verdict or fatigue into PASS.

Implementer roles usually keep the inherited session (their decisions and tradeoffs are genuine cross-iteration state) plus disciplines 1–2; reviewer roles prefer discipline 3.

## Completeness critic

Before delivery, add one agent that asks only "what is missing — requirement not covered, file not checked, claim not verified?" and route its findings into a Human gate or the acceptance loop. Cheap insurance on thorough-audit requests.

## No silent caps

If any step bounds its coverage (top-N items, sampling, skip-on-error), its prompt must require reporting what was excluded. Silent truncation reads downstream as full coverage and corrupts every later judgment.

## Scale to the request

Match structure to stakes; more graph is not more quality.

- "Quick check", "draft", "summarize" → the simplest linear graph, at most one reviewer.
- "Deliver until accepted" → one acceptance loop.
- "Thorough audit", "be comprehensive", "production-critical" → perspective-diverse fan-out, adversarial gating, a synthesizer, possibly a completeness critic.

Do not interpret end-to-end ownership as one monolithic graph. Split a delivery into checkpointed workflows when phases have different editable repositories, side-effect authority, acceptance owners, or expensive integration evidence. Pass stable commits, fingerprints, and compact gate records between runs. If a failed gate would cause several downstream agents to launch only to return `SKIPPED`, split the workflow or use a native conditional primitive when available instead of simulating branching in prompts.

When unsure, lean thorough for review/audit/research requests and lean minimal for everything else.
