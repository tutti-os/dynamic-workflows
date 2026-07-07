#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CATEGORIES = ["coding", "review", "planning", "research", "ops"];
const DIFFICULTIES = ["starter", "advanced"];
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BLUEPRINT_DIR = "src/lib/workflow/blueprints";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const id = args._[0];
const title = args.title;
const category = args.category ?? "coding";
const difficulty = args.difficulty ?? "starter";
const requiresCwd = Boolean(args["requires-cwd"]);

if (!id || !title) {
  printUsage();
  process.exit(1);
}
if (!ID_PATTERN.test(id)) {
  fail(`Invalid blueprint id "${id}". Use lowercase kebab-case.`);
}
if (!CATEGORIES.includes(category)) {
  fail(`Invalid category "${category}". Use one of: ${CATEGORIES.join(", ")}.`);
}
if (!DIFFICULTIES.includes(difficulty)) {
  fail(
    `Invalid difficulty "${difficulty}". Use one of: ${DIFFICULTIES.join(", ")}.`,
  );
}

const scriptRelativePath = path.join(BLUEPRINT_DIR, `${id}.workflow.js`);
const scriptPath = path.join(process.cwd(), scriptRelativePath);

if (await exists(scriptPath)) {
  fail(`Blueprint script already exists: ${scriptRelativePath}`);
}

await mkdir(path.dirname(scriptPath), { recursive: true });
await writeFile(scriptPath, blueprintScript({ title, requiresCwd }));

console.log(`Created ${scriptRelativePath}`);
console.log("");
console.log("Add this metadata entry to BUILTIN_WORKFLOW_BLUEPRINTS:");
console.log("");
console.log(metadataSnippet({ id, title, category, difficulty, requiresCwd }));
console.log("");
console.log("Then run:");
console.log("  npm run check:blueprints");

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

async function exists(filePath) {
  return access(filePath)
    .then(() => true)
    .catch(() => false);
}

function blueprintScript({ title, requiresCwd }) {
  const cwdLine = requiresCwd ? '    cwd: ".",\n' : "";
  return `export const meta = {
  name: ${JSON.stringify(title)},
  description: "TODO: Describe what this blueprint helps the user accomplish.",
  requiresCwd: ${requiresCwd ? "true" : "false"},
};

export const inputs = {
  task: {
    type: "string",
    required: true,
    label: "Task",
    widget: "textarea",
  },
};

phase("Run", () => {
  agent({
    id: "main",
    label: "Main Agent",
${cwdLine}    prompt: \`
Task:
{{task}}
\`,
  });
});
`;
}

function metadataSnippet({ id, title, category, difficulty, requiresCwd }) {
  return `{
  id: ${JSON.stringify(id)},
  title: ${JSON.stringify(title)},
  description: "TODO: Keep this specific and between 20 and 240 characters.",
  category: ${JSON.stringify(category)},
  tags: ["todo", "blueprint"],
  difficulty: ${JSON.stringify(difficulty)},
  requiresCwd: ${requiresCwd ? "true" : "false"},
  patternSummary:
    "TODO: Explain the reusable workflow pattern and why it is useful.",
  useCases: [
    "TODO: Describe a concrete user job this blueprint accelerates.",
  ],
  script: readBuiltinBlueprintScript(
    new URL("./blueprints/${id}.workflow.js", import.meta.url),
  ),
},`;
}

function printUsage() {
  console.log(`Usage:
  npm run blueprint:new -- <id> --title "Blueprint Title" [options]

Options:
  --category <value>      ${CATEGORIES.join(" | ")} (default: coding)
  --difficulty <value>    ${DIFFICULTIES.join(" | ")} (default: starter)
  --requires-cwd          Mark the workflow as requiring a project cwd
  --help                  Show this help
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
