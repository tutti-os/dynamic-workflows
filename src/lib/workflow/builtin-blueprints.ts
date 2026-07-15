import fs from "node:fs";
import type { WorkflowBlueprintDetail } from "./blueprint-types";

export const BUILTIN_WORKFLOW_BLUEPRINTS: WorkflowBlueprintDetail[] = [
  {
    id: "loop-primitive-rd-acceptance-test-v1",
    title: "RD Acceptance Delivery",
    description:
      "A bounded RD implementation and independent acceptance loop that runs until PASS, followed by an MR/PR based on the current repository state or a status report when acceptance never passes.",
    category: "coding",
    tags: ["loop", "rd", "acceptance", "independent-review", "mr", "cwd", "session"],
    difficulty: "advanced",
    requiresCwd: true,
    patternSummary:
      "In a bounded two-role loop, an RD agent implements the requirement while an independent acceptance reviewer evaluates only the original requirement and the repository's current implementation, without receiving the RD delivery summary or claimed change scope. The reviewer fails only on blocking issues and returns PASS or FAIL on the final line. Both roles keep inherited sessions with appendPrompt deltas. A final step uses the acceptance result only as a gate, then creates an MR/PR from the current repository changes or reports remaining blockers when iterations run out.",
    useCases: [
      "Implement a requirement in a local repository with adversarial acceptance review.",
      "Keep reviewer judgment independent from the implementer's delivery narrative and claimed change scope.",
      "Demonstrate a bounded loop, inherited sessions, appendPrompt, and until finalStatus primitives.",
      "Create a reusable RD/reviewer delivery pattern that degrades to a status report instead of failing silently.",
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
