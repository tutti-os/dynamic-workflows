import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";
import type { WorkflowBlueprintDetail } from "./blueprint-types";

type BlueprintMetadata = Omit<WorkflowBlueprintDetail, "bundle" | "schemaVersion">;

function flowBlueprint(
  metadata: BlueprintMetadata,
  flowSource: string,
): WorkflowBlueprintDetail {
  return {
    ...metadata,
    schemaVersion: "tutti.flow.v1",
    bundle: createFlowV1Bundle([
      {
        path: "flow.js",
        content: flowSource,
      },
      {
        path: "scripts/extract-approved-tasks.mjs",
        content: `export async function run(ctx) {
  const history = Array.isArray(ctx.breakdown?.history) ? ctx.breakdown.history : [];
  const tasks = history.at(-1)?.outputs?.decompose;
  if (!Array.isArray(tasks)) throw new Error("Approved task array is missing from Loop history.");
  return tasks;
}
`,
      },
      {
        path: "scripts/build-release-record.mjs",
        content: `export async function run(ctx) {
  return { outcome: ctx.decision.action, output: {
    summary: ctx.summary,
    decision: ctx.decision,
    acceptedBlockers:
      ctx.decision?.action === "go" ? ctx.summary?.blockedChecks ?? [] : [],
    shipped: false,
    cycle: ctx.cycle ?? null,
  } };
}
`,
      },
      {
        path: "scripts/prepare-delivery-workspace.mjs",
        content: `import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
function git(args, cwd = process.cwd()) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function identity(ctx) {
  const root = path.join(process.cwd(), ".tutti-flow-worktrees");
  return { root, path: path.join(root, "cycle-" + ctx.cycle.id), branch: "flow/cycle-" + ctx.cycle.sequence };
}
export async function apply(ctx) {
  const workspace = identity(ctx);
  git(["fetch", "origin", ctx.targetBranch]);
  fs.mkdirSync(workspace.root, { recursive: true });
  if (!fs.existsSync(workspace.path)) git(["worktree", "add", "-B", workspace.branch, workspace.path, "origin/" + ctx.targetBranch]);
  return { externalRef: workspace.path, output: { ...workspace, baseCommit: git(["rev-parse", "HEAD"], workspace.path) } };
}
export async function reconcile(ctx) {
  const workspace = identity(ctx);
  if (!fs.existsSync(workspace.path)) return { status: "not_applied" };
  try {
    return { status: "completed", externalRef: workspace.path, output: { ...workspace, baseCommit: git(["rev-parse", "HEAD"], workspace.path) } };
  } catch { return { status: "unknown", reason: "Workspace exists but is not a readable git worktree." }; }
}
`,
      },
      {
        path: "scripts/check-delivery-changes.mjs",
        content: `import { execFileSync } from "node:child_process";
export async function run() {
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
  return status ? { outcome: "changed", output: { status } } : { outcome: "no_changes", output: { status: "" } };
}
`,
      },
      {
        path: "scripts/commit-delivery.mjs",
        content: `import { execFileSync } from "node:child_process";
function git(args) { return execFileSync("git", args, { encoding: "utf8" }).trim(); }
function marker(ctx) { return "Flow-Cycle: " + ctx.cycle.id; }
export async function apply(ctx) {
  git(["add", "-A"]);
  git(["commit", "-m", ctx.title, "-m", marker(ctx)]);
  const sha = git(["rev-parse", "HEAD"]);
  return { externalRef: sha, output: { sha, branch: ctx.workspace.branch } };
}
export async function reconcile(ctx) {
  const chunks = git(["log", "-n", "100", "--format=%H%x00%B%x00"]).split("\\u0000");
  for (let index = 0; index + 1 < chunks.length; index += 2) {
    if (chunks[index + 1].includes(marker(ctx))) return { status: "completed", externalRef: chunks[index], output: { sha: chunks[index], branch: ctx.workspace.branch } };
  }
  return { status: "not_applied" };
}
`,
      },
      {
        path: "scripts/push-delivery.mjs",
        content: `import { execFileSync } from "node:child_process";
function git(args) { return execFileSync("git", args, { encoding: "utf8" }).trim(); }
function remoteSha(branch) { const line = git(["ls-remote", "origin", "refs/heads/" + branch]); return line ? line.split(/\\s+/u)[0] : ""; }
export async function apply(ctx) {
  git(["push", "-u", "origin", ctx.commit.sha + ":refs/heads/" + ctx.commit.branch]);
  return { externalRef: ctx.commit.branch, output: { branch: ctx.commit.branch, sha: ctx.commit.sha } };
}
export async function reconcile(ctx) {
  return remoteSha(ctx.commit.branch) === ctx.commit.sha
    ? { status: "completed", externalRef: ctx.commit.branch, output: { branch: ctx.commit.branch, sha: ctx.commit.sha } }
    : { status: "not_applied" };
}
`,
      },
      {
        path: "scripts/create-delivery-pr.mjs",
        content: `import { execFileSync } from "node:child_process";
function gh(args) { return execFileSync("gh", args, { encoding: "utf8" }).trim(); }
export async function apply(ctx) {
  const url = gh(["pr", "create", "--head", ctx.push.branch, "--base", ctx.targetBranch, "--title", ctx.title, "--body", ctx.body]);
  return { externalRef: url, output: { url, branch: ctx.push.branch, commit: ctx.push.sha } };
}
export async function reconcile(ctx) {
  const items = JSON.parse(gh(["pr", "list", "--state", "all", "--head", ctx.push.branch, "--json", "url,headRefName"]));
  return items[0] ? { status: "completed", externalRef: items[0].url, output: { url: items[0].url, branch: ctx.push.branch, commit: ctx.push.sha } } : { status: "not_applied" };
}
`,
      },
      {
        path: "scripts/cleanup-delivery-workspace.mjs",
        content: `import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
export async function run(ctx) {
  const workspace = path.join(process.cwd(), ".tutti-flow-worktrees", "cycle-" + ctx.cycle.id);
  if (fs.existsSync(workspace)) execFileSync("git", ["worktree", "remove", "--force", workspace], { encoding: "utf8" });
  execFileSync("git", ["worktree", "prune"], { encoding: "utf8" });
  return { workspace, cleaned: true };
}
`,
      },
    ]),
  };
}

