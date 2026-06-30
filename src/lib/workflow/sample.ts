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
    id: "final_summary",
    label: "Final Summary",
    cwd: ".",
    inputs: { delivery_loop },
    prompt: \`
启动工作目录：
{{workflow.cwd}}

循环执行结果：
{{delivery_loop}}

请总结最终交付、迭代次数、是否通过、最后验收意见。
\`,
  });
});
`;
