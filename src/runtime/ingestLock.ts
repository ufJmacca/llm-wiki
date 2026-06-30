import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { RuntimeCommandError } from "./errors.js";

export type IngestLockOptions = {
  label?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
};

export type IngestLockMetadata = {
  pid: number;
  started_at: string;
  label: string;
};

export const INGEST_LOCK_RELATIVE_PATH = ".llm-wiki/cache/locks/ingest.lock" as const;

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_LABEL = "ingest";

export async function withIngestLock<T>(
  repoRoot: string,
  options: IngestLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = resolve(repoRoot, INGEST_LOCK_RELATIVE_PATH);
  await acquireIngestLock(repoRoot, options);

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true, recursive: true });
  }
}

async function acquireIngestLock(repoRoot: string, options: IngestLockOptions): Promise<void> {
  const lockPath = resolve(repoRoot, INGEST_LOCK_RELATIVE_PATH);
  const lockParentPath = resolve(lockPath, "..");
  const timeoutMs = normalizeDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const retryDelayMs = normalizeDuration(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  const deadline = Date.now() + timeoutMs;

  await mkdir(lockParentPath, { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      await writeMetadata(lockPath, options);
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          await rm(lockPath, { force: true, recursive: true });
        }
        throw error;
      }

      if (Date.now() >= deadline) {
        throw lockBusyError();
      }

      await sleep(Math.min(retryDelayMs, Math.max(deadline - Date.now(), 0)));
    }
  }
}

async function writeMetadata(lockPath: string, options: IngestLockOptions): Promise<void> {
  const metadata: IngestLockMetadata = {
    pid: process.pid,
    started_at: (options.now?.() ?? new Date()).toISOString(),
    label: options.label ?? DEFAULT_LABEL,
  };

  try {
    await writeFile(resolve(lockPath, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  } catch (error) {
    await rm(lockPath, { force: true, recursive: true });
    throw error;
  }
}

function lockBusyError(): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "INGEST_LOCK_BUSY",
    message: `Ingest lock is already held: ${INGEST_LOCK_RELATIVE_PATH}`,
    path: INGEST_LOCK_RELATIVE_PATH,
    hint: "Another ingest worker is already mutating this wiki. Wait for it to finish, then retry.",
  });
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
