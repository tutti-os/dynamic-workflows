# Blueprint Guide

Blueprints are curated, validated workflow scripts that demonstrate proven graph and session patterns. Reuse a close blueprint as a structural reference; do not inherit its product assumptions blindly.

The library is intentionally small. Use one focused search and, if needed, one refined search. If neither returns a close pattern, draft directly from `dsl-reference.md` instead of repeatedly querying.

## Commands

```bash
tutti --json dynamic-workflows blueprints list
tutti --json dynamic-workflows blueprints search --query "acceptance loop" --category coding
tutti --json dynamic-workflows blueprints get --blueprint-id <id> --include-script
```

- `search` supports `--query`, `--category` (`coding|review|planning|research|ops`), `--tags` (comma-separated), `--requires-cwd`, and `--limit`.
- `get --include-script` returns the full workflow script.

## Selection

Choose by behavior, not vocabulary. Compare:

- graph shape and phase order;
- sequential, looped, or parallel work;
- role and information boundaries;
- inherited versus independent sessions;
- acceptance and termination behavior;
- first-iteration entry versus later-iteration order;
- runtime cwd needs and external side effects.

If these do not substantially match the request, start from the DSL rather than forcing the nearest blueprint.

A single-repository acceptance blueprint is not a close match for a staged cross-repository delivery merely because both use worker/reviewer loops. When repositories, editable authority, acceptance owners, or integration costs differ by phase, prefer checkpointed workflows or explicit phase contracts. Never let an upstream reviewer derive blockers from the full global requirement when those artifacts are owned by a downstream stage.

## Adaptation

1. Use the selected script as a skeleton, then rewrite `meta`, `inputs`, phases, node ids, labels, prompts, roles, and output contracts for the actual request.
2. Preserve only the structural mechanics that are relevant, such as loop bounds, first-iteration entry, cross-loop session continuity, `appendPrompt`, and `until` gating.
3. Rebuild dataflow deliberately. Do not pass one role's output to another merely because the blueprint did; preserve independent judgment where the request needs it.
4. Re-evaluate every side effect. A copied commit, push, publish, message, or deletion instruction must still be explicitly authorized by the new workflow.
5. Remove all placeholder and blueprint-specific wording, then validate the complete adapted script before submission.

For a Human-approved implementation followed by independent acceptance, search for `human rd acceptance session`. The `rd-human-acceptance-delivery-v1` pattern deliberately orders the acceptance steps as `[rd_fix, reviewer]` but starts the first iteration at `reviewer`. Reviewer failure therefore runs `rd_fix` and then re-review without repeating the Human gate. The initial RD and `rd_fix` share one session key; the reviewer uses another. When the acceptance criteria include visual or interactive behavior (UI appearance, animation, drag feel), prefer this human-gated variant so a person verifies them directly at the gate, or explicitly exempt visual verification in the requirement — an independent agent reviewer can only leave such criteria in the unverified list.

For the contrasting sessionless-reviewer shape, see `loop-primitive-rd-acceptance-test-v1`: the RD keeps one inherited session with `appendPrompt` deltas, while the reviewer runs each round as a fresh independent session emitting `output: "json"` (a verdict/criteria/blockers/suggestions contract). The loop exits on `until { source: "acceptance.verdict", equals: "PASS" }`, and cross-round injection is precise and dotted — the reviewer reuses its own `{{acceptance.criteria}}` and re-checks `{{acceptance.blockers}}` (empty on the first round), and the RD receives `{{acceptance.blockers}}` + `{{acceptance.suggestions}}` rather than the whole record. The round budget is run-configurable via a `max_rounds` number input (default 3). Choose it when the reviewer should re-judge from scratch every iteration.

When adapting an acceptance-delivery blueprint, preserve its exhausted-loop handoff: the terminal submit report uses structured `result: "not_accepted"` and includes a same-cwd continuation hint so the next run can build on the retained workspace instead of redoing accepted work.

Also preserve loop repairability: every blocking criterion must be changeable by the next worker in that loop. A downstream, read-only, repeated, or new-authority blocker ends the stage honestly; increasing the round budget is not a repair.

For loop-free multi-perspective review, search for `parallel review synthesis`. The `parallel-review-synthesis-v1` pattern fans one inventory out to lens reviewers that are blind to each other, then synthesizes with explicit coverage reporting; its shared optional `review_model` and `review_permission_mode` inputs demonstrate the fall-back-to-run-level runtime override mechanism (permission modes let read-only roles be enforced at the permission layer, not just requested in the prompt).

For dynamic-width fan-out over a runtime-discovered list, search for `map fan-out`. The `map-fan-out-demo-v1` pattern is the reference shape: `output: "json"` discovery bounded to the map's `maxItems`, one independent child per item told to stay within its item's scope, `onItemFailure: "skip"`, and a synthesizer that keeps the failed list visible.

For a codebase migration that fans out per call site and then judges the whole change, search for `repo migration sweep`. The `repo-migration-sweep-v1` pattern chains a `map` (per-item migrate→verify, failures isolated) into a bounded acceptance loop that enters first at the reviewer: the whole-change reviewer catches cross-file regressions the per-item verify cannot, running as a fresh independent session each round emitting `output: "json"` (verdict/criteria/blockers), with dotted self-references to its prior review (`{{reviewer.criteria}}`, `{{reviewer.blockers}}`) and the map record via loop inputs; the loop exits on `until { source: "reviewer.verdict", equals: "PASS" }` and its round budget is run-configurable via `max_rounds`. Its `fix` step is deliberately independent/sessionless — repair is driven entirely by current git state plus reviewer feedback, so a fresh context cannot drift on stale memory. Submit gates on the loop stop reason and lists rejected/failed sites honestly. Choose it over `map-fan-out-demo-v1` when per-item work needs a second, whole-artifact acceptance gate before delivery.

For a fact-checked, cited research report, search for `research fan-out report`. The `research-fanout-report-v1` pattern decomposes a topic into sub-questions (`output: "json"`), fans out a per-item research→fact-check pipeline where the fact-checker adversarially refutes claims and stamps a `Confidence` line, and synthesizes ordered by sub-question while keeping failed, low-confidence, and unverified items in a Coverage section. It runs without a cwd and degrades honestly when the runtime lacks web access (claims are tagged `unverified` rather than fabricated).

For gating a release on a fixed checklist, search for `release readiness check`. The `release-readiness-check-v1` pattern uses a STATIC inline-list `map` (five fixed dimensions) instead of a discovery node — each step returns a JSON `ready`/`blocked` verdict against the real repository — then a summary, a human go/no_go gate, and a side-effect-free `record` step that emits the decision, verbatim reason, and outstanding blockers as a machine-readable JSON audit record (`output: "json"`) — an upstream agent caller reads the outcome from the run's report without parsing prose. Choose the static-list map whenever the fan-out items are a known checklist rather than a runtime-discovered list.

For turning an epic into an approved, detailed plan, search for `epic breakdown plan`. The `epic-breakdown-plan-v1` pattern shows the loop→map bridge: a `map` cannot source a loop record, so a loop (decompose with an inherited planner session + `appendPrompt` revisions, gated by a human approve/revise) is followed by an `extract` step (`output: "json"`) that re-emits the approved task array verbatim, which then feeds a `map` that details each task. Reuse the `extract` bridge whenever a human-approved list produced inside a loop must fan out.