export const PRESERVED_FLOW_V1_BLUEPRINTS: WorkflowBlueprintDetail[] = [
  flowBlueprint(
    {
      id: "human-feedback-loop-v1",
      title: "Human Feedback Loop",
      description:
        "Pause after each agent result so a person can accept it or send structured feedback into the next iteration.",
      category: "coding",
      tags: ["human", "feedback", "loop", "approval", "structured-output"],
      difficulty: "advanced",
      requiresCwd: false,
      capabilities: ["agent", "human", "loop", "durable-checkpoint"],
      patternSummary:
        "An Agent produces a structured draft, a Human task captures approval or revision feedback, and a bounded Loop carries the explicit prior iteration record forward until the person accepts.",
      useCases: [
        "Review generated content before downstream automation continues.",
        "Collect revision feedback without hiding decisions in Agent conversation state.",
        "Demonstrate durable Human tasks inside a bounded Loop.",
      ],
    },
    `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Human Feedback Loop",
  description: "Iterate on an Agent result until a person explicitly approves it.",
  requiresCwd: false,
};
export const inputs = defineInputs({
  request: stringInput({ required: true }),
});
export const cycles = defineCycles({ mode: "singleton" });

const feedback = loop({
  id: "feedback",
  label: "Draft and review",
  inputs: { request: ref("inputs.request") },
  maxIterations: 5,
  onMaxIterations: "fail",
  steps: [
    agent({
      id: "draft",
      label: "Produce or revise result",
      output: "json",
      prompt: "Produce the requested result as JSON. On later iterations, revise the previous draft using the human comment in previousIteration. Request: {{request}} Previous iteration: {{previousIteration}}",
    }),
    human({
      id: "review",
      label: "Review result",
      description: "Approve this result or request a concrete revision.",
      context: [
        { label: "Requested work", value: "{{request}}", display: "markdown" },
        { label: "Current result", value: "{{previous}}", display: "json" },
      ],
      actions: [
        { id: "approve", label: "Approve", intent: "primary", fields: [] },
        {
          id: "revise",
          label: "Request revision",
          intent: "default",
          fields: [
            {
              id: "comment",
              type: "textarea",
              label: "Revision comment",
              required: true,
            },
          ],
        },
      ],
    }),
  ],
  until: { source: "review", equals: { action: "approve", values: {} } },
});
completeCycle({ id: "complete", outcome: "approved", inputs: { feedback } });
`,
  ),
  flowBlueprint(
    {
      id: "loop-primitive-rd-acceptance-test-v1",
      title: "RD Acceptance Delivery",
      description:
        "A bounded implementation and isolated acceptance loop that runs until PASS, then commits, pushes, and opens a pull request through reconciled Effects.",
      category: "coding",
      tags: ["loop", "rd", "acceptance", "independent-review", "delivery", "cwd"],
      difficulty: "advanced",
      requiresCwd: true,
      capabilities: [
        "agent",
        "loop",
        "json-output",
        "retry",
        "review-isolation",
        "worktree",
        "effect",
        "github-cli",
        "cwd",
      ],
      patternSummary:
        "A bounded two-role Loop alternates implementation and isolated JSON acceptance. PASS continues through separate commit, push, and pull-request Effects; exhaustion closes with not_accepted and no delivery mutation.",
      useCases: [
        "Implement a repository requirement with adversarial acceptance review.",
        "Keep reviewer judgment independent from the implementer narrative.",
        "Open a pull request only after acceptance while preserving an honest not_accepted terminal when the iteration budget is exhausted.",
      ],
    },
    `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "RD Acceptance Delivery",
  description: "Implement a requirement and independently review it until PASS or budget exhaustion.",
  requiresCwd: true,
};
export const inputs = defineInputs({
  requirement: stringInput({ required: true }),
});
export const params = defineParams({
  maxRounds: numberParam({ default: 3, min: 1, max: 10 }),
  targetBranch: stringParam({ default: "main" }),
  reviewerAgent: stringParam({ default: "" }),
  reviewerModel: stringParam({ default: "" }),
  reviewerPermission: stringParam({ default: "" }),
});
export const secrets = defineSecrets({
  GH_TOKEN: connectionSecret({ provider: "github", required: true }),
});
export const cycles = defineCycles({ mode: "singleton" });

const workspace = effect({
  id: "prepare_workspace",
  file: "scripts/prepare-delivery-workspace.mjs",
  inputs: { targetBranch: ref("params.targetBranch") },
  idempotencyKey: template("{{cycle.id}}:prepare-workspace"),
});
const acceptance = loop({
  id: "acceptance",
  label: "Implement and accept",
  inputs: { requirement: ref("inputs.requirement"), workspace },
  workspace,
  execution: { access: "write", isolation: "required" },
  maxIterations: ref("params.maxRounds"),
  onMaxIterations: "complete",
  steps: [
    agent({
      id: "implement",
      label: "Implement requirement",
      session: { mode: "inherit", key: "rd_room" },
      prompt: "Work in the configured repository. Implement the requirement, run focused checks, and leave changes uncommitted. Requirement: {{requirement}}",
      appendPrompt: "Continue in the same RD session. Re-anchor on repository truth, repair only the latest acceptance blockers, run focused checks, and leave changes uncommitted. Blockers: {{previousIteration.outputs.review.blockers}} Suggestions: {{previousIteration.outputs.review.suggestions}}",
    }),
    agent({
      id: "review",
      label: "Independent acceptance",
      agent: ref("params.reviewerAgent"),
      model: ref("params.reviewerModel"),
      permissionMode: ref("params.reviewerPermission"),
      session: { mode: "independent" },
      execution: { access: "review", isolation: "shared" },
      output: json({ schema: {
        type: "object",
        required: ["status", "criteria", "blockers", "suggestions", "checks", "unverified"],
        properties: {
          status: { enum: ["PASS", "FAIL"] },
          criteria: { type: "array" },
          blockers: { type: "array" },
          suggestions: { type: "array" },
          checks: { type: "string" },
          unverified: { type: "array" },
        },
      } }),
      prompt: "Act as an independent reviewer in a fresh session inside the configured implementation workspace. Judge repository truth against the original requirement and do not rely on the implementer narrative. Reuse only the prior criteria and blockers below; intermediate rounds focus on repaired blockers and new diff, while a prospective PASS requires complete coverage. Return valid JSON with status, criteria, blockers, suggestions, checks, and unverified fields. Requirement: {{requirement}} Previous criteria: {{previousStep.criteria}} Previous blockers: {{previousStep.blockers}}",
    }),
  ],
  until: { source: "review", finalStatus: "PASS" },
});
const delivery = agent({
  id: "delivery",
  label: "Prepare delivery report",
  inputs: {
    requirement: ref("inputs.requirement"),
    acceptance,
    workspace,
  },
  workspace,
  execution: { access: "read", isolation: "required" },
  output: json({ schema: {
    type: "object",
    required: ["title", "body", "changedFiles", "checks", "unverified"],
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      changedFiles: { type: "array" },
      checks: { type: "string" },
      unverified: { type: "array" },
    },
  } }),
  prompt: "Inspect repository truth and the accepted review. Return valid JSON with title, body, changedFiles, checks, and unverified fields for the commit and pull request. Do not perform Git or GitHub mutations. Requirement: {{requirement}} Acceptance: {{acceptance}}",
});
const notAccepted = agent({
  id: "not_accepted_report",
  label: "Report remaining blockers",
  inputs: { acceptance },
  output: "json",
  prompt: "Return valid JSON describing the unfinished implementation, remaining blockers, checks, changed files, and an explicit result of not_accepted. Do not commit, push, or create a PR. Acceptance: {{acceptance}}",
});
const changes = script({
  id: "check_changes",
  file: "scripts/check-delivery-changes.mjs",
  inputs: { delivery, workspace },
  workspace,
  execution: { access: "read", isolation: "required" },
  outcomes: ["changed", "no_changes"],
});
const commit = effect({
  id: "commit",
  file: "scripts/commit-delivery.mjs",
  inputs: { title: ref("delivery.title"), workspace, changes },
  workspace,
  execution: { access: "write", isolation: "required" },
  idempotencyKey: template("{{cycle.id}}:commit"),
});
const push = effect({
  id: "push",
  file: "scripts/push-delivery.mjs",
  inputs: { commit, workspace },
  workspace,
  execution: { access: "write", isolation: "required" },
  idempotencyKey: template("{{cycle.id}}:push"),
});
const pullRequest = effect({
  id: "create_pull_request",
  file: "scripts/create-delivery-pr.mjs",
  secrets: ["GH_TOKEN"],
  inputs: {
    push,
    title: ref("delivery.title"),
    body: ref("delivery.body"),
    targetBranch: ref("params.targetBranch"),
  },
  idempotencyKey: template("{{cycle.id}}:create-pr"),
});
const accepted = completeCycle({
  id: "accepted",
  outcome: "accepted",
  inputs: { pullRequest },
});
const acceptedNoChanges = completeCycle({
  id: "accepted_no_changes",
  outcome: "accepted_no_changes",
  inputs: { changes },
});
const exhausted = completeCycle({
  id: "not_accepted",
  outcome: "not_accepted",
  inputs: { notAccepted },
});
route(acceptance, { matched: delivery, exhausted: notAccepted });
route(changes, { changed: commit, no_changes: acceptedNoChanges });
finalize({
  id: "cleanup_workspace",
  file: "scripts/cleanup-delivery-workspace.mjs",
  runOn: ["completed", "canceled", "failed"],
  retainOnFailure: true,
});
`,
  ),
  flowBlueprint(
    {
      id: "rd-human-acceptance-delivery-v1",
      title: "RD Human-Gated Acceptance Delivery",
      description:
        "An implementation first iterates with a person, then enters isolated acceptance and opens a pull request without repeating the human gate for reviewer-driven repairs.",
      category: "coding",
      tags: ["human", "loop", "rd", "acceptance", "reviewer", "delivery", "cwd"],
      difficulty: "advanced",
      requiresCwd: true,
      capabilities: [
        "agent",
        "human",
        "loop",
        "json-output",
        "review-isolation",
        "worktree",
        "effect",
        "github-cli",
        "cwd",
      ],
      patternSummary:
        "A Human alignment Loop approves implementation direction before a separate isolated acceptance Loop. Reviewer failures drive repair rounds; PASS continues through separate commit, push, and pull-request Effects.",
      useCases: [
        "Align implementation direction with a person before formal acceptance.",
        "Repair reviewer findings without asking the person to approve every repair.",
        "Keep Human approval and independent acceptance as separate auditable stages.",
        "Deliver the accepted change as a real pull request with independently reconciled Git and GitHub mutations.",
      ],
    },
    `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "RD Human-Gated Acceptance Delivery",
  description: "Human-align an implementation, then independently review and repair it.",
  requiresCwd: true,
};
export const inputs = defineInputs({
  requirement: stringInput({ required: true }),
});
export const params = defineParams({
  maxRounds: numberParam({ default: 3, min: 1, max: 10 }),
  targetBranch: stringParam({ default: "main" }),
  reviewerAgent: stringParam({ default: "" }),
  reviewerModel: stringParam({ default: "" }),
  reviewerPermission: stringParam({ default: "" }),
});
export const secrets = defineSecrets({
  GH_TOKEN: connectionSecret({ provider: "github", required: true }),
});
export const cycles = defineCycles({ mode: "singleton" });

const workspace = effect({
  id: "prepare_workspace",
  file: "scripts/prepare-delivery-workspace.mjs",
  inputs: { targetBranch: ref("params.targetBranch") },
  idempotencyKey: template("{{cycle.id}}:prepare-workspace"),
});
const alignment = loop({
  id: "alignment",
  label: "Human alignment",
  inputs: { requirement: ref("inputs.requirement"), workspace },
  workspace,
  execution: { access: "write", isolation: "required" },
  maxIterations: 4,
  onMaxIterations: "fail",
  steps: [
    agent({
      id: "implement",
      label: "Implement or revise",
      session: { mode: "inherit", key: "rd_room" },
      prompt: "Implement the requirement in the configured repository. Run focused checks and do not commit. Requirement: {{requirement}}",
      appendPrompt: "Continue in the same RD session. Re-anchor on repository truth and address only the latest explicit Human feedback. Run focused checks and do not commit. Human feedback: {{previousIteration.outputs.human_review.values.comment}}",
    }),
    human({
      id: "human_review",
      label: "Human alignment decision",
      description: "Approve the direction for independent acceptance or request revision.",
      context: [
        { label: "Requirement", value: "{{requirement}}", display: "markdown" },
        { label: "Implementation report", value: "{{previous}}", display: "markdown" },
      ],
      actions: [
        { id: "approve", label: "Approve direction", intent: "primary", fields: [] },
        {
          id: "revise",
          label: "Request revision",
          intent: "default",
          fields: [
            {
              id: "comment",
              type: "textarea",
              label: "Revision comment",
              required: true,
            },
          ],
        },
      ],
    }),
  ],
  until: { source: "human_review", equals: { action: "approve", values: {} } },
});

const acceptance = loop({
  id: "acceptance",
  label: "Independent acceptance",
  inputs: {
    requirement: ref("inputs.requirement"),
    alignment,
    workspace,
  },
  workspace,
  execution: { access: "write", isolation: "required" },
  maxIterations: ref("params.maxRounds"),
  onMaxIterations: "complete",
  firstIteration: { startAt: "review" },
  steps: [
    agent({
      id: "repair",
      label: "Repair acceptance blockers",
      session: { mode: "inherit", key: "rd_room" },
      prompt: "Continue as the Human-approved RD owner. Repair only the latest blocking findings against the original requirement, inspect repository truth, run focused checks, and do not commit. Requirement: {{requirement}} Blockers: {{previousIteration.outputs.review.blockers}} Suggestions: {{previousIteration.outputs.review.suggestions}}",
      appendPrompt: "Continue in the same RD session. Re-anchor on repository truth, repair only the latest acceptance blockers, run focused checks, and do not commit. Blockers: {{previousIteration.outputs.review.blockers}} Suggestions: {{previousIteration.outputs.review.suggestions}}",
    }),
    agent({
      id: "review",
      label: "Independent reviewer",
      agent: ref("params.reviewerAgent"),
      model: ref("params.reviewerModel"),
      permissionMode: ref("params.reviewerPermission"),
      session: { mode: "independent" },
      execution: { access: "review", isolation: "shared" },
      output: json({ schema: {
        type: "object",
        required: ["status", "criteria", "blockers", "suggestions", "checks", "unverified"],
        properties: {
          status: { enum: ["PASS", "FAIL"] },
          criteria: { type: "array" },
          blockers: { type: "array" },
          suggestions: { type: "array" },
          checks: { type: "string" },
          unverified: { type: "array" },
        },
      } }),
      prompt: "Review repository truth independently in a fresh session inside the configured implementation workspace. Human approval permits review but is not acceptance evidence. Reuse only the prior criteria and blockers below; intermediate rounds focus on repaired blockers and new diff, while a prospective PASS requires complete coverage. Return valid JSON with status, criteria, blockers, suggestions, checks, and unverified fields. Requirement: {{requirement}} Previous criteria: {{previousStep.criteria}} Previous blockers: {{previousStep.blockers}}",
    }),
  ],
  until: { source: "review", finalStatus: "PASS" },
});

const delivery = agent({
  id: "delivery",
  label: "Prepare delivery report",
  inputs: { alignment, acceptance, workspace },
  workspace,
  execution: { access: "read", isolation: "required" },
  output: json({ schema: {
    type: "object",
    required: ["title", "body", "changedFiles", "checks", "unverified"],
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      changedFiles: { type: "array" },
      checks: { type: "string" },
      unverified: { type: "array" },
    },
  } }),
  prompt: "Inspect repository truth and return valid JSON with title, body, changedFiles, checks, and unverified fields for the commit and pull request. Do not perform Git or GitHub mutations. Alignment: {{alignment}} Acceptance: {{acceptance}}",
});
const notAccepted = agent({
  id: "not_accepted_report",
  label: "Report remaining blockers",
  inputs: { alignment, acceptance },
  output: "json",
  prompt: "Return valid JSON with result not_accepted, the durable Human alignment, remaining independent-review blockers, checks, and changed files. Do not commit, push, or create a PR. Alignment: {{alignment}} Acceptance: {{acceptance}}",
});
const changes = script({
  id: "check_changes",
  file: "scripts/check-delivery-changes.mjs",
  inputs: { delivery, workspace },
  workspace,
  execution: { access: "read", isolation: "required" },
  outcomes: ["changed", "no_changes"],
});
const commit = effect({
  id: "commit",
  file: "scripts/commit-delivery.mjs",
  inputs: { title: ref("delivery.title"), workspace, changes },
  workspace,
  execution: { access: "write", isolation: "required" },
  idempotencyKey: template("{{cycle.id}}:commit"),
});
const push = effect({
  id: "push",
  file: "scripts/push-delivery.mjs",
  inputs: { commit, workspace },
  workspace,
  execution: { access: "write", isolation: "required" },
  idempotencyKey: template("{{cycle.id}}:push"),
});
const pullRequest = effect({
  id: "create_pull_request",
  file: "scripts/create-delivery-pr.mjs",
  secrets: ["GH_TOKEN"],
  inputs: {
    push,
    title: ref("delivery.title"),
    body: ref("delivery.body"),
    targetBranch: ref("params.targetBranch"),
  },
  idempotencyKey: template("{{cycle.id}}:create-pr"),
});
completeCycle({
  id: "accepted",
  outcome: "accepted",
  inputs: { pullRequest },
});
const acceptedNoChanges = completeCycle({
  id: "accepted_no_changes",
  outcome: "accepted_no_changes",
  inputs: { changes },
});
completeCycle({
  id: "not_accepted",
  outcome: "not_accepted",
  inputs: { notAccepted },
});
route(acceptance, { matched: delivery, exhausted: notAccepted });
route(changes, { changed: commit, no_changes: acceptedNoChanges });
finalize({
  id: "cleanup_workspace",
  file: "scripts/cleanup-delivery-workspace.mjs",
  runOn: ["completed", "canceled", "failed"],
  retainOnFailure: true,
});
`,
  ),
  flowBlueprint(
    {
      id: "parallel-review-synthesis-v1",
      title: "Parallel Review Synthesis",
      description:
        "Run architecture, security, and correctness reviewers independently, then merge their evidence into one severity-ordered report.",
      category: "review",
      tags: ["review", "fan-out", "parallel", "synthesis", "independent-review", "cwd"],
      difficulty: "starter",
      requiresCwd: true,
      capabilities: ["agent", "parallel", "fan-in", "cwd"],
      patternSummary:
        "One inventory feeds three independent reviewer nodes with no edges between them, allowing parallel execution without narrative leakage. A final synthesizer deduplicates evidence and preserves uncovered areas.",
      useCases: [
        "Review a repository change from several independent perspectives.",
        "Keep parallel reviewers blind to one another before synthesis.",
        "Demonstrate graph-level fan-out and fan-in without a dynamic Map.",
      ],
    },
    `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Parallel Review Synthesis",
  description: "Review one repository scope through three independent lenses and synthesize the findings.",
  requiresCwd: true,
};
export const inputs = defineInputs({
  review_scope: stringInput({ required: true }),
});
export const cycles = defineCycles({ mode: "singleton" });
export const runtime = {
  maxNodeExecutionsPerTick: 30,
  maxImmediateContinuations: 1,
  maxParallelNodes: 4,
};

const inventory = agent({
  id: "inventory",
  label: "Inventory review scope",
  inputs: { scope: ref("inputs.review_scope") },
  output: "json",
  prompt: "Inspect the configured repository read-only. Return only JSON listing changed or relevant files, key boundaries, tests, and unexamined areas for this scope: {{scope}}",
});
const architecture = agent({
  id: "architecture",
  label: "Architecture review",
  inputs: { inventory },
  prompt: "Review architecture only. Cite file-level evidence, severity, impact, and recommendation. Do not infer other reviewers' conclusions. Scope inventory: {{inventory}}",
});
const security = agent({
  id: "security",
  label: "Security review",
  inputs: { inventory },
  prompt: "Review security and trust boundaries only. Cite file-level evidence, severity, exploit or failure mode, and recommendation. Scope inventory: {{inventory}}",
});
const correctness = agent({
  id: "correctness",
  label: "Correctness review",
  inputs: { inventory },
  prompt: "Review correctness, edge cases, and test coverage only. Cite file-level evidence, severity, and recommendation. Scope inventory: {{inventory}}",
});
const synthesis = agent({
  id: "synthesis",
  label: "Synthesize findings",
  inputs: { architecture, security, correctness },
  prompt: "Merge the three independent reviews. Deduplicate only when evidence points to the same defect, preserve corroboration, order findings by severity, and end with Coverage and Unexamined areas. Architecture: {{architecture}} Security: {{security}} Correctness: {{correctness}}",
});
completeCycle({ id: "complete", outcome: "reviewed", inputs: { synthesis } });
`,
  ),
  flowBlueprint(
    {
      id: "map-fan-out-demo-v1",
      title: "Dynamic Fan-Out Demo",
      description:
        "Discover a JSON work list, process and adversarially verify each item in an isolated worktree, then synthesize results without hiding failures.",
      category: "coding",
      tags: ["map", "fan-out", "dynamic", "json-output", "pipeline", "synthesis", "worktree", "cwd"],
      difficulty: "starter",
      requiresCwd: true,
      capabilities: ["agent", "map", "json-output", "worktree", "effect", "cwd"],
      patternSummary:
        "A discovery Agent returns bounded JSON items, a host-provisioned cycle worktree keeps writes off the parent checkout, Map expands each item into a safely serialized process-and-verify pipeline, and the final report receives completed and failed records explicitly.",
      useCases: [
        "Process a runtime-discovered list item by item.",
        "Demonstrate dynamic Map expansion and per-item pipelines.",
        "Keep skipped or failed work visible in final synthesis.",
      ],
    },
    `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Dynamic Fan-Out Demo",
  description: "Discover, process, verify, and summarize a dynamic repository work list.",
  requiresCwd: true,
};
export const inputs = defineInputs({
  discovery_focus: stringInput({ required: true }),
});
export const params = defineParams({
  targetBranch: stringParam({ default: "main" }),
});
export const cycles = defineCycles({ mode: "singleton" });
export const runtime = {
  maxNodeExecutionsPerTick: 80,
  maxImmediateContinuations: 1,
  maxParallelNodes: 4,
};

const workspace = effect({
  id: "prepare_workspace",
  file: "scripts/prepare-delivery-workspace.mjs",
  inputs: { targetBranch: ref("params.targetBranch") },
  idempotencyKey: template("{{cycle.id}}:prepare-workspace"),
});
const discover = agent({
  id: "discover",
  label: "Discover work items",
  inputs: { focus: ref("inputs.discovery_focus") },
  output: "json",
  prompt: "Inspect the configured repository read-only and return only a JSON array of at most 12 work items shaped {id, file, goal}. Do not silently truncate; make the last item disclose omitted scope. Focus: {{focus}}",
});
const process = map({
  id: "process",
  label: "Process and verify each item",
  source: discover,
  inputs: { workspace },
  workspace,
  maxItems: 12,
  execution: { access: "write", isolation: "required" },
  onItemFailure: "skip",
  onItemRejected: "collect",
  itemOutcome: {
    source: "verify_one.status",
    success: ["VERIFIED"],
    rejected: ["REJECTED"],
  },
  steps: [
    agent({
      id: "process_one",
      label: "Process item",
      prompt: "Handle exactly this item in the configured repository, make only the necessary changes, run focused checks, and report evidence. Item: {{item}}",
    }),
    agent({
      id: "verify_one",
      label: "Verify item",
      output: "json",
      prompt: "Independently verify this one item against repository truth. Return only JSON shaped {status: VERIFIED|REJECTED, evidence: [], blockers: []}. Item: {{item}} Proposed result: {{previous}}",
    }),
  ],
});
const synthesis = agent({
  id: "synthesis",
  label: "Synthesize fan-out",
  inputs: { process },
  prompt: "Summarize completed items, rejected items, failed items, checks, and uncovered scope. Never present partial coverage as complete. Map record: {{process}}",
});
completeCycle({ id: "complete", outcome: "processed", inputs: { synthesis } });
finalize({
  id: "cleanup_workspace",
  file: "scripts/cleanup-delivery-workspace.mjs",
  runOn: ["completed", "canceled", "failed"],
  retainOnFailure: true,
});
`,
  ),
  flowBlueprint(
    {
      id: "repo-migration-sweep-v1",
      title: "Repo Migration Sweep",
      description:
        "Discover migration sites, migrate and verify each with Map, run isolated whole-change acceptance, then commit, push, and open a pull request.",
      category: "coding",
      tags: ["migration", "map", "loop", "acceptance", "independent-review", "delivery", "cwd"],
      difficulty: "advanced",
      requiresCwd: true,
      capabilities: [
        "agent",
        "map",
        "loop",
        "json-output",
        "review-isolation",
        "worktree",
        "effect",
        "github-cli",
        "cwd",
      ],
      patternSummary:
        "A discovery Agent emits migration sites, Map migrates and verifies them, a bounded isolated Loop reviews cross-file correctness, and accepted work proceeds through separate commit, push, and pull-request Effects.",
      useCases: [
        "Sweep an API or code-pattern migration across a repository.",
        "Catch cross-file regressions after per-site verification.",
        "Block pull-request delivery on rejected or exhausted acceptance while preserving those outcomes for review.",
      ],
    },
    `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Repo Migration Sweep",
  description: "Migrate a bounded set of repository call sites and independently accept the whole change.",
  requiresCwd: true,
};
export const inputs = defineInputs({
  migration_brief: stringInput({ required: true }),
});
export const params = defineParams({
  maxRounds: numberParam({ default: 3, min: 1, max: 10 }),
  targetBranch: stringParam({ default: "main" }),
  reviewerAgent: stringParam({ default: "" }),
  reviewerModel: stringParam({ default: "" }),
  reviewerPermission: stringParam({ default: "" }),
});
export const secrets = defineSecrets({
  GH_TOKEN: connectionSecret({ provider: "github", required: true }),
});
export const cycles = defineCycles({ mode: "singleton" });
export const runtime = {
  maxNodeExecutionsPerTick: 120,
  maxImmediateContinuations: 1,
  maxParallelNodes: 4,
};

const workspace = effect({
  id: "prepare_workspace",
  file: "scripts/prepare-delivery-workspace.mjs",
  inputs: { targetBranch: ref("params.targetBranch") },
  idempotencyKey: template("{{cycle.id}}:prepare-workspace"),
});
const discover = agent({
  id: "discover",
  label: "Discover migration sites",
  inputs: { brief: ref("inputs.migration_brief"), workspace },
  workspace,
  execution: { access: "read", isolation: "required" },
  output: "json",
  prompt: "Inspect the repository read-only. Return only a JSON array of at most 12 migration sites shaped {file, line, change}. Exclude already-migrated and out-of-scope sites, and disclose omitted coverage. Migration brief: {{brief}}",
});
const migrate = map({
  id: "migrate",
  label: "Migrate and verify sites",
  source: discover,
  inputs: { brief: ref("inputs.migration_brief"), workspace },
  workspace,
  maxItems: 12,
  execution: { access: "write", isolation: "required" },
  onItemFailure: "skip",
  onItemRejected: "collect",
  itemOutcome: {
    source: "verify_one.status",
    success: ["VERIFIED"],
    rejected: ["REJECTED"],
  },
  steps: [
    agent({
      id: "migrate_one",
      label: "Migrate site",
      prompt: "Migrate exactly this site according to the brief, make the smallest necessary change, run focused checks, and do not commit. Brief: {{brief}} Site: {{item}}",
    }),
    agent({
      id: "verify_one",
      label: "Verify site",
      output: "json",
      prompt: "Independently verify this site against repository truth. Return only JSON shaped {status: VERIFIED|REJECTED, blockers: [], evidence: []}. Brief: {{brief}} Site: {{item}} Result: {{previous}}",
    }),
  ],
});
const acceptance = loop({
  id: "acceptance",
  label: "Whole-change acceptance",
  inputs: {
    brief: ref("inputs.migration_brief"),
    migrate,
    workspace,
  },
  workspace,
  execution: { access: "write", isolation: "required" },
  maxIterations: ref("params.maxRounds"),
  onMaxIterations: "complete",
  firstIteration: { startAt: "review" },
  steps: [
    agent({
      id: "repair",
      label: "Repair whole-change blockers",
      session: { mode: "inherit", key: "migration_repair_room" },
      prompt: "Repair only the blocking whole-change findings, preserve scope, run focused checks, and do not commit. Brief: {{brief}} Per-site record: {{migrate}} Blockers: {{previousIteration.outputs.review.blockers}}",
      appendPrompt: "Continue in the same repair session. Re-anchor on repository truth and repair only the latest whole-change blockers without expanding scope. Blockers: {{previousIteration.outputs.review.blockers}}",
    }),
    agent({
      id: "review",
      label: "Review whole migration",
      agent: ref("params.reviewerAgent"),
      model: ref("params.reviewerModel"),
      permissionMode: ref("params.reviewerPermission"),
      session: { mode: "independent" },
      execution: { access: "review", isolation: "shared" },
      output: json({ schema: {
        type: "object",
        required: ["status", "criteria", "blockers", "rejectedSites", "checks", "unverified"],
        properties: {
          status: { enum: ["PASS", "FAIL"] },
          criteria: { type: "array" },
          blockers: { type: "array" },
          rejectedSites: { type: "array" },
          checks: { type: "string" },
          unverified: { type: "array" },
        },
      } }),
      prompt: "Review the entire repository change independently in a fresh session inside the configured implementation workspace. Use repository truth, the migration brief, structured per-site outcomes, and only the prior criteria and blockers below. Return valid JSON with status, criteria, blockers, rejectedSites, checks, and unverified fields. Brief: {{brief}} Per-site record: {{migrate}} Previous criteria: {{previousStep.criteria}} Previous blockers: {{previousStep.blockers}}",
    }),
  ],
  until: { source: "review", finalStatus: "PASS" },
});
const delivery = agent({
  id: "delivery",
  label: "Prepare migration delivery",
  inputs: { migrate, acceptance, workspace },
  workspace,
  execution: { access: "read", isolation: "required" },
  output: json({ schema: {
    type: "object",
    required: ["title", "body", "changedFiles", "checks", "unverified"],
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      changedFiles: { type: "array" },
      checks: { type: "string" },
      unverified: { type: "array" },
    },
  } }),
  prompt: "Inspect repository truth and return valid JSON with title, body, changedFiles, checks, rejectedSites, failedSites, and unverified fields for the commit and pull request. Do not perform Git or GitHub mutations. Per-site record: {{migrate}} Acceptance: {{acceptance}}",
});
const notAccepted = agent({
  id: "not_accepted_report",
  label: "Report incomplete migration",
  inputs: { migrate, acceptance },
  output: "json",
  prompt: "Return valid JSON with result not_accepted, changed files, remaining blockers, rejected and failed sites, checks, and unverified scope. Do not commit, push, or create a PR. Per-site record: {{migrate}} Acceptance: {{acceptance}}",
});
const changes = script({
  id: "check_changes",
  file: "scripts/check-delivery-changes.mjs",
  inputs: { delivery, workspace },
  workspace,
  execution: { access: "read", isolation: "required" },
  outcomes: ["changed", "no_changes"],
});
const commit = effect({
  id: "commit",
  file: "scripts/commit-delivery.mjs",
  inputs: { title: ref("delivery.title"), workspace, changes },
  workspace,
  execution: { access: "write", isolation: "required" },
  idempotencyKey: template("{{cycle.id}}:commit"),
});
const push = effect({
  id: "push",
  file: "scripts/push-delivery.mjs",
  inputs: { commit, workspace },
  workspace,
  execution: { access: "write", isolation: "required" },
  idempotencyKey: template("{{cycle.id}}:push"),
});
const pullRequest = effect({
  id: "create_pull_request",
  file: "scripts/create-delivery-pr.mjs",
  secrets: ["GH_TOKEN"],
  inputs: {
    push,
    title: ref("delivery.title"),
    body: ref("delivery.body"),
    targetBranch: ref("params.targetBranch"),
  },
  idempotencyKey: template("{{cycle.id}}:create-pr"),
});
completeCycle({
  id: "accepted",
  outcome: "accepted",
  inputs: { pullRequest },
});
const acceptedNoChanges = completeCycle({
  id: "accepted_no_changes",
  outcome: "accepted_no_changes",
  inputs: { changes },
});
completeCycle({
  id: "not_accepted",
  outcome: "not_accepted",
  inputs: { notAccepted },
});
route(acceptance, { matched: delivery, exhausted: notAccepted });
route(changes, { changed: commit, no_changes: acceptedNoChanges });
finalize({
  id: "cleanup_workspace",
  file: "scripts/cleanup-delivery-workspace.mjs",
  runOn: ["completed", "canceled", "failed"],
  retainOnFailure: true,
});
`,
  ),
  flowBlueprint(
    {
      id: "research-fanout-report-v1",
      title: "Research Fan-Out Report",
      description:
        "Decompose a topic, research and fact-check each sub-question in parallel, then synthesize a cited report with honest confidence.",
      category: "research",
      tags: ["research", "map", "fan-out", "fact-check", "citations", "synthesis"],
      difficulty: "starter",
      requiresCwd: false,
      capabilities: ["agent", "map", "parallel", "json-output"],
      patternSummary:
        "A planning Agent emits bounded sub-questions, Map runs a research-and-adversarial-fact-check pipeline per item, and synthesis preserves citations, confidence, failed items, and unverified claims.",
      useCases: [
        "Produce a parallel, fact-checked report on a research question.",
        "Keep low-confidence and unverified claims visible.",
        "Demonstrate research fan-out without a project directory.",
      ],
    },
    `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Research Fan-Out Report",
  description: "Research a topic through parallel sub-questions and adversarial fact checking.",
  requiresCwd: false,
};
export const inputs = defineInputs({
  research_topic: stringInput({ required: true }),
});
export const cycles = defineCycles({ mode: "singleton" });
export const runtime = {
  maxNodeExecutionsPerTick: 60,
  maxImmediateContinuations: 1,
  maxParallelNodes: 4,
};

const plan = agent({
  id: "plan",
  label: "Decompose research topic",
  inputs: { topic: ref("inputs.research_topic") },
  output: "json",
  prompt: "Return only a JSON array of 3 to 6 independent, non-overlapping sub-questions shaped {id, question, why}. Cover the topic and disclose omitted scope. Topic: {{topic}}",
});
const research = map({
  id: "research",
  label: "Research and fact-check",
  source: plan,
  inputs: { topic: ref("inputs.research_topic") },
  maxItems: 6,
  execution: { access: "read", isolation: "shared" },
  onItemFailure: "skip",
  steps: [
    agent({
      id: "research_one",
      label: "Research sub-question",
      prompt: "Answer exactly this sub-question. Cite primary sources with URLs when available; mark every unverifiable claim unverified and list open gaps. Overall topic: {{topic}} Sub-question: {{item}}",
    }),
    agent({
      id: "fact_check_one",
      label: "Fact-check answer",
      output: "json",
      prompt: "Adversarially fact-check the proposed answer. Return only JSON shaped {answer, confidence: high|medium|low, survivingClaims: [], removedClaims: [], citations: [], unverified: []}. Sub-question: {{item}} Proposed answer: {{previous}}",
    }),
  ],
});
const report = agent({
  id: "report",
  label: "Synthesize research report",
  inputs: {
    topic: ref("inputs.research_topic"),
    research,
  },
  prompt: "Write the final cited report. Preserve per-claim confidence and end with Coverage listing failed items, low-confidence answers, unverified claims, and open gaps. Topic: {{topic}} Research record: {{research}}",
});
completeCycle({ id: "complete", outcome: "reported", inputs: { report } });
`,
  ),
  flowBlueprint(
    {
      id: "release-readiness-check-v1",
      title: "Release Readiness Check",
      description:
        "Run fixed release checks in parallel, synthesize a go or no-go recommendation, collect a Human decision, and record it.",
      category: "ops",
      tags: ["release", "map", "static-list", "human", "gate", "go-no-go", "cwd"],
      difficulty: "starter",
      requiresCwd: true,
      capabilities: ["agent", "map", "human", "json-output", "cwd"],
      patternSummary:
        "A static input list drives parallel readiness checks, a summary keeps blocked and failed checks explicit, a durable Human task captures go or no-go with rationale, and a final JSON record audits the decision.",
      useCases: [
        "Gate a release on a fixed checklist verified against repository state.",
        "Demonstrate a static-list Map and Human go/no-go decision.",
        "Produce an auditable decision record without shipping anything.",
      ],
    },
    `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Release Readiness Check",
  description: "Verify release dimensions, ask a person for go or no-go, and record the decision.",
  requiresCwd: true,
};
export const inputs = defineInputs({
  release_context: stringInput({ required: true }),
  checks: jsonInput({
    required: false,
    default: ["changelog", "tests", "migrations", "documentation", "security"],
  }),
});
export const cycles = defineCycles({ mode: "singleton" });
export const runtime = {
  maxNodeExecutionsPerTick: 40,
  maxImmediateContinuations: 1,
  maxParallelNodes: 5,
};

const checks = map({
  id: "checks",
  label: "Run readiness checks",
  source: ref("inputs.checks"),
  inputs: { context: ref("inputs.release_context") },
  maxItems: 5,
  execution: { access: "read", isolation: "shared" },
  onItemFailure: "skip",
  steps: [
    agent({
      id: "check_one",
      label: "Check release dimension",
      output: "json",
      prompt: "Inspect the configured repository read-only for exactly this release dimension. Return only JSON shaped {check, status: ready|blocked, evidence: [], blockers: [], unverified: []}. Release context: {{context}} Check: {{item}}",
    }),
  ],
});
const summary = agent({
  id: "summary",
  label: "Summarize readiness",
  inputs: { checks },
  output: "json",
  prompt: "Return only JSON shaped {recommendation: GO|NO_GO, readyChecks: [], blockedChecks: [], failedChecks: [], unverified: []}. Never hide a failed or unverified check. Checks: {{checks}}",
});
const decision = human({
  id: "decision",
  label: "Release decision",
  description: "Choose whether this release may proceed.",
  inputs: { summary },
  context: [
    { label: "Readiness summary", value: "{{summary}}", display: "json" },
  ],
  actions: [
    {
      id: "go",
      label: "Go",
      intent: "primary",
      fields: [
        {
          id: "reason",
          type: "textarea",
          label: "Decision rationale and accepted blockers",
          required: true,
        },
      ],
    },
    {
      id: "no_go",
      label: "No-go",
      intent: "danger",
      fields: [
        {
          id: "reason",
          type: "textarea",
          label: "Reason",
          required: true,
        },
      ],
    },
  ],
});
const record = transform({
  id: "record",
  label: "Record release decision",
  file: "scripts/build-release-record.mjs",
  inputs: { summary, decision },
  outcomes: ["go", "no_go"],
});
const go = completeCycle({ id: "go", outcome: "go", inputs: { record } });
const noGo = completeCycle({
  id: "no_go",
  outcome: "no_go",
  inputs: { record },
});
route(decision, { go: record, no_go: record });
route(record, { go, no_go: noGo });
`,
  ),
  flowBlueprint(
    {
      id: "epic-breakdown-plan-v1",
      title: "Epic Breakdown Plan",
      description:
        "Iterate on an epic breakdown with a Human approver, detail approved tasks in parallel, and assemble a dependency-ordered plan.",
      category: "planning",
      tags: ["planning", "epic", "loop", "human", "map", "json-output", "extract"],
      difficulty: "advanced",
      requiresCwd: false,
      capabilities: ["agent", "human", "loop", "map", "json-output"],
      patternSummary:
        "A bounded Human approval Loop converges on a structured task list, a deterministic Transform projects approved tasks into Map, parallel Agents detail each task, and synthesis reports any failed coverage.",
      useCases: [
        "Turn an epic into an approved, dependency-ordered task plan.",
        "Revise task decomposition with a person before expansion.",
        "Demonstrate an explicit Loop-to-Map data bridge.",
      ],
    },
    `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Epic Breakdown Plan",
  description: "Human-approve an epic breakdown, detail each task, and assemble the plan.",
  requiresCwd: false,
};
export const inputs = defineInputs({
  epic_brief: stringInput({ required: true }),
});
export const cycles = defineCycles({ mode: "singleton" });

const breakdown = loop({
  id: "breakdown",
  label: "Decompose with Human approval",
  inputs: { brief: ref("inputs.epic_brief") },
  maxIterations: 4,
  onMaxIterations: "fail",
  steps: [
    agent({
      id: "decompose",
      label: "Decompose epic",
      output: "json",
      prompt: "Return only a JSON array of 3 to 10 non-overlapping tasks shaped {id, title, goal, dependencies}. Cover definition of done without scope drift. On later iterations revise using previousIteration Human feedback while retaining stable ids. Epic brief: {{brief}} Previous iteration: {{previousIteration}}",
    }),
    human({
      id: "plan_review",
      label: "Approve breakdown",
      description: "Approve the task breakdown or request a concrete revision.",
      context: [
        { label: "Epic brief", value: "{{brief}}", display: "markdown" },
        { label: "Task breakdown", value: "{{previous}}", display: "json" },
      ],
      actions: [
        { id: "approve", label: "Approve breakdown", intent: "primary", fields: [] },
        {
          id: "revise",
          label: "Request revision",
          intent: "default",
          fields: [
            {
              id: "comment",
              type: "textarea",
              label: "Revision comment",
              required: true,
            },
          ],
        },
      ],
    }),
  ],
  until: { source: "plan_review", equals: { action: "approve", values: {} } },
});
const approvedTasks = transform({
  id: "extract",
  label: "Extract approved tasks",
  file: "scripts/extract-approved-tasks.mjs",
  inputs: { breakdown },
});
const details = map({
  id: "details",
  label: "Detail approved tasks",
  source: approvedTasks,
  inputs: { brief: ref("inputs.epic_brief") },
  maxItems: 10,
  onItemFailure: "skip",
  steps: [
    agent({
      id: "detail_one",
      label: "Detail task",
      output: "json",
      prompt: "Detail exactly this approved task. Return only JSON shaped {id, title, scope, nonGoals, acceptanceCriteria, dependencies}. Do not estimate effort or own decisions assigned to dependencies. Epic: {{brief}} Task: {{item}}",
    }),
  ],
});
const plan = agent({
  id: "plan",
  label: "Assemble final plan",
  inputs: { details },
  prompt: "Assemble a dependency-ordered epic plan from the detailed tasks. Preserve full acceptance criteria and end with Coverage listing every failed or missing task. Details: {{details}}",
});
completeCycle({ id: "complete", outcome: "planned", inputs: { plan } });
`,
  ),
];
