import { isDeepStrictEqual } from "node:util";
import { getFlowV1BundleForVersion } from "@/lib/db/workflows/flow-bundles";
import { getCurrentFlowV1Params } from "@/lib/db/workflows/flow-settings";
import type {
  WorkflowVersionDiffLine,
  WorkflowVersionRecord,
  WorkflowVersionReview,
} from "@/lib/db/workflows/types";
import { listWorkflowVersions } from "@/lib/db/workflows/versions";
import { parseFlowV1Bundle } from "./parser";
import { getFlowV1RuntimeConfig } from "./runtime-config";
import type {
  FlowV1Bundle,
  FlowV1Edge,
  FlowV1JsonObject,
  FlowV1Node,
  ParsedFlowV1,
} from "./types";

export function getFlowV1VersionReview(
  flowId: string,
  versionId?: string,
): WorkflowVersionReview | null {
  const versions = listWorkflowVersions(flowId);
  const version = versionId
    ? versions.find((candidate) => candidate.id === versionId)
    : versions.find((candidate) => candidate.status === "draft") ??
      versions.find((candidate) => candidate.status === "published") ??
      versions[0];
  if (!version) {
    return null;
  }
  const bundle = getFlowV1BundleForVersion(version.id);
  if (!bundle) {
    return null;
  }
  const flow = parseFlowV1Bundle(bundle);
  const currentParams = getCurrentFlowV1Params(flowId)?.values ?? {};
  const suggestedParams: FlowV1JsonObject = {};
  for (const entry of Object.values(flow.params)) {
    if (currentParams[entry.name] !== undefined) {
      suggestedParams[entry.name] = currentParams[entry.name]!;
    } else if (entry.config.default !== undefined) {
      suggestedParams[entry.name] = entry.config.default;
    }
  }
  const runtimeConfig = getFlowV1RuntimeConfig(flowId);
  const baseVersion = versions.find(
    (candidate) => candidate.version < version.version,
  );
  return {
    version,
    bundle: {
      hash: bundle.hash,
      files: bundle.files,
    },
    graph: {
      nodes: flow.nodes,
      edges: flow.edges,
    },
    configuration: {
      paramsSchema: flow.params,
      inputsSchema: flow.inputs,
      secretsSchema: flow.secrets,
      suggestedParams,
      projectCwd: runtimeConfig.projectCwd,
      defaultAgent: runtimeConfig.defaultAgent,
      defaultModel: runtimeConfig.defaultModel,
      defaultPermissionMode: runtimeConfig.defaultPermissionMode,
      defaultReasoningEffort: runtimeConfig.defaultReasoningEffort,
    },
    diagnostics: flow.diagnostics,
    comparison: baseVersion
      ? buildVersionComparison(baseVersion, bundle, flow)
      : null,
  };
}

export function getLatestFlowV1DraftReview(
  flowId: string,
): WorkflowVersionReview | null {
  const draft = listWorkflowVersions(flowId).find(
    (candidate) => candidate.status === "draft",
  );
  return draft
    ? getFlowV1VersionReview(flowId, draft.id)
    : null;
}

function buildVersionComparison(
  baseVersion: WorkflowVersionRecord,
  bundle: FlowV1Bundle,
  flow: ParsedFlowV1,
): NonNullable<WorkflowVersionReview["comparison"]> | null {
  const baseBundle = getFlowV1BundleForVersion(baseVersion.id);
  if (!baseBundle) {
    return null;
  }
  const baseFlow = parseFlowV1Bundle(baseBundle);
  const beforeFiles = new Map(
    baseBundle.files.map((file) => [file.path, file]),
  );
  const afterFiles = new Map(bundle.files.map((file) => [file.path, file]));
  const paths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
    .sort((left, right) => left.localeCompare(right));
  return {
    baseVersion,
    files: paths.map((path) => {
      const before = beforeFiles.get(path);
      const after = afterFiles.get(path);
      const status = !before
        ? "added"
        : !after
          ? "removed"
          : before.sha256 === after.sha256
            ? "unchanged"
            : "modified";
      return {
        path,
        status,
        lines:
          status === "unchanged"
            ? []
            : createLineDiff(before?.content ?? "", after?.content ?? ""),
      };
    }),
    graph: {
      ...compareEntities(baseFlow.nodes, flow.nodes),
      ...compareEdges(baseFlow.edges, flow.edges),
    },
  };
}

