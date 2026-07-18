export const meta = {
  name: "Repo Migration Sweep",
  description: "先发现所有需要迁移的调用点并以 JSON 列出，用 map 逐点迁移并逐点独立验收，再由独立 Reviewer 对整体改动做跨文件验收循环，通过后提交只描述本次迁移的 MR/PR，未通过或被拒的条目如实列出。",
  requiresCwd: true,
};

export const inputs = {
  migration_brief: {
    type: "string",
    required: true,
    label: "迁移说明",
    description: "本次迁移的唯一说明；发现、迁移、验收各角色都独立读取仓库，但只共享这份说明。请包含：1) 从什么迁移到什么（旧 API/模式 → 新 API/模式）；2) 范围目录或模块（在哪里查找调用点）；3) 什么算完成（每个调用点迁移后应满足的行为与检查）；4) 明确不做的事项与约束（不改的文件、不引入的依赖）。",
    placeholder: "从 → 到：\n\n范围目录：\n\n完成标准：\n\n明确不做：\n",
    widget: "textarea",
  },
  reviewer_agent: {
    type: "string",
    required: false,
    label: "Reviewer agent",
    description: "可选：整体验收 Reviewer 使用的 agent target id（来自 tutti --json agent list）。留空则使用 run 级 agent。",
  },
  reviewer_model: {
    type: "string",
    required: false,
    label: "Reviewer model",
    description: "可选：整体验收 Reviewer 使用的模型，需与所选 agent 兼容。留空则使用 run 级 model。整体验收是质量门禁，值得配置更强的模型。",
  },
  reviewer_permission_mode: {
    type: "string",
    required: false,
    label: "Reviewer permission mode",
    description: "可选：整体验收 Reviewer 的权限模式 id。先用 tutti agent composer-options --agent-id <reviewer_agent> --json 查询 permissionConfig.modes；留空先继承 run 级权限，run 级也未设置时使用该 agent 的默认权限。Reviewer 是只读角色——若该 agent 提供只读类权限模式，建议在此指定，从权限层强制它不改代码。",
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

phase("发现调用点");

const discover = agent({
  id: "discover",
  label: "发现调用点",
  output: "json",
  prompt: "你负责在仓库中发现本次迁移需要改动的全部调用点。只做发现与定位，不修改任何代码。\n\n工作要求：\n1. 依据迁移说明，在其指定的范围目录内定位所有属于「从」侧、需要迁移到「到」侧的调用点；不要包含已在「到」侧或明确不做范围内的位置。\n2. 每个调用点用一个对象描述：file（相对路径）、line（行号，整数）、note（一句话说明这里要改什么）。\n3. 最多返回 12 个最关键、确实需要迁移的调用点。如果实际调用点超过 12 个，在最后一个对象的 note 中标注「还有 N 处未列出：<定位线索>」，不要静默截断。\n4. 如果没有任何需要迁移的调用点，返回 []。\n\n输出契约：消息最后只包含一个 JSON 数组，形如 [{\"file\": \"path/to/file\", \"line\": 1, \"note\": \"要迁移的内容\"}]，其后不得有任何多余文字。\n\n启动工作目录：\n{{workflow.cwd}}\n\n迁移说明：\n{{migration_brief}}",
});

phase("逐点迁移");

const migrate_all = map({
  id: "migrate_all",
  label: "逐点迁移并验收",
  source: discover,
  maxItems: 12,
  onItemFailure: "skip",
  steps: [
    agent({
      id: "migrate_one",
      label: "迁移 {{item.file}}",
      prompt: "你只负责迁移这一个调用点，其他调用点由并行的 agent 处理，严格待在本条目的范围内。在本轮内完成实现与验证后再结束回合，不要以计划或问题清单收尾。\n\n工作要求：\n1. 依据迁移说明，将本条目对应的调用点从「从」侧迁移到「到」侧；只编辑这一处及其直接必需的最小改动，不要触碰其他调用点或迁移说明「明确不做」范围内的内容。\n2. 优先复用仓库现有模式与约定；改动保留在工作区，不要自行 commit 或 push。\n3. 改动后运行与本处相关的 focused checks；无法运行或失败时如实说明，不要声称通过。\n4. 只输出本条目的迁移结果（改了哪个文件/位置、做了什么、验证方式），它会与其他条目合并；不要复述整份迁移说明。\n\n启动工作目录：\n{{workflow.cwd}}\n\n迁移说明：\n{{migration_brief}}\n\n本次调用点 {{item_index}}：\n{{item}}",
    }),
    agent({
      id: "verify_one",
      label: "验收 {{item.file}}",
      prompt: "你独立验收这一个调用点的迁移结果，不修改代码，不重做迁移，也不触碰其他条目。要有对抗性：检查仓库当前的实际状态，尝试找出这处迁移错误、不完整或伪造的具体证据；当你无法确认它已正确迁移时，判为拒绝。\n\n只针对本条目验证：迁移说明的「完成标准」在这一处是否满足、是否仍残留「从」侧写法、是否越界改动了其他内容。复述你接受的迁移结果（仅在证据要求时更正），最后一个非空行只写 VERIFIED 或 REJECTED。\n\n启动工作目录：\n{{workflow.cwd}}\n\n迁移说明：\n{{migration_brief}}\n\n本次调用点 {{item_index}}：\n{{item}}\n\n待验收的迁移结果：\n{{migrate_one}}",
    }),
  ],
});

phase("整体验收");

const acceptance_loop = loop({
  id: "acceptance_loop",
  label: "整体验收循环",
  cwd: ".",
  inputs: { migrate_all },
  maxIterations: "{{max_rounds:3}}",
  onMaxIterations: "complete",
  firstIteration: { startAt: "reviewer" },
  steps: [
    agent({
      id: "fix",
      label: "整体修复",
      session: { mode: "independent" },
      prompt: "你负责在独立会话中对整个工作区做一次迁移修复。你没有历史对话，一切以仓库当前状态为准：先查看 git status 与 git diff，针对将要修改的文件做定向重读，再依据下方 Reviewer 反馈修复标注为「阻断」的问题。在本轮内完成实现与验证后再结束回合。\n\n工作要求：\n1. 修复面向整份迁移说明，可跨文件处理逐点迁移遗漏或引入的回归；但不要扩大到迁移说明「明确不做」的范围，也不要重做已 VERIFIED 且无问题的条目。\n2. Reviewer 不能扩展或改写迁移说明：若反馈需要新增产品决策或超出原始范围，标注「需要对齐」并说明原因，不要自行扩大范围。\n3. 改动保留在工作区，不要自行 commit 或 push；修复后运行相关 focused checks 并如实报告结果。\n4. 最后输出简洁的本轮修复摘要（改了哪些文件、修了哪些阻断、已运行检查及结果）。\n\n启动工作目录：\n{{workflow.cwd}}\n\n迁移说明：\n{{migration_brief}}\n\n逐点迁移记录（items 为各条目结果，failed 为失败条目）：\n{{migrate_all}}\n\nReviewer 阻断（逐条修复；每项含 location/issue/evidence/expectation）：\n{{reviewer.blockers}}\n\nReviewer 建议（可选处理，非阻断）：\n{{reviewer.suggestions}}",
    }),
    agent({
      id: "reviewer",
      label: "整体验收 Reviewer",
      agent: "{{reviewer_agent}}",
      model: "{{reviewer_model}}",
      permissionMode: "{{reviewer_permission_mode}}",
      session: { mode: "independent" },
      output: "json",
      prompt: "你是独立的整体验收 Reviewer，每一轮都在全新会话中工作，不修改代码，也不读取或依赖任何迁移叙述。只依据迁移说明和仓库当前实际状态，判断整份迁移是否完成。\n\n验收方法：\n1. 从迁移说明提炼逐条、可验证的完成标准，不自行新增产品需求或扩大范围。若下方「上一轮完成标准」非空且迁移说明未变，沿用该清单逐项重验，不必重新推导；仅当需求或范围理解被证明有误时才修订清单。\n2. 独立查看 git status、git diff、相关代码、测试与配置，运行与本次迁移相关的 focused checks；无法验证的项明确说明原因并列入 unverified。\n3. 复验轮次的验证范围＝上一轮阻断的修复及其影响面 ＋ 自上一轮评审以来的全部新改动面（用 git diff 对比确定）——新问题只可能藏在新改动里。完整检查面（全量测试/构建等重型检查）只在你准备返回 PASS 的轮次要求，首轮仍需完整建立基线。\n4. 你的判断覆盖整体，而不只是单点：全仓是否仍残留「从」侧写法、逐点迁移之间是否引入跨文件回归或不一致、下方逐点迁移记录中标为 REJECTED 或出现在 failed 列表的条目是否已被妥善处理。\n5. 若下方「上一轮阻断」非空，逐条核对其是否已解决，并检查是否引入新问题。上一轮记录只是你自己的历史判断，不构成当前证据；若迁移说明、相关代码和同一个阻断都没有变化，不要重复无关检查，简洁确认阻断仍存在并返回 verdict=FAIL。\n\n返回 PASS 之前：上一轮清单只是核对起点，不是扫描边界——必须以全新视角覆盖整个变更面，主动寻找清单之外的问题。\n\n判定标准：\n- verdict=FAIL 仅用于不满足迁移说明的阻断性问题；风格类意见放入 suggestions，不作为 FAIL 依据。\n- 每个阻断在 blockers 中逐条给出 location、issue、evidence、expectation。\n- 迁移说明缺少判断所必需的信息时，作为一个 blocker（issue 以「需要对齐」开头）并返回 verdict=FAIL，不要替用户做产品决策。\n\n输出契约（output: \"json\"）：可先给出简短的验收推理，但消息最后只包含一个 JSON 对象，其后不得有任何多余文字。形如：\n{\"verdict\": \"PASS\" | \"FAIL\", \"criteria\": [{\"id\": 1, \"text\": \"完成标准原文\", \"result\": \"通过\" | \"不通过\" | \"未验证\"}], \"blockers\": [{\"location\": \"文件/函数\", \"issue\": \"问题\", \"evidence\": \"证据\", \"expectation\": \"期望行为\"}], \"suggestions\": [\"非阻断的改进建议\"], \"checks\": \"已运行检查的简要清单（一段）\", \"unverified\": [\"未能验证的项及原因\"]}\n字段规则：verdict=PASS 时 blockers 为 []；criteria 逐条覆盖完成标准，result 三选一；suggestions/unverified 没有则填 []；checks 一段话如实说明。\n\n启动工作目录：\n{{workflow.cwd}}\n\n迁移说明：\n{{migration_brief}}\n\n逐点迁移记录（items 为各条目结果，failed 为失败条目）：\n{{migrate_all}}\n\n上一轮完成标准（首轮为空，沿用重验）：\n{{reviewer.criteria}}\n\n上一轮阻断（首轮为空，逐条核对是否已解决）：\n{{reviewer.blockers}}",
    }),
  ],
  until: { source: "reviewer.verdict", equals: "PASS" },
});

phase("提交");

agent({
  id: "submit_mr",
  label: "提交 MR",
  cwd: ".",
  output: "json",
  inputs: { acceptance_loop, migrate_all },
  prompt: "你负责整体验收之后的提交步骤。只用下方验收循环结果开头的 Stop reason 判断门禁：until_matched 表示整体验收 PASS；max_iterations_reached 表示打满轮次仍未通过。不要依赖循环中的叙述来推断 PR 范围。\n\n若验收未通过：不要创建 MR/PR，也不要 commit。检查当前仓库状态并输出现状报告：已完成的迁移与改动文件、剩余未通过的阻断问题、逐点迁移记录中 REJECTED 或 failed 的条目、建议的下一步，并附续跑提示：工作区已保留全部进展，在同一工作目录重跑本工作流即可从当前状态继续收敛，无需重做已完成的迁移。\n\n若验收已通过，以当前工作区和迁移说明为准提交 MR/PR：\n1. 检查当前分支、git status 和 git diff，独立总结本次迁移的实际改动，据此确定提交内容与 PR 说明。\n2. 如当前分支不适合直接提交，创建语义清晰的新分支。\n3. 提交前运行必要的 focused checks；无法运行时说明原因。\n4. 使用准确简洁的 commit message 提交，push 分支并用仓库可用工具创建 MR/PR。\n5. PR 标题和正文只描述本次迁移（从什么迁到什么、覆盖的调用点、验证结果），不复述过程性对话；并在正文中如实列出逐点迁移记录里 REJECTED 或 failed 的条目及原因，不要粉饰为全部完成；同时在正文中原样保留最终一轮验收记录中的「未验证项」（逐条照抄，不改写、不省略），供人工在合并前复核。\n6. 若缺少 remote、认证、权限或 MR/PR 工具，不伪造链接；报告阻塞点，并输出已准备好的分支、commit 和下一步命令。\n\n输出契约（output: \"json\"）：消息最后只包含一个 JSON 对象，其后不得有任何多余文字。形如：\n{\"result\": \"mr_created\" | \"blocked\" | \"not_accepted\", \"prUrl\": string|null, \"branch\": string|null, \"commit\": string|null, \"checks\": \"已运行检查的一句话摘要\", \"unverified\": [\"最终验收未验证项，逐条\"], \"rejectedSites\": [\"逐点迁移记录中 REJECTED 或 failed 的条目及原因\"], \"summary\": \"一句话交付/现状摘要\"}\n字段规则：\n- result：mr_created 表示已创建 MR/PR；blocked 表示验收通过但因缺少 remote/认证/权限/工具无法创建；not_accepted 表示验收未通过、未创建 MR/PR。\n- prUrl/branch/commit：没有的填 null，绝不伪造链接。\n- unverified：逐条照抄最终一轮验收记录中的「未验证项」，与 PR 正文中保留的内容逐条一致；没有则填 []。\n- rejectedSites：逐条列出逐点迁移记录里 REJECTED 或 failed 的条目及原因；没有则填 []。\n- checks/summary：各一句话，如实描述，不粉饰。\n\n启动工作目录：\n{{workflow.cwd}}\n\n迁移说明：\n{{migration_brief}}\n\n逐点迁移记录：\n{{migrate_all}}\n\n验收循环结果：\n{{acceptance_loop}}",
});
