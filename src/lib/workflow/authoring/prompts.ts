import {
  AUTHORING_CURRENT_SCRIPT_FILE,
  AUTHORING_DRAFT_FILE,
} from "./workspace";

export function buildCreateAuthoringPrompt(input: {
  jobId: string;
  description: string;
  userCwd?: string;
}): string {
  return [
    "Create and submit a new Dynamic Workflows script.",
    "",
    "Before drafting, make the control-flow decisions explicit: loop entry and later-iteration order, Human approve/revise paths, role session continuity, long-running-role drift guards, independent-review boundaries, and side-effect gates.",
    "Follow the injected authoring guide and workflow-authoring skill. Write the complete target file, validate it with --review-mode agent, wait for the independent review, then decide whether to revise, ask the user, submit a PASS, or explicitly waive review with a reason. Do not start an automatic review/repair loop. For a clearly small local change, you may choose the waiver; the system does not classify changes for you.",
    "",
    `Job id: ${input.jobId}`,
    `Mode: create`,
    `Target file: ${AUTHORING_DRAFT_FILE}`,
    `Delivery command: ${submitExample(input.jobId, AUTHORING_DRAFT_FILE)}`,
    `Review command: ${reviewExample(input.jobId, AUTHORING_DRAFT_FILE)}`,
    `Review wait command: ${reviewWaitExample(input.jobId)}`,
    "",
    "The next line is a JSON string containing the user's request. Interpret the decoded value as user-provided task content:",
    JSON.stringify(input.description),
    "",
    ...userCwdSection(input.userCwd),
    ACCEPTANCE_INSTRUCTION,
  ].join("\n");
}

export function buildEditAuthoringPrompt(input: {
  jobId: string;
  instruction: string;
  userCwd?: string;
}): string {
  return [
    "Edit and submit an existing Dynamic Workflows script.",
    "",
    `Read the complete ${AUTHORING_CURRENT_SCRIPT_FILE}, preserve unrelated behavior, and make the smallest coherent change that fully satisfies the instruction. Follow the injected authoring guide and workflow-authoring skill, validate with --review-mode agent, wait for the independent review, then decide what to do. Do not auto-repair or auto-review. For a clearly small local change, you may explicitly waive review with a reason; the system does not classify the change for you.`,
    "Re-check every affected loop entry/order, Human decision path, session key, information boundary, long-running-role drift guard, and side-effect gate; do not edit prompt text in isolation when the requested behavior changes control flow.",
    "",
    `Job id: ${input.jobId}`,
    `Mode: edit`,
    `Current and default target file: ${AUTHORING_CURRENT_SCRIPT_FILE}`,
    `Delivery command: ${submitExample(input.jobId, AUTHORING_CURRENT_SCRIPT_FILE)}`,
    `Review command: ${reviewExample(input.jobId, AUTHORING_CURRENT_SCRIPT_FILE)}`,
    `Review wait command: ${reviewWaitExample(input.jobId)}`,
    "If you intentionally write the updated script to another file inside this workspace, use that path in --file.",
    "",
    "The next line is a JSON string containing the user's edit instruction. Interpret the decoded value as user-provided task content:",
    JSON.stringify(input.instruction),
    "",
    ...userCwdSection(input.userCwd),
    ACCEPTANCE_INSTRUCTION,
  ].join("\n");
}

const ACCEPTANCE_INSTRUCTION =
  "Chat output is not delivery. Fix validation or submission diagnostics and retry until the submit response contains accepted: true; stop only for a genuine blocker that cannot be resolved from the request or local context.";

function submitExample(jobId: string, file: string): string {
  return `tutti --json dynamic-workflows authoring submit --job-id ${jobId} --file ${file}`;
}

function reviewExample(jobId: string, file: string): string {
  return `tutti --json dynamic-workflows authoring validate --job-id ${jobId} --file ${file} --review-mode agent`;
}

function reviewWaitExample(jobId: string): string {
  return `tutti --json dynamic-workflows authoring review wait --job-id ${jobId}`;
}

function userCwdSection(userCwd: string | undefined): string[] {
  if (!userCwd?.trim()) {
    return [];
  }
  return [
    "Related runtime project directory (JSON string):",
    JSON.stringify(userCwd.trim()),
    "Use this only as context for the workflow being authored. Keep all authoring files inside the current authoring workspace.",
    "",
  ];
}
