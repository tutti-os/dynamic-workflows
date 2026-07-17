---
name: workflow-authoring
description: Author or edit Dynamic Workflows scripts for an authoring job. Use when creating a workflow from a request, editing an existing workflow script, or repairing a script that fails validation.
---

# Workflow Authoring

Create a valid Dynamic Workflows script and deliver it through the authoring submit command. The task prompt supplies the job id, mode, user request, and target draft file.

## Required references

- Read `dsl-reference.md` completely before writing or editing a script. It is the authoritative DSL contract.
- Read `patterns.md` before designing the graph. It explains the execution model and the reusable structural patterns (fan-out, adversarial verify, acceptance loops, scaling).
- Use `blueprint-guide.md` when searching for and adapting reusable workflow patterns.

## Command palette

All commands support `--json` for machine-readable output.

| Purpose | Command |
| --- | --- |
| Search blueprints | `tutti --json dynamic-workflows blueprints search --query "<keywords>"` |
| Inspect agent models and permissions | `tutti agent composer-options --agent-id <agent-id> --json` |
| List all blueprints | `tutti --json dynamic-workflows blueprints list` |
| Read one blueprint script | `tutti --json dynamic-workflows blueprints get --blueprint-id <id> --include-script` |
| Validate an authoring file | `tutti --json dynamic-workflows authoring validate --job-id <job-id> --file <path>` |
| List saved workflows | `tutti --json dynamic-workflows list` |
| Inspect a saved workflow | `tutti --json dynamic-workflows show --workflow-id <id> --include-script` |
| Submit the finished script | `tutti --json dynamic-workflows authoring submit --job-id <job-id> --file <path>` |

## Working loop

1. Read the task prompt and `dsl-reference.md`. Identify the job id, create-or-edit mode, requested behavior, target file, runtime cwd needs, role boundaries, first-versus-later loop behavior, conversation continuity, side effects, and completion condition.
2. For edit jobs, read the complete `current.workflow.js` before deciding what to change. Preserve behavior outside the edit instruction.
3. Resolve small gaps with conservative, reversible assumptions. Ask the user only when a missing choice would materially alter scope, authority, graph structure, or acceptance behavior and local context cannot answer it.
4. Design the graph before writing prompts: phases, roles, which branches are independent (they run concurrently), loop entry and later-iteration order, acceptance contract, and human gates. Choose structures from `patterns.md` and scale them to the request — a quick check gets the simplest linear graph, a thorough audit gets diverse review fan-out with adversarial gating.
5. Search the blueprint library with one focused query. If a close pattern exists, fetch its script and adapt it. Try at most one refined query before drafting directly from `dsl-reference.md`.
6. Write one complete, coherent script to the target file. Do not deliver a plan, partial snippet, or chat-only script.
7. Validate the file. Read every diagnostic, fix the underlying issue, and validate again until no error diagnostics remain. Warnings are review prompts — fix them unless the flagged pattern is deliberate, and never suppress a warning by weakening the workflow.
8. Submit using the exact job id and target file. If `accepted: false`, repair the returned diagnostics and resubmit until `accepted: true`.
9. On follow-up requests, revise the last accepted script and repeat validation and submission with the same job id.

## Quality checklist

Before submitting, verify:

- Every runtime value is declared in `inputs` or comes from a valid upstream reference.
- Every explicit `permissionMode` uses an exact `permissionConfig.modes[].id` returned by `tutti agent composer-options` for the selected agent; omit it when the agent default is intended.
- Every node has a clear role, sufficient context, explicit authority, concrete work, and an observable completion/output contract. Prompts demand the deliverable itself — downstream nodes and `until` matchers consume the final message as data, not as chat.
- Dataflow is intentional: independent roles do not receive another role's narrative unless the workflow explicitly requires it, and no node lists an input its prompt never uses (false dependencies serialize parallel branches).
- Reviewers that gate a loop or delivery are skeptics: prompted to refute, failing when uncertain, judging the actual artifact rather than a prior Human approval or an implementer's self-assessment.
- Any step that bounds its coverage (top-N, sampling, skip-on-error) reports what it excluded.
- Structure is scaled to the request: no review panel for a quick check, no single rubber-stamp reviewer for a thorough audit.
- Human actions have unambiguous effects; revise feedback is required when the next iteration depends on it, and approval resumes the intended branch only.
- Loop order matches the intended first evaluation and later repair cycles. `firstIteration.startAt`, `maxIterations`, `until`, and `onMaxIterations` agree with that behavior.
- Conversation identity is intentional: the same continuing role reuses one inherited session key across step or loop boundaries, different roles use different keys, and every inherited loop step has a continuation-safe `appendPrompt`.
- Long-running roles carry drift guards: iterating implementers get delegation discipline and per-iteration re-anchoring on actual state; gating reviewers get an independent session with any needed history passed through dataflow.
- Prompt sections are ordered by stability — identity and rules first, labeled per-run context blocks last — and delivery roles include a persistence line so they do not end the turn on a plan.
- `until.finalStatus` matches the reviewer output contract exactly, with the same token spelled out in the reviewer prompt; a Human-decided gate uses the structured matcher instead of text parsing.
- External side effects have explicit authorization and honest failure behavior.
- The script is concise, UI-readable, and free of leftover blueprint wording.
