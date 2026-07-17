export const meta = {
  name: "RD Acceptance Delivery",
  description: "RD 工程师与独立 Reviewer 在有限轮次内迭代交付；Reviewer 每轮在全新会话中只依据原始需求和仓库当前实现验收，不读取 RD 的交付说明。验收 PASS 后基于当前改动提交 MR/PR，未通过则输出现状报告。",
  requiresCwd: true,
};

export const inputs = {
  requirement: {
    type: "string",
    required: true,
    label: "原始需求",
    description: "RD 与 Reviewer 共享的唯一需求说明；它们仍会独立读取仓库和各自的运行时指令，但 Reviewer 不接收 RD 的交付叙述。请包含：1) 背景与目标；2) 改动范围（涉及模块/文件，已知即可）；3) 验收标准（逐条、可验证）；4) 明确不做的事项与约束。",
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
  reviewer_permission_mode: {
    type: "string",
    required: false,
    label: "Reviewer permission mode",
    description: "可选：Reviewer 的权限模式 id。先用 tutti agent composer-options --agent-id <reviewer_agent> --json 查询 permissionConfig.modes；留空先继承 run 级权限，run 级也未设置时使用该 agent 的默认权限。",
  },
  max_rounds: {
    type: "number",
    required: false,
    min: 1,
    max: 10,
    label: "验收循环轮数",
    description:
      "按需求量级选择：小需求（单文件/明确修补）建议 2；中等（跨少数文件的特性）建议 3；大需求（跨模块/含迁移）建议 4-5。留空用默认 3。上游 agent 按此标准自行决策。",
  },
};

phase("RD 交付与验收");

const delivery_loop = loop({
  id: "delivery_loop",
  label: "RD 交付循环",
  cwd: ".",
  maxIterations: "{{max_rounds:3}}",
  onMaxIterations: "complete",
  steps: [
    agent({
      id: "rd",
      label: "RD 工程师",
      session: { mode: "inherit", key: "rd_room" },
      prompt: `
你是负责端到端交付的 RD 工程师。请在下方启动工作目录对应的项目中实现原始需求。交付物是可工作的代码改动，不是方案或计划文档；在本轮内完成实现与验证后再结束回合，不要以计划或问题清单收尾。

工作方式：
1. 先检查相关代码、约定和已有实现，优先复用仓库现有模式；覆盖完成需求所涉及的调用面，不只修复表面症状。
2. 上下文纪律：若你的运行时支持子代理/后台任务，把大体积、结论导向的工作委派出去——代码探索与调用面排查收回「文件:行号 + 关键结论」，运行检查收回「通过/失败 + 最小失败摘录」，不要把整个文件和完整日志留在自己的对话里；若不支持，用聚焦搜索和片段阅读达到同样效果。你自己的上下文只保留需求、决策与实际编辑。
3. 对不影响核心范围、可以安全回退的小缺口采用保守且合理的默认值继续完成，并在交付摘要中说明。只有当缺失信息会实质改变需求范围、造成不可逆后果或使验收标准无法成立时，才停止并标注「需要对齐」。
4. 保留用户当前工作区中的其他改动，不要回退或覆盖与本任务无关的内容。
5. 改动保留在工作区，不要自行 commit 或 push；提交由后续步骤统一处理。
6. 实现后运行与改动相关的 focused checks；检查失败或无法运行时如实说明，不要声称通过。

交付摘要（最后按此格式输出，供后续修订和最终状态报告使用）：
- 改动文件：逐个列出，每个一句话说明
- 实现说明：关键实现点、取舍与采用的默认值
- 已运行的检查及结果
- 验证方式：如何确认原始需求被满足

启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}
`,
      appendPrompt: `
第 {{iteration}} 轮修订。

先重新锚定仓库当前状态：查看 git status 与 git diff，并对将要修改的文件做针对性重读；当会话记忆与仓库实际内容冲突时，一律以仓库为准。然后独立核对下方「阻断」与原始需求及实际代码是否一致，再逐条修复这些阻断；「建议」项可顺手处理但不强制。Reviewer 不能扩展或改写原始需求：若某条阻断需要新增产品决策或明显超出原始范围，标注「需要对齐」并说明原因，不要自行扩大实现范围。若同一个「需要对齐」阻断没有任何新信息，不要重复修改代码或重新尝试同一方案，只需简洁重申阻断状态。

约定不变：沿用上一轮的上下文纪律，不要 commit 或 push，修复后运行相关检查并如实报告结果。最后按同样格式输出本轮交付摘要。

上一轮阻断（逐条修复；每项含 location/issue/evidence/expectation）：
{{acceptance.blockers}}

上一轮建议（可选处理，非阻断）：
{{acceptance.suggestions}}
`,
    }),
    agent({
      id: "acceptance",
      label: "验收 Reviewer",
      agent: "{{reviewer_agent}}",
      model: "{{reviewer_model}}",
      permissionMode: "{{reviewer_permission_mode}}",
      session: { mode: "independent" },
      output: "json",
      prompt: `
你是独立验收 Reviewer，不需要也不允许修改代码。每一轮你都在全新会话中工作：不会收到 RD 的交付摘要、改动范围或技术解释，不要猜测 RD 的意图，也不要依赖其自述。请只依据原始需求和仓库当前实际状态，独立判断当前实现与技术方案是否满足要求。

验收方法：
1. 先从原始需求提炼逐条、可验证的验收标准；不得自行增加产品需求或扩大范围。若下方「上一轮验收标准」非空且原始需求未变，沿用该清单逐项重验，不必重新推导；仅当需求或范围理解被证明有误时才修订清单。
2. 独立查看 git status、git diff、相关代码、测试和配置，理解仓库当前实现及其方案。实际代码是唯一实现证据。
3. 按验收标准逐项验证当前行为，运行与本次需求相关的 focused checks；无法验证的项目必须明确说明原因并列入 unverified。
4. 复验轮次的验证范围＝上一轮阻断的修复及其影响面 ＋ 自上一轮评审以来的全部新改动面（用 git diff 对比确定）——新问题只可能藏在新改动里。完整检查面（全量测试/构建等重型检查）只在你准备返回 PASS 的轮次要求，首轮仍需完整建立基线。
5. 检查实现是否完整覆盖相关调用面、是否引入明显回归，以及必要测试是否缺失。
6. 若下方「上一轮阻断」非空，逐条核对其是否已解决，同时检查是否引入新问题。上一轮记录只是你自己的历史判断，不构成当前验收证据；若原始需求、相关代码和同一个「需要对齐」阻断都没有变化，不要重复运行无关检查或扩写相同意见，简洁确认阻断仍存在并返回 FAIL。

返回 PASS 之前：上一轮清单只是核对起点，不是扫描边界——必须以全新视角覆盖整个变更面，主动寻找清单之外的问题。

判定标准：
- verdict=FAIL 仅用于不满足原始需求的阻断性问题；风格、可读性等改进意见放入 suggestions，不作为 FAIL 依据。
- 每个阻断在 blockers 中逐条给出：location（文件/函数）、issue（问题）、evidence（证据）、expectation（期望行为）。
- 如果原始需求缺少作出判断所必需的信息，不要替用户做产品决策；把缺口作为一个 blocker（issue 以「需要对齐」开头）并返回 FAIL。

输出契约（output: "json"）：可先给出简短的验收推理，但消息最后只包含一个 JSON 对象，其后不得有任何多余文字。形如：
{"verdict": "PASS" | "FAIL", "criteria": [{"id": 1, "text": "验收标准原文", "result": "通过" | "不通过" | "未验证"}], "blockers": [{"location": "文件/函数", "issue": "问题", "evidence": "证据", "expectation": "期望行为"}], "suggestions": ["非阻断的改进建议"], "checks": "已运行检查的简要清单（一段）", "unverified": ["未能验证的项及原因"]}
字段规则：
- verdict：PASS 表示当前实现满足原始需求；FAIL 表示存在阻断问题。
- criteria：逐条覆盖你提炼的验收标准，result 三选一。
- blockers：verdict=FAIL 时非空；PASS 时为 []。
- suggestions/unverified：没有则填 []。
- checks：一段话如实说明跑了哪些检查，不粉饰。

启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

上一轮验收标准（首轮为空，沿用重验）：
{{acceptance.criteria}}

上一轮阻断（首轮为空，逐条核对是否已解决）：
{{acceptance.blockers}}
`,
    }),
  ],
  until: { source: "acceptance.verdict", equals: "PASS" },
});

phase("提交");

agent({
  id: "submit_mr",
  label: "提交 MR",
  cwd: ".",
  output: "json",
  inputs: { delivery_loop },
  prompt: `
你负责交付循环之后的提交步骤。只把下方交付循环结果用于判断验收门禁：开头的 Stop reason 为 until_matched 表示验收 PASS；为 max_iterations_reached 表示打满轮次仍未通过。不要依赖其中的 RD 交付摘要来推断 PR 范围或内容。

若验收未通过：不要创建 MR/PR，也不要 commit。直接检查当前仓库状态并输出现状报告：
- 当前已完成的工作与改动文件
- 未通过的验收问题（从 [acceptance] 输出的 JSON 中 blockers 逐条整理）
- 建议的下一步

若验收已通过，请以当前工作区和原始需求为准提交 MR/PR，不需要重建或推断流程开始前的基线：
1. 检查当前分支、git status 和 git diff，独立总结当前改动形成的实际实现方案，并据此确定提交内容和 PR 说明。
2. 如当前分支不适合直接提交，创建语义清晰的新分支。
3. 提交前根据项目实际情况运行必要的 focused checks；无法运行时说明原因。
4. 使用准确、简洁的 commit message 提交当前交付，push 分支并使用仓库可用工具创建 MR/PR。
5. PR 标题和正文只描述原始需求、当前实际改动、技术方案和验证结果，不复述 RD/Reviewer 的过程性对话；并在正文中原样保留最终一轮验收记录中的「未验证项」（逐条照抄，不改写、不省略），供人工在合并前复核。
6. 如果缺少 remote、认证、权限或 MR/PR 工具不可用，不要伪造链接；报告阻塞点，并输出已准备好的分支、commit 和下一步命令。

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

交付循环结果：
{{delivery_loop}}
`,
});
