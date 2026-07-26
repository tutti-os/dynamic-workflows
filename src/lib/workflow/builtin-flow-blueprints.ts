import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";
import type { WorkflowBlueprintDetail } from "./blueprint-types";
import { PRESERVED_FLOW_V1_BLUEPRINTS } from "./preserved-flow-blueprints";

export const BUILTIN_FLOW_V1_BLUEPRINTS: WorkflowBlueprintDetail[] = [
  ...PRESERVED_FLOW_V1_BLUEPRINTS,
  {
    id: "large-file-governance-v1",
    title: "Large File Governance Loop",
    description:
      "Periodically refactors one oversized file, runs an adversarial RD and QA acceptance loop, asks a Human to review the evidence, then opens and tracks a pull request.",
    category: "coding",
    tags: [
      "large-file",
      "github",
      "issue",
      "pull-request",
      "schedule",
      "memory",
      "acceptance",
      "human-review",
    ],
    difficulty: "advanced",
    requiresCwd: true,
    schemaVersion: "tutti.flow.v1",
    capabilities: [
      "schedule",
      "effect",
      "gate",
      "agent",
      "memory",
      "worktree",
      "finally",
      "immediate-continuation",
      "github-cli",
      "loop",
      "json-output",
      "review-isolation",
      "human",
    ],
    patternSummary:
      "A scheduled singleton Cycle plans and implements one refactor in an isolated worktree. An independent QA Agent reviews repository truth first; failures send only explicit blockers to an RD repair Agent. QA PASS produces a structured evidence package for a Human delivery gate before any commit, push, or pull-request mutation.",
    useCases: [
      "Continuously reduce monolithic source files without spending Agent tokens while approvals or merges are pending.",
      "Make RD repairs and adversarial QA findings visible before delivery.",
      "Give a Human one compact final-artifact review package before any commit or pull request.",
      "Use as a complete Bundle template for scheduled governance automations.",
    ],
    bundle: createFlowV1Bundle([
      {
        path: "flow.js",
        content: `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Large File Governance Loop",
  description: "Find, refactor, adversarially accept, Human-review, and merge one oversized file per Cycle.",
  requiresCwd: true,
};
export const params = defineParams({
  scanCron: cronParam({ default: "0 0 * * *" }),
  timezone: stringParam({ default: "UTC" }),
  mainBranch: stringParam({ default: "main", minLength: 1 }),
  lineThreshold: numberParam({ default: 1200, min: 1, integer: true }),
  scanRoot: stringParam({ default: "" }),
  approvalLabel: stringParam({ default: "flow-approved", minLength: 1, maxLength: 50 }),
  maxAcceptanceRounds: numberParam({ default: 3, min: 1, max: 10, integer: true }),
  qaAgent: stringParam({ default: "" }),
  qaModel: stringParam({ default: "" }),
  qaPermission: stringParam({ default: "" }),
});
export const secrets = defineSecrets({
  GH_TOKEN: connectionSecret({ provider: "github", required: false }),
});
export const cycles = defineCycles({ mode: "singleton" });
export const runtime = {
  maxNodeExecutionsPerTick: 60,
  maxImmediateContinuations: 1,
  maxParallelNodes: 2,
};
export const schedule = cron({
  id: "maintenance",
  expression: ref("params.scanCron"),
  timezone: ref("params.timezone"),
  catchUp: "latest",
  overlap: "coalesce-latest",
});
export const memory = defineMemory({
  sections: {
    currentUnderstanding: {
      title: "Current Understanding",
      update: "replace",
    },
    timeline: {
      title: "Timeline",
      update: "append",
    },
    decisions: {
      title: "Decisions",
      update: "append",
    },
  },
});

const preflight = script({
  id: "preflight_environment",
  file: "scripts/preflight-environment.mjs",
  inputs: { branch: ref("params.mainBranch") },
});
const sync = effect({
  id: "sync_main",
  file: "scripts/sync-main.mjs",
  inputs: { preflight, branch: ref("params.mainBranch") },
  idempotencyKey: template("{{cycle.id}}:sync-main"),
});
const candidate = script({
  id: "find_large_file",
  file: "scripts/find-large-file.mjs",
  outcomes: ["found", "empty"],
  inputs: {
    sync,
    threshold: ref("params.lineThreshold"),
    root: ref("params.scanRoot"),
  },
});
const noWork = completeCycle({
  id: "no_work",
  outcome: "no_work",
  continue: "scheduled",
  inputs: { candidate },
});
const deliveryReady = script({
  id: "preflight_delivery",
  file: "scripts/preflight-delivery.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { candidate, preflight },
});
const approvalLabel = effect({
  id: "ensure_approval_label",
  file: "scripts/ensure-approval-label.mjs",
  secrets: ["GH_TOKEN"],
  inputs: {
    deliveryReady,
    label: ref("params.approvalLabel"),
  },
  idempotencyKey: template("{{cycle.id}}:ensure-approval-label"),
});
const plan = agent({
  id: "plan_refactor",
  inputs: { approvalLabel, candidate, deliveryReady },
  memory: { include: ["currentUnderstanding"] },
  output: json({ schema: {
    type: "object",
    required: ["title", "rationale", "boundaries", "orderedSteps", "tests", "risks"],
    properties: {
      title: { type: "string" },
      rationale: { type: "string" },
      boundaries: { type: "array", items: { type: "string" } },
      orderedSteps: { type: "array", items: { type: "string" } },
      tests: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
    },
  } }),
  prompt: "Inspect {{candidate.path}} ({{candidate.lines}} lines). Return one JSON object with string fields title and rationale, plus boundaries, orderedSteps, tests, and risks as arrays of strings. Do not edit files.",
});
const issue = effect({
  id: "create_issue",
  file: "scripts/create-issue.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { approvalLabel, candidate, plan },
  idempotencyKey: template("{{cycle.id}}:create-issue"),
});
const approval = gate({
  id: "wait_issue_approval",
  file: "scripts/issue-approval.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { issue },
  outcomes: ["approved", "rejected"],
});
const workspace = effect({
  id: "prepare_workspace",
  file: "scripts/prepare-worktree.mjs",
  inputs: {
    approval,
    candidate,
    sync,
    mainBranch: ref("params.mainBranch"),
  },
  idempotencyKey: template("{{cycle.id}}:prepare-workspace"),
});
const implement = agent({
  id: "implement_plan",
  label: "RD implement approved plan",
  inputs: {
    candidate,
    plan,
    approval,
    workspace,
    lineThreshold: ref("params.lineThreshold"),
  },
  workspace,
  execution: { access: "write", isolation: "required" },
  session: { mode: "inherit", key: "rd_room" },
  prompt: "Work only inside the prepared git worktree at {{workspace.path}} on branch {{workspace.branch}}. Implement the approved refactor plan for {{candidate.path}} and reduce it to at most {{lineThreshold}} lines without weakening behavior. Follow {{plan}} and run the smallest focused tests that cover the change. Do not install dependencies or run repository-wide checks unless the focused test cannot otherwise run. Leave the worktree ready for review and do not modify the parent checkout.",
});
const acceptance = loop({
  id: "rd_qa_acceptance",
  label: "RD + QA adversarial acceptance",
  inputs: {
    candidate,
    plan,
    approval,
    implement,
    workspace,
    lineThreshold: ref("params.lineThreshold"),
  },
  workspace,
  execution: { access: "write", isolation: "required" },
  maxIterations: ref("params.maxAcceptanceRounds"),
  onMaxIterations: "complete",
  firstIteration: { startAt: "qa_review" },
  steps: [
    agent({
      id: "rd_repair",
      label: "RD repair QA blockers",
      session: { mode: "inherit", key: "rd_room" },
      prompt: "Act as the RD owner inside the prepared worktree at {{workspace.path}}. Repair only the blocking findings from the previous QA iteration while preserving the approved boundaries and behavior. Re-inspect repository truth, keep {{candidate.path}} at or below {{lineThreshold}} lines, run focused checks, and leave all changes uncommitted. Do not dismiss blockers without evidence. Approved plan: {{plan}} QA blockers: {{previousIteration.outputs.qa_review.blockers}} QA suggestions: {{previousIteration.outputs.qa_review.suggestions}}",
      appendPrompt: "Continue in the same RD session and prepared worktree. Re-anchor on git status, git diff, and the files implicated by QA; repository truth overrides stale session memory. Repair only the latest blocking findings, preserve the approved scope, run focused checks, and leave changes uncommitted. QA blockers: {{previousIteration.outputs.qa_review.blockers}} QA suggestions: {{previousIteration.outputs.qa_review.suggestions}}",
    }),
    agent({
      id: "qa_review",
      label: "Adversarial QA acceptance",
      agent: ref("params.qaAgent"),
      model: ref("params.qaModel"),
      permissionMode: ref("params.qaPermission"),
      session: { mode: "independent" },
      execution: { access: "review", isolation: "shared" },
      output: json({ schema: {
        type: "object",
        required: ["status", "criteria", "blockers", "suggestions", "risks", "checks", "evidence", "unverified"],
        properties: {
          status: { enum: ["PASS", "FAIL"] },
          criteria: { type: "array", items: { type: "string" } },
          blockers: { type: "array", items: { type: "string" } },
          suggestions: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          checks: { type: "array", items: { type: "string" } },
          evidence: { type: "array", items: { type: "string" } },
          unverified: { type: "array", items: { type: "string" } },
        },
      } }),
      prompt: "Act as adversarial QA in a fresh independent session, using the prepared worktree at {{workspace.path}} as repository truth. Judge the approved plan, behavior preservation, the {{lineThreshold}}-line limit for {{candidate.path}}, edge cases, and focused test results; do not consume or trust any RD narrative. Reuse the previous criteria when the requirement is unchanged and re-check every previous blocker. On intermediate FAIL rounds, focus on blocker repairs, their impact area, and all new diff; before PASS, cover the complete change surface and required checks. PASS only when there are no blocking defects and every required claim is supported. Return valid JSON with status PASS or FAIL plus criteria, blockers, suggestions, risks, checks, evidence, and unverified arrays. Approved plan: {{plan}} Previous QA criteria: {{previousStep.criteria}} Previous QA blockers: {{previousStep.blockers}}",
    }),
  ],
  until: { source: "qa_review", finalStatus: "PASS" },
});
const reviewPackage = agent({
  id: "prepare_human_review",
  label: "Prepare Human review package",
  inputs: {
    candidate,
    plan,
    acceptance,
    workspace,
    lineThreshold: ref("params.lineThreshold"),
  },
  workspace,
  execution: { access: "read", isolation: "required" },
  output: json({ schema: {
    type: "object",
    required: [
      "title",
      "summary",
      "changedFiles",
      "checks",
      "qaEvidence",
      "residualRisks",
      "unverified",
    ],
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      changedFiles: { type: "array", items: { type: "string" } },
      checks: { type: "array", items: { type: "string" } },
      qaEvidence: { type: "array", items: { type: "string" } },
      residualRisks: { type: "array", items: { type: "string" } },
      unverified: { type: "array", items: { type: "string" } },
    },
  } }),
  prompt: "Prepare a compact, evidence-first package for a Human reviewer. Inspect the final worktree diff against {{workspace.baseCommit}} and the accepted QA record. Report the behavioral intent, exact changed files, checks with results, proof that {{candidate.path}} is at or below {{lineThreshold}} lines, QA evidence, residual risks, and anything unverified. Do not modify files or perform Git/GitHub mutations. Approved plan: {{plan}} Acceptance: {{acceptance}}",
});
const humanReview = human({
  id: "human_delivery_review",
  label: "Human final-artifact review",
  description: "Review the final diff and RD + QA evidence before any commit, push, or pull request.",
  inputs: { candidate, plan, acceptance, reviewPackage, workspace },
  context: [
    { label: "Candidate", value: "{{candidate}}", display: "json" },
    { label: "Approved plan", value: "{{plan}}", display: "json" },
    { label: "RD + QA acceptance", value: "{{acceptance}}", display: "json" },
    { label: "Final review package", value: "{{reviewPackage}}", display: "json" },
    { label: "Review worktree", value: "{{workspace}}", display: "json" },
  ],
  actions: [
    {
      id: "approve_delivery",
      label: "Approve delivery",
      intent: "primary",
      fields: [
        {
          id: "rationale",
          type: "textarea",
          label: "Approval rationale",
          required: true,
        },
      ],
    },
    {
      id: "reject_delivery",
      label: "Reject delivery",
      intent: "danger",
      fields: [
        {
          id: "reason",
          type: "textarea",
          label: "Blocking reason",
          required: true,
        },
      ],
    },
  ],
});
const notAccepted = agent({
  id: "qa_not_accepted_report",
  label: "Report remaining QA blockers",
  inputs: { candidate, plan, acceptance, workspace },
  workspace,
  execution: { access: "read", isolation: "required" },
  output: "json",
  prompt: "Inspect repository truth and return valid JSON with result not_accepted, the changed files, remaining QA blockers, checks, risks, and unverified areas. Do not commit, push, or create a pull request. Candidate: {{candidate}} Approved plan: {{plan}} Acceptance: {{acceptance}}",
});
const closeNotAcceptedIssue = effect({
  id: "close_qa_not_accepted_issue",
  file: "scripts/resolve-issue.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { issue, notAccepted },
  idempotencyKey: template("{{cycle.id}}:close-qa-not-accepted"),
});
const qaNotAccepted = completeCycle({
  id: "qa_not_accepted",
  outcome: "qa_not_accepted",
  inputs: { closeNotAcceptedIssue, notAccepted },
  continue: "scheduled",
});
const closeHumanRejectedIssue = effect({
  id: "close_human_rejected_issue",
  file: "scripts/resolve-issue.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { issue, humanReview, reviewPackage },
  idempotencyKey: template("{{cycle.id}}:close-human-rejected"),
});
const humanRejected = completeCycle({
  id: "human_rejected",
  outcome: "human_rejected",
  inputs: { closeHumanRejectedIssue, humanReview, reviewPackage },
  continue: "scheduled",
});
const changes = script({
  id: "check_changes",
  file: "scripts/check-changes.mjs",
  inputs: { implement, acceptance, reviewPackage, humanReview, workspace },
  workspace,
  execution: { access: "read", isolation: "required" },
  outcomes: ["changed", "no_changes"],
});
const commit = effect({
  id: "commit_changes",
  file: "scripts/commit-changes.mjs",
  inputs: { changes, candidate, workspace },
  workspace,
  execution: { access: "write", isolation: "required" },
  idempotencyKey: template("{{cycle.id}}:commit"),
});
const push = effect({
  id: "push_branch",
  file: "scripts/push-branch.mjs",
  inputs: { commit, workspace },
  workspace,
  execution: { access: "write", isolation: "required" },
  idempotencyKey: template("{{cycle.id}}:push"),
});
const pullRequest = effect({
  id: "create_pull_request",
  file: "scripts/create-pr.mjs",
  secrets: ["GH_TOKEN"],
  inputs: {
    issue,
    candidate,
    plan,
    acceptance,
    reviewPackage,
    humanReview,
    commit,
    push,
    workspace,
    mainBranch: ref("params.mainBranch"),
  },
  workspace,
  execution: { access: "write", isolation: "required" },
  idempotencyKey: template("{{cycle.id}}:create-pr"),
});
const noChangesIssue = effect({
  id: "close_no_changes_issue",
  file: "scripts/resolve-issue.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { issue, changes },
  idempotencyKey: template("{{cycle.id}}:close-no-changes"),
});
const noChanges = completeCycle({
  id: "no_changes",
  outcome: "no_changes",
  continue: "scheduled",
  inputs: { noChangesIssue },
});
const merged = gate({
  id: "wait_pull_request_merge",
  file: "scripts/pr-merged.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { pullRequest },
  outcomes: ["merged", "closed"],
});
const closeIssue = effect({
  id: "close_issue",
  file: "scripts/close-issue.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { issue, pullRequest, merged },
  idempotencyKey: template("{{cycle.id}}:close-issue"),
});
const memoryUpdate = transform({
  id: "build_memory_update",
  file: "scripts/build-memory-update.mjs",
  inputs: { candidate, plan, issue, pullRequest, merged, closeIssue },
});
const rememberResult = remember({
  id: "remember_result",
  inputs: { memoryUpdate },
  updates: {
    currentUnderstanding: {
      mode: "replace",
      value: ref("memoryUpdate.currentUnderstanding"),
    },
    timeline: {
      mode: "append",
      value: ref("memoryUpdate.timeline"),
    },
    decisions: {
      mode: "append",
      value: ref("memoryUpdate.decision"),
    },
  },
});
const complete = completeCycle({
  id: "complete",
  outcome: "delivered",
  inputs: { rememberResult },
  continue: "immediate",
});
const rejected = cancelCycle({
  id: "rejected",
  outcome: "plan_rejected",
  inputs: { approval },
  continue: "scheduled",
});
const rejectedDeliveryIssue = effect({
  id: "close_rejected_delivery_issue",
  file: "scripts/resolve-issue.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { issue, pullRequest, merged },
  idempotencyKey: template("{{cycle.id}}:close-rejected-delivery"),
});
const pullRequestClosed = completeCycle({
  id: "pull_request_closed",
  outcome: "delivery_rejected",
  inputs: { rejectedDeliveryIssue, merged },
  continue: "scheduled",
});
finalize({
  id: "cleanup_workspace",
  file: "scripts/cleanup-worktree.mjs",
  runOn: ["completed", "failed", "canceled"],
  retainOnFailure: true,
});
route(approval, { approved: workspace, rejected });
route(acceptance, {
  matched: reviewPackage,
  exhausted: notAccepted,
});
route(humanReview, {
  approve_delivery: changes,
  reject_delivery: closeHumanRejectedIssue,
});
route(changes, { changed: commit, no_changes: noChangesIssue });
route(merged, { merged: closeIssue, closed: rejectedDeliveryIssue });
route(candidate, { found: deliveryReady, empty: noWork });
`,
      },
      {
        path: "memory.template.md",
        content: `# Flow Memory

<!-- flow-memory:section:currentUnderstanding:start -->
No file has been refactored yet.
<!-- flow-memory:section:currentUnderstanding:end -->

<!-- flow-memory:section:timeline:start -->
<!-- flow-memory:section:timeline:end -->

<!-- flow-memory:section:decisions:start -->
<!-- flow-memory:section:decisions:end -->
`,
      },
      {
        path: "scripts/build-memory-update.mjs",
        content: `export async function run(ctx) {
  const currentUnderstanding = [
    "Last completed candidate: " + ctx.candidate.path + " (" + ctx.candidate.lines + " lines before refactor)",
    "Plan: " + ctx.plan.title,
    "Issue: " + ctx.issue.url,
    "Pull request: " + ctx.pullRequest.url,
    "Merged: " + Boolean(ctx.merged?.mergedAt),
  ].join("\\n");
  return {
    currentUnderstanding,
    decision: "Cycle " + ctx.cycle.id + ": " + ctx.plan.title + " for " + ctx.candidate.path,
    timeline: "Cycle " + ctx.cycle.id + ": merged " + ctx.pullRequest.url,
  };
}
`,
      },
      {
        path: "scripts/preflight-environment.mjs",
        content: `import { execFileSync } from "node:child_process";
function exec(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error("Preflight failed while running " + command + " " + args.join(" ") + ": " + detail);
  }
}
function repositoryFromRemote(url) {
  const match = url.match(/github\\.com[/:]([^/]+)\\/([^/]+?)(?:\\.git)?$/u);
  if (!match) throw new Error("Preflight requires origin to point to a GitHub repository.");
  return match[1] + "/" + match[2];
}
export async function run(ctx) {
  exec("git", ["--version"]);
  if (exec("git", ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error("Preflight requires the configured cwd to be a git worktree.");
  }
  const remoteUrl = exec("git", ["remote", "get-url", "origin"]);
  const repository = repositoryFromRemote(remoteUrl);
  return {
    branch: ctx.branch,
    remote: "origin",
    repository,
  };
}
`,
      },
      {
        path: "scripts/preflight-delivery.mjs",
        content: `import { execFileSync } from "node:child_process";
function exec(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error("Delivery preflight failed while running " + command + " " + args.join(" ") + ": " + detail);
  }
}
export async function run(ctx) {
  exec("git", ["config", "--get", "user.name"]);
  exec("git", ["config", "--get", "user.email"]);
  exec("gh", ["auth", "status"]);
  return {
    repository: ctx.preflight.repository,
  };
}
`,
      },
      {
        path: "scripts/sync-main.mjs",
        content: `import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
function marker(ctx) {
  const commonDir = path.resolve(process.cwd(), git(["rev-parse", "--git-common-dir"]));
  return path.join(commonDir, "tutti-flow-state", "sync-" + ctx.cycle.id + ".json");
}
export async function apply(ctx) {
  git(["fetch", "origin", ctx.branch]);
  const output = { branch: ctx.branch, commit: git(["rev-parse", "origin/" + ctx.branch]) };
  const file = marker(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(output));
  fs.renameSync(file + ".tmp", file);
  return { externalRef: file, output };
}
export async function reconcile(ctx) {
  try {
    const output = JSON.parse(fs.readFileSync(marker(ctx), "utf8"));
    return output.branch === ctx.branch && typeof output.commit === "string"
      ? { status: "completed", externalRef: marker(ctx), output }
      : { status: "unknown", reason: "Sync marker does not match the requested branch." };
  } catch {
    return { status: "not_applied" };
  }
}
`,
      },
      {
        path: "scripts/find-large-file.mjs",
        content: `import { execFileSync } from "node:child_process";
import path from "node:path";
const extensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"]);
const ignoredDirectory = /(?:^|\\/)(?:node_modules|\\.next|dist|build|coverage|vendor|generated|__tests__|tests?)(?:\\/|$)/u;
const ignoredFile = /(?:^|\\/)[^/]+\\.(?:test|spec|gen|generated)\\.[^/]+$/u;
function gitLineCounts(commit) {
  let output = "";
  try {
    output = execFileSync(
      "git",
      ["grep", "-I", "--count", "-e", "^", commit, "--"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    if (error?.status !== 1) throw error;
    output = String(error?.stdout || "");
  }
  const prefix = commit + ":";
  return output
    .trim()
    .split(/\\r?\\n/u)
    .flatMap((line) => {
      if (!line.startsWith(prefix)) return [];
      const separator = line.lastIndexOf(":");
      const lines = Number(line.slice(separator + 1));
      return Number.isInteger(lines)
        ? [{ path: line.slice(prefix.length, separator), lines }]
        : [];
    });
}
export async function run(ctx) {
  const root = String(ctx.root ?? "")
    .replace(/^\\.\\//u, "")
    .replace(/\\/+$/u, "");
  const candidate = gitLineCounts(ctx.sync.commit)
    .filter((file) =>
      (!root || file.path === root || file.path.startsWith(root + "/")) &&
      !ignoredDirectory.test(file.path) &&
      !ignoredFile.test(file.path) &&
      extensions.has(path.extname(file.path))
    )
    .filter((file) => file.lines > ctx.threshold)
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path))[0];
  return candidate
    ? { outcome: "found", output: candidate }
    : { outcome: "empty", output: { reason: "No source file exceeds the configured threshold." } };
}
`,
      },
      {
        path: "scripts/ensure-approval-label.mjs",
        content: `import { execFileSync } from "node:child_process";
function gh(args) { return execFileSync("gh", args, { encoding: "utf8" }).trim(); }
function apiPath(ctx) {
  return "repos/" + ctx.deliveryReady.repository + "/labels/" + encodeURIComponent(ctx.label);
}
function output(ctx) {
  return { name: ctx.label, repository: ctx.deliveryReady.repository };
}
function labelExists(ctx) {
  try {
    gh(["api", apiPath(ctx)]);
    return true;
  } catch (error) {
    const message = String(error?.stderr || error?.message || error);
    if (/HTTP 404|Not Found/iu.test(message)) return false;
    throw error;
  }
}
export async function apply(ctx) {
  if (!labelExists(ctx)) {
    gh([
      "label",
      "create",
      ctx.label,
      "--repo",
      ctx.deliveryReady.repository,
      "--color",
      "1D76DB",
      "--description",
      "Approve a Tutti Flow plan for execution",
    ]);
  }
  return {
    externalRef: ctx.deliveryReady.repository + ":" + ctx.label,
    output: output(ctx),
  };
}
export async function reconcile(ctx) {
  if (labelExists(ctx)) {
    return {
      status: "completed",
      externalRef: ctx.deliveryReady.repository + ":" + ctx.label,
      output: output(ctx),
    };
  }
  return { status: "not_applied" };
}
`,
      },
      {
        path: "scripts/create-issue.mjs",
        content: `import { execFileSync } from "node:child_process";
function gh(args) { return execFileSync("gh", args, { encoding: "utf8" }).trim(); }
function bullets(values, prefix = "- ") {
  return values.map((value, index) => prefix === "1. " ? (index + 1) + ". " + value : prefix + value).join("\\n");
}
export async function apply(ctx) {
  const marker = "[flow:" + ctx.cycle.id + "]";
  const title = marker + " Refactor " + ctx.candidate.path;
  const body = [
    "## Candidate",
    "\`" + ctx.candidate.path + "\` — " + ctx.candidate.lines + " lines",
    "",
    "## Rationale",
    ctx.plan.rationale,
    "",
    "## Boundaries",
    bullets(ctx.plan.boundaries),
    "",
    "## Plan",
    bullets(ctx.plan.orderedSteps, "1. "),
    "",
    "## Validation",
    bullets(ctx.plan.tests, "- [ ] "),
    "",
    "## Risks",
    bullets(ctx.plan.risks),
    "",
    "Add the \`" + ctx.approvalLabel.name + "\` label to approve this plan.",
  ].join("\\n");
  const url = gh(["issue", "create", "--title", title, "--body", body]);
  return { externalRef: url, output: { url, title, marker, approvalLabel: ctx.approvalLabel.name } };
}
export async function reconcile(ctx) {
  const marker = "[flow:" + ctx.cycle.id + "]";
  const raw = gh(["issue", "list", "--state", "all", "--search", marker + " in:title", "--json", "url,title"]);
  const issue = JSON.parse(raw)[0];
  return issue
    ? { status: "completed", externalRef: issue.url, output: { ...issue, marker, approvalLabel: ctx.approvalLabel.name } }
    : { status: "not_applied" };
}
`,
      },
      {
        path: "scripts/issue-approval.mjs",
        content: `import { execFileSync } from "node:child_process";
function issueApiPath(url) {
  const [owner, repo, kind, number] = new URL(url).pathname.split("/").filter(Boolean);
  if (!owner || !repo || kind !== "issues" || !number) throw new Error("Invalid GitHub Issue URL: " + url);
  return "repos/" + owner + "/" + repo + "/issues/" + number;
}
function isTransient(error) {
  const message = String(error?.stderr || error?.message || error);
  return /\\b(?:EOF|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\\b|timed? out|connection reset|TLS handshake|HTTP (?:408|429|5\\d\\d)|rate limit/iu.test(message);
}
export async function check(ctx) {
  const apiPath = issueApiPath(ctx.issue.url);
  try {
    const issue = JSON.parse(execFileSync("gh", ["api", apiPath], { encoding: "utf8" }));
    const output = { state: issue.state, labels: issue.labels, url: issue.html_url };
    if (issue.state === "closed") return { status: "completed", outcome: "rejected", output };
    const approved = issue.labels.some((label) => label.name === ctx.issue.approvalLabel);
    return approved
      ? { status: "completed", outcome: "approved", output }
      : { status: "waiting", reason: "Add the " + ctx.issue.approvalLabel + " label to approve the Issue plan." };
  } catch (error) {
    if (isTransient(error)) {
      return { status: "waiting", reason: "GitHub Issue status is temporarily unavailable; retry on the next Tick." };
    }
    throw error;
  }
}
`,
      },
      {
        path: "scripts/prepare-worktree.mjs",
        content: `import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
function git(args, cwd = process.cwd()) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function identity(ctx) {
  const root = path.join(process.cwd(), ".tutti-flow-worktrees");
  return {
    root,
    path: path.join(root, "cycle-" + ctx.cycle.id),
    branch: "flow/large-file-" + ctx.cycle.id.slice(0, 12),
  };
}
export async function apply(ctx) {
  const workspace = identity(ctx);
  fs.mkdirSync(workspace.root, { recursive: true });
  if (!fs.existsSync(workspace.path)) {
    git([
      "worktree",
      "add",
      "-B",
      workspace.branch,
      workspace.path,
      ctx.sync.commit,
    ]);
  }
  return {
    externalRef: workspace.path,
    output: {
      path: workspace.path,
      branch: workspace.branch,
      baseCommit: git(["rev-parse", "HEAD"], workspace.path),
    },
  };
}
export async function reconcile(ctx) {
  const workspace = identity(ctx);
  if (!fs.existsSync(workspace.path)) return { status: "not_applied" };
  try {
    return {
      status: "completed",
      externalRef: workspace.path,
      output: {
        path: workspace.path,
        branch: workspace.branch,
        baseCommit: git(["rev-parse", "HEAD"], workspace.path),
      },
    };
  } catch {
    return {
      status: "unknown",
      reason: "Worktree path exists but is not a readable git worktree.",
    };
  }
}
`,
      },
      {
        path: "scripts/check-changes.mjs",
        content: `import { execFileSync } from "node:child_process";
function git(args) { return execFileSync("git", args, { encoding: "utf8" }).trim(); }
export async function run() {
  const status = git(["status", "--porcelain"]);
  return status
    ? { outcome: "changed", output: { status } }
    : { outcome: "no_changes", output: { reason: "Implementation produced no repository changes." } };
}
`,
      },
      {
        path: "scripts/commit-changes.mjs",
        content: `import { execFileSync } from "node:child_process";
function git(args) { return execFileSync("git", args, { encoding: "utf8" }).trim(); }
function marker(ctx) { return "Flow-Cycle: " + ctx.cycle.id; }
export async function apply(ctx) {
  git(["add", "-A"]);
  git(["commit", "-s", "-m", "refactor: split " + ctx.candidate.path, "-m", marker(ctx)]);
  return { externalRef: git(["rev-parse", "HEAD"]), output: { sha: git(["rev-parse", "HEAD"]) } };
}
export async function reconcile(ctx) {
  const records = git(["log", "-n", "100", "--format=%H%x00%B%x00"]).split("\\u0000");
  for (let index = 0; index + 1 < records.length; index += 2) {
    if (records[index + 1].includes(marker(ctx))) {
      return { status: "completed", externalRef: records[index], output: { sha: records[index] } };
    }
  }
  return { status: "not_applied" };
}
`,
      },
      {
        path: "scripts/push-branch.mjs",
        content: `import { execFileSync } from "node:child_process";
function git(args) { return execFileSync("git", args, { encoding: "utf8" }).trim(); }
function remoteSha(branch) {
  const line = git(["ls-remote", "origin", "refs/heads/" + branch]);
  return line ? line.split(/\\s+/u)[0] : "";
}
export async function apply(ctx) {
  git(["push", "-u", "origin", ctx.commit.sha + ":refs/heads/" + ctx.workspace.branch]);
  return { externalRef: ctx.workspace.branch, output: { branch: ctx.workspace.branch, sha: ctx.commit.sha } };
}
export async function reconcile(ctx) {
  return remoteSha(ctx.workspace.branch) === ctx.commit.sha
    ? { status: "completed", externalRef: ctx.workspace.branch, output: { branch: ctx.workspace.branch, sha: ctx.commit.sha } }
    : { status: "not_applied" };
}
`,
      },
      {
        path: "scripts/create-pr.mjs",
        content: `import { execFileSync } from "node:child_process";
function run(command, args, cwd = process.cwd()) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}
export async function apply(ctx) {
  const body = [
    "## Summary",
    ctx.plan.title,
    "",
    "Refactors \`" + ctx.candidate.path + "\` from its previous " + ctx.candidate.lines + "-line form.",
    "",
    "## Validation plan",
    ctx.plan.tests.map((test) => "- " + test).join("\\n"),
    "",
    "## Accepted validation evidence",
    ctx.reviewPackage.checks.map((check) => "- " + check).join("\\n"),
    "",
    "## QA evidence",
    ctx.reviewPackage.qaEvidence.map((item) => "- " + item).join("\\n"),
    "",
    "## Residual risks",
    ctx.reviewPackage.residualRisks.length
      ? ctx.reviewPackage.residualRisks.map((risk) => "- " + risk).join("\\n")
      : "- None reported",
    "",
    "Human delivery review: approved." +
      (ctx.humanReview.values?.rationale
        ? " Rationale: " + ctx.humanReview.values.rationale
        : ""),
    "",
    "Closes " + ctx.issue.url,
  ].join("\\n");
  const url = run("gh", ["pr", "create", "--head", ctx.push.branch, "--base", ctx.mainBranch, "--title", "Refactor " + ctx.candidate.path, "--body", body]);
  return {
    externalRef: url,
    output: { url, branch: ctx.push.branch, commit: ctx.commit.sha },
  };
}
export async function reconcile(ctx) {
  const branch = ctx.push.branch;
  const raw = run("gh", ["pr", "list", "--state", "all", "--head", branch, "--json", "url,headRefName"]);
  const pullRequest = JSON.parse(raw)[0];
  return pullRequest
    ? { status: "completed", externalRef: pullRequest.url, output: { url: pullRequest.url, branch } }
    : { status: "not_applied" };
}
`,
      },
      {
        path: "scripts/resolve-issue.mjs",
        content: `import { execFileSync } from "node:child_process";
function gh(args) { return execFileSync("gh", args, { encoding: "utf8" }).trim(); }
function issueApiPath(url) {
  const [owner, repo, kind, number] = new URL(url).pathname.split("/").filter(Boolean);
  if (!owner || !repo || kind !== "issues" || !number) throw new Error("Invalid GitHub Issue URL: " + url);
  return "repos/" + owner + "/" + repo + "/issues/" + number;
}
function reason(ctx) {
  if (ctx.pullRequest?.url) {
    return "Pull request was closed without merge: " + ctx.pullRequest.url;
  }
  if (ctx.humanReview) {
    const detail = ctx.humanReview.values?.reason || ctx.humanReview.reason || "No reason recorded.";
    return "Human rejected the final artifact before delivery: " + detail;
  }
  if (ctx.notAccepted) {
    const blockers = ctx.notAccepted.remainingBlockers || ctx.notAccepted.blockers || [];
    const detail = Array.isArray(blockers) && blockers.length
      ? " Remaining blockers: " + blockers.slice(0, 8).join("; ")
      : "";
    return "RD + QA acceptance exhausted its iteration budget without PASS." + detail;
  }
  return "Implementation produced no repository changes.";
}
export async function apply(ctx) {
  gh(["issue", "close", ctx.issue.url, "--comment", reason(ctx)]);
  return { externalRef: ctx.issue.url, output: { url: ctx.issue.url, closed: true, reason: reason(ctx) } };
}
export async function reconcile(ctx) {
  const issue = JSON.parse(gh(["api", issueApiPath(ctx.issue.url)]));
  return issue.state === "closed"
    ? { status: "completed", externalRef: issue.html_url, output: { url: issue.html_url, closed: true } }
    : { status: "not_applied" };
}
`,
      },
      {
        path: "scripts/cleanup-worktree.mjs",
        content: `import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
export async function run(ctx) {
  const branch = "flow/large-file-" + ctx.cycle.id.slice(0, 12);
  const workspace = path.join(
    process.cwd(),
    ".tutti-flow-worktrees",
    "cycle-" + ctx.cycle.id,
  );
  if (fs.existsSync(workspace)) {
    execFileSync("git", ["worktree", "remove", "--force", workspace], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  }
  execFileSync("git", ["worktree", "prune"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  try {
    execFileSync("git", ["branch", "-D", branch], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  } catch {}
  const commonDir = path.resolve(
    process.cwd(),
    execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim(),
  );
  fs.rmSync(
    path.join(commonDir, "tutti-flow-state", "sync-" + ctx.cycle.id + ".json"),
    { force: true },
  );
  return {
    cleaned: true,
    workspace,
    branch,
    terminalStatus: ctx.terminal.status,
  };
}
`,
      },
      {
        path: "scripts/pr-merged.mjs",
        content: `import { execFileSync } from "node:child_process";
function pullRequestApiPath(url) {
  const [owner, repo, kind, number] = new URL(url).pathname.split("/").filter(Boolean);
  if (!owner || !repo || kind !== "pull" || !number) throw new Error("Invalid GitHub Pull Request URL: " + url);
  return "repos/" + owner + "/" + repo + "/pulls/" + number;
}
function isTransient(error) {
  const message = String(error?.stderr || error?.message || error);
  return /\\b(?:EOF|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\\b|timed? out|connection reset|TLS handshake|HTTP (?:408|429|5\\d\\d)|rate limit/iu.test(message);
}
export async function check(ctx) {
  const apiPath = pullRequestApiPath(ctx.pullRequest.url);
  try {
    const pr = JSON.parse(execFileSync("gh", ["api", apiPath], { encoding: "utf8" }));
    const output = { state: pr.state, mergedAt: pr.merged_at, url: pr.html_url };
    if (pr.merged_at) return { status: "completed", outcome: "merged", output };
    if (pr.state === "closed") return { status: "completed", outcome: "closed", output };
    return { status: "waiting", reason: "Pull request is still open." };
  } catch (error) {
    if (isTransient(error)) {
      return { status: "waiting", reason: "GitHub Pull Request status is temporarily unavailable; retry on the next Tick." };
    }
    throw error;
  }
}
`,
      },
      {
        path: "scripts/close-issue.mjs",
        content: `import { execFileSync } from "node:child_process";
function gh(args) { return execFileSync("gh", args, { encoding: "utf8" }).trim(); }
function issueApiPath(url) {
  const [owner, repo, kind, number] = new URL(url).pathname.split("/").filter(Boolean);
  if (!owner || !repo || kind !== "issues" || !number) throw new Error("Invalid GitHub Issue URL: " + url);
  return "repos/" + owner + "/" + repo + "/issues/" + number;
}
export async function apply(ctx) {
  gh(["issue", "close", ctx.issue.url, "--comment", "Merged via " + ctx.pullRequest.url]);
  return { externalRef: ctx.issue.url, output: { url: ctx.issue.url, closed: true } };
}
export async function reconcile(ctx) {
  const issue = JSON.parse(gh(["api", issueApiPath(ctx.issue.url)]));
  return issue.state === "closed"
    ? { status: "completed", externalRef: issue.html_url, output: { url: issue.html_url, closed: true } }
    : { status: "not_applied" };
}
`,
      },
    ]),
  },
];
