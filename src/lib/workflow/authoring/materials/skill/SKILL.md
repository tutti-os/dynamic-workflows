---
name: workflow-authoring
description: Author or edit Dynamic Workflows scripts for an authoring job. Use when creating a workflow from a request, editing an existing workflow script, or repairing a script that fails validation.
---

# Workflow Authoring

Create a valid Dynamic Workflows script and deliver it through the authoring submit command. The task prompt supplies the job id, mode, user request, and target draft file.

## Required references

- Read `dsl-reference.md` completely before writing or editing a script. It is the authoritative DSL contract.
- Use `blueprint-guide.md` when searching for and adapting reusable workflow patterns.

## Command palette

All commands support `--json` for machine-readable output.

| Purpose | Command |
| --- | --- |
| Search blueprints | `tutti --json dynamic-workflows blueprints search --query "<keywords>"` |
| List all blueprints | `tutti --json dynamic-workflows blueprints list` |
| Read one blueprint script | `tutti --json dynamic-workflows blueprints get --blueprint-id <id> --include-script` |
| Validate an authoring file | `tutti --json dynamic-workflows authoring validate --job-id <job-id> --file <path>` |
| List saved workflows | `tutti --json dynamic-workflows list` |
| Inspect a saved workflow | `tutti --json dynamic-workflows show --workflow-id <id> --include-script` |
| Submit the finished script | `tutti --json dynamic-workflows authoring submit --job-id <job-id> --file <path>` |

## Working loop

1. Read the task prompt and `dsl-reference.md`. Identify the job id, create-or-edit mode, requested behavior, target file, runtime cwd needs, role boundaries, side effects, and completion condition.
2. For edit jobs, read the complete `current.workflow.js` before deciding what to change. Preserve behavior outside the edit instruction.
3. Resolve small gaps with conservative, reversible assumptions. Ask the user only when a missing choice would materially alter scope, authority, graph structure, or acceptance behavior and local context cannot answer it.
4. Search the blueprint library with one focused query. If a close pattern exists, fetch its script and adapt it. Try at most one refined query before drafting directly from `dsl-reference.md`.
5. Write one complete, coherent script to the target file. Do not deliver a plan, partial snippet, or chat-only script.
6. Validate the file. Read every diagnostic, fix the underlying issue, and validate again until no error diagnostics remain.
7. Submit using the exact job id and target file. If `accepted: false`, repair the returned diagnostics and resubmit until `accepted: true`.
8. On follow-up requests, revise the last accepted script and repeat validation and submission with the same job id.

## Quality checklist

Before submitting, verify:

- Every runtime value is declared in `inputs` or comes from a valid upstream reference.
- Every node has a clear role, sufficient context, explicit authority, concrete work, and an observable completion/output contract.
- Dataflow is intentional: independent roles do not receive another role's narrative unless the workflow explicitly requires it.
- Loops are bounded, inherited sessions use `appendPrompt`, and `until.finalStatus` matches the reviewer output contract exactly.
- External side effects have explicit authorization and honest failure behavior.
- The script is concise, UI-readable, and free of leftover blueprint wording.
