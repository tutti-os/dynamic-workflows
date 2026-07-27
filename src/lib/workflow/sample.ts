import { createFlowV1Bundle } from "@/lib/flow-v1/bundle";

export function createSampleFlowV1Bundle(description?: string) {
  const resolvedDescription =
    description?.trim() ||
    "Inspect a codebase with focused local agents and synthesize the results.";
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "Repository Review",
  description: ${JSON.stringify(resolvedDescription)},
  requiresCwd: true,
};
export const runtime = {
  maxNodeExecutionsPerTick: 20,
  maxImmediateContinuations: 1,
  maxParallelNodes: 2,
};
const inventory = agent({
  id: "inventory",
  output: "text",
  prompt: "请检查代码仓库结构，并返回运行时技术栈、主要目录和重要扩展点。",
});
const architecture = agent({
  id: "architecture_review",
  inputs: { inventory },
  output: "text",
  prompt: "请根据以下清单审查架构边界和数据流：\\n\\n{{inventory}}",
});
const security = agent({
  id: "security_review",
  inputs: { inventory },
  output: "text",
  prompt: "请根据以下清单审查认证、密钥、Shell 执行、文件写入和网络访问：\\n\\n{{inventory}}",
});
const summary = agent({
  id: "final_summary",
  inputs: { architecture, security },
  output: "text",
  prompt: "请将架构和安全审查结果汇总为一份实现说明。\\n\\n架构：\\n{{architecture}}\\n\\n安全：\\n{{security}}",
});
completeCycle({ id: "complete", inputs: { summary } });
`,
    },
  ]);
}
