import fs from "node:fs";
import type { WorkflowBlueprintDetail } from "./blueprint-types";

export const BUILTIN_WORKFLOW_BLUEPRINTS: WorkflowBlueprintDetail[] = [
  {
    id: "loop-primitive-rd-acceptance-test-v1",
    title: "Loop Primitive RD Acceptance Test",
    description:
      "Bounded RD implementation and acceptance review loop that runs until PASS, then prepares an MR/PR submission.",
    category: "coding",
    tags: ["loop", "rd", "acceptance", "mr", "cwd", "session"],
    difficulty: "advanced",
    requiresCwd: true,
    patternSummary:
      "A bounded two-role loop where an RD agent iterates on implementation and an acceptance reviewer returns PASS or FAIL on the final line. Each role keeps an inherited session across iterations, and a final submission step runs after acceptance passes.",
    useCases: [
      "Implement a requirement in a local repository with acceptance feedback.",
      "Exercise loop, inherited sessions, appendPrompt, cwd, and until finalStatus primitives.",
      "Create a reusable RD/reviewer delivery pattern for agentic coding workflows.",
    ],
    script: readBuiltinBlueprintScript(
      new URL(
        "./blueprints/loop-primitive-rd-acceptance-test-v1.workflow.js",
        import.meta.url,
      ),
    ),
  },
];

function readBuiltinBlueprintScript(fileUrl: URL): string {
  return fs.readFileSync(fileUrl, "utf8");
}
