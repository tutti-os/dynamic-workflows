export const meta = {
  name: "Release Readiness Check",
  description: "Run five fixed release checks (changelog, tests, migrations, docs, security) in parallel with map, each returning a JSON ready/blocked verdict against the actual repository, merge them into a go/no-go summary, gate on a human decision, and record the decision with any blockers for audit.",
  requiresCwd: true,
};

export const inputs = {
  release_scope: {
    type: "string",
    required: true,
    label: "Release scope",
    description: "The one description every check reads. Include: 1) what is being released (features, fixes, the change set); 2) the version and/or branch or tag being cut; 3) any special concerns to weigh (risky migrations, a security-sensitive area, a tight rollback window). Each of the five checks verifies its dimension against the actual repository plus this scope.",
    placeholder: "Releasing:\n\nVersion / branch:\n\nSpecial concerns:\n",
    widget: "textarea",
  },
};

phase("Checks");

const checks = map({
  id: "checks",
  label: "Run each release check",
  source: [
    { check: "changelog", verify: "A changelog or release-notes entry exists for this release and accurately reflects the scope; nothing shipped in scope is missing from it." },
    { check: "tests", verify: "The test suite covering the release scope exists and passes; there are no skipped or failing tests hiding regressions in the changed areas." },
    { check: "migrations", verify: "Any data or schema migrations required by the scope are present, correctly ordered, and safe to apply and roll back; no destructive step lacks a guard." },
    { check: "docs", verify: "User-facing and API documentation reflects the changes in scope; no changed public behavior is left undocumented." },
    { check: "security", verify: "The diff introduces no secrets, credentials, obvious injection or auth regressions, or unsafe dependency changes in the release scope." },
  ],
  onItemFailure: "skip",
  step: agent({
    id: "check_one",
    label: "Check {{item.check}}",
    output: "json",
    prompt: "You verify exactly one release-readiness dimension against the ACTUAL repository. Other dimensions are handled by parallel checks, so stay strictly within this one. Do not modify anything; inspect and judge only.\n\nInstructions:\n1. Verify the single dimension named in the item, exactly as its \"verify\" field describes, against the real repository state (files, tests, diff, config) plus the release scope below.\n2. Base the verdict on evidence you actually observed — cite the file, command, or test you checked. If you cannot verify something, that is itself grounds for \"blocked\", not a silent pass.\n3. Judge only this dimension; note anything out of scope in \"notes\" rather than acting on it.\n\nOutput contract: end your message with ONLY a JSON object shaped {\"check\": \"<the dimension>\", \"verdict\": \"ready\" | \"blocked\", \"evidence\": \"what you observed\", \"notes\": \"caveats or follow-ups, or empty\"}, with no prose after it.\n\nWorking directory:\n{{workflow.cwd}}\n\nRelease scope:\n{{release_scope}}\n\nCheck to run {{item_index}}:\n{{item}}",
  }),
});

phase("Summary");

const summary = agent({
  id: "summary",
  label: "Summarize readiness",
  inputs: { checks },
  prompt: "You merge the five release checks below into one go/no-go recommendation for a human approver. Each check ended with a JSON verdict of \"ready\" or \"blocked\"; treat those verdicts as authoritative.\n\nInstructions:\n1. Lead with a one-line recommendation: GO only if every check is \"ready\"; otherwise NO-GO.\n2. Give a per-check table or list with each check's verdict and its evidence.\n3. Call out explicitly, in their own section, every \"blocked\" check with its reason and every check in the failed list with its error — a check that could not run is not a pass.\n\nRender as clean Markdown; it is shown directly to the approver.\n\nRelease scope:\n{{release_scope}}\n\nCheck results (items, failed, total):\n{{checks}}",
});

phase("Decision");

const go_no_go = human({
  id: "go_no_go",
  label: "Go / No-Go decision",
  description: "Review the readiness summary and decide whether to proceed with the release. Choosing No-Go requires a reason for the audit record.",
  context: [
    { label: "Release scope", value: "{{release_scope}}", display: "markdown" },
    { label: "Readiness summary", value: "{{summary}}", display: "markdown" },
  ],
  actions: [
    { id: "go", label: "Go — proceed with release", intent: "primary" },
    {
      id: "no_go",
      label: "No-Go — hold the release",
      intent: "danger",
      fields: [
        {
          id: "reason",
          type: "textarea",
          label: "Reason",
          required: true,
          placeholder: "Why the release is held, and what must change before it can proceed.",
        },
      ],
    },
  ],
});

phase("Record");

agent({
  id: "record",
  label: "Record decision",
  output: "json",
  inputs: { summary, go_no_go },
  prompt: "You write the final audit record of this release decision as machine-readable JSON facts — an upstream caller reads this record to learn the outcome without parsing prose. Take no external action: no commit, push, tag, deploy, or message; this is a record, not an execution step.\n\nInstructions:\n1. The decision is what the approver chose: \"{{go_no_go.action}}\".\n2. If the decision was no_go, carry the approver's reason verbatim: {{go_no_go.values.reason}}. If it was go, reason is null.\n3. List the outstanding blockers from the summary — every blocked check and every check that failed to run — even on a go decision, so the record shows what was accepted.\n\nOutput contract: end your message with ONLY a JSON object shaped {\"decision\": \"go\" | \"no_go\", \"reason\": string|null, \"blockers\": [\"one line per outstanding blocker, empty if none\"], \"summary\": \"one plain sentence suitable for a release log\"}, with no prose after it.\n\nReadiness summary:\n{{summary}}",
});
