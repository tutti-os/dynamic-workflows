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
  prompt: "Inspect the repository structure. Return the runtime stack, main folders, and important extension points.",
});
const architecture = agent({
  id: "architecture_review",
  inputs: { inventory },
  output: "text",
  prompt: "Review architecture boundaries and data flow using this inventory:\\n\\n{{inventory}}",
});
const security = agent({
  id: "security_review",
  inputs: { inventory },
  output: "text",
  prompt: "Review auth, secrets, shell execution, file writes, and network access using this inventory:\\n\\n{{inventory}}",
});
const summary = agent({
  id: "final_summary",
  inputs: { architecture, security },
  output: "text",
  prompt: "Synthesize the architecture and security findings into an implementation brief.\\n\\nArchitecture:\\n{{architecture}}\\n\\nSecurity:\\n{{security}}",
});
completeCycle({ id: "complete", inputs: { summary } });
`,
    },
  ]);
}
