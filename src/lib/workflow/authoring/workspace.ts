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
  patterns: new URL("./materials/skill/patterns.md", import.meta.url),
  blueprintGuide: new URL(
    "./materials/skill/blueprint-guide.md",
    import.meta.url,
  ),
} as const;

export const AUTHORING_DRAFT_BUNDLE_DIR = "draft.flow";

export type AuthoringWorkspace = {
  dir: string;
};

export function getAuthoringWorkspaceDir(jobId: string): string {
  return path.join(getDataDir(), "authoring", jobId);
}

export function prepareSemanticReviewWorkspace(input: {
  jobId: string;
  reviewId: string;
}): string {
  const dir = path.join(
    getDataDir(),
    "authoring-reviews",
    input.jobId,
    input.reviewId,
  );
  fs.mkdirSync(dir, { recursive: true });
  const instructions = [
    "# Workflow Design Reviewer",
    "",
    "Review only the workflow supplied in the task prompt.",
    "Do not edit files, execute the workflow, submit it, or start another agent.",
    "Return exactly the requested review result.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), instructions);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), instructions);
  return dir;
}

export function prepareAuthoringWorkspace(input: {
  jobId: string;
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
      name: "patterns.md",
      content: readMaterial(MATERIAL_URLS.patterns),
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

  return { dir };
}

export function resolveAuthoringBundleDirectory(input: {
  jobId: string;
  directory?: string;
}): string {
  const dir = getAuthoringWorkspaceDir(input.jobId);
  const directory = input.directory ?? AUTHORING_DRAFT_BUNDLE_DIR;
  const requested = path.resolve(dir, directory);

  let realDir: string;
  let realRequested: string;
  try {
    realDir = fs.realpathSync(dir);
    if (fs.lstatSync(requested).isSymbolicLink()) {
      throw new AuthoringWorkspaceError(
        `Flow Bundle directory must not be a symlink: ${directory}`,
      );
    }
    realRequested = fs.realpathSync(requested);
  } catch (error) {
    if (error instanceof AuthoringWorkspaceError) {
      throw error;
    }
    throw new AuthoringWorkspaceError(
      `Flow Bundle directory not found in authoring workspace: ${directory}`,
    );
  }

  const relative = path.relative(realDir, realRequested);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AuthoringWorkspaceError(
      `Flow Bundle directory must stay inside the authoring workspace: ${directory}`,
    );
  }
  if (!fs.statSync(realRequested).isDirectory()) {
    throw new AuthoringWorkspaceError(
      `Flow Bundle path is not a directory: ${directory}`,
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
