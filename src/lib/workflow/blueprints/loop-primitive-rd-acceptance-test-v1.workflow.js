export const meta = {
  name: "RD Acceptance Delivery",
  description: "先记录 git 基线，RD 工程师与验收 Reviewer 在有限轮次内迭代交付；验收 PASS 后提交 MR/PR，未通过则输出现状报告。必须从明确的项目目录启动，所有 agent 固定在该目录工作。",
  requiresCwd: true,
};

export const inputs = {
  requirement: {
    type: "string",
    required: true,
    label: "原始需求",
    description: "标准规格需求文档。RD 与验收器只能看到这段文本，对话中达成的共识必须写入其中：1) 背景与目标；2) 改动范围（涉及模块/文件，已知即可）；3) 验收标准（逐条、可验证）；4) 明确不做的事项与约束。",
    placeholder: "背景与目标：\n\n改动范围：\n\n验收标准：\n1. \n2. \n\n明确不做：\n",
    widget: "textarea",
  },
};

phase("交付基线");

const baseline = agent({
  id: "baseline",
  label: "记录基线",
  cwd: ".",
  prompt: `
启动工作目录：
{{workflow.cwd}}

你是交付基线记录员。请在上述 cwd 对应的项目目录中记录当前 git 基线，供后续验收和提交步骤区分"本次交付的改动"与"启动时已存在的存量改动"。不要做任何修改。

请收集并整理：
1. 当前分支与 HEAD commit（git branch --show-current、git rev-parse HEAD）。
2. 工作区现状（git status --short）：启动时已有的未提交改动逐项列出——它们是存量，不属于本次交付。
3. 项目类型与可用的检查命令（测试/构建/lint），找不到就写"未发现"。

最终只输出以下格式的基线报告：
- 分支：
- HEAD：
- 启动时未提交改动：（无 / 逐项列表）
- 可用检查命令：
`,
});

phase("RD 交付与验收");

const delivery_loop = loop({
  id: "delivery_loop",
  label: "RD 交付循环",
  cwd: ".",
  maxIterations: 5,
  onMaxIterations: "complete",
  inputs: { baseline },
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

交付基线（启动时的 git 状态，其中已有的未提交改动是存量，不要动它们）：
{{baseline}}

你是 RD 工程师。请在上述 cwd 对应的项目目录中用代码实现原始需求。交付物是可工作的代码改动，不是方案或计划文档。

约定：
1. 改动保留在工作区，不要自行 commit 或 push；提交由后续步骤统一处理。
2. 实现后运行与改动相关的检查（可参考基线报告中的检查命令）；检查失败或无法运行时如实说明，不要声称通过。
3. 实现过程中如果发现需求不可行、有歧义、或不偏离需求就无法继续，立即停止实现：在交付摘要第一行标注「需要对齐」，说明冲突点和你建议的方向。不要按自己的猜测做完。

最后输出交付摘要，作为验收依据：
- 改动文件：逐个列出，每个一句话说明
- 实现说明：关键实现点与取舍
- 已运行的检查及结果：
- 验证方式：告诉验收者如何确认需求被满足
`,
      appendPrompt: `
第 {{iteration}} 轮修订。

上一轮验收反馈：
{{acceptance}}

请继续在同一个项目目录中工作，修复反馈中标注为"阻断"的问题；"建议"项可顺手处理但不强制。若反馈是对「需要对齐」问题的裁决，按裁决给出的方向继续实现。约定不变：不要 commit 或 push，修复后运行相关检查并如实报告结果。

最后按同样格式输出本轮交付摘要（改动文件、实现说明、检查结果、验证方式）。
`,
    }),
    agent({
      id: "acceptance",
      label: "验收 Reviewer",
      session: { mode: "inherit", key: "acceptance_room" },
      prompt: `启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

交付基线（启动时的 git 状态）：
{{baseline}}

你是验收器，独立于 RD 工作，不需要也不允许修改代码。请在同一个 cwd 对应的项目目录中验收本次交付是否满足原始需求。

验收方法：
1. 先用 git status / git diff 对照基线圈定本次交付的实际改动范围；基线中已存在的存量改动不在验收范围内。
2. 下面是 RD 的交付摘要。把它当作待核实的声明，逐条对照实际代码验证，不要仅凭摘要下结论：
{{rd}}
3. 按原始需求逐项核对实际行为；能运行 RD 声明的检查就复核其结果。

判定标准：
- 如果 RD 交付摘要标注了「需要对齐」：本轮不做全量审查，优先依据原始需求裁决该对齐问题，给出明确方向后直接 FAIL；若需求文本不足以裁决，说明缺口后仍然 FAIL，缺口会随最终现状报告带给用户。
- FAIL 仅用于不满足原始需求的阻断性问题；风格、可读性等改进意见标注为"建议"，不作为 FAIL 依据。
- FAIL 时反馈必须逐条列出：位置（文件/函数）、问题、期望行为，并标注"阻断"或"建议"。

你可以先给出验收意见，但最后一个非空行必须只返回以下两种状态之一：
PASS
FAIL
`,
      appendPrompt: `
第 {{iteration}} 轮验收。

RD 本轮交付摘要（待核实的声明）：
{{rd}}

请重新验收：先用 git diff 确认实际改动，逐条核对你上一轮标注为"阻断"的问题是否已解决，同时检查本轮修订是否引入新问题。判定标准与反馈格式不变。

最后一个非空行必须只返回以下两种状态之一：
PASS
FAIL
`,
    }),
  ],
  until: { source: "acceptance", finalStatus: "PASS" },
});

phase("提交");

agent({
  id: "submit_mr",
  label: "提交 MR",
  cwd: ".",
  inputs: { delivery_loop, baseline },
  prompt: `
启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

交付基线（启动时的 git 状态，其中已有的未提交改动是存量，不要提交它们）：
{{baseline}}

交付循环结果：
{{delivery_loop}}

先判断验收结论：循环结果开头的 Stop reason 为 until_matched 表示验收 PASS；为 max_iterations_reached 表示打满轮次仍未通过。

若验收未通过：不要创建 MR/PR，也不要 commit。改为输出现状报告：
- 已完成的工作与改动文件
- 未通过的验收问题（从 [acceptance] 输出逐条整理）
- 建议的下一步

若验收已通过，请在上述 cwd 对应的项目目录中提交本次交付对应的 MR/PR：
1. 对照基线检查 git status 和当前分支，只提交本次交付相关的变更，排除基线中的存量改动。
2. 如当前分支不适合直接提交，创建语义清晰的新分支。
3. 提交前根据项目实际情况运行必要的 focused checks；无法运行时说明原因。
4. commit message 简洁描述本次交付，可参考 [rd] 交付摘要。
5. push 分支并使用仓库可用工具创建 MR/PR。
6. 如果缺少 remote、认证、权限或 MR/PR 工具不可用，不要伪造链接；报告阻塞点，并输出已准备好的分支、commit 和下一步命令。

最终只输出：
- 结果：MR/PR 链接 / 阻塞原因 / 未通过现状报告
- 分支名与 commit id（如有）
- 已运行的检查
- 本次提交或现状摘要
`,
});
