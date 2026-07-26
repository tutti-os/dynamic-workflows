import {
  createFlowV1Bundle,
  FlowV1BundleError,
} from "@/lib/flow-v1/bundle";
import {
  FLOW_V1_SCHEMA_VERSION,
  type FlowV1Bundle,
} from "@/lib/flow-v1/types";
import { getDb } from "../client";

type BundleRow = {
  version_id: string;
  schema_version: string;
  bundle_hash: string;
  created_at: string;
};

type BundleFileRow = {
  path: string;
  content: string;
  sha256: string;
  size_bytes: number;
  media_kind: string;
  file_role: string;
};

export class FlowV1BundlePersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowV1BundlePersistenceError";
    this.code = code;
  }
}

export function saveFlowV1BundleForVersion(input: {
  versionId: string;
  bundle: FlowV1Bundle;
}): FlowV1Bundle {
  const database = getDb();
  const version = database
    .prepare("SELECT id FROM workflow_versions WHERE id = ?")
    .get(input.versionId) as { id: string } | undefined;
  if (!version) {
    throw new FlowV1BundlePersistenceError(
      "workflow_version_not_found",
      `Workflow version ${input.versionId} was not found.`,
    );
  }

  const verified = verifyBundleObject(input.bundle);
  const existing = readBundleRow(input.versionId);
  if (existing) {
    if (
      existing.schema_version === verified.schemaVersion &&
      existing.bundle_hash === verified.hash
    ) {
      return requireStoredBundle(input.versionId);
    }
    throw new FlowV1BundlePersistenceError(
      "flow_bundle_immutable",
      `Workflow version ${input.versionId} already has a different immutable Flow Bundle.`,
    );
  }

  const now = new Date().toISOString();
  database
    .transaction(() => {
      database
        .prepare(
          `
          INSERT INTO workflow_version_bundles (
            version_id, schema_version, bundle_hash, created_at
          ) VALUES (?, ?, ?, ?)
        `,
        )
        .run(
          input.versionId,
          verified.schemaVersion,
          verified.hash,
          now,
        );

      const insertFile = database.prepare(`
        INSERT INTO workflow_version_files (
          version_id, path, content, sha256, size_bytes, media_kind,
          file_role, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const file of verified.files) {
        insertFile.run(
          input.versionId,
          file.path,
          file.content,
          file.sha256,
          file.sizeBytes,
          file.mediaKind,
          file.role,
          now,
        );
      }
    })();
  return verified;
}

export function getFlowV1BundleForVersion(
  versionId: string,
): FlowV1Bundle | null {
  const metadata = readBundleRow(versionId);
  if (!metadata) {
    return null;
  }
  return requireStoredBundle(versionId, metadata);
}

function requireStoredBundle(
  versionId: string,
  metadata = readBundleRow(versionId),
): FlowV1Bundle {
  if (!metadata) {
    throw new FlowV1BundlePersistenceError(
      "flow_bundle_not_found",
      `Workflow version ${versionId} has no Flow Bundle.`,
    );
  }
  if (metadata.schema_version !== FLOW_V1_SCHEMA_VERSION) {
    throw corruptBundle(
      versionId,
      `unsupported schema version ${metadata.schema_version}`,
    );
  }

  const rows = getDb()
    .prepare(
      `
      SELECT path, content, sha256, size_bytes, media_kind, file_role
      FROM workflow_version_files
      WHERE version_id = ?
      ORDER BY path ASC
    `,
    )
    .all(versionId) as BundleFileRow[];
  let rebuilt: FlowV1Bundle;
  try {
    rebuilt = createFlowV1Bundle(
      rows.map((row) => ({ path: row.path, content: row.content })),
    );
  } catch (error) {
    if (error instanceof FlowV1BundleError) {
      throw corruptBundle(versionId, error.message);
    }
    throw error;
  }
  for (const [index, row] of rows.entries()) {
    const file = rebuilt.files[index];
    if (
      !file ||
      file.path !== row.path ||
      file.sha256 !== row.sha256 ||
      file.sizeBytes !== row.size_bytes ||
      file.mediaKind !== row.media_kind ||
      file.role !== row.file_role
    ) {
      throw corruptBundle(versionId, `file checksum mismatch at ${row.path}`);
    }
  }
  if (rebuilt.hash !== metadata.bundle_hash) {
    throw corruptBundle(versionId, "Bundle hash mismatch");
  }
  return rebuilt;
}

function verifyBundleObject(bundle: FlowV1Bundle): FlowV1Bundle {
  if (bundle.schemaVersion !== FLOW_V1_SCHEMA_VERSION) {
    throw new FlowV1BundlePersistenceError(
      "flow_bundle_schema_unsupported",
      `Unsupported Flow Bundle schema version: ${bundle.schemaVersion}.`,
    );
  }
  let verified: FlowV1Bundle;
  try {
    verified = createFlowV1Bundle(
      bundle.files.map((file) => ({
        path: file.path,
        content: file.content,
      })),
    );
  } catch (error) {
    if (error instanceof FlowV1BundleError) {
      throw new FlowV1BundlePersistenceError(
        "flow_bundle_invalid",
        error.message,
      );
    }
    throw error;
  }
  if (verified.hash !== bundle.hash) {
    throw new FlowV1BundlePersistenceError(
      "flow_bundle_hash_mismatch",
      "Flow Bundle hash does not match its file contents.",
    );
  }
  return verified;
}

function readBundleRow(versionId: string): BundleRow | undefined {
  return getDb()
    .prepare(
      `
      SELECT version_id, schema_version, bundle_hash, created_at
      FROM workflow_version_bundles
      WHERE version_id = ?
    `,
    )
    .get(versionId) as BundleRow | undefined;
}

function corruptBundle(
  versionId: string,
  detail: string,
): FlowV1BundlePersistenceError {
  return new FlowV1BundlePersistenceError(
    "flow_bundle_corrupt",
    `Stored Flow Bundle for workflow version ${versionId} is corrupt: ${detail}.`,
  );
}
