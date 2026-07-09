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
    "User request (the tags delimit the user's own words):",
    "<user_request>",
    input.description,
    "</user_request>",
    "",
    ...userCwdSection(input.userCwd),
    "Follow the authoring guide in AGENTS.md / CLAUDE.md and the workflow-authoring skill in skills/workflow-authoring/ — they define the working loop (clarify, search blueprints, draft, validate) and the DSL contract.",
    "",
    `Draft the script to ${AUTHORING_DRAFT_FILE} and submit it:`,
    "",
    submitExample(input.jobId, AUTHORING_DRAFT_FILE),
    "",
    ITERATE_INSTRUCTION,
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
    "Edit instruction (the tags delimit the user's own words):",
    "<edit_instruction>",
    input.instruction,
    "</edit_instruction>",
    "",
    `The current workflow script is at ${AUTHORING_CURRENT_SCRIPT_FILE} in this workspace. Edit it in place, or write the updated script to a new file. Preserve unrelated behavior and structure.`,
    "",
    ...userCwdSection(input.userCwd),
    "Follow the authoring guide in AGENTS.md / CLAUDE.md and the workflow-authoring skill in skills/workflow-authoring/ — they define the working loop (clarify, search blueprints, draft, validate) and the DSL contract.",
    "",
    "Validate your changes, then submit the complete updated script:",
    "",
    submitExample(input.jobId, AUTHORING_CURRENT_SCRIPT_FILE),
    "",
    "If you wrote the updated script to a different file, pass that file to --file instead.",
    "",
    ITERATE_INSTRUCTION,
  ].join("\n");
}

const ITERATE_INSTRUCTION =
  "Iterate on diagnostics until submit returns accepted: true. Each accepted submit saves a new workflow version, so keep this conversation going: when the user asks for changes, revise and submit again with the same job id.";

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
