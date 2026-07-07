# Workflow Blueprints

Workflow blueprints are checked-in workflow scripts plus catalog metadata. They are local-only seed workflows for cold start, and they are not fetched from a remote service.

## Built-In Contract

Each built-in blueprint must satisfy these rules:

- Add one script file under `src/lib/workflow/blueprints/<id>.workflow.js`.
- Add one metadata entry in `src/lib/workflow/builtin-blueprints.ts`.
- Use a lowercase kebab-case `id` that exactly matches the script filename.
- Keep `title`, `description`, `patternSummary`, `tags`, and `useCases` user-facing and specific.
- Keep `requiresCwd` aligned with `meta.requiresCwd` in the workflow script.
- Keep `title` aligned with `meta.name` in the workflow script.
- Do not expose `script` from list or search responses unless `includeScript` is explicitly requested.

Allowed categories and difficulties live in `src/lib/workflow/blueprint-contract.ts`.

## Add A Blueprint

1. Create a scaffold:

```bash
npm run blueprint:new -- <id> --title "Blueprint Title" --category coding --difficulty starter
```

Use `--requires-cwd` when the workflow script needs a project directory.

2. Fill in the generated script and add the printed metadata entry to `BUILTIN_WORKFLOW_BLUEPRINTS`.
3. Keep the script loaded with an explicit `new URL("./blueprints/<id>.workflow.js", import.meta.url)` reference so Next standalone tracing includes it.
4. Run:

```bash
npm run check:blueprints
```

For script grammar or runtime primitive changes, also run:

```bash
npx vitest run src/lib/workflow/parser.test.ts
```
