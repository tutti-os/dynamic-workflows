import fs from "node:fs";
import type { WorkflowBlueprintDetail } from "./blueprint-types";

export const BUILTIN_WORKFLOW_BLUEPRINTS: WorkflowBlueprintDetail[] = [
  {
    id: "human-feedback-loop-v1",
    title: "Human Feedback Loop",
    description:
      "Pause after each agent result so a person can accept it or send structured feedback into the next iteration.",
    category: "coding",
    tags: ["human", "feedback", "loop", "approval", "structured-output"],
    difficulty: "advanced",
    requiresCwd: false,
    patternSummary:
      "An agent produces a result, a Human Task captures accept or revise, and the structured response controls loop convergence while preserving feedback for the next iteration.",
    useCases: [
      "Review generated content before downstream automation continues.",
      "Collect revision feedback without encoding decisions in agent text.",
      "Demonstrate persistent Human Tasks and structured loop conditions.",
    ],
    script: readBuiltinBlueprintScript(
      new URL("./blueprints/human-feedback-loop-v1.workflow.js", import.meta.url),
    ),
  },
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
  {
    id: "rd-human-acceptance-delivery-v1",
    title: "RD Human-Gated Acceptance Delivery",
    description:
      "An RD first iterates with a person, then enters independent acceptance. Reviewer failures return directly to the same RD session for repair without repeating the human gate.",
    category: "coding",
    tags: ["human", "loop", "rd", "acceptance", "reviewer", "mr", "session"],
    difficulty: "advanced",
    requiresCwd: true,
    patternSummary:
      "A human alignment loop approves the RD implementation before an acceptance loop starts directly at the reviewer. Failed reviews run RD repair and review again. Both RD steps share rd_room across loop boundaries, while the reviewer keeps a separate inherited session.",
    useCases: [
      "Align implementation direction with a person before formal acceptance.",
      "Send acceptance failures directly back to the original RD context.",
      "Avoid making a person approve every reviewer-driven repair cycle.",
      "Create an MR/PR only after independent acceptance passes.",
    ],
    script: readBuiltinBlueprintScript(
      new URL(
        "./blueprints/rd-human-acceptance-delivery-v1.workflow.js",
        import.meta.url,
      ),
    ),
  },
];

function readBuiltinBlueprintScript(fileUrl: URL): string {
  return fs.readFileSync(fileUrl, "utf8");
}
