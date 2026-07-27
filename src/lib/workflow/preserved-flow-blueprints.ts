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
      prompt: "请以 JSON 格式产出所请求的结果。在后续迭代中，根据 previousIteration 中的人工反馈修改上一版草稿。请求：{{request}} 上一轮迭代：{{previousIteration}}",
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
      prompt: "请在已配置的代码仓库中工作。实现需求，运行有针对性的检查，并保留所有更改为未提交状态。需求：{{requirement}}",
      appendPrompt: "请在同一个 RD 会话中继续。重新以代码仓库的实际状态为准，只修复最新的验收阻塞项，运行有针对性的检查，并保留所有更改为未提交状态。阻塞项：{{previousIteration.outputs.review.blockers}} 建议：{{previousIteration.outputs.review.suggestions}}",
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
      prompt: "请在已配置的实现工作区中开启一个全新会话，担任独立审查者。依据代码仓库的实际状态和原始需求进行判断，不要依赖实现者的叙述。仅复用下方之前的验收标准与阻塞项；中间轮次重点检查已修复的阻塞项和新增差异，而准备给出 PASS 时必须覆盖全部变更。返回有效 JSON，包含 status、criteria、blockers、suggestions、checks 和 unverified 字段。需求：{{requirement}} 上一轮标准：{{previousStep.criteria}} 上一轮阻塞项：{{previousStep.blockers}}",
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
  prompt: "请检查代码仓库的实际状态和已通过的审查结果。返回用于提交和拉取请求的有效 JSON，包含 title、body、changedFiles、checks 和 unverified 字段。不要执行任何 Git 或 GitHub 写操作。需求：{{requirement}} 验收结果：{{acceptance}}",
});
const notAccepted = agent({
  id: "not_accepted_report",
  label: "Report remaining blockers",
  inputs: { acceptance },
  output: "json",
  prompt: "请返回有效 JSON，说明未完成的实现、剩余阻塞项、检查结果、变更文件，并明确将 result 设为 not_accepted。不要提交、推送或创建拉取请求。验收结果：{{acceptance}}",
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
      prompt: "请在已配置的代码仓库中实现需求。运行有针对性的检查，不要提交更改。需求：{{requirement}}",
      appendPrompt: "请在同一个 RD 会话中继续。重新以代码仓库的实际状态为准，只处理最新且明确的人工反馈。运行有针对性的检查，不要提交更改。人工反馈：{{previousIteration.outputs.human_review.values.comment}}",
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
      prompt: "请作为已获人工批准的 RD 负责人继续工作。仅修复相对于原始需求的最新阻塞问题，检查代码仓库的实际状态，运行有针对性的检查，不要提交更改。需求：{{requirement}} 阻塞项：{{previousIteration.outputs.review.blockers}} 建议：{{previousIteration.outputs.review.suggestions}}",
      appendPrompt: "请在同一个 RD 会话中继续。重新以代码仓库的实际状态为准，只修复最新的验收阻塞项，运行有针对性的检查，不要提交更改。阻塞项：{{previousIteration.outputs.review.blockers}} 建议：{{previousIteration.outputs.review.suggestions}}",
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
      prompt: "请在已配置的实现工作区中开启一个全新会话，独立审查代码仓库的实际状态。人工批准只表示允许进入审查，并不能作为验收证据。仅复用下方之前的验收标准与阻塞项；中间轮次重点检查已修复的阻塞项和新增差异，而准备给出 PASS 时必须覆盖全部变更。返回有效 JSON，包含 status、criteria、blockers、suggestions、checks 和 unverified 字段。需求：{{requirement}} 上一轮标准：{{previousStep.criteria}} 上一轮阻塞项：{{previousStep.blockers}}",
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
  prompt: "请检查代码仓库的实际状态，并返回用于提交和拉取请求的有效 JSON，包含 title、body、changedFiles、checks 和 unverified 字段。不要执行任何 Git 或 GitHub 写操作。对齐结果：{{alignment}} 验收结果：{{acceptance}}",
});
const notAccepted = agent({
  id: "not_accepted_report",
  label: "Report remaining blockers",
  inputs: { alignment, acceptance },
  output: "json",
  prompt: "请返回有效 JSON，将 result 设为 not_accepted，并包含持久化的人工对齐结果、独立审查中剩余的阻塞项、检查结果和变更文件。不要提交、推送或创建拉取请求。对齐结果：{{alignment}} 验收结果：{{acceptance}}",
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
  prompt: "请以只读方式检查已配置的代码仓库。仅返回 JSON，列出该范围内已变更或相关的文件、关键边界、测试以及尚未检查的区域。范围：{{scope}}",
});
const architecture = agent({
  id: "architecture",
  label: "Architecture review",
  inputs: { inventory },
  prompt: "请只审查架构。提供文件级证据、严重程度、影响和建议。不要推断其他审查者的结论。范围清单：{{inventory}}",
});
const security = agent({
  id: "security",
  label: "Security review",
  inputs: { inventory },
  prompt: "请只审查安全性和信任边界。提供文件级证据、严重程度、利用方式或故障模式以及建议。范围清单：{{inventory}}",
});
const correctness = agent({
  id: "correctness",
  label: "Correctness review",
  inputs: { inventory },
  prompt: "请只审查正确性、边界情况和测试覆盖率。提供文件级证据、严重程度和建议。范围清单：{{inventory}}",
});
const synthesis = agent({
  id: "synthesis",
  label: "Synthesize findings",
  inputs: { architecture, security, correctness },
  prompt: "请合并三份独立审查。仅当证据指向同一缺陷时去重，保留相互印证的信息，按严重程度排列发现项，并以“覆盖情况”和“未检查区域”两部分结尾。架构审查：{{architecture}} 安全审查：{{security}} 正确性审查：{{correctness}}",
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
  prompt: "请以只读方式检查已配置的代码仓库，仅返回最多包含 12 个工作项的 JSON 数组，每项格式为 {id, file, goal}。不要静默截断；如有省略，必须在最后一项中说明未覆盖的范围。重点：{{focus}}",
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
      prompt: "请在已配置的代码仓库中只处理这一项，仅进行必要的更改，运行有针对性的检查，并报告证据。工作项：{{item}}",
    }),
    agent({
      id: "verify_one",
      label: "Verify item",
      output: "json",
      prompt: "请依据代码仓库的实际状态独立验证这一项。仅返回格式为 {status: VERIFIED|REJECTED, evidence: [], blockers: []} 的 JSON。工作项：{{item}} 待验证结果：{{previous}}",
    }),
  ],
});
const synthesis = agent({
  id: "synthesis",
  label: "Synthesize fan-out",
  inputs: { process },
  prompt: "请汇总已完成项、被拒绝项、失败项、检查结果和未覆盖范围。绝不能把部分覆盖描述成完整覆盖。Map 记录：{{process}}",
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
  prompt: "请以只读方式检查代码仓库。仅返回最多包含 12 个迁移位置的 JSON 数组，每项格式为 {file, line, change}。排除已迁移和范围外的位置，并说明被省略的覆盖范围。迁移说明：{{brief}}",
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
      prompt: "请严格按照迁移说明只迁移这个位置，进行最小必要更改，运行有针对性的检查，不要提交。迁移说明：{{brief}} 迁移位置：{{item}}",
    }),
    agent({
      id: "verify_one",
      label: "Verify site",
      output: "json",
      prompt: "请依据代码仓库的实际状态独立验证这个迁移位置。仅返回格式为 {status: VERIFIED|REJECTED, blockers: [], evidence: []} 的 JSON。迁移说明：{{brief}} 迁移位置：{{item}} 迁移结果：{{previous}}",
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
      prompt: "请只修复针对整体变更的阻塞问题，保持既定范围，运行有针对性的检查，不要提交。迁移说明：{{brief}} 各位置记录：{{migrate}} 阻塞项：{{previousIteration.outputs.review.blockers}}",
      appendPrompt: "请在同一个修复会话中继续。重新以代码仓库的实际状态为准，只修复最新的整体变更阻塞项，不要扩大范围。阻塞项：{{previousIteration.outputs.review.blockers}}",
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
      prompt: "请在已配置的实现工作区中开启一个全新会话，独立审查代码仓库的全部变更。以代码仓库的实际状态、迁移说明、结构化的各位置结果以及下方之前的验收标准和阻塞项为依据。返回有效 JSON，包含 status、criteria、blockers、rejectedSites、checks 和 unverified 字段。迁移说明：{{brief}} 各位置记录：{{migrate}} 上一轮标准：{{previousStep.criteria}} 上一轮阻塞项：{{previousStep.blockers}}",
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
  prompt: "请检查代码仓库的实际状态，并返回用于提交和拉取请求的有效 JSON，包含 title、body、changedFiles、checks、rejectedSites、failedSites 和 unverified 字段。不要执行任何 Git 或 GitHub 写操作。各位置记录：{{migrate}} 验收结果：{{acceptance}}",
});
const notAccepted = agent({
  id: "not_accepted_report",
  label: "Report incomplete migration",
  inputs: { migrate, acceptance },
  output: "json",
  prompt: "请返回有效 JSON，将 result 设为 not_accepted，并包含变更文件、剩余阻塞项、被拒绝和失败的位置、检查结果以及未验证范围。不要提交、推送或创建拉取请求。各位置记录：{{migrate}} 验收结果：{{acceptance}}",
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
  prompt: "请仅返回包含 3 至 6 个相互独立且不重叠子问题的 JSON 数组，每项格式为 {id, question, why}。覆盖整个主题，并说明被省略的范围。主题：{{topic}}",
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
      prompt: "请只回答这个子问题。如有可用资料，请引用带 URL 的一手来源；将所有无法验证的主张标记为 unverified，并列出仍未解决的空白。总体主题：{{topic}} 子问题：{{item}}",
    }),
    agent({
      id: "fact_check_one",
      label: "Fact-check answer",
      output: "json",
      prompt: "请以对抗式方法核查待验证答案中的事实。仅返回格式为 {answer, confidence: high|medium|low, survivingClaims: [], removedClaims: [], citations: [], unverified: []} 的 JSON。子问题：{{item}} 待验证答案：{{previous}}",
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
  prompt: "请撰写带引用的最终报告。保留每项主张的置信度，并以“覆盖情况”部分结尾，列出失败项、低置信度答案、未验证主张和仍未解决的空白。主题：{{topic}} 研究记录：{{research}}",
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
      prompt: "请以只读方式检查已配置的代码仓库，并且只检查这个发布维度。仅返回格式为 {check, status: ready|blocked, evidence: [], blockers: [], unverified: []} 的 JSON。发布背景：{{context}} 检查项：{{item}}",
    }),
  ],
});
const summary = agent({
  id: "summary",
  label: "Summarize readiness",
  inputs: { checks },
  output: "json",
  prompt: "请仅返回格式为 {recommendation: GO|NO_GO, readyChecks: [], blockedChecks: [], failedChecks: [], unverified: []} 的 JSON。绝不能隐藏失败或未经验证的检查项。检查结果：{{checks}}",
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
      prompt: "请仅返回包含 3 至 10 个互不重叠任务的 JSON 数组，每项格式为 {id, title, goal, dependencies}。覆盖完成定义，不要偏离范围。在后续迭代中依据 previousIteration 中的人工反馈进行修改，同时保持 id 稳定。Epic 说明：{{brief}} 上一轮迭代：{{previousIteration}}",
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
      prompt: "请只细化这个已批准的任务。仅返回格式为 {id, title, scope, nonGoals, acceptanceCriteria, dependencies} 的 JSON。不要估算工作量，也不要代替依赖方做决定。Epic：{{brief}} 任务：{{item}}",
    }),
  ],
});
const plan = agent({
  id: "plan",
  label: "Assemble final plan",
  inputs: { details },
  prompt: "请根据已细化的任务组装一份按依赖顺序排列的 Epic 计划。保留完整的验收标准，并以“覆盖情况”部分结尾，列出所有失败或缺失的任务。任务详情：{{details}}",
});
completeCycle({ id: "complete", outcome: "planned", inputs: { plan } });
`,
  ),
];
