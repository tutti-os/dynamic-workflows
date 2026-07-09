import fs from "node:fs";
import type { WorkflowBlueprintDetail } from "./blueprint-types";

export const BUILTIN_WORKFLOW_BLUEPRINTS: WorkflowBlueprintDetail[] = [
  {
    id: "loop-primitive-rd-acceptance-test-v1",
    title: "RD Acceptance Delivery",
    description:
      "Baseline capture, then a bounded RD implementation and acceptance review loop that runs until PASS, followed by an MR/PR submission or a status report when acceptance never passes.",
    category: "coding",
    tags: ["loop", "rd", "acceptance", "baseline", "mr", "cwd", "session"],
    difficulty: "advanced",
    requiresCwd: true,
    patternSummary:
      "A baseline step records the starting git state so later roles can separate this delivery from pre-existing changes. In a bounded two-role loop, an RD agent implements and hands off a structured delivery summary; an independent acceptance reviewer verifies those claims against the actual diff, fails only on blocking issues, and returns PASS or FAIL on the final line. Both roles keep inherited sessions with appendPrompt deltas. A final step submits an MR/PR on PASS, or reports remaining blockers when iterations run out.",
    useCases: [
      "Implement a requirement in a local repository with adversarial acceptance review.",
      "Demonstrate baseline capture, loop, inherited sessions, appendPrompt, loop-level inputs, and until finalStatus primitives.",
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
