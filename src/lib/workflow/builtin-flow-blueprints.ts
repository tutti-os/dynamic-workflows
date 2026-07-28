import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";
import type { WorkflowBlueprintDetail } from "./blueprint-types";
import { PRESERVED_FLOW_V1_BLUEPRINTS } from "./preserved-flow-blueprints";

export const BUILTIN_FLOW_V1_BLUEPRINTS: WorkflowBlueprintDetail[] = [
  ...PRESERVED_FLOW_V1_BLUEPRINTS,
  {
    id: "large-file-governance-v1",
    title: "Large File Governance Loop",
    description:
      "Periodically plans and refactors one oversized file, runs an adversarial RD and QA acceptance loop, then publishes and tracks a pull request when QA passes.",
    category: "coding",
    tags: [
      "large-file",
      "github",
      "issue",
      "pull-request",
      "schedule",
      "memory",
      "acceptance",
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
    ],
    patternSummary:
      "A scheduled singleton Cycle plans and implements one refactor in an isolated worktree. An independent QA Agent reviews repository truth first; failures send explicit blockers to an RD repair Agent, while QA PASS commits, pushes, and opens a pull request containing the QA conclusion and evidence.",
    useCases: [
      "Continuously reduce monolithic source files without spending Agent tokens while approvals or merges are pending.",
      "Make RD repairs and adversarial QA findings visible before delivery.",
      "Publish a pull request immediately after QA accepts the repository state.",
      "Use as a complete Bundle template for scheduled governance automations.",
    ],
    bundle: createFlowV1Bundle([
      {
        path: "flow.js",
        content: `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Large File Governance Loop",
  description: "Find, plan, refactor, adversarially accept, and publish one oversized file per Cycle.",
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
const workspace = effect({
  id: "prepare_workspace",
  file: "scripts/prepare-worktree.mjs",
  inputs: {
    deliveryReady,
    candidate,
    sync,
    mainBranch: ref("params.mainBranch"),
  },
  idempotencyKey: template("{{cycle.id}}:prepare-workspace"),
});
const plan = agent({
  id: "plan_refactor",
  label: "Analyze candidate and propose refactor plan",
  inputs: {
    candidate,
    sync,
    workspace,
    lineThreshold: ref("params.lineThreshold"),
  },
  workspace,
  execution: { access: "review", isolation: "required" },
  session: { mode: "independent" },
  memory: { include: ["currentUnderstanding"] },
  output: json({ schema: {
    type: "object",
    required: [
      "title",
      "rationale",
      "responsibilities",
      "evidence",
      "boundaries",
      "affectedFiles",
      "behaviorInvariants",
      "orderedSteps",
      "tests",
      "risks",
      "unknowns",
    ],
    properties: {
      title: { type: "string", minLength: 1 },
      rationale: { type: "string", minLength: 1 },
      responsibilities: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      boundaries: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      affectedFiles: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      behaviorInvariants: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      orderedSteps: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      tests: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      risks: { type: "array", items: { type: "string" } },
      unknowns: { type: "array", items: { type: "string" } },
    },
  } }),
  prompt: "# 角色\\n\\n你是只读的代码重构分析员。你的职责是调查代码并制定方案，不实施修改。\\n\\n# 目标\\n\\n为目标文件制定安全、可执行的重构方案，使其在保持现有行为的前提下降至目标行数以内。\\n\\n# 分析要求\\n\\n1. 阅读仓库中适用的 AGENTS.md 和项目规范。\\n2. 检查目标文件承担的主要职责。\\n3. 查阅与分析结论直接相关的调用方、依赖、测试、配置和公开 API。\\n4. 识别可以独立迁移的职责边界、耦合关系和实施顺序。\\n5. 给出逐文件、按依赖顺序排列的重构步骤和针对性测试命令。\\n\\n# 证据标准\\n\\n- 每个关键结论必须在 evidence 中引用具体的 path:line 或 path#symbol。\\n- affectedFiles 只列出预计需要修改或新增的文件。\\n- behaviorInvariants 必须写明不可改变的 API、错误处理、副作用和兼容性。\\n- tests 必须同时写明执行命令及其验证目标。\\n- 无法从仓库确认的内容放入 unknowns；不要将推测写成事实。\\n- Flow Memory 仅作历史背景；如果它与仓库实际内容冲突，以仓库为准。\\n\\n# 约束\\n\\n- 不修改任何文件。\\n- 不执行 Git 或 GitHub 写操作。\\n- 只返回符合声明 schema 的 JSON 对象，不附加解释或 Markdown。\\n\\n<target>\\npath: {{candidate.path}}\\ncurrent_lines: {{candidate.lines}}\\nmax_lines: {{lineThreshold}}\\nsnapshot_commit: {{workspace.baseCommit}}\\n</target>",
});
const issue = effect({
  id: "create_issue",
  file: "scripts/create-issue.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { approvalLabel, candidate, plan, workspace },
  idempotencyKey: template("{{cycle.id}}:create-issue"),
});
const approval = gate({
  id: "wait_issue_approval",
  file: "scripts/issue-approval.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { issue },
  outcomes: ["approved", "rejected"],
});
const acceptance = loop({
  id: "rd_qa_acceptance",
  label: "RD + QA adversarial acceptance",
  inputs: {
    candidate,
    plan,
    approval,
    workspace,
    lineThreshold: ref("params.lineThreshold"),
  },
  workspace,
  execution: { access: "write", isolation: "required" },
  maxIterations: ref("params.maxAcceptanceRounds"),
  onMaxIterations: "complete",
  steps: [
    agent({
      id: "rd_work",
      label: "RD implement or repair",
      session: { mode: "inherit", key: "rd_room" },
      prompt: "# 角色\\n\\n你是负责实施重构的 RD。只在绑定的隔离 worktree 中工作。\\n\\n# 任务\\n\\n执行已批准的重构方案，在保持现有行为的前提下，将目标文件缩减至目标行数以内。\\n\\n# 工作规则\\n\\n1. 阅读仓库中适用的 AGENTS.md 和项目规范。\\n2. 开始前检查 git status 和现有差异；仓库实际状态优先于会话记忆。\\n3. 遵循批准方案中的边界和行为约束，只修改完成方案所需的文件。\\n4. 优先运行覆盖本次变更的针对性测试；仅在这些测试不足或不可用时扩大检查范围。\\n5. 完成后检查最终 diff，并将所有更改保留为未提交状态。\\n\\n# 约束\\n\\n- 不修改父检出目录。\\n- 不执行 commit、push 或 GitHub 写操作。\\n- 不安装非必要依赖。\\n\\n<context>\\nworktree: {{workspace.path}}\\nbranch: {{workspace.branch}}\\ntarget_path: {{candidate.path}}\\ncurrent_lines: {{candidate.lines}}\\nmax_lines: {{lineThreshold}}\\napproved_plan: {{plan}}\\n</context>",
      appendPrompt: "# 本轮任务\\n\\n在同一个 RD 会话和 worktree 中继续修复最新一轮 QA 阻塞项。\\n\\n# 修复规则\\n\\n1. 重新检查 git status、git diff 和 QA 指出的代码；仓库实际状态优先。\\n2. 只处理 blockers，并保持批准方案的范围。suggestions 仅供参考，除非解决 blocker 必须，否则不要实施。\\n3. 运行覆盖修复内容的针对性测试，并检查最终 diff。\\n4. 保留更改为未提交状态；不要 commit、push 或执行 GitHub 写操作。\\n\\n<qa_feedback>\\nblockers: {{previousIteration.outputs.qa_review.blockers}}\\nsuggestions: {{previousIteration.outputs.qa_review.suggestions}}\\n</qa_feedback>",
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
        required: ["status", "conclusion", "criteria", "blockers", "suggestions", "risks", "checks", "evidence", "unverified"],
        properties: {
          status: { enum: ["PASS", "FAIL"] },
          conclusion: { type: "string", minLength: 1 },
          criteria: { type: "array", items: { type: "string" } },
          blockers: { type: "array", items: { type: "string" } },
          suggestions: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          checks: { type: "array", items: { type: "string" } },
          evidence: { type: "array", items: { type: "string" } },
          unverified: { type: "array", items: { type: "string" } },
        },
      } }),
      prompt: "# 角色\\n\\n你是独立的对抗式 QA。只以绑定 worktree 的仓库状态和实际检查结果为依据，不采信 RD 的叙述。\\n\\n# 验收目标\\n\\n判断当前实现是否完成批准方案、保持既有行为、满足目标文件行数限制，并经过足够的针对性验证。\\n\\n# 检查要求\\n\\n1. 阅读适用的 AGENTS.md 和项目规范。\\n2. 检查 git status、完整 diff、所有受影响文件及相关测试。\\n3. 对照批准方案的职责边界、行为约束、风险和测试计划进行验收。\\n4. 必要时重新运行针对性测试；checks 写明命令及结果，无法验证的内容放入 unverified。\\n5. 如果存在上一轮标准或阻塞项，逐项复查。中间轮次可以聚焦新增差异，但给出 PASS 前必须覆盖完整变更面。\\n6. evidence 引用具体的 path:line、path#symbol、diff 或测试结果。\\n\\n# 判定规则\\n\\n- 只有不存在阻塞性缺陷，并且每项必要结论都有证据时，才能给出 PASS。\\n- PASS 时 blockers 必须为空。\\n- FAIL 时 blockers 必须至少包含一个可执行的阻塞项，写明位置、问题及预期修正结果。\\n- suggestions 只能包含不影响本次通过的非阻塞建议。\\n- conclusion 简洁说明 PASS 或 FAIL 的依据；PASS 后该结论会直接写入拉取请求。\\n\\n# 输出约束\\n\\n只返回符合声明 schema 的 JSON 对象，不附加解释或 Markdown。\\n\\n<context>\\nworktree: {{workspace.path}}\\ntarget_path: {{candidate.path}}\\nmax_lines: {{lineThreshold}}\\napproved_plan: {{plan}}\\nprevious_criteria: {{previousStep.criteria}}\\nprevious_blockers: {{previousStep.blockers}}\\n</context>",
    }),
  ],
  until: { source: "qa_review", finalStatus: "PASS" },
});
const closeNotAcceptedIssue = effect({
  id: "close_qa_not_accepted_issue",
  file: "scripts/resolve-issue.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { issue, acceptance },
  idempotencyKey: template("{{cycle.id}}:close-qa-not-accepted"),
});
const qaNotAccepted = completeCycle({
  id: "qa_not_accepted",
  outcome: "qa_not_accepted",
  inputs: { closeNotAcceptedIssue, acceptance },
  continue: "scheduled",
});
const pullRequest = effect({
  id: "publish_qa_approved_pr",
  label: "QA PASS: commit, push, and open pull request",
  file: "scripts/publish-qa-approved-pr.mjs",
  secrets: ["GH_TOKEN"],
  inputs: {
    issue,
    candidate,
    plan,
    acceptance,
    workspace,
    mainBranch: ref("params.mainBranch"),
  },
  workspace,
  execution: { access: "write", isolation: "required" },
  idempotencyKey: template("{{cycle.id}}:publish-qa-approved-pr"),
});
const merged = gate({
  id: "wait_pull_request_merge",
  file: "scripts/pr-merged.mjs",
  secrets: ["GH_TOKEN"],
  inputs: { pullRequest },
  outcomes: ["merged"],
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
finalize({
  id: "cleanup_workspace",
  file: "scripts/cleanup-worktree.mjs",
  runOn: ["completed", "failed", "canceled"],
  retainOnFailure: true,
});
route(approval, { approved: acceptance, rejected });
route(acceptance, {
  matched: pullRequest,
  exhausted: closeNotAcceptedIssue,
});
route(merged, { merged: closeIssue });
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
    "## Analysis snapshot",
    "\`" + ctx.workspace.baseCommit + "\`",
    "",
    "## Proposal",
    ctx.plan.title,
    "",
    "## Rationale",
    ctx.plan.rationale,
    "",
    "## Current responsibilities",
    bullets(ctx.plan.responsibilities),
    "",
    "## Repository evidence",
    bullets(ctx.plan.evidence),
    "",
    "## Boundaries",
    bullets(ctx.plan.boundaries),
    "",
    "## Affected files",
    bullets(ctx.plan.affectedFiles),
    "",
    "## Behavior invariants",
    bullets(ctx.plan.behaviorInvariants),
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
    "## Unknowns",
    bullets(ctx.plan.unknowns),
    "",
    "Add the \`" + ctx.approvalLabel.name + "\` label to approve this generated plan snapshot.",
    "Editing this Issue or adding comments does not change the plan executed by the Flow.",
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
        path: "scripts/publish-qa-approved-pr.mjs",
        content: `import { execFileSync } from "node:child_process";
function git(args) { return execFileSync("git", args, { encoding: "utf8" }).trim(); }
function gh(args) { return execFileSync("gh", args, { encoding: "utf8" }).trim(); }
function marker(ctx) { return "Flow-Cycle: " + ctx.cycle.id; }
function bullets(values, fallback = "- None reported") {
  return values.length ? values.map((value) => "- " + value).join("\\n") : fallback;
}
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
    qaConclusion: ctx.acceptance.final.conclusion,
  };
}
function body(ctx) {
  const qa = ctx.acceptance.final;
  return [
    "## Summary",
    ctx.plan.title,
    "",
    "Refactors \`" + ctx.candidate.path + "\` from its previous " + ctx.candidate.lines + "-line form.",
    "",
    "## QA conclusion",
    qa.conclusion,
    "",
    "## Acceptance criteria",
    bullets(qa.criteria),
    "",
    "## Checks",
    bullets(qa.checks),
    "",
    "## Evidence",
    bullets(qa.evidence),
    "",
    "## Risks",
    bullets(qa.risks),
    "",
    "## Unverified",
    bullets(qa.unverified),
    "",
    "Closes " + ctx.issue.url,
  ].join("\\n");
}
export async function apply(ctx) {
  if (ctx.acceptance.final.status !== "PASS") {
    throw new Error("Pull request publication requires a final QA PASS.");
  }
  let commit = committedSha(ctx);
  if (!commit) {
    if (!git(["status", "--porcelain"])) {
      throw new Error("QA passed but the implementation produced no repository changes.");
    }
    git(["add", "-A"]);
    git(["commit", "-s", "-m", "refactor: split " + ctx.candidate.path, "-m", marker(ctx)]);
    commit = git(["rev-parse", "HEAD"]);
  } else if (git(["rev-parse", "HEAD"]) !== commit || git(["status", "--porcelain"])) {
    throw new Error("The QA-approved worktree changed after its delivery commit.");
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
        path: "scripts/resolve-issue.mjs",
        content: `import { execFileSync } from "node:child_process";
function gh(args) { return execFileSync("gh", args, { encoding: "utf8" }).trim(); }
function issueApiPath(url) {
  const [owner, repo, kind, number] = new URL(url).pathname.split("/").filter(Boolean);
  if (!owner || !repo || kind !== "issues" || !number) throw new Error("Invalid GitHub Issue URL: " + url);
  return "repos/" + owner + "/" + repo + "/issues/" + number;
}
function reason(ctx) {
  if (ctx.acceptance?.final) {
    const blockers = ctx.acceptance.final.blockers || [];
    const detail = Array.isArray(blockers) && blockers.length
      ? " Remaining blockers: " + blockers.slice(0, 8).join("; ")
      : "";
    return "RD + QA acceptance exhausted its iteration budget without PASS. Final QA conclusion: " +
      ctx.acceptance.final.conclusion + "." + detail;
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
