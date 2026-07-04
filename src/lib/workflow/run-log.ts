import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { RUN_LOG_PREVIEW_BYTES } from "@/lib/workflow/run-constants";

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

export function appendRunLogEvent(logPath: string | null, event: unknown) {
  if (!logPath) {
    return;
  }
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
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
