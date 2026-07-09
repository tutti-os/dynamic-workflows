---
name: workflow-authoring
description: Author or edit Dynamic Workflows scripts for an authoring job. Use when creating a new workflow from a request, editing an existing workflow script, or repairing a script that fails validation.
---

# Workflow Authoring

Author a Dynamic Workflows script and deliver it through the authoring submit command. The job id and task come from your task prompt.

## Files

- `dsl-reference.md` — the authoritative workflow script DSL contract. Read it before writing any script.
- `blueprint-guide.md` — how to search the blueprint library and adapt a blueprint script.

## Command palette

All commands support `--json` for machine-readable output.

| Purpose | Command |
| --- | --- |
| Search blueprints | `tutti --json dynamic-workflows blueprints search --query "<keywords>"` |
| List all blueprints | `tutti --json dynamic-workflows blueprints list` |
| Read one blueprint script | `tutti --json dynamic-workflows blueprints get --blueprint-id <id> --include-script` |
| Validate a draft script | `tutti --json dynamic-workflows validate --script "$(cat draft.workflow.js)"` |
| List saved workflows | `tutti --json dynamic-workflows list` |
| Inspect a saved workflow | `tutti --json dynamic-workflows show --workflow-id <id> --include-script` |
| Submit the finished script | `tutti --json dynamic-workflows authoring submit --job-id <job-id> --file <path>` |

## Working loop

1. Read the task prompt: job id, create-or-edit, and the user's request.
2. If the request is ambiguous, ask the user and wait for their reply before drafting.
3. For edit jobs, read `current.workflow.js` in the workspace root — that is the script you are editing.
4. Search blueprints for a similar pattern; adapt the closest match instead of drafting from scratch when one fits. The library is small — if nothing matches after a search or two, draft from scratch per `dsl-reference.md`.
5. Draft the script into a file, following `dsl-reference.md`.
6. Validate, fix diagnostics, and repeat until clean.
7. Submit with the job id. If `accepted: false`, fix the reported diagnostics and submit again until `accepted: true`.
8. Stay available: each accepted submit saves a new version, so when the user requests changes, revise and submit again with the same job id.
