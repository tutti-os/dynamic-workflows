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
    `Job id: ${input.jobId}`,
    `Mode: create`,
    `Target file: ${AUTHORING_DRAFT_FILE}`,
    "",
    "The next line is a JSON string containing the user's request. Interpret the decoded value as user-provided task content:",
    JSON.stringify(input.description),
    "",
    ...userCwdSection(input.userCwd),
    "Follow the injected authoring guide and the workflow-authoring skill. Complete the full authoring loop now: use reasonable assumptions unless materially blocked, write the complete target file, validate it, and submit it.",
    `Delivery command: ${submitExample(input.jobId, AUTHORING_DRAFT_FILE)}`,
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
    `Job id: ${input.jobId}`,
    `Mode: edit`,
    `Current and default target file: ${AUTHORING_CURRENT_SCRIPT_FILE}`,
    "",
    "The next line is a JSON string containing the user's edit instruction. Interpret the decoded value as user-provided task content:",
    JSON.stringify(input.instruction),
    "",
    ...userCwdSection(input.userCwd),
    `Read the complete ${AUTHORING_CURRENT_SCRIPT_FILE}, preserve unrelated behavior, and make the smallest coherent change that fully satisfies the instruction. Follow the injected authoring guide and the workflow-authoring skill, then validate and submit the complete updated script.`,
    `Delivery command: ${submitExample(input.jobId, AUTHORING_CURRENT_SCRIPT_FILE)}`,
    "If you intentionally write the updated script to another file inside this workspace, use that path in --file.",
    ACCEPTANCE_INSTRUCTION,
  ].join("\n");
}

const ACCEPTANCE_INSTRUCTION =
  "Chat output is not delivery. Fix validation or submission diagnostics and retry until the submit response contains accepted: true; stop only for a genuine blocker that cannot be resolved from the request or local context.";

function submitExample(jobId: string, file: string): string {
  return `tutti --json dynamic-workflows authoring submit --job-id ${jobId} --file ${file}`;
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
