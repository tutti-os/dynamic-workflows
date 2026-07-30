import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";
import type { WorkflowBlueprintDetail } from "./blueprint-types";
import { PRESERVED_FLOW_V1_BLUEPRINTS } from "./preserved-flow-blueprints";

export const BUILTIN_FLOW_V1_BLUEPRINTS: WorkflowBlueprintDetail[] = [
  ...PRESERVED_FLOW_V1_BLUEPRINTS,
  {
    id: "large-file-governance-v1",
    title: "Large File Governance",
    description:
      "Periodically plans and refactors one oversized file, lets RD use a read-only sub-agent for implementation review, then publishes and tracks a linked pull request.",
    category: "coding",
    tags: [
      "large-file",
      "github",
      "issue",
      "pull-request",
      "schedule",
      "memory",
      "sub-agent",
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
      "immediate-continuation",
      "github-cli",
      "json-output",
    ],
    patternSummary:
      "A scheduled singleton Cycle checks out a fresh Flow branch from origin/main in the configured project directory, creates an Issue, then gives one RD Agent ownership of implementation and read-only sub-agent review before publishing a linked pull request.",
    useCases: [
      "Continuously reduce monolithic source files without spending Agent tokens while approvals or merges are pending.",
      "Let one RD Agent implement, delegate read-only review, and repair findings before delivery.",
      "Publish a linked pull request immediately after RD reports the implementation ready.",
      "Use as a complete Bundle template for scheduled governance automations.",
    ],
    instantiationDefaults: {
      projectCwd: "~/tsh-project/tutti",
      defaultAgent: "local:codex",
    },
    bundle: createFlowV1Bundle([
      {
        path: "flow.js",
        content: `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Large File Governance",
  description: "Find, plan, refactor with RD-owned sub-agent review, and publish one oversized file per Cycle.",
  requiresCwd: true,
};
export const params = defineParams({
  scanCron: cronParam({ default: "*/30 * * * *" }),
  timezone: stringParam({ default: "Asia/Singapore" }),
  mainBranch: stringParam({ default: "main", minLength: 1 }),
  lineThreshold: numberParam({ default: 800, min: 1, integer: true }),
  scanRoot: stringParam({ default: "" }),
  approvalLabel: stringParam({ default: "flow-approved", minLength: 1, maxLength: 50 }),
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
const workspace = effect({
  id: "prepare_workspace",
  file: "scripts/prepare-branch.mjs",
  inputs: { preflight, mainBranch: ref("params.mainBranch") },
  idempotencyKey: template("{{cycle.id}}:prepare-workspace"),
});
const candidate = script({
  id: "find_large_file",
  file: "scripts/find-large-file.mjs",
  outcomes: ["found", "empty"],
  inputs: {
    sync: workspace,
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
const deliveryReady = gate({
  id: "preflight_delivery",
  file: "scripts/preflight-delivery.mjs",
  inputs: { candidate, preflight },
  outcomes: ["ready"],
});
const approvalLabel = effect({
  id: "ensure_approval_label",
  file: "scripts/ensure-approval-label.mjs",
  inputs: {
    deliveryReady,
    label: ref("params.approvalLabel"),
  },
  idempotencyKey: template("{{cycle.id}}:ensure-approval-label"),
});
const plan = agent({
  id: "plan_refactor",
  label: "Analyze candidate and propose refactor plan",
  inputs: {
    candidate,
    workspace,
    lineThreshold: ref("params.lineThreshold"),
  },
  workspace,
  execution: { access: "review", isolation: "shared" },
  session: { mode: "independent" },
  memory: { include: ["currentUnderstanding"] },
  output: json({ schema: {
    type: "object",
    required: ["title", "body"],
    properties: {
      title: { type: "string", minLength: 1 },
      body: { type: "string", minLength: 1 },
    },
  } }),
  prompt: "# 角色\\n\\n你是只读的代码重构分析员。你的职责是调查代码并起草一份可直接提交的 GitHub Issue，不实施修改。\\n\\n# 目标\\n\\n为目标文件制定安全、可执行的重构方案，我们将这些单体大文件视为一种潜在的架构不合理的疑点，基于这个文件出发你围绕评估当前涉及模块架构是否合理（文件是否单职责、高内聚低耦合、是否具备可维护性）。重构的要求是在保障原功能不被破坏的前提下，让后续代码更利于后续的开发维护工作。\\n\\n# Issue 正文要求\\n\\n1. 阅读仓库中适用的 AGENTS.md 和项目规范。\\n2. 写明目标、现状职责、仓库证据、修改边界、受影响文件、行为约束、按依赖排序的实施步骤、验证命令、风险和未知项。\\n3. 每个关键结论引用具体的 path:line 或 path#symbol。\\n4. 验证部分同时写明执行命令及其验证目标。\\n5. 无法从仓库确认的内容明确标为未知；不要将推测写成事实。\\n6. Flow Memory 仅作历史背景；如果它与仓库实际内容冲突，以仓库为准。\\n\\n# 约束\\n\\n- 不修改任何文件。\\n- 不执行 Git 或 GitHub 写操作。\\n- title 是简洁的 Issue 标题，不包含 Flow marker。\\n- body 是完整的 GitHub Markdown Issue 正文。\\n- 只返回一个 JSON 对象，不附加解释或 Markdown 代码围栏。\\n\\n# 输出格式\\n\\n{\\n  \\\"title\\\": \\\"Issue title\\\",\\n  \\\"body\\\": \\\"Complete GitHub Issue Markdown body\\\"\\n}\\n\\n<target>\\npath: {{candidate.path}}\\ncurrent_lines: {{candidate.lines}}\\nmax_lines: {{lineThreshold}}\\nsnapshot_commit: {{workspace.baseCommit}}\\n</target>",
});
const issue = effect({
  id: "create_issue",
  file: "scripts/create-issue.mjs",
  inputs: { approvalLabel, plan },
  idempotencyKey: template("{{cycle.id}}:create-issue"),
});
const approval = gate({
  id: "wait_issue_approval",
  file: "scripts/issue-approval.mjs",
  inputs: { issue },
  outcomes: ["approved", "rejected"],
});
const rdWork = agent({
  id: "rd_work",
  label: "RD implement with independent sub-agent review",
  inputs: {
    candidate,
    issue,
    approval,
    workspace,
    lineThreshold: ref("params.lineThreshold"),
  },
  workspace,
  execution: { access: "write", isolation: "shared" },
  session: { mode: "independent" },
  output: json({ schema: {
    type: "object",
    required: ["status", "summary"],
    properties: {
      status: { enum: ["READY", "BLOCKED"] },
      summary: { type: "string", minLength: 1 },
    },
  } }),
  prompt: "# 角色\\n\\n你是负责实施重构的 RD，并负责协调独立、只读的 Sub-agent 完成实现复审。\\n\\n# 任务\\n\\n使用 gh 读取 Issue 的最新正文和评论，并以它们作为唯一需求来源。\\n\\n# 工作规则\\n\\n1. 阅读仓库中适用的 AGENTS.md 和项目规范。\\n2. 开始前读取 Issue、检查 git status 和现有差异；仓库和 Issue 的实际状态优先于会话记忆。\\n3. 遵循 Issue 中的边界和行为约束，只修改完成 Issue 提及的任务内容。\\n4. 优先运行覆盖本次变更的针对性测试；仅在这些测试不足或不可用时扩大检查范围。\\n5. 实现完成后，必须启动至少一个独立只读 Sub-agent。让它直接检查 Issue、完整工作区差异、未跟踪文件和实际测试结果，不得仅审查你的总结。\\n6. Sub-agent 只验收当前实现，不得把尚未发生的 commit、push、PR、DCO、CI、合并或 Issue 关闭状态作为阻塞项。修复所有复审发现后再次复审，直到没有异常。\\n7. 完成后检查最终 diff，并将所有更改保留为未提交状态。\\n\\n# 约束\\n\\n- 只在当前项目目录和 Flow 分支内工作。\\n- 不执行 commit、push 或 GitHub 写操作；这些由后续交付节点负责。\\n- 不安装非必要依赖。\\n- 只有实现和复审均满足 Issue 时才能返回 READY。\\n- 无法完成实现或独立复审时返回 BLOCKED，并在 summary 中说明原因。\\n- 只返回一个 JSON 对象，不附加解释或 Markdown 代码围栏。\\n\\n# 输出格式\\n\\n{\\n  \\\"status\\\": \\\"READY\\\",\\n  \\\"summary\\\": \\\"实现、验证和只读 Sub-agent 复审的简要结论\\\"\\n}\\n\\n<context>\\nissue_url: {{issue.url}}\\nproject_cwd: {{workspace.path}}\\nbranch: {{workspace.branch}}\\ntarget_path: {{candidate.path}}\\ncurrent_lines: {{candidate.lines}}\\nmax_lines: {{lineThreshold}}\\n</context>",
});
const rdDecision = gate({
  id: "check_rd_delivery_status",
  file: "scripts/rd-delivery-status.mjs",
  inputs: { rdWork },
  outcomes: ["ready", "blocked"],
});
const implementationBlocked = completeCycle({
  id: "implementation_blocked",
  outcome: "implementation_blocked",
  inputs: { rdDecision, rdWork, issue },
  continue: "scheduled",
});
const pullRequest = effect({
  id: "publish_rd_ready_pr",
  label: "RD READY: commit, push, and open pull request",
  file: "scripts/publish-rd-ready-pr.mjs",
  inputs: {
    issue,
    candidate,
    rdWork,
    rdDecision,
    workspace,
    mainBranch: ref("params.mainBranch"),
  },
  workspace,
  execution: { access: "write", isolation: "shared" },
  idempotencyKey: template("{{cycle.id}}:publish-rd-ready-pr"),
});
const merged = gate({
  id: "wait_pull_request_merge",
  file: "scripts/pr-merged.mjs",
  inputs: { pullRequest },
  outcomes: ["merged"],
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
  inputs: { candidate, issue, pullRequest, merged, closeIssue },
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
route(approval, { approved: rdWork, rejected });
route(rdDecision, { ready: pullRequest, blocked: implementationBlocked });
route(merged, { merged: closeIssue });
route(candidate, { found: deliveryReady, empty: noWork });
route(deliveryReady, { ready: approvalLabel });
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
    "Issue: " + ctx.issue.url,
    "Pull request: " + ctx.pullRequest.url,
    "Merged: " + Boolean(ctx.merged?.mergedAt),
  ].join("\\n");
  return {
    currentUnderstanding,
    decision: "Cycle " + ctx.cycle.id + ": delivered " + ctx.candidate.path + " via " + ctx.issue.url,
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
export async function check(ctx) {
  exec("git", ["config", "--get", "user.name"]);
  exec("git", ["config", "--get", "user.email"]);
  const login = exec("gh", ["api", "user", "--jq", ".login"]);
  return {
    status: "completed",
    outcome: "ready",
    output: {
      repository: ctx.preflight.repository,
      login,
    },
  };
}
`,
      },
      {
        path: "scripts/prepare-branch.mjs",
        content: `import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
function identity(ctx) {
  return {
    path: fs.realpathSync(process.cwd()),
    branch: "flow/large-file-" + ctx.cycle.id.slice(0, 12),
  };
}
function marker(ctx, workspace = identity(ctx)) {
  const commonDir = path.resolve(process.cwd(), git(["rev-parse", "--git-common-dir"]));
  return path.join(commonDir, "tutti-flow-state", "workspace-" + ctx.cycle.id + ".json");
}
function assertClean() {
  const status = git(["status", "--porcelain"]);
  if (status) {
    throw new Error(
      "Configured project cwd has uncommitted changes. Resolve or preserve them before starting another Flow Cycle.\\n" +
        status,
    );
  }
}
export async function apply(ctx) {
  assertClean();
  const workspace = identity(ctx);
  git(["fetch", "origin", ctx.mainBranch]);
  const baseCommit = git(["rev-parse", "origin/" + ctx.mainBranch]);
  git(["checkout", "-B", workspace.branch, baseCommit]);
  const output = {
    ...workspace,
    mainBranch: ctx.mainBranch,
    baseCommit,
    commit: baseCommit,
  };
  const file = marker(ctx, workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(output));
  fs.renameSync(file + ".tmp", file);
  return { externalRef: file, output };
}
export async function reconcile(ctx) {
  try {
    const workspace = identity(ctx);
    const file = marker(ctx, workspace);
    const output = JSON.parse(fs.readFileSync(file, "utf8"));
    const branchExists = git(["show-ref", "--verify", "--hash", "refs/heads/" + workspace.branch]);
    return output.path === workspace.path &&
      output.branch === workspace.branch &&
      output.mainBranch === ctx.mainBranch &&
      typeof output.baseCommit === "string" &&
      branchExists
      ? { status: "completed", externalRef: file, output }
      : { status: "unknown", reason: "Prepared branch marker does not match the configured project cwd." };
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
export async function apply(ctx) {
  const marker = "[flow:" + ctx.cycle.id + "]";
  const title = marker + " " + ctx.plan.title;
  const body = [
    ctx.plan.body.trim(),
    "",
    "---",
    "Add the \`" + ctx.approvalLabel.name + "\` label to approve this Issue.",
    "After approval, RD and Reviewer agents read the latest Issue body and comments as the source of truth.",
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
        path: "scripts/rd-delivery-status.mjs",
        content: `export async function check(ctx) {
  if (ctx.rdWork?.status === "READY") {
    return {
      status: "completed",
      outcome: "ready",
      output: {
        status: "READY",
        summary: ctx.rdWork.summary,
      },
    };
  }
  if (ctx.rdWork?.status === "BLOCKED") {
    return {
      status: "completed",
      outcome: "blocked",
      output: {
        status: "BLOCKED",
        summary: ctx.rdWork.summary,
      },
    };
  }
  throw new Error("RD output must contain status READY or BLOCKED.");
}
`,
      },
      {
        path: "scripts/publish-rd-ready-pr.mjs",
        content: `import { execFileSync } from "node:child_process";
function git(args) { return execFileSync("git", args, { encoding: "utf8" }).trim(); }
function gh(args) { return execFileSync("gh", args, { encoding: "utf8" }).trim(); }
function marker(ctx) { return "Flow-Cycle: " + ctx.cycle.id; }
function committedSha(ctx) {
  const records = git(["log", "-n", "100", "--format=%H%x00%B%x00"]).split("\\u0000");
  for (let index = 0; index + 1 < records.length; index += 2) {
    if (records[index + 1].includes(marker(ctx))) {
      return records[index];
    }
  }
  return "";
}
function remoteSha(branch) {
  const line = git(["ls-remote", "origin", "refs/heads/" + branch]);
  return line ? line.split(/\\s+/u)[0] : "";
}
function existingPullRequest(ctx) {
  const raw = gh(["pr", "list", "--state", "all", "--head", ctx.workspace.branch, "--base", ctx.mainBranch, "--json", "url,headRefName,baseRefName"]);
  return JSON.parse(raw)[0] || null;
}
function output(ctx, url, commit) {
  return {
    url,
    branch: ctx.workspace.branch,
    commit,
    rdSummary: ctx.rdWork.summary,
  };
}
function body(ctx) {
  return [
    "## Source Issue",
    ctx.issue.url,
    "",
    "## Change",
    "Refactors \`" + ctx.candidate.path + "\` from its previous " + ctx.candidate.lines + "-line form.",
    "",
    "## RD Implementation and Sub-agent Review",
    ctx.rdWork.summary,
    "",
    "Closes " + ctx.issue.url,
  ].join("\\n");
}
export async function apply(ctx) {
  if (ctx.rdWork.status !== "READY") {
    throw new Error("Pull request publication requires RD status READY.");
  }
  let commit = committedSha(ctx);
  if (!commit) {
    if (!git(["status", "--porcelain"])) {
      throw new Error("RD reported READY but the implementation produced no repository changes.");
    }
    git(["add", "-A"]);
    git(["commit", "-s", "-m", "refactor: split " + ctx.candidate.path, "-m", marker(ctx)]);
    commit = git(["rev-parse", "HEAD"]);
  } else if (git(["rev-parse", "HEAD"]) !== commit || git(["status", "--porcelain"])) {
    throw new Error("The RD-approved project directory changed after its delivery commit.");
  }
  const publishedSha = remoteSha(ctx.workspace.branch);
  if (publishedSha && publishedSha !== commit) {
    throw new Error("Remote delivery branch exists at an unexpected commit.");
  }
  if (!publishedSha) {
    git(["push", "-u", "origin", commit + ":refs/heads/" + ctx.workspace.branch]);
  }
  const existing = existingPullRequest(ctx);
  const url = existing
    ? existing.url
    : gh(["pr", "create", "--head", ctx.workspace.branch, "--base", ctx.mainBranch, "--title", "Refactor " + ctx.candidate.path, "--body", body(ctx)]);
  return { externalRef: url, output: output(ctx, url, commit) };
}
export async function reconcile(ctx) {
  const commit = committedSha(ctx);
  const pullRequest = commit && remoteSha(ctx.workspace.branch) === commit
    ? existingPullRequest(ctx)
    : null;
  return pullRequest
    ? { status: "completed", externalRef: pullRequest.url, output: output(ctx, pullRequest.url, commit) }
    : { status: "not_applied" };
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
    if (pr.state === "closed") {
      return { status: "waiting", reason: "Pull request was closed without merge; reopen and merge it before the Flow can continue." };
    }
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