function compareEntities(
  before: FlowV1Node[],
  after: FlowV1Node[],
): Pick<
  NonNullable<WorkflowVersionReview["comparison"]>["graph"],
  "addedNodeIds" | "removedNodeIds" | "changedNodeIds"
> {
  const compared = compareById(
    before.map(withoutSourceRange),
    after.map(withoutSourceRange),
  );
  return {
    addedNodeIds: compared.addedIds,
    removedNodeIds: compared.removedIds,
    changedNodeIds: compared.changedIds,
  };
}

function withoutSourceRange(
  node: FlowV1Node,
): Omit<FlowV1Node, "sourceRange"> {
  const { sourceRange: _sourceRange, ...semanticNode } = node;
  return semanticNode;
}

function compareEdges(
  before: FlowV1Edge[],
  after: FlowV1Edge[],
): Pick<
  NonNullable<WorkflowVersionReview["comparison"]>["graph"],
  "addedEdgeIds" | "removedEdgeIds" | "changedEdgeIds"
> {
  const compared = compareById(before, after);
  return {
    addedEdgeIds: compared.addedIds,
    removedEdgeIds: compared.removedIds,
    changedEdgeIds: compared.changedIds,
  };
}

function compareById<T extends { id: string }>(
  before: T[],
  after: T[],
): { addedIds: string[]; removedIds: string[]; changedIds: string[] } {
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  return {
    addedIds: after
      .filter((entry) => !beforeById.has(entry.id))
      .map((entry) => entry.id),
    removedIds: before
      .filter((entry) => !afterById.has(entry.id))
      .map((entry) => entry.id),
    changedIds: after
      .filter((entry) => {
        const prior = beforeById.get(entry.id);
        return prior !== undefined && !isDeepStrictEqual(prior, entry);
      })
      .map((entry) => entry.id),
  };
}

function createLineDiff(
  beforeContent: string,
  afterContent: string,
): WorkflowVersionDiffLine[] {
  const before = splitLines(beforeContent);
  const after = splitLines(afterContent);
  if (before.length * after.length > 4_000_000) {
    return [
      ...before.map((content, index) => ({
        kind: "removed" as const,
        content,
        beforeLine: index + 1,
        afterLine: null,
      })),
      ...after.map((content, index) => ({
        kind: "added" as const,
        content,
        beforeLine: null,
        afterLine: index + 1,
      })),
    ];
  }
  const common = longestCommonSubsequence(before, after);
  const result: WorkflowVersionDiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  for (const line of common) {
    while (before[beforeIndex] !== line) {
      result.push({
        kind: "removed",
        content: before[beforeIndex]!,
        beforeLine: beforeIndex + 1,
        afterLine: null,
      });
      beforeIndex += 1;
    }
    while (after[afterIndex] !== line) {
      result.push({
        kind: "added",
        content: after[afterIndex]!,
        beforeLine: null,
        afterLine: afterIndex + 1,
      });
      afterIndex += 1;
    }
    result.push({
      kind: "context",
      content: line,
      beforeLine: beforeIndex + 1,
      afterLine: afterIndex + 1,
    });
    beforeIndex += 1;
    afterIndex += 1;
  }
  while (beforeIndex < before.length) {
    result.push({
      kind: "removed",
      content: before[beforeIndex]!,
      beforeLine: beforeIndex + 1,
      afterLine: null,
    });
    beforeIndex += 1;
  }
  while (afterIndex < after.length) {
    result.push({
      kind: "added",
      content: after[afterIndex]!,
      beforeLine: null,
      afterLine: afterIndex + 1,
    });
    afterIndex += 1;
  }
  return result;
}

function splitLines(content: string): string[] {
  if (!content) {
    return [];
  }
  return content.replace(/\r\n/gu, "\n").split("\n");
}

function longestCommonSubsequence(
  before: string[],
  after: string[],
): string[] {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = Array.from({ length: rows }, () =>
    new Uint32Array(columns),
  );
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      table[left]![right] =
        before[left] === after[right]
          ? table[left + 1]![right + 1]! + 1
          : Math.max(
              table[left + 1]![right]!,
              table[left]![right + 1]!,
            );
    }
  }
  const result: string[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      result.push(before[left]!);
      left += 1;
      right += 1;
    } else if (table[left + 1]![right]! >= table[left]![right + 1]!) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return result;
}
