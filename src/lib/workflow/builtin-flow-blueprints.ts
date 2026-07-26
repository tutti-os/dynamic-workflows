import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";
import type { WorkflowBlueprintDetail } from "./blueprint-types";

export const BUILTIN_FLOW_V1_BLUEPRINTS: WorkflowBlueprintDetail[] = [
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
});
export const secrets = defineSecrets({
  GH_TOKEN: connectionSecret({ provider: "github", required: true }),
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
  inputs: {
    sync,
    threshold: ref("params.lineThreshold"),
  },
});
const plan = agent({
  id: "plan_refactor",
  inputs: { candidate },
  memory: { include: ["currentUnderstanding"] },
  output: "json",
  prompt: "Inspect {{candidate.path}} ({{candidate.lines}} lines). Return JSON with title, rationale, boundaries, orderedSteps, tests, and risks. Do not edit files.",
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
    mainBranch: ref("params.mainBranch"),
  },
  idempotencyKey: template("{{cycle.id}}:prepare-workspace"),
});
const implement = agent({
  id: "implement_plan",
  inputs: { candidate, plan, approval, workspace },
  permissionMode: "workspace-write",
  prompt: "Work only inside the prepared git worktree at {{workspace.path}} on branch {{workspace.branch}}. Implement the approved refactor plan for {{candidate.path}}. Follow {{plan}}, run focused tests there, and leave that worktree ready for review. Do not modify the parent checkout.",
});
const pullRequest = effect({
  id: "create_pull_request",
  file: "scripts/create-pr.mjs",
  inputs: { issue, candidate, plan, implement, workspace },
  idempotencyKey: template("{{cycle.id}}:create-pr"),
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
const rememberResult = remember({
  id: "remember_result",
  inputs: { candidate, pullRequest, closeIssue },
  updates: {
    currentUnderstanding: {
      mode: "replace",
      value: ref("candidate.path"),
    },
    timeline: {
      mode: "append",
      value: ref("pullRequest.url"),
    },
  },
});
const complete = completeCycle({
  id: "complete",
  inputs: { rememberResult },
  continue: "immediate",
});
const rejected = cancelCycle({
  id: "rejected",
  inputs: { approval },
  continue: "scheduled",
});
const pullRequestClosed = cancelCycle({
  id: "pull_request_closed",
  inputs: { merged },
  continue: "scheduled",
});
finalize({
  id: "cleanup_workspace",
  file: "scripts/cleanup-worktree.mjs",
  runOn: ["completed", "failed", "canceled"],
  retainOnFailure: true,
});
route(approval, { approved: workspace, rejected });
route(merged, { merged: closeIssue, closed: pullRequestClosed });
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
`,
      },
      {
        path: "scripts/sync-main.mjs",
        content: `import { execFileSync } from "node:child_process";
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
export async function apply(ctx) {
  git(["checkout", ctx.branch]);
  git(["pull", "--ff-only", "origin", ctx.branch]);
  return { output: { branch: ctx.branch, commit: git(["rev-parse", "HEAD"]) } };
}
export async function reconcile() {
  return { status: "not_applied" };
}
`,
      },
      {
        path: "scripts/find-large-file.mjs",
        content: `import fs from "node:fs";
import path from "node:path";
const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
const extensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"]);
function visit(directory, found) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(absolute, found);
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      const lines = fs.readFileSync(absolute, "utf8").split(/\\r?\\n/u).length;
      found.push({ path: path.relative(process.cwd(), absolute), lines });
    }
  }
}
export async function run(ctx) {
  const files = [];
  visit(process.cwd(), files);
  const candidate = files
    .filter((file) => file.lines >= ctx.threshold)
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path))[0];
  if (!candidate) throw new Error("No source file exceeds the configured threshold.");
  return candidate;
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
export async function check(ctx) {
  const issue = JSON.parse(execFileSync("gh", ["issue", "view", ctx.issue.url, "--json", "state,labels,url"], { encoding: "utf8" }));
  if (issue.state === "CLOSED") return { status: "completed", outcome: "rejected", output: issue };
  const approved = issue.labels.some((label) => label.name === "flow-approved");
  return approved
    ? { status: "completed", outcome: "approved", output: issue }
    : { status: "waiting", reason: "Add the flow-approved label to approve the Issue plan." };
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
      "origin/" + ctx.mainBranch,
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
        path: "scripts/create-pr.mjs",
        content: `import { execFileSync } from "node:child_process";
function run(command, args, cwd = process.cwd()) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}
export async function apply(ctx) {
  const cwd = ctx.workspace.path;
  run("git", ["add", "-A"], cwd);
  run("git", ["commit", "-m", "refactor: split " + ctx.candidate.path], cwd);
  run("git", ["push", "-u", "origin", ctx.workspace.branch], cwd);
  const url = run("gh", ["pr", "create", "--head", ctx.workspace.branch, "--title", "Refactor " + ctx.candidate.path, "--body", "Closes " + ctx.issue.url], cwd);
  return {
    externalRef: url,
    output: { url, branch: ctx.workspace.branch, workspace: cwd },
  };
}
export async function reconcile(ctx) {
  const branch = ctx.workspace.branch;
  const raw = run("gh", ["pr", "list", "--state", "all", "--head", branch, "--json", "url,headRefName"], ctx.workspace.path);
  const pullRequest = JSON.parse(raw)[0];
  return pullRequest
    ? { status: "completed", externalRef: pullRequest.url, output: { url: pullRequest.url, branch } }
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
export async function check(ctx) {
  const pr = JSON.parse(execFileSync("gh", ["pr", "view", ctx.pullRequest.url, "--json", "state,mergedAt,url"], { encoding: "utf8" }));
  if (pr.mergedAt) return { status: "completed", outcome: "merged", output: pr };
  if (pr.state === "CLOSED") return { status: "completed", outcome: "closed", output: pr };
  return { status: "waiting", reason: "Pull request is still open." };
}
`,
      },
      {
        path: "scripts/close-issue.mjs",
        content: `import { execFileSync } from "node:child_process";
function gh(args) { return execFileSync("gh", args, { encoding: "utf8" }).trim(); }
export async function apply(ctx) {
  gh(["issue", "close", ctx.issue.url, "--comment", "Merged via " + ctx.pullRequest.url]);
  return { externalRef: ctx.issue.url, output: { url: ctx.issue.url, closed: true } };
}
export async function reconcile(ctx) {
  const issue = JSON.parse(gh(["issue", "view", ctx.issue.url, "--json", "state,url"]));
  return issue.state === "CLOSED"
    ? { status: "completed", externalRef: issue.url, output: { url: issue.url, closed: true } }
    : { status: "not_applied" };
}
`,
      },
    ]),
  },
];
