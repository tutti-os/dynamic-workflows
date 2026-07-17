# Browser Acceptance Playbook

The pre-push acceptance gate for changes that touch the run UI or runtime behavior. Every round of this playbook so far has caught a real bug that unit tests missed (UI miscounting step records as items; recovery attaching downstream nodes to stale agent sessions), because the bugs lived in seams no single-layer test crosses: executor ↔ persistence ↔ streaming ↔ UI.

## Roles and rules

- The implementing session does not accept its own work. Acceptance runs in a separate agent session (historically Codex via `tutti agent start/send`), driving the real app in a browser.
- The acceptance agent verifies only: it must not modify code. Preparing scenario scaffolding outside the repo (flag files in /tmp, imported test workflows) is allowed and expected.
- Steering a run mid-acceptance must go through an Operator Note (`runs note`, or the run detail "Add note" affordance), never a raw `tutti agent send` to the underlying session — an unrecorded steer poisons the run record the acceptance is judging.
- FAIL verdicts must be honest and specific: location, symptom, screenshot, blocking-vs-suggestion. A run that "mostly works" with one blocking defect is a FAIL.
- Fixes return to the SAME acceptance session (`tutti agent send`) for a focused re-verification of only the failed points; completed runs stay in the DB, so re-verification can often reuse persisted runs instead of spending new agent executions.

## Environment

- Start the app with `TUTTI_CLI=/Users/liying/.tutti/bin/tutti npm run dev` — without the override the app can fall back to a stale `tutti-dev` binary that cannot reach the daemon, and `local:codex` runs fail.
- Known dev quirks: better-sqlite3 native module may need a rebuild for the Node running Next (dual-ABI), and turbopack occasionally misses static assets. Neither has fired recently; rebuild deps only when startup actually fails.
- Stop the dev server and free port 3000 when done; clean up any /tmp scaffolding.

## Fixtures

- **Builtin blueprints are the acceptance fixtures.** `map-fan-out-demo-v1` exercises `output: "json"` discovery, dynamic fan-out, the per-item process→verify pipeline, and failure-visible synthesis. Always instantiate a FRESH workflow from the blueprint — blueprint scripts change between batches and an old workflow pins the old script.
- **Inline scripts via the import API** (`POST /api/workflows/import`) cover shapes no blueprint has, e.g. static-list map sources.
- **Deterministic per-item failure**: give an item a behavior instruction gated on a flag file, combined with a step-level `output: "json"` contract — "if /tmp/<flag> does not exist, output no JSON at all" makes extraction fail exactly once; `touch` the flag before retry to make the re-run succeed. This turns "fail → retry → recover" into a reproducible loop instead of a coin flip.
- **Mock runs** (`agent=mock`) are free and echo the prompt: right for empty/expansion states and pure-UI checks (the echo of a prompt containing `[]` parses as an empty list). Real behavior needs one real run — keep it cheap by bounding the discovery focus (e.g. "the .mjs files under scripts/, one sentence each").

## What every acceptance must include

1. **One real end-to-end run** with `agent=local:codex` — pure-UI inspection cannot catch runtime bugs, and both serious bugs so far were runtime-side.
2. **The persistence trio, every time**: run reaches a terminal status; `finishedAt`/`result` are actually persisted; the run detail API returns 200 after termination. Both historical bugs broke exactly this seam while the live-streaming view looked perfect.
3. **Both views**: the live streaming state during the run AND the reloaded post-terminal state. Bugs hide in the difference.
4. **Empty/zero states** for any new list-shaped UI (a map that expands to zero items must render, not break).
5. **Screenshots** with sequential numbers in a /tmp working dir, absolute paths listed in the report.

## Report contract

- Verdict first: PASS or FAIL (any blocking point unmet → FAIL).
- Per-acceptance-point results, in the order the task listed them.
- Problems: location (file:line where known), symptom, severity (blocking/suggestion), screenshot path.
- Environment notes (how the server was started, quirks hit) and an explicit statement that no code was modified.

## For the implementing session

- Write acceptance points as observable behaviors ("badge shows 5/8", "detail API returns 200"), not implementation claims.
- When a FAIL comes back: reproduce the finding in a test FIRST (the fix's regression test should fail without the fix — red-check it), then fix, then send the focused re-verification.
- Test-fidelity lesson: keep behavioral-test mocks faithful to real adapter event streams (session_ref, error/canceled done states). The stale-attach bug was invisible to tests precisely because the mock never emitted `session_ref`.
