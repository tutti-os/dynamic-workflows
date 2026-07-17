export const meta = {
  name: "Parallel Review Synthesis",
  description: "Fan out independent single-lens reviewers over one repository inventory and synthesize their findings into a deduplicated, severity-ordered report.",
  requiresCwd: true,
};

export const inputs = {
  review_focus: {
    type: "string",
    required: true,
    label: "Review focus",
    description: "What to review and why. Include: 1) the change, module, or directory in scope; 2) the concerns that matter most (correctness, security, performance, ...); 3) anything explicitly out of scope.",
    placeholder: "Scope:\n\nConcerns:\n\nOut of scope:\n",
    widget: "textarea",
  },
  review_model: {
    type: "string",
    required: false,
    label: "Reviewer model",
    description: "Optional model override shared by all lens reviewers; must be compatible with the run-level agent. Leave empty to use the run-level model.",
  },
  review_permission_mode: {
    type: "string",
    required: false,
    label: "Reviewer permission mode",
    description: "Optional permission mode id shared by all lens reviewers. Discover ids with tutti agent composer-options --agent-id <id> --json (permissionConfig.modes). Leave empty to inherit the run-level mode, falling back to the agent's own default. Lens reviewers are read-only roles — if the agent offers a read-only mode, set it here to enforce inspect-only at the permission layer.",
  },
};

phase("Inventory");

const inventory = agent({
  id: "inventory",
  label: "Repository inventory",
  prompt: "Inventory the repository so single-lens reviewers can navigate it quickly. Return only the inventory: main folders, runtime stack, entry points, and the files most relevant to the review focus below. Do not review anything yet.\n\nWorking directory:\n{{workflow.cwd}}\n\nReview focus:\n{{review_focus}}",
});

phase("Review");

const architecture = agent({
  id: "architecture",
  label: "Architecture review",
  model: "{{review_model}}",
  permissionMode: "{{review_permission_mode}}",
  inputs: { inventory },
  prompt: "You review architecture only: module boundaries, data flow, coupling, and extension points. Judge the actual code, not the inventory narrative. Look for concrete problems; do not pad the list with generic advice, and mark a finding blocking only when it breaks the review focus. Output only your findings — each with file:line, the issue, evidence, and severity (blocking or suggestion) — then a final section listing the areas you did not examine.\n\nWorking directory:\n{{workflow.cwd}}\n\nReview focus:\n{{review_focus}}\n\nRepository inventory:\n{{inventory}}",
});

const security = agent({
  id: "security",
  label: "Security review",
  model: "{{review_model}}",
  permissionMode: "{{review_permission_mode}}",
  inputs: { inventory },
  prompt: "You review security only: auth, secrets handling, shell execution, file writes, network access, and injection surfaces. Judge the actual code, not the inventory narrative. Look for concrete, exploitable problems; do not pad the list with generic hardening advice. Output only your findings — each with file:line, the issue, evidence, and severity (blocking or suggestion) — then a final section listing the areas you did not examine.\n\nWorking directory:\n{{workflow.cwd}}\n\nReview focus:\n{{review_focus}}\n\nRepository inventory:\n{{inventory}}",
});

const quality = agent({
  id: "quality",
  label: "Correctness and tests review",
  model: "{{review_model}}",
  permissionMode: "{{review_permission_mode}}",
  inputs: { inventory },
  prompt: "You review correctness only: logic bugs, unhandled edge cases, error handling, and missing or weak tests around the review focus. Judge the actual code and tests, not the inventory narrative. Look for concrete failure scenarios; state the input or state that triggers each one. Output only your findings — each with file:line, the issue, evidence, and severity (blocking or suggestion) — then a final section listing the areas you did not examine.\n\nWorking directory:\n{{workflow.cwd}}\n\nReview focus:\n{{review_focus}}\n\nRepository inventory:\n{{inventory}}",
});

phase("Synthesize");

agent({
  id: "synthesis",
  label: "Synthesize findings",
  inputs: { architecture, security, quality },
  prompt: "Merge the three single-lens reviews below into one report. Deduplicate overlapping findings while keeping every file:line and the strongest evidence, order findings by severity with blocking issues first, and do not soften or drop any finding. End with a Coverage section that combines the unexamined areas reported by each lens, so the reader knows what this review did not check.\n\nReview focus:\n{{review_focus}}\n\nArchitecture findings:\n{{architecture}}\n\nSecurity findings:\n{{security}}\n\nCorrectness findings:\n{{quality}}",
});
