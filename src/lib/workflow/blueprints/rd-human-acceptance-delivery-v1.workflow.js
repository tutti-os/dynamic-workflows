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
  reviewer_agent: {
    type: "string",
    required: false,
    label: "Reviewer agent",
    description: "可选：验收 Reviewer 使用的 agent target id（来自 tutti --json agent list）。留空则使用 run 级 agent。",
  },
  reviewer_model: {
    type: "string",
    required: false,
    label: "Reviewer model",
    description: "可选：验收 Reviewer 使用的模型，需与所选 agent 兼容。留空则使用 run 级 model。验收是质量门禁，值得配置更强的模型。",
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
你是负责端到端交付的 RD 工程师。请在下方启动工作目录对应的项目中实现原始需求，交付可工作的代码改动，而不是只输出方案；在本轮内完成实现与验证后再结束回合，不要以计划或问题清单收尾。

工作要求：
1. 先检查仓库约定、相关代码和已有实现，覆盖需求涉及的完整调用面。
2. 上下文纪律：若你的运行时支持子代理/后台任务，把大体积、结论导向的工作委派出去——代码探索与调用面排查收回「文件:行号 + 关键结论」，运行检查收回「通过/失败 + 最小失败摘录」，不要把整个文件和完整日志留在自己的对话里；若不支持，用聚焦搜索和片段阅读达到同样效果。你自己的上下文只保留需求、决策与实际编辑。
3. 保留用户工作区中的无关改动；不要自行 commit 或 push。
4. 实现后运行相关 focused checks，并如实报告失败或未验证项。
5. 对会实质改变范围或验收标准的信息缺口，明确标注「需要对齐」，不要擅自做产品决策。

交付摘要（最后按此格式输出，供 Human 审阅）：
- 改动文件及用途
- 关键实现与取舍
- 已运行检查及结果
- 仍需确认的问题

启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}
`,
      appendPrompt: `
Human 对上一版交付提出了修改意见（见下方）。请留在当前同一个 RD 会话和工作目录中继续处理，不要重新开始任务，不要 commit 或 push。

先重新锚定仓库当前状态：查看 git status 与 git diff，并对将要修改的文件做针对性重读；当会话记忆与仓库实际内容冲突时，一律以仓库为准。然后结合原始需求核对意见并修改实际代码。完成后重新运行相关检查，沿用上一轮的上下文纪律，并按原格式输出更新后的交付摘要。

Human 修改意见：
{{human_review.values.comment}}
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
Human 对齐门禁已经完成，不需要再次请求 Human 审批。请修复下方 Reviewer 验收反馈中标注为「阻断」且属于原始需求范围的问题，运行相关检查，并保留改动在工作区。若反馈暴露出必须新增产品决策的信息缺口，标注「需要重新对齐」并停止猜测，不要擅自扩展需求。不要 commit 或 push。

启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

Reviewer 验收反馈：
{{reviewer}}
`,
      appendPrompt: `
Reviewer 最新一轮验收未通过，反馈见下方。Human 对齐门禁已经完成，不要再次请求 Human 审批。请继续使用当前同一个 RD 会话和工作目录修复「阻断」问题。

先重新锚定仓库当前状态：查看 git status 与 git diff，并对将要修改的文件做针对性重读；当会话记忆与仓库实际内容冲突时，一律以仓库为准。再核对反馈是否符合原始需求，不要因建议项或范围外意见扩大实现；若必须新增产品决策，标注「需要重新对齐」并停止猜测。修复后运行相关检查并输出简洁的修复摘要，沿用上一轮的上下文纪律；不要 commit 或 push。

Reviewer 验收反馈：
{{reviewer}}
`,
    }),
    agent({
      id: "reviewer",
      label: "验收 Reviewer",
      agent: "{{reviewer_agent}}",
      model: "{{reviewer_model}}",
      session: { mode: "inherit", key: "reviewer_room" },
      prompt: `
你是独立验收 Reviewer，不修改代码，也不读取或依赖 RD 的交付叙述。Human 通过只表示允许进入验收，不构成需求已经满足的证据。只依据原始需求和仓库当前实际状态验收。

验收要求：
1. 从原始需求提炼逐条、可验证的标准，不增加产品需求或扩大范围。
2. 独立查看 git status、git diff、相关代码、测试与配置，并运行相关 focused checks。复验轮次优先验证上一轮「阻断」的修复及其影响面，加上针对性回归；完整检查面（全量测试/构建等重型检查）只在你准备返回 PASS 的轮次要求，首轮仍需完整建立基线。
3. FAIL 只用于不满足原始需求的阻断问题；改进意见标注为「建议」，不作为 FAIL 依据。
4. FAIL 时逐条给出位置、问题、证据和期望行为；必要信息缺失时标注「阻断：需要对齐」。

输出：验收标准及结论、阻断问题、建议、检查结果、未验证项。最后一个非空行必须只为：
PASS
或
FAIL

启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}
`,
      appendPrompt: `
请基于原始需求和仓库当前实际状态重新验收。独立查看当前代码与 diff，核对上一轮阻断问题是否解决，同时检查是否引入新回归。以仓库当前状态为准，不要依赖会话记忆中的旧代码内容，也不要依赖 RD 的交付摘要。你上一轮已建立验收标准清单，若原始需求未变，沿用该清单逐项重验，不必重新推导；仅当需求或范围理解被证明有误时才修订清单。若原始需求、相关代码和同一个「需要对齐」阻断都没有变化，不要重复运行无关检查或扩写相同意见，简洁确认阻断仍存在并返回 FAIL。判定标准和输出格式不变。

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
  output: "json",
  inputs: { acceptance_loop },
  prompt: `
你负责验收循环之后的提交步骤。只用下方验收循环结果的 Stop reason 判断门禁：until_matched 表示 Reviewer PASS；max_iterations_reached 表示仍未通过。Human 曾经通过不能替代 Reviewer PASS。

若未通过，不要 commit、push 或创建 MR/PR。检查当前仓库状态，输出已完成改动、剩余阻断问题和建议下一步。

若已通过：
1. 独立检查当前分支、git status、git diff 和必要检查结果。
2. 创建合适分支并提交当前任务相关改动，保留无关工作区改动。
3. push 分支并用仓库可用工具创建 MR/PR；标题和正文描述需求、实际改动与验证结果，并在正文中原样保留最终一轮验收记录中的「未验证项」（逐条照抄，不改写、不省略），供人工在合并前复核。
4. 若缺少 remote、认证、权限或工具，不伪造链接，报告阻塞点和已准备好的分支、commit、下一步命令。

输出契约（output: "json"）：消息最后只包含一个 JSON 对象，其后不得有任何多余文字。形如：
{"result": "mr_created" | "blocked" | "not_accepted", "prUrl": string|null, "branch": string|null, "commit": string|null, "checks": "已运行检查的一句话摘要", "unverified": ["最终验收未验证项，逐条"], "summary": "一句话交付/现状摘要"}
字段规则：
- result：mr_created 表示已创建 MR/PR；blocked 表示验收通过但因缺少 remote/认证/权限/工具无法创建；not_accepted 表示验收未通过、未创建 MR/PR。
- prUrl/branch/commit：没有的填 null，绝不伪造链接。
- unverified：逐条照抄最终一轮验收记录中的「未验证项」，与 PR 正文中保留的内容逐条一致；没有则填 []。
- checks/summary：各一句话，如实描述，不粉饰。

启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

验收循环结果：
{{acceptance_loop}}
`,
});
