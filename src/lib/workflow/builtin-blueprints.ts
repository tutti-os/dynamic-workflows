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
      "In a bounded two-role loop, an RD agent implements the requirement while an independent reviewer judges only the original requirement and current repository state, never the RD delivery narrative. The RD keeps an inherited session with appendPrompt deltas; the reviewer runs each round fresh and independent, seeing only its own previous review, and returns PASS or FAIL on the final line. A final step gates on the acceptance result, then emits a structured JSON delivery report (output json): an MR/PR, or an honest blocked/not-accepted status carrying the review's unverified items.",
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
      "Create an MR/PR only after independent acceptance passes, with a structured JSON delivery report as the terminal output.",
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
  {
    id: "map-fan-out-demo-v1",
    title: "Dynamic Fan-Out Demo",
    description:
      "A discover agent returns a JSON work list, map fans out a per-item pipeline (process, then adversarially verify) with per-item failure isolation, and a synthesizer merges the results while keeping skipped items visible.",
    category: "coding",
    tags: ["map", "fan-out", "dynamic", "json-output", "pipeline", "synthesis", "cwd"],
    difficulty: "starter",
    requiresCwd: true,
    patternSummary:
      "The reference dynamic-width pattern: a discovery step with output json ends with a bounded JSON array, and map expands it into at most maxItems items that run concurrently in independent sessions. Each item is a two-step pipeline — process_one produces the deliverable, then verify_one adversarially checks that item's output ({{process_one}}) — with no cross-item barrier. onItemFailure skip isolates per-item failures (attributed to the failing step), and the final report receives { items, failed, total } so dropped work stays visible.",
    useCases: [
      "Process a runtime-discovered work list (TODOs, deprecated call sites, untested files) item by item.",
      "Demonstrate output json discovery, map expansion, a per-item process→verify pipeline, and failure-visible synthesis.",
      "Serve as the acceptance fixture for map node UI and runtime behavior.",
    ],
    script: readBuiltinBlueprintScript(
      new URL(
        "./blueprints/map-fan-out-demo-v1.workflow.js",
        import.meta.url,
      ),
    ),
  },
  {
    id: "repo-migration-sweep-v1",
    title: "Repo Migration Sweep",
    description:
      "Discover call sites as JSON, migrate and verify each with map, run an independent whole-change acceptance loop, then open an MR that lists any skipped or rejected sites honestly.",
    category: "coding",
    tags: ["migration", "map", "loop", "acceptance", "independent-review", "mr", "cwd"],
    difficulty: "advanced",
    requiresCwd: true,
    patternSummary:
      "Combines dynamic fan-out with an acceptance loop for a migration. A discovery step emits a bounded JSON array of call sites; map runs a per-item adversarial migrate→verify pipeline with onItemFailure skip. A bounded acceptance loop then judges the WHOLE change, entering at the reviewer: fix runs in a fresh independent session driven by git state and feedback, while the reviewer re-judges cross-file regressions via a self-reference and the map record. Submit gates on the stop reason and emits a structured JSON delivery report (output json) listing rejected/failed sites and unverified items.",
    useCases: [
      "Sweep a from→to API or pattern migration across a repository call site by call site.",
      "Catch cross-file regressions the per-item verify cannot see with a whole-change reviewer.",
      "Open an MR that reports skipped and rejected sites instead of claiming full completion.",
    ],
    script: readBuiltinBlueprintScript(
      new URL(
        "./blueprints/repo-migration-sweep-v1.workflow.js",
        import.meta.url,
      ),
    ),
  },
  {
    id: "research-fanout-report-v1",
    title: "Research Fan-Out Report",
    description:
      "Decompose a topic into sub-questions as JSON, research each in parallel with an adversarial fact-check, then synthesize a cited report that keeps per-claim confidence and a coverage section.",
    category: "research",
    tags: ["research", "map", "fan-out", "fact-check", "citations", "synthesis"],
    difficulty: "starter",
    requiresCwd: false,
    patternSummary:
      "A planning step with output json decomposes the topic into 3..6 sub-questions; map fans out a per-item research→fact-check pipeline. The researcher cites sources when the runtime has web access and marks unverifiable claims when it does not; the fact-checker adversarially tries to refute each claim, drops what it cannot confirm, and ends with a Confidence high|medium|low line. The synthesizer orders by sub-question, preserves per-claim confidence and citations, and keeps failed, low-confidence, and unverified items in an explicit Coverage section.",
    useCases: [
      "Produce a fact-checked, cited report on a research question with parallel coverage.",
      "Keep honest confidence and unverified tags instead of laundering weak claims into confident prose.",
      "Run without a project directory — the runtime's own web access, if any, supplies sources.",
    ],
    script: readBuiltinBlueprintScript(
      new URL(
        "./blueprints/research-fanout-report-v1.workflow.js",
        import.meta.url,
      ),
    ),
  },
  {
    id: "release-readiness-check-v1",
    title: "Release Readiness Check",
    description:
      "Run five fixed release checks in parallel with a static map, merge them into a go/no-go summary, gate on a human decision, and record the outcome with any blockers for audit.",
    category: "ops",
    tags: ["release", "map", "static-list", "human", "gate", "go-no-go", "json-output", "cwd"],
    difficulty: "starter",
    requiresCwd: true,
    patternSummary:
      "A static inline list of five checks (changelog, tests, migrations, docs, security) drives a map whose single step verifies exactly one dimension against the actual repository and ends with a JSON verdict of ready or blocked. A summary merges the verdicts into a GO/NO-GO recommendation with blocked and failed checks explicit, a human gate captures go (primary) or no_go (danger, reason required), and a final record agent emits the decision, verbatim reason, and blockers as a JSON audit record (output json) with no external side effects.",
    useCases: [
      "Gate a release on a fixed checklist verified against the real repository state.",
      "Demonstrate a static-list map, a JSON per-check verdict, and a human go/no-go gate.",
      "Produce an auditable record of the decision and accepted blockers without shipping anything.",
    ],
    script: readBuiltinBlueprintScript(
      new URL(
        "./blueprints/release-readiness-check-v1.workflow.js",
        import.meta.url,
      ),
    ),
  },
  {
    id: "epic-breakdown-plan-v1",
    title: "Epic Breakdown Plan",
    description:
      "Decompose an epic into a JSON task list and iterate with a human approver, extract the approved tasks, detail each with map, and assemble an ordered plan with a coverage section.",
    category: "planning",
    tags: ["planning", "epic", "loop", "human", "map", "json-output", "extract"],
    difficulty: "advanced",
    requiresCwd: false,
    patternSummary:
      "A loop pairs a decompose step (output json, inherited planner session, appendPrompt revisions) with a human approve/revise gate, running until approved. Because a map cannot source a loop record, a post-loop extract step (output json) re-emits the approved task array verbatim; map then details each task independently (estimate-free scope + acceptance criteria + dependencies), and a final step assembles the tasks in dependency order with a Coverage section for any that failed to detail.",
    useCases: [
      "Turn an epic into an approved, dependency-ordered task plan with detailed specs.",
      "Iterate a decomposition with a human until approved before expanding any task.",
      "Demonstrate feeding a loop-approved list into a map via an explicit extract step.",
    ],
    script: readBuiltinBlueprintScript(
      new URL(
        "./blueprints/epic-breakdown-plan-v1.workflow.js",
        import.meta.url,
      ),
    ),
  },
];

function readBuiltinBlueprintScript(fileUrl: URL): string {
  return fs.readFileSync(fileUrl, "utf8");
}
