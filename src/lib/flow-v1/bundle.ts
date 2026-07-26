import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";
import {
  FLOW_V1_SCHEMA_VERSION,
  type FlowV1Bundle,
  type FlowV1BundleFile,
  type FlowV1BundleFileRole,
  type FlowV1BundleMediaKind,
  type FlowV1BundleSourceFile,
} from "./types";

export const FLOW_V1_ENTRY_FILE = "flow.js";
export const FLOW_V1_MEMORY_TEMPLATE_FILE = "memory.template.md";
export const FLOW_V1_MAX_FILE_BYTES = 1024 * 1024;
export const FLOW_V1_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const FLOW_V1_MAX_FILES = 256;

const ALLOWED_ROOT_FILES = new Set([
  FLOW_V1_ENTRY_FILE,
  FLOW_V1_MEMORY_TEMPLATE_FILE,
  "README.md",
]);
const ALLOWED_SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".sh",
  ".md",
  ".json",
]);

export class FlowV1BundleError extends Error {
  readonly diagnostics: WorkflowDiagnostic[];

  constructor(diagnostics: WorkflowDiagnostic[]) {
    super(
      diagnostics[0]?.message ??
        "The Flow Bundle does not satisfy the tutti.flow.v1 contract.",
    );
    this.name = "FlowV1BundleError";
    this.diagnostics = diagnostics;
  }
}

export function createFlowV1Bundle(
  sourceFiles: FlowV1BundleSourceFile[],
): FlowV1Bundle {
  const diagnostics = validateFlowV1BundleFiles(sourceFiles);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new FlowV1BundleError(diagnostics);
  }

  const files = sourceFiles
    .map(toBundleFile)
    .sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\n");
  }
  return {
    schemaVersion: FLOW_V1_SCHEMA_VERSION,
    hash: hash.digest("hex"),
    files,
  };
}

export function validateFlowV1BundleFiles(
  sourceFiles: FlowV1BundleSourceFile[],
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  if (sourceFiles.length > FLOW_V1_MAX_FILES) {
    diagnostics.push({
      severity: "error",
      code: "bundle.too_many_files",
      path: "bundle",
      message: `Flow Bundle has ${sourceFiles.length} files; the limit is ${FLOW_V1_MAX_FILES}.`,
    });
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  for (const [index, file] of sourceFiles.entries()) {
    const diagnosticPath = `files[${index}]`;
    const normalized = normalizeBundlePath(file.path);
    if (!normalized.ok) {
      diagnostics.push({
        severity: "error",
        code: normalized.code,
        path: `${diagnosticPath}.path`,
        message: normalized.message,
      });
      continue;
    }
    if (paths.has(normalized.path)) {
      diagnostics.push({
        severity: "error",
        code: "bundle.path_duplicate",
        path: `${diagnosticPath}.path`,
        message: `Duplicate Flow Bundle path: ${normalized.path}.`,
      });
    }
    paths.add(normalized.path);

    if (!isAllowedBundlePath(normalized.path)) {
      diagnostics.push({
        severity: "error",
        code: "bundle.path_unsupported",
        path: `${diagnosticPath}.path`,
        message: `Unsupported Flow Bundle file: ${normalized.path}.`,
      });
    }

    if (typeof file.content !== "string") {
      diagnostics.push({
        severity: "error",
        code: "bundle.content_invalid",
        path: `${diagnosticPath}.content`,
        message: `Flow Bundle file ${normalized.path} must contain UTF-8 text.`,
      });
      continue;
    }
    if (file.content.includes("\0")) {
      diagnostics.push({
        severity: "error",
        code: "bundle.content_nul_forbidden",
        path: `${diagnosticPath}.content`,
        message: `Flow Bundle file ${normalized.path} contains a NUL character.`,
      });
    }
    const sizeBytes = Buffer.byteLength(file.content, "utf8");
    totalBytes += sizeBytes;
    if (sizeBytes > FLOW_V1_MAX_FILE_BYTES) {
      diagnostics.push({
        severity: "error",
        code: "bundle.file_too_large",
        path: `${diagnosticPath}.content`,
        message: `Flow Bundle file ${normalized.path} exceeds ${FLOW_V1_MAX_FILE_BYTES} bytes.`,
      });
    }
  }

  if (!paths.has(FLOW_V1_ENTRY_FILE)) {
    diagnostics.push({
      severity: "error",
      code: "bundle.entry_missing",
      path: "bundle",
      message: `Flow Bundle must contain ${FLOW_V1_ENTRY_FILE}.`,
    });
  }
  if (totalBytes > FLOW_V1_MAX_BUNDLE_BYTES) {
    diagnostics.push({
      severity: "error",
      code: "bundle.too_large",
      path: "bundle",
      message: `Flow Bundle exceeds ${FLOW_V1_MAX_BUNDLE_BYTES} bytes.`,
    });
  }
  return diagnostics;
}

export function getFlowV1BundleFile(
  bundle: FlowV1Bundle,
  filePath: string,
): FlowV1BundleFile | undefined {
  return bundle.files.find((file) => file.path === filePath);
}

export function readFlowV1BundleDirectory(directory: string): FlowV1Bundle {
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw symlinkBundleError(".");
  }
  const root = fs.realpathSync(directory);
  const files: FlowV1BundleSourceFile[] = [];
  walkBundleDirectory(root, root, files);
  return createFlowV1Bundle(files);
}

