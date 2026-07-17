# Workflow Script DSL — Canonical References

The authoritative, always-current contract for the workflow script DSL lives in the authoring skill materials, NOT in this file. Those files are materialized into every authoring workspace and are pinned by tests, so they are maintained as part of every DSL change; this page previously duplicated parts of them and drifted twice.

Read, in order:

- [`src/lib/workflow/authoring/materials/skill/dsl-reference.md`](../src/lib/workflow/authoring/materials/skill/dsl-reference.md) — the full language contract: `meta`, `inputs`, `phase`, `log`, agent nodes (`output: "json"`, runtime `agent`/`model` option templates and their run-level fallback, `{{workflow.cwd}}`/`requiresCwd` coupling), sessions and `appendPrompt`, human tasks, `loop` (including `firstIteration`, dotted-source `until`, step self-references), and `map` (dynamic and static-list sources, per-item `steps` pipelines, failure records).
- [`src/lib/workflow/authoring/materials/skill/patterns.md`](../src/lib/workflow/authoring/materials/skill/patterns.md) — the design disciplines: execution model, prompt anatomy, outputs-as-data, fan-out/fan-in, adversarial verify, acceptance loops, long-running-role drift guards, no-silent-caps.
- [`src/lib/workflow/authoring/materials/skill/blueprint-guide.md`](../src/lib/workflow/authoring/materials/skill/blueprint-guide.md) — behavior-keyed guidance for choosing and adapting the builtin blueprints, including composed shapes like the loop→map extract bridge.

Related docs in this directory:

- [`workflow-blueprints.md`](./workflow-blueprints.md) — the builtin blueprint contract and how to add one.
- [`dynamic-fan-out-design.md`](./dynamic-fan-out-design.md) — the map/retry design record (phases, deviations, retry-from-node).
- [`acceptance.md`](./acceptance.md) — the browser acceptance playbook for UI/runtime changes.

Quick orientation (details and exact rules live in the dsl-reference):

- A workflow script is one JavaScript module using only the DSL primitives; prompts are single string literals with `{{...}}` placeholders.
- `agent`/`model` resolve per step → node/loop → run level → runtime fallback; runtime option templates must be declared inputs, and empty optional values fall back to the run level.
- Scheduling is dataflow-driven: independent nodes run concurrently; only `inputs`, session continuity, and loop/map membership order execution.
