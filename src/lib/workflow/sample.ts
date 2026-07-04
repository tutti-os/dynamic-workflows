export const SAMPLE_WORKFLOW = `export const meta = {
  name: "repo_review",
  description: "Inspect a codebase with focused local agents and synthesize the results",
}

phase("Scan")

const inventory = await agent({
  id: "inventory",
  label: "Repository inventory",
  prompt: \`
Inspect the repository structure.

Return the main folders, runtime stack, and files that look important for future changes.
  \`,
})

phase("Review")

const architecture = await agent({
  id: "architecture_review",
  label: "Architecture review",
  inputs: { inventory },
  prompt: \`
Review the architecture using this inventory:

{{inventory}}

Focus on module boundaries, data flow, and likely extension points.
  \`,
})

const security = await agent({
  id: "security_review",
  label: "Security review",
  inputs: { inventory },
  prompt: \`
Review security-sensitive areas using this inventory:

{{inventory}}

Look for auth, secrets, shell execution, file writes, and network access.
  \`,
})

phase("Synthesize")

const summary = await agent({
  id: "final_summary",
  label: "Final summary",
  inputs: { architecture, security },
  prompt: \`
Synthesize these reviews into a concise implementation brief.

Architecture:
{{architecture}}

Security:
{{security}}
  \`,
})

log("Workflow completed with final_summary")
`;

export const LOOP_RD_ACCEPTANCE_TEST_WORKFLOW = `export const meta = {
  name: "Loop Primitive RD Acceptance Test",
  description: "Tests a bounded loop where an RD engineer and acceptance reviewer iterate until PASS or max iterations is reached. Requires a run cwd before launch and keeps all agents pinned to it.",
  requiresCwd: true,
};

phase("RD delivery and acceptance", () => {
  const delivery_loop = loop({
    id: "delivery_loop",
    label: "RD delivery loop",
    cwd: ".",
    maxIterations: 4,
    onMaxIterations: "fail",
    steps: [
      agent({
        id: "rd",
        label: "RD Engineer",
        session: { mode: "inherit", key: "rd_room" },
        prompt: \`
启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

你是 RD 工程师。请在上述 cwd 对应的项目目录中工作，并根据原始需求交付实现方案或修订结果。
\`,
        appendPrompt: \`
第 {{iteration}} 轮修订。

启动工作目录（保持不变）：
{{workflow.cwd}}

上一轮验收反馈：
{{acceptance}}

请继续在同一个 cwd 对应的项目目录中工作，仅基于这次验收反馈修订交付，不要重新询问需求。
\`,
      }),
      agent({
        id: "acceptance",
        label: "Acceptance Reviewer",
        session: { mode: "inherit", key: "acceptance_room" },
        prompt: \`启动工作目录：
{{workflow.cwd}}

原始需求：
{{requirement}}

你是验收器。请在同一个 cwd 对应的项目目录中严格验收 RD 本轮交付是否满足原始需求。注意你不需要做修改，直接提出你的审查意见即可。

你必须只返回以下两种格式之一：
PASS: <简短通过理由>
FAIL: <具体打回意见>
\`,
      }),
    ],
    until: { source: "acceptance", includes: "PASS:" },
  });

  agent({
    id: "submit_mr",
    label: "Submit MR",
    cwd: ".",
    inputs: { delivery_loop },
    prompt: \`
启动工作目录：
{{workflow.cwd}}

循环执行结果：
{{delivery_loop}}

验收已经通过。请在上述 cwd 对应的项目目录中提交本次交付对应的 MR/PR。

要求：
1. 先检查 git status 和当前分支，只提交与原始需求及本次 RD 交付相关的变更。
2. 如当前分支不适合直接提交，请创建语义清晰的新分支。
3. 提交前根据项目实际情况运行必要的 focused checks；如果检查无法运行，请说明原因。
4. commit message 要简洁描述本次交付。
5. push 分支并使用仓库可用工具创建 MR/PR。
6. 如果缺少 remote、认证、权限或 MR/PR 工具不可用，不要伪造链接；请报告阻塞点，并输出已准备好的分支、commit 和下一步命令。

最终只输出：
- MR/PR 链接或阻塞原因
- 分支名
- commit id
- 已运行的检查
- 本次提交摘要
\`,
  });
});
`;