export function materializeFlowV1Bundle(
  bundle: FlowV1Bundle,
  destination: string,
): void {
  const expected = createFlowV1Bundle(
    bundle.files.map(({ path: filePath, content }) => ({
      path: filePath,
      content,
    })),
  );
  if (expected.hash !== bundle.hash) {
    throw new FlowV1BundleError([
      {
        severity: "error",
        code: "bundle.hash_mismatch",
        path: "bundle.hash",
        message: "Flow Bundle hash does not match its file contents.",
      },
    ]);
  }

  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
    throw symlinkBundleError(".");
  }
  fs.mkdirSync(destination, { recursive: true });
  const realDestination = fs.realpathSync(destination);
  const targets: Array<{ file: FlowV1BundleFile; target: string }> = [];
  for (const file of bundle.files) {
    const segments = file.path.split("/");
    let parent = realDestination;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent);
        continue;
      }
      const stat = fs.lstatSync(parent);
      if (stat.isSymbolicLink()) {
        throw symlinkBundleError(
          path.relative(realDestination, parent).split(path.sep).join("/"),
        );
      }
      if (!stat.isDirectory()) {
        throw new FlowV1BundleError([
          {
            severity: "error",
            code: "bundle.materialize_parent_invalid",
            path: file.path,
            message: `Flow Bundle parent path is not a directory: ${parent}.`,
          },
        ]);
      }
    }
    const target = path.join(parent, segments.at(-1)!);
    const relative = path.relative(realDestination, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new FlowV1BundleError([
        {
          severity: "error",
          code: "bundle.materialize_escape",
          path: file.path,
          message: `Flow Bundle file escapes materialization root: ${file.path}.`,
          },
        ]);
    }
    if (fs.existsSync(target)) {
      throw new FlowV1BundleError([
        {
          severity: "error",
          code: "bundle.materialize_target_exists",
          path: file.path,
          message: `Flow Bundle target already exists: ${file.path}.`,
        },
      ]);
    }
    targets.push({ file, target });
  }
  for (const { file, target } of targets) {
    fs.writeFileSync(target, file.content, { encoding: "utf8", flag: "wx" });
  }
}

function normalizeBundlePath(
  value: string,
):
  | { ok: true; path: string }
  | { ok: false; code: string; message: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return {
      ok: false,
      code: "bundle.path_invalid",
      message: "Flow Bundle path must be a non-empty string.",
    };
  }
  if (value.includes("\\") || value.includes("\0")) {
    return {
      ok: false,
      code: "bundle.path_invalid",
      message: `Flow Bundle path must use safe POSIX separators: ${value}.`,
    };
  }
  if (path.posix.isAbsolute(value)) {
    return {
      ok: false,
      code: "bundle.path_absolute",
      message: `Flow Bundle path must be relative: ${value}.`,
    };
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return {
      ok: false,
      code: "bundle.path_escape",
      message: `Flow Bundle path must be normalized and stay inside the Bundle: ${value}.`,
    };
  }
  return { ok: true, path: normalized };
}

function isAllowedBundlePath(filePath: string): boolean {
  if (ALLOWED_ROOT_FILES.has(filePath)) {
    return true;
  }
  if (!filePath.startsWith("scripts/")) {
    return false;
  }
  if (
    filePath.split("/").some((segment) => segment === "node_modules") ||
    filePath.endsWith("/package.json") ||
    filePath === "scripts/package.json"
  ) {
    return false;
  }
  return ALLOWED_SCRIPT_EXTENSIONS.has(path.posix.extname(filePath));
}

function toBundleFile(file: FlowV1BundleSourceFile): FlowV1BundleFile {
  const normalized = normalizeBundlePath(file.path);
  if (!normalized.ok) {
    throw new Error(normalized.message);
  }
  return {
    path: normalized.path,
    content: file.content,
    sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
    sizeBytes: Buffer.byteLength(file.content, "utf8"),
    mediaKind: classifyMediaKind(normalized.path),
    role: classifyFileRole(normalized.path),
  };
}

function classifyMediaKind(filePath: string): FlowV1BundleMediaKind {
  switch (path.posix.extname(filePath)) {
    case ".js":
    case ".mjs":
      return "javascript";
    case ".sh":
      return "shell";
    case ".json":
      return "json";
    default:
      return "markdown";
  }
}

function classifyFileRole(filePath: string): FlowV1BundleFileRole {
  if (filePath === FLOW_V1_ENTRY_FILE) {
    return "entry";
  }
  if (filePath === FLOW_V1_MEMORY_TEMPLATE_FILE) {
    return "memory_template";
  }
  if (filePath === "README.md") {
    return "documentation";
  }
  return /\.(?:js|mjs|sh)$/u.test(filePath) ? "code" : "resource";
}

function walkBundleDirectory(
  root: string,
  current: string,
  files: FlowV1BundleSourceFile[],
): void {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw symlinkBundleError(path.relative(root, absolute));
    }
    if (entry.isDirectory()) {
      walkBundleDirectory(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new FlowV1BundleError([
        {
          severity: "error",
          code: "bundle.file_type_forbidden",
          path: path.relative(root, absolute),
          message: "Flow Bundle may contain only regular files.",
        },
      ]);
    }
    files.push({
      path: path.relative(root, absolute).split(path.sep).join("/"),
      content: fs.readFileSync(absolute, "utf8"),
    });
  }
}

function symlinkBundleError(filePath: string): FlowV1BundleError {
  return new FlowV1BundleError([
    {
      severity: "error",
      code: "bundle.symlink_forbidden",
      path: filePath,
      message: "Flow Bundle directories and files must not be symlinks.",
    },
  ]);
}
