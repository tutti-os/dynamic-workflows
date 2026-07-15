import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RUN_LOG_PREVIEW_BYTES } from "@/lib/workflow/run-constants";

export type RunLogEntry<T = unknown> = {
  id: string;
  event: T;
};

export type RunLogChunk = {
  text: string;
  nextOffset: number;
};

export type RunLogPreview = {
  log: string;
  logSizeBytes: number;
  logReturnedBytes: number;
  logTruncated: boolean;
};

export const EMPTY_LOG_PREVIEW: RunLogPreview = {
  log: "",
  logSizeBytes: 0,
  logReturnedBytes: 0,
  logTruncated: false,
};

export function ensureRunLogDirectory(logPath: string | null) {
  if (!logPath) {
    return;
  }
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
}

export function appendRunLogEvent<T>(
  logPath: string | null,
  event: T,
): RunLogEntry<T> {
  const entry = { id: randomUUID(), event };
  if (!logPath) {
    return entry;
  }
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function readRunLogPreview(logPath: string): Promise<RunLogPreview> {
  try {
    const stats = await fsPromises.stat(logPath);
    if (stats.size <= RUN_LOG_PREVIEW_BYTES) {
      const log = await fsPromises.readFile(logPath, "utf8");
      return {
        log,
        logSizeBytes: stats.size,
        logReturnedBytes: stats.size,
        logTruncated: false,
      };
    }

    const file = await fsPromises.open(logPath, "r");
    try {
      const buffer = Buffer.alloc(RUN_LOG_PREVIEW_BYTES);
      const { bytesRead } = await file.read(
        buffer,
        0,
        RUN_LOG_PREVIEW_BYTES,
        stats.size - RUN_LOG_PREVIEW_BYTES,
      );
      return {
        log: buffer.subarray(0, bytesRead).toString("utf8"),
        logSizeBytes: stats.size,
        logReturnedBytes: bytesRead,
        logTruncated: true,
      };
    } finally {
      await file.close();
    }
  } catch {
    return EMPTY_LOG_PREVIEW;
  }
}

export async function readRunLog(logPath: string | null): Promise<string> {
  if (!logPath) {
    return "";
  }
  try {
    return await fsPromises.readFile(logPath, "utf8");
  } catch {
    return "";
  }
}

export async function readRunLogChunk(
  logPath: string | null,
  offset: number,
): Promise<RunLogChunk> {
  if (!logPath) {
    return { text: "", nextOffset: 0 };
  }

  try {
    const stats = await fsPromises.stat(logPath);
    const start = offset <= stats.size ? offset : 0;
    if (start === stats.size) {
      return { text: "", nextOffset: start };
    }

    const file = await fsPromises.open(logPath, "r");
    try {
      const buffer = Buffer.alloc(stats.size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const bytes = buffer.subarray(0, bytesRead);
      const lastNewline = bytes.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        return { text: "", nextOffset: start };
      }
      const consumed = lastNewline + 1;
      return {
        text: bytes.subarray(0, consumed).toString("utf8"),
        nextOffset: start + consumed,
      };
    } finally {
      await file.close();
    }
  } catch {
    return { text: "", nextOffset: 0 };
  }
}
