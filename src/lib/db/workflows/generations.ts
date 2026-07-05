import { randomUUID } from "node:crypto";
import { workflowNotFoundError } from "@/lib/api/app-error";
import { assertWorkflowScriptValid } from "@/lib/workflow/parser";
import { getDb } from "../client";
import { getWorkflowDetail } from "./workflow-repository";
import {
  stringifyJsonValueColumn,
  stringifyWorkflowGenerationErrorColumn,
  stringifyWorkflowMetaColumn,
} from "./json-schemas";
import { mapGeneration, type GenerationRow } from "./mappers";
import type {
  WorkflowDetail,
  WorkflowGenerationError,
  WorkflowGenerationRecord,
} from "./types";

export function createPendingWorkflowGeneration(input: {
  prompt: string;
  agent?: string;
  model?: string;
  cwd?: string;
}): WorkflowDetail {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const now = new Date().toISOString();
  const workflowId = randomUUID();
  const generationId = randomUUID();
  const database = getDb();

  database
    .transaction(() => {
      database
        .prepare(
          `
          INSERT INTO workflows (
            id, name, description, current_version_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          workflowId,
          derivePendingWorkflowName(prompt),
          derivePendingWorkflowDescription(prompt),
          null,
          now,
          now,
        );

      database
        .prepare(
          `
          INSERT INTO workflow_generations (
            id, workflow_id, prompt, agent, model, cwd, status,
            generation_json, error_json, created_at, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          generationId,
          workflowId,
          prompt,
          input.agent ?? null,
          input.model ?? null,
          input.cwd ?? null,
          "pending",
          null,
          null,
          now,
          null,
          null,
        );
    })();

  const detail = getWorkflowDetail(workflowId);
  if (!detail) {
    throw new Error("Failed to create workflow");
  }
  return detail;
}

export function getWorkflowGeneration(
  generationId: string,
): WorkflowGenerationRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM workflow_generations WHERE id = ?")
    .get(generationId) as GenerationRow | undefined;
  return row ? mapGeneration(row) : null;
}

export function getLatestWorkflowGeneration(
  workflowId: string,
): WorkflowGenerationRecord | null {
  const row = getDb()
    .prepare(
      `
      SELECT * FROM workflow_generations
      WHERE workflow_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `,
    )
    .get(workflowId) as GenerationRow | undefined;
  return row ? mapGeneration(row) : null;
}

export function markWorkflowGenerationRunning(
  generationId: string,
): WorkflowGenerationRecord | null {
  const now = new Date().toISOString();
  const database = getDb();
  return database.transaction(() => {
    const generation = getWorkflowGeneration(generationId);
    if (!generation || generation.status === "completed") {
      return null;
    }

    database
      .prepare(
        `
        UPDATE workflow_generations
        SET status = 'running',
          started_at = COALESCE(started_at, ?),
          finished_at = NULL,
          error_json = NULL
        WHERE id = ?
          AND status != 'completed'
      `,
      )
      .run(now, generationId);

    return getWorkflowGeneration(generationId);
  })();
}

export function resetWorkflowGenerationForRetry(
  workflowId: string,
): WorkflowGenerationRecord | null {
  const database = getDb();
  return database.transaction(() => {
    const generation = getLatestWorkflowGeneration(workflowId);
    if (!generation || generation.status === "completed") {
      return generation;
    }

    database
      .prepare(
        `
        UPDATE workflow_generations
        SET status = 'pending',
          generation_json = NULL,
          error_json = NULL,
          started_at = NULL,
          finished_at = NULL
        WHERE id = ?
      `,
      )
      .run(generation.id);

    return getWorkflowGeneration(generation.id);
  })();
}

export function completeWorkflowGeneration(input: {
  generationId: string;
  script: string;
  generation: unknown;
}): WorkflowDetail {
  const generation = getWorkflowGeneration(input.generationId);
  if (!generation) {
    throw new Error("Workflow generation not found");
  }

  const parsed = assertWorkflowScriptValid(input.script);
  const database = getDb();
  const now = new Date().toISOString();
  const versionId = randomUUID();
  const version = database
    .prepare(
      `
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM workflow_versions
      WHERE workflow_id = ?
    `,
    )
    .get(generation.workflowId) as { next_version: number };

  database
    .transaction(() => {
      database
        .prepare(
          `
          INSERT INTO workflow_versions (
            id, workflow_id, version, script, meta_json, source,
            base_version_id, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          versionId,
          generation.workflowId,
          version.next_version,
          input.script,
          stringifyWorkflowMetaColumn(parsed.meta, {
            table: "workflow_versions",
            column: "meta_json",
            id: versionId,
          }),
          "generation",
          null,
          null,
          now,
        );

      database
        .prepare(
          `
          UPDATE workflows
          SET name = ?, description = ?, current_version_id = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(
          parsed.meta.name,
          parsed.meta.description,
          versionId,
          now,
          generation.workflowId,
        );

      database
        .prepare(
          `
          UPDATE workflow_generations
          SET status = 'completed',
            generation_json = ?,
            error_json = NULL,
            finished_at = ?
          WHERE id = ?
        `,
        )
        .run(
          stringifyJsonValueColumn(input.generation, {
            table: "workflow_generations",
            column: "generation_json",
            id: input.generationId,
          }),
          now,
          input.generationId,
        );
    })();

  const detail = getWorkflowDetail(generation.workflowId);
  if (!detail) {
    throw workflowNotFoundError();
  }
  return detail;
}

export function failWorkflowGeneration(input: {
  generationId: string;
  error: WorkflowGenerationError;
}): WorkflowGenerationRecord | null {
  const now = new Date().toISOString();
  const database = getDb();
  return database.transaction(() => {
    database
      .prepare(
        `
        UPDATE workflow_generations
        SET status = 'failed',
          error_json = ?,
          finished_at = ?
        WHERE id = ?
          AND status != 'completed'
      `,
      )
      .run(
        stringifyWorkflowGenerationErrorColumn(input.error, {
          table: "workflow_generations",
          column: "error_json",
          id: input.generationId,
        }),
        now,
        input.generationId,
      );

    return getWorkflowGeneration(input.generationId);
  })();
}

function derivePendingWorkflowName(prompt: string): string {
  const preview = truncate(normalizeWhitespace(prompt), 72);
  return preview ? `Generating: ${preview}` : "Generating workflow";
}

function derivePendingWorkflowDescription(prompt: string): string {
  const preview = truncate(normalizeWhitespace(prompt), 220);
  return preview || "Generating workflow from prompt.";
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
