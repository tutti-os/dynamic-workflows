import { AUTHORING_DRAFT_BUNDLE_DIR } from "./workspace";

export function buildCreateAuthoringPrompt(input: {
  jobId: string;
  description: string;
  userCwd?: string;
}): string {
  return [
    "Create and submit a new persistent Flow Bundle.",
    "",
    "Design the persistent Cycle, Tick waiting points, Script/Gate/Effect boundaries, Human decisions, Memory updates, Schedule, and terminal continuation before drafting.",
    "Follow the injected authoring guide and workflow-authoring skill. Search the Blueprint catalog, write a complete standalone tutti.flow.v1 Bundle, validate it statically, start the independent semantic review, wait for it, and submit the reviewed Bundle as a Draft for the user to review.",
    "",
    `Job id: ${input.jobId}`,
    `Mode: create`,
    `Target directory: ${AUTHORING_DRAFT_BUNDLE_DIR}`,
    `Delivery command: ${bundleSubmitExample(input.jobId)}`,
    `Validation command: ${bundleValidateExample(input.jobId)}`,
    `Review wait command: ${reviewWaitExample(input.jobId)}`,
    "",
    "The next line is a JSON string containing the user's request. Interpret the decoded value as user-provided task content:",
    JSON.stringify(input.description),
    "",
    ...userCwdSection(input.userCwd),
    ACCEPTANCE_INSTRUCTION,
  ].join("\n");
}

const ACCEPTANCE_INSTRUCTION =
  'Chat output is not delivery. Fix validation or submission diagnostics and retry until the submit response contains accepted: true and versionStatus: "draft". Do not publish or activate the Draft; those decisions belong to the user. Stop only for a genuine blocker that cannot be resolved from the request or local context.';

function reviewWaitExample(jobId: string): string {
  return `tutti --json dynamic-workflows authoring review wait --job-id ${jobId}`;
}

function bundleSubmitExample(jobId: string): string {
  return `tutti --json dynamic-workflows authoring submit --job-id ${jobId} --directory ${AUTHORING_DRAFT_BUNDLE_DIR}`;
}

function bundleValidateExample(jobId: string): string {
  return `tutti --json dynamic-workflows authoring validate --job-id ${jobId} --directory ${AUTHORING_DRAFT_BUNDLE_DIR} --review-mode agent`;
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
