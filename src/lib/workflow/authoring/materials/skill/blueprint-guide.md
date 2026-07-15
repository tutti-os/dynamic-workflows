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
- runtime cwd needs and external side effects.

If these do not substantially match the request, start from the DSL rather than forcing the nearest blueprint.

## Adaptation

1. Use the selected script as a skeleton, then rewrite `meta`, `inputs`, phases, node ids, labels, prompts, roles, and output contracts for the actual request.
2. Preserve only the structural mechanics that are relevant, such as loop bounds, session inheritance, `appendPrompt`, and `until` gating.
3. Rebuild dataflow deliberately. Do not pass one role's output to another merely because the blueprint did; preserve independent judgment where the request needs it.
4. Re-evaluate every side effect. A copied commit, push, publish, message, or deletion instruction must still be explicitly authorized by the new workflow.
5. Remove all placeholder and blueprint-specific wording, then validate the complete adapted script before submission.
