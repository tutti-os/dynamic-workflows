export const meta = {
  name: "RD Human-Gated Acceptance Delivery",
  description: "RD 先与 Human 在同一会话中迭代对齐，再进入独立 Reviewer 验收；Reviewer 打回时直接回到同一个 RD 会话修复，不重复经过 Human，验收通过后提交 MR/PR。",
  requiresCwd: true,
};

export const inputs = {
  requirement: {
    type: "string",
    required: true,
    label: "原始需求",
    description: "请包含背景与目标、改动范围、逐条可验证的验收标准，以及明确不做的事项与约束。",
    placeholder: "背景与目标：\n\n改动范围：\n\n验收标准：\n1. \n2. \n\n明确不做：\n",
    widget: "textarea",
  },
};

phase("RD 与 Human 对齐");

const human_alignment = loop({
  id: "human_alignment",
  label: "RD 与 Human 对齐",
  cwd: ".",
  maxIterations: 5,
  onMaxIterations: "fail",
  steps: [
    agent({
      id: "rd",
      label: "RD 工程师",
      session: { mode: "inherit", key: "rd_room" },
      prompt: `
启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

你是负责端到端交付的 RD 工程师。请在当前项目目录中实现原始需求，交付可工作的代码改动，而不是只输出方案。

工作要求：
1. 先检查仓库约定、相关代码和已有实现，覆盖需求涉及的完整调用面。
2. 保留用户工作区中的无关改动；不要自行 commit 或 push。
3. 实现后运行相关 focused checks，并如实报告失败或未验证项。
4. 对会实质改变范围或验收标准的信息缺口，明确标注「需要对齐」，不要擅自做产品决策。

最后输出给 Human 审阅的交付摘要：
- 改动文件及用途
- 关键实现与取舍
- 已运行检查及结果
- 仍需确认的问题
`,
      appendPrompt: `
Human 对上一版交付提出了修改意见：
{{human_review.values.comment}}

请留在当前同一个 RD 会话和工作目录中，结合原始需求核对意见并修改实际代码。不要重新开始任务，不要 commit 或 push。完成后重新运行相关检查，并按原格式输出更新后的交付摘要。
`,
    }),
    human({
      id: "human_review",
      label: "Human 确认",
      description: "确认当前实现方向可以进入独立验收，或提出修改意见让同一个 RD 会话继续处理。",
      context: [
        { label: "原始需求", value: "{{requirement}}", display: "markdown" },
        { label: "RD 当前交付摘要", value: "{{rd}}", display: "markdown" },
      ],
      actions: [
        { id: "approve", label: "通过并进入验收", intent: "primary" },
        {
          id: "revise",
          label: "打回修改",
          fields: [
            {
              id: "comment",
              type: "textarea",
              label: "修改意见",
              required: true,
              placeholder: "说明需要修改的行为、范围或验收预期。",
            },
          ],
        },
      ],
    }),
  ],
  until: { source: "human_review.action", equals: "approve" },
});

phase("独立验收与修复");

const acceptance_loop = loop({
  id: "acceptance_loop",
  label: "Reviewer 验收循环",
  cwd: ".",
  inputs: { human_alignment },
  maxIterations: 4,
  onMaxIterations: "complete",
  firstIteration: { startAt: "reviewer" },
  steps: [
    agent({
      id: "rd_fix",
      label: "RD 修复",
      session: { mode: "inherit", key: "rd_room" },
      prompt: `
启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

Reviewer 验收反馈：
{{reviewer}}

Human 对齐门禁已经完成，不需要再次请求 Human 审批。请修复 Reviewer 标注为「阻断」且属于原始需求范围的问题，运行相关检查，并保留改动在工作区。若反馈暴露出必须新增产品决策的信息缺口，标注「需要重新对齐」并停止猜测，不要擅自扩展需求。不要 commit 或 push。
`,
      appendPrompt: `
Reviewer 最新一轮验收未通过，反馈如下：
{{reviewer}}

Human 对齐门禁已经完成，不要再次请求 Human 审批。请继续使用当前同一个 RD 会话和工作目录修复「阻断」问题。先核对反馈是否符合原始需求，不要因建议项或范围外意见扩大实现；若必须新增产品决策，标注「需要重新对齐」并停止猜测。修复后运行相关检查并输出简洁的修复摘要；不要 commit 或 push。
`,
    }),
    agent({
      id: "reviewer",
      label: "验收 Reviewer",
      session: { mode: "inherit", key: "reviewer_room" },
      prompt: `
启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

你是独立验收 Reviewer，不修改代码，也不读取或依赖 RD 的交付叙述。Human 通过只表示允许进入验收，不构成需求已经满足的证据。只依据原始需求和仓库当前实际状态验收。

验收要求：
1. 从原始需求提炼逐条、可验证的标准，不增加产品需求或扩大范围。
2. 独立查看 git status、git diff、相关代码、测试与配置，并运行相关 focused checks。
3. FAIL 只用于不满足原始需求的阻断问题；改进意见标注为「建议」，不作为 FAIL 依据。
4. FAIL 时逐条给出位置、问题、证据和期望行为；必要信息缺失时标注「阻断：需要对齐」。

输出：验收标准及结论、阻断问题、建议、检查结果、未验证项。最后一个非空行必须只为：
PASS
或
FAIL
`,
      appendPrompt: `
请基于原始需求和仓库当前实际状态重新验收。独立查看当前代码与 diff，核对上一轮阻断问题是否解决，同时检查是否引入新回归。不要依赖 RD 的交付摘要。判定标准和输出格式不变。

最后一个非空行必须只为：
PASS
或
FAIL
`,
    }),
  ],
  until: { source: "reviewer", finalStatus: "PASS" },
});

phase("提交");

agent({
  id: "submit_mr",
  label: "提交 MR",
  cwd: ".",
  inputs: { acceptance_loop },
  prompt: `
启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

验收循环结果：
{{acceptance_loop}}

只用验收循环的 Stop reason 判断门禁：until_matched 表示 Reviewer PASS；max_iterations_reached 表示仍未通过。Human 曾经通过不能替代 Reviewer PASS。

若未通过，不要 commit、push 或创建 MR/PR。检查当前仓库状态，输出已完成改动、剩余阻断问题和建议下一步。

若已通过：
1. 独立检查当前分支、git status、git diff 和必要检查结果。
2. 创建合适分支并提交当前任务相关改动，保留无关工作区改动。
3. push 分支并用仓库可用工具创建 MR/PR；标题和正文描述需求、实际改动与验证结果。
4. 若缺少 remote、认证、权限或工具，不伪造链接，报告阻塞点和已准备好的分支、commit、下一步命令。

最终只输出结果、分支与 commit（如有）、已运行检查、本次提交或现状摘要。
`,
});
