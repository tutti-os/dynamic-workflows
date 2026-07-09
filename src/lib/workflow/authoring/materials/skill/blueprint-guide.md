# Blueprint Guide

Blueprints are curated, validated workflow scripts that demonstrate proven patterns (bounded loops, inherited sessions, acceptance gates, multi-role delivery). Prefer adapting a blueprint over drafting a structure from scratch when one matches the request.

The library is currently small, so an empty search result is normal. If one or two searches find nothing close, draft from scratch following `dsl-reference.md` instead of retrying more queries.

## Commands

```bash
tutti --json dynamic-workflows blueprints list
tutti --json dynamic-workflows blueprints search --query "acceptance loop" --category coding
tutti --json dynamic-workflows blueprints get --blueprint-id <id> --include-script
```

- `search` supports `--query`, `--category` (`coding|review|planning|research|ops`), `--tags` (comma-separated), `--requires-cwd`, and `--limit`.
- `get --include-script` returns the full workflow script.

## How to adapt a blueprint

1. Search with keywords from the user's request; read `patternSummary` and `useCases` to pick the closest match.
2. Fetch the script and use it as your draft's skeleton.
3. Rewrite for the actual request: node ids, labels, prompts, `meta.name`, `meta.description`, and the `inputs` schema all belong to the new workflow — never leave blueprint placeholder wording behind.
4. Keep the structural pattern that made the blueprint work (loop bounds, session inheritance, `until` gating) unless the request calls for something different.
5. Validate the adapted script before submitting; blueprints are valid at the source, but your edits can break parsing.
