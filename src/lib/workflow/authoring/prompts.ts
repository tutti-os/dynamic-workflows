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
    `You are handling workflow authoring job ${input.jobId}: create a new Dynamic Workflows script.`,
    "",
    "User request:",
    input.description,
    "",
    ...userCwdSection(input.userCwd),
    "Follow the authoring guide in AGENTS.md / CLAUDE.md and the workflow-authoring skill in skills/workflow-authoring/.",
    "Suggested flow: clarify the request with the user if needed, search blueprints for a similar pattern, draft the script to " +
      `${AUTHORING_DRAFT_FILE}, validate it, then submit:`,
    "",
    submitExample(input.jobId, AUTHORING_DRAFT_FILE),
    "",
    "Iterate on diagnostics until submit returns accepted: true. Each accepted submit saves a workflow version, so keep this conversation going: when the user asks for changes, revise and submit again.",
  ].join("\n");
}

export function buildEditAuthoringPrompt(input: {
  jobId: string;
  instruction: string;
  userCwd?: string;
}): string {
  return [
    `You are handling workflow authoring job ${input.jobId}: edit an existing Dynamic Workflows script.`,
    "",
    "Edit instruction:",
    input.instruction,
    "",
    `The current workflow script is at ${AUTHORING_CURRENT_SCRIPT_FILE} in this workspace. Edit it in place (or write the updated script to a new file). Preserve unrelated behavior and structure.`,
    "",
    ...userCwdSection(input.userCwd),
    "Follow the authoring guide in AGENTS.md / CLAUDE.md and the workflow-authoring skill in skills/workflow-authoring/.",
    "Clarify with the user if the instruction is ambiguous, validate your changes, then submit the complete updated script:",
    "",
    submitExample(input.jobId, AUTHORING_CURRENT_SCRIPT_FILE),
    "",
    "Iterate on diagnostics until submit returns accepted: true. Each accepted submit saves a new draft version, so keep this conversation going: when the user asks for further changes, revise and submit again.",
  ].join("\n");
}

function submitExample(jobId: string, file: string): string {
  return `tutti --json dynamic-workflows authoring submit --job-id ${jobId} --file ${file}`;
}

function userCwdSection(userCwd: string | undefined): string[] {
  if (!userCwd?.trim()) {
    return [];
  }
  return [
    `Related project directory (context for authoring, not your working directory): ${userCwd.trim()}`,
    "",
  ];
}
