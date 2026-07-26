import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";
import type { WorkflowBlueprintDetail } from "./blueprint-types";
import { PRESERVED_FLOW_V1_BLUEPRINTS } from "./preserved-flow-blueprints";

export const BUILTIN_FLOW_V1_BLUEPRINTS: WorkflowBlueprintDetail[] = [
  ...PRESERVED_FLOW_V1_BLUEPRINTS,
  {
    id: "large-file-governance-v1",
    title: "Large File Governance Loop",
    description:
      "Periodically finds one oversized source file, proposes an Issue plan, waits for approval, implements it, opens a PR, waits for merge, closes the Issue, and starts the next Cycle.",
    category: "coding",
    tags: ["large-file", "github", "issue", "pull-request", "schedule", "memory"],
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
    ],
    patternSummary:
      "A scheduled singleton Cycle uses deterministic code nodes for discovery, Effects for repository sync, per-Cycle worktree setup, and GitHub mutations, Gates for approval and merge checks, Agent planning and implementation, terminal cleanup, Markdown Memory, and immediate continuation after merge.",
    useCases: [
      "Continuously reduce monolithic source files without spending Agent tokens while approvals or merges are pending.",
      "Turn repository maintenance into an auditable Issue-to-PR loop.",
      "Use as a complete Bundle template for scheduled governance automations.",
    ],
    bundle: createFlowV1Bundle([
      {
        path: "flow.js",
        content: `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Large File Governance Loop",
  description: "Find, approve, refactor, and merge one oversized file per Cycle.",
  requiresCwd: true,
};
export const params = defineParams({
  scanCron: cronParam({ default: "*/30 * * * *" }),
  timezone: stringParam({ default: "UTC" }),
  mainBranch: stringParam({ default: "main" }),
  lineThreshold: numberParam({ default: 1200 }),
  scanRoot: stringParam({ default: "" }),
});
export const secrets = defineSecrets({
  GH_TOKEN: connectionSecret({ provider: "github", required: false }),
});
export const cycles = defineCycles({ mode: "singleton" });
export const runtime = {
  maxNodeExecutionsPerTick: 40,
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

const sync = effect({
  id: "sync_main",
  file: "scripts/sync-main.mjs",
  inputs: { branch: ref("params.mainBranch") },
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
const plan = agent({
  id: "plan_refactor",
  inputs: { candidate },
  memory: { include: ["currentUnderstanding", "decisions"] },
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
  inputs: { candidate, plan },
  idempotencyKey: template("{{cycle.id}}:create-issue"),
});
const approval = gate({
  id: "wait_issue_approval",
  file: "scripts/issue-approval.mjs",
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
  inputs: {
    candidate,
    plan,
    approval,
    workspace,
    lineThreshold: ref("params.lineThreshold"),
  },
  workspace,
  execution: { access: "write", isolation: "required" },
  prompt: "Work only inside the prepared git worktree at {{workspace.path}} on branch {{workspace.branch}}. Implement the approved refactor plan for {{candidate.path}} and reduce it to at most {{lineThreshold}} lines without weakening behavior. Follow {{plan}} and run the smallest focused tests that cover the change. Do not install dependencies or run repository-wide checks unless the focused test cannot otherwise run. Leave the worktree ready for review and do not modify the parent checkout.",
});
const changes = script({
  id: "check_changes",
  file: "scripts/check-changes.mjs",
  inputs: { implement, workspace },
  workspace,
  execution: { access: "write", isolation: "required" },
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
  inputs: {
    issue,
    candidate,
    plan,
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
  inputs: { pullRequest },
  outcomes: ["merged", "closed"],
});
const closeIssue = effect({
  id: "close_issue",
  file: "scripts/close-issue.mjs",
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
route(changes, { changed: commit, no_changes: noChangesIssue });
route(merged, { merged: closeIssue, closed: rejectedDeliveryIssue });
route(candidate, { found: plan, empty: noWork });
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
    "Candidate: " + ctx.candidate.path + " (" + ctx.candidate.lines + " lines)",
    "Issue: " + ctx.issue.url,
    "Pull request: " + ctx.pullRequest.url,
    "Merged: " + Boolean(ctx.merged?.mergedAt),
    "Plan: " + JSON.stringify(ctx.plan),
  ].join("\\n");
  return {
    currentUnderstanding,
    decision: "Cycle " + ctx.cycle.id + ": approved plan for " + ctx.candidate.path,
    timeline: "Cycle " + ctx.cycle.id + ": merged " + ctx.pullRequest.url,
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
function git(args) { return execFileSync("git", args, { encoding: "utf8" }); }
function lineCount(content) {
  if (!content) return 0;
  const lines = content.split(/\\r?\\n/u);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}
export async function run(ctx) {
  const root = String(ctx.root ?? "")
    .replace(/^\\.\\//u, "")
    .replace(/\\/+$/u, "");
  const paths = git(["ls-tree", "-r", "--name-only", ctx.sync.commit])
    .trim()
    .split(/\\r?\\n/u)
    .filter((file) =>
      file &&
      (!root || file === root || file.startsWith(root + "/")) &&
      !ignoredDirectory.test(file) &&
      !ignoredFile.test(file) &&
      extensions.has(path.extname(file))
    );
  const files = paths.map((file) => ({
    path: file,
    lines: lineCount(git(["show", ctx.sync.commit + ":" + file])),
  }));
  const candidate = files
    .filter((file) => file.lines > ctx.threshold)
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path))[0];
  return candidate
    ? { outcome: "found", output: candidate }
    : { outcome: "empty", output: { reason: "No source file exceeds the configured threshold." } };
}
`,
      },
      {
        path: "scripts/create-issue.mjs",
        content: `import { execFileSync } from "node:child_process";
function gh(args) { return execFileSync("gh", args, { encoding: "utf8" }).trim(); }
export async function apply(ctx) {
  const marker = "[flow:" + ctx.cycle.id + "]";
  const title = marker + " Refactor " + ctx.candidate.path;
  const body = "Automated proposal\\n\\n\\\`\\\`\\\`json\\n" + JSON.stringify(ctx.plan, null, 2) + "\\n\\\`\\\`\\\`";
  const url = gh(["issue", "create", "--title", title, "--body", body]);
  return { externalRef: url, output: { url, title, marker } };
}
export async function reconcile(ctx) {
  const marker = "[flow:" + ctx.cycle.id + "]";
  const raw = gh(["issue", "list", "--state", "all", "--search", marker + " in:title", "--json", "url,title"]);
  const issue = JSON.parse(raw)[0];
  return issue
    ? { status: "completed", externalRef: issue.url, output: { ...issue, marker } }
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
export async function check(ctx) {
  const apiPath = issueApiPath(ctx.issue.url);
  try {
    const issue = JSON.parse(execFileSync("gh", ["api", apiPath], { encoding: "utf8" }));
    const output = { state: issue.state, labels: issue.labels, url: issue.html_url };
    if (issue.state === "closed") return { status: "completed", outcome: "rejected", output };
    const approved = issue.labels.some((label) => label.name === "flow-approved");
    return approved
      ? { status: "completed", outcome: "approved", output }
      : { status: "waiting", reason: "Add the flow-approved label to approve the Issue plan." };
  } catch {
    return { status: "waiting", reason: "GitHub Issue status is temporarily unavailable; retry on the next Tick." };
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
    branch: "flow/large-file-" + ctx.cycle.sequence,
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
  const url = run("gh", ["pr", "create", "--head", ctx.push.branch, "--base", ctx.mainBranch, "--title", "Refactor " + ctx.candidate.path, "--body", "Closes " + ctx.issue.url]);
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
  return ctx.pullRequest?.url
    ? "Pull request was closed without merge: " + ctx.pullRequest.url
    : "Implementation produced no repository changes.";
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
  return {
    cleaned: true,
    workspace,
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
export async function check(ctx) {
  const apiPath = pullRequestApiPath(ctx.pullRequest.url);
  try {
    const pr = JSON.parse(execFileSync("gh", ["api", apiPath], { encoding: "utf8" }));
    const output = { state: pr.state, mergedAt: pr.merged_at, url: pr.html_url };
    if (pr.merged_at) return { status: "completed", outcome: "merged", output };
    if (pr.state === "closed") return { status: "completed", outcome: "closed", output };
    return { status: "waiting", reason: "Pull request is still open." };
  } catch {
    return { status: "waiting", reason: "GitHub Pull Request status is temporarily unavailable; retry on the next Tick." };
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
