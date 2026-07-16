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
      "In a bounded two-role loop, an RD agent implements the requirement while an independent acceptance reviewer judges only the original requirement and current repository state, never the RD delivery narrative. The RD keeps an inherited session with appendPrompt deltas; the reviewer runs each round in a fresh independent session, receiving only its own previous review through dataflow, and fails only on blocking issues with PASS or FAIL on the final line. A final step uses the acceptance result only as a gate, then creates an MR/PR from current changes or reports remaining blockers.",
    useCases: [
      "Implement a requirement in a local repository with adversarial acceptance review.",
      "Keep reviewer judgment independent from the implementer's delivery narrative and claimed change scope.",
      "Demonstrate a bounded loop, an inherited RD session with appendPrompt, a fresh reviewer session per round, and until finalStatus primitives.",
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
  {
    id: "parallel-review-synthesis-v1",
    title: "Parallel Review Synthesis",
    description:
      "Independent single-lens reviewers (architecture, security, correctness) run in parallel over one repository inventory, then a synthesizer merges their findings into one deduplicated, severity-ordered report.",
    category: "review",
    tags: ["review", "fan-out", "parallel", "synthesis", "independent-review", "cwd"],
    difficulty: "starter",
    requiresCwd: true,
    patternSummary:
      "A shared inventory step fans out to three lens reviewers with no edges between them, so they run concurrently and never see each other's narrative. A final synthesizer receives all three outputs, dedupes overlapping findings while preserving evidence, orders by severity, and reports the combined unexamined areas instead of silently truncating coverage. An optional shared review_model input overrides the model for every lens and falls back to the run-level model when left empty.",
    useCases: [
      "Review a change or module from several independent perspectives at once.",
      "Keep lens reviewers blind to each other so overlapping findings corroborate instead of echo.",
      "Demonstrate fan-out/fan-in dataflow, no-silent-caps coverage reporting, and optional runtime model overrides.",
    ],
    script: readBuiltinBlueprintScript(
      new URL(
        "./blueprints/parallel-review-synthesis-v1.workflow.js",
        import.meta.url,
      ),
    ),
  },
];

function readBuiltinBlueprintScript(fileUrl: URL): string {
  return fs.readFileSync(fileUrl, "utf8");
}
