# Flow Blueprints

Blueprints are checked-in, immutable `tutti.flow.v1` Bundles. They are
authoring templates, never runtime dependencies: instantiation copies the
complete Bundle into a new Flow Version.

## Built-in contract

Each built-in Blueprint must:

- use a stable lowercase kebab-case id;
- provide specific catalog metadata and capabilities;
- include a complete Bundle with `flow.js` and every referenced module;
- parse without diagnostics;
- align catalog title and `requiresCwd` with Bundle metadata;
- expose Bundle files only when callers explicitly request them;
- preserve a useful execution shape rather than merely matching keywords.
- distinguish technical status from business `outcome`;
- declare shared/read/write/review execution and isolation requirements;
- give every Effect one independently reconcilable external intent;
- cover happy, rejected, exhausted, and recovery paths with behavior tests.

The catalog includes the pre-Flow-v1 product goals plus the persistent
large-file governance reference. See
[`goal-preservation.md`](./goal-preservation.md) for the compatibility
contract.

## Adding a Blueprint

1. Add a `WorkflowBlueprintDetail` to
   `src/lib/workflow/builtin-flow-blueprints.ts` or a focused catalog module.
2. Build its Bundle with `createFlowV1Bundle`.
3. Keep pure projection in Transform, deterministic local work in Script,
   observation in Gate, and external mutation in Effect.
4. End every reachable control branch at a terminal with an explicit business
   outcome.
5. Run:

```bash
npm run check:blueprints
npm run check:quick
```

Agent authors should search the catalog by execution shape, copy the complete
Bundle, adapt it to the business request, validate it, and submit it as a new
standalone Version.
