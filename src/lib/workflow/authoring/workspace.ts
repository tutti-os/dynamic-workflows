import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "@/lib/db/client";

const SKILL_NAME = "workflow-authoring";

// Static URL literals only: bundlers resolve `new URL(..., import.meta.url)`
// assets by static analysis, so dynamic segments break asset resolution.
const MATERIAL_URLS = {
  guide: new URL("./materials/authoring-guide.md", import.meta.url),
  skill: new URL("./materials/skill/SKILL.md", import.meta.url),
  dslReference: new URL("./materials/skill/dsl-reference.md", import.meta.url),
  blueprintGuide: new URL(
    "./materials/skill/blueprint-guide.md",
    import.meta.url,
  ),
} as const;

export const AUTHORING_DRAFT_FILE = "draft.workflow.js";
export const AUTHORING_CURRENT_SCRIPT_FILE = "current.workflow.js";

export type AuthoringWorkspace = {
  dir: string;
  currentScriptPath?: string;
};

export function getAuthoringWorkspaceDir(jobId: string): string {
  return path.join(getDataDir(), "authoring", jobId);
}

export function prepareAuthoringWorkspace(input: {
  jobId: string;
  currentScript?: string;
}): AuthoringWorkspace {
  const dir = getAuthoringWorkspaceDir(input.jobId);
  fs.mkdirSync(dir, { recursive: true });

  const guide = readMaterial(MATERIAL_URLS.guide);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), guide);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), guide);

  const skillFiles = [
    { name: "SKILL.md", content: readMaterial(MATERIAL_URLS.skill) },
    {
      name: "dsl-reference.md",
      content: readMaterial(MATERIAL_URLS.dslReference),
    },
    {
      name: "blueprint-guide.md",
      content: readMaterial(MATERIAL_URLS.blueprintGuide),
    },
  ];
  for (const root of [
    path.join(dir, "skills"),
    path.join(dir, ".claude", "skills"),
    path.join(dir, ".codex", "skills"),
  ]) {
    const skillDir = path.join(root, SKILL_NAME);
    fs.mkdirSync(skillDir, { recursive: true });
    for (const file of skillFiles) {
      fs.writeFileSync(path.join(skillDir, file.name), file.content);
    }
  }

  let currentScriptPath: string | undefined;
  if (input.currentScript !== undefined) {
    currentScriptPath = path.join(dir, AUTHORING_CURRENT_SCRIPT_FILE);
    fs.writeFileSync(currentScriptPath, input.currentScript);
  }

  return { dir, currentScriptPath };
}

export function resolveAuthoringScriptFile(input: {
  jobId: string;
  file: string;
}): string {
  const dir = getAuthoringWorkspaceDir(input.jobId);
  const requested = path.resolve(dir, input.file);

  let realDir: string;
  let realRequested: string;
  try {
    realDir = fs.realpathSync(dir);
    realRequested = fs.realpathSync(requested);
  } catch {
    throw new AuthoringWorkspaceError(
      `Script file not found in authoring workspace: ${input.file}`,
    );
  }

  const relative = path.relative(realDir, realRequested);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AuthoringWorkspaceError(
      `Script file must stay inside the authoring workspace: ${input.file}`,
    );
  }
  if (!fs.statSync(realRequested).isFile()) {
    throw new AuthoringWorkspaceError(
      `Script path is not a file: ${input.file}`,
    );
  }
  return realRequested;
}

export class AuthoringWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthoringWorkspaceError";
  }
}

function readMaterial(fileUrl: URL): string {
  return fs.readFileSync(fileUrl, "utf8");
}
