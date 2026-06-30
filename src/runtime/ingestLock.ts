import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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
  await acquireIngestLock(repoRoot, options);

  try {
    return await fn();
  } finally {
    await removeIngestLock(repoRoot);
  }
}

async function acquireIngestLock(repoRoot: string, options: IngestLockOptions): Promise<void> {
  const lockPath = resolve(repoRoot, INGEST_LOCK_RELATIVE_PATH);
  const timeoutMs = normalizeDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const retryDelayMs = normalizeDuration(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  const deadline = Date.now() + timeoutMs;

  await ensureLockParentDirectory(repoRoot);

  while (true) {
    try {
      await mkdir(lockPath);
      await assertExistingLockPathSafe(repoRoot, INGEST_LOCK_RELATIVE_PATH, "directory");
      await writeMetadata(repoRoot, lockPath, options);
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      const existingLock = await readExistingLockPathSafety(repoRoot, INGEST_LOCK_RELATIVE_PATH, "directory");
      if (!existingLock.exists) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw lockBusyError();
      }

      await sleep(Math.min(retryDelayMs, Math.max(deadline - Date.now(), 0)));
    }
  }
}

async function writeMetadata(repoRoot: string, lockPath: string, options: IngestLockOptions): Promise<void> {
  const metadata: IngestLockMetadata = {
    pid: process.pid,
    started_at: (options.now?.() ?? new Date()).toISOString(),
    label: options.label ?? DEFAULT_LABEL,
  };

  try {
    await writeFile(resolve(lockPath, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  } catch (error) {
    await removeIngestLock(repoRoot);
    throw error;
  }
}

async function ensureLockParentDirectory(repoRoot: string): Promise<void> {
  const rootPath = resolve(repoRoot);
  const rootRealPath = await realpath(rootPath);
  const segments = INGEST_LOCK_RELATIVE_PATH.split("/").slice(0, -1);
  let currentPath = rootPath;
  let currentRelativePath = "";

  for (const segment of segments) {
    currentPath = resolve(currentPath, segment);
    currentRelativePath = currentRelativePath === "" ? segment : `${currentRelativePath}/${segment}`;
    assertPathInsideRoot(rootPath, currentPath, currentRelativePath);

    try {
      await mkdir(currentPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }

    await assertPathSegmentSafe(rootRealPath, currentPath, currentRelativePath, "directory");
  }
}

async function removeIngestLock(repoRoot: string): Promise<void> {
  const safe = await readExistingLockPathSafety(repoRoot, INGEST_LOCK_RELATIVE_PATH, "directory");
  if (!safe.exists) {
    return;
  }

  await rm(resolve(repoRoot, INGEST_LOCK_RELATIVE_PATH), { force: true, recursive: true });
}

async function assertExistingLockPathSafe(
  repoRoot: string,
  relativePath: string,
  expectedKind: "directory" | "file",
): Promise<void> {
  const safe = await readExistingLockPathSafety(repoRoot, relativePath, expectedKind);
  if (!safe.exists) {
    throw lockPathUnsafe(relativePath, `Ingest lock path does not exist: ${relativePath}`);
  }
}

async function readExistingLockPathSafety(
  repoRoot: string,
  relativePath: string,
  expectedKind: "directory" | "file",
): Promise<{ exists: boolean }> {
  const rootPath = resolve(repoRoot);
  const rootRealPath = await realpath(rootPath);
  const segments = relativePath.split("/");
  let currentPath = rootPath;
  let currentRelativePath = "";

  for (const segment of segments) {
    currentPath = resolve(currentPath, segment);
    currentRelativePath = currentRelativePath === "" ? segment : `${currentRelativePath}/${segment}`;
    assertPathInsideRoot(rootPath, currentPath, currentRelativePath);

    try {
      const isLastSegment = currentRelativePath === relativePath;
      await assertPathSegmentSafe(
        rootRealPath,
        currentPath,
        currentRelativePath,
        isLastSegment ? expectedKind : "directory",
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { exists: false };
      }

      throw error;
    }
  }

  return { exists: true };
}

async function assertPathSegmentSafe(
  rootRealPath: string,
  absolutePath: string,
  relativePath: string,
  expectedKind: "directory" | "file",
): Promise<void> {
  const pathStat = await lstat(absolutePath);
  if (pathStat.isSymbolicLink()) {
    throw lockPathUnsafe(relativePath, `Ingest lock path must not include symlinks: ${relativePath}`);
  }

  const isExpectedKind = expectedKind === "directory" ? pathStat.isDirectory() : pathStat.isFile();
  if (!isExpectedKind) {
    throw lockPathUnsafe(relativePath, `Ingest lock path is not a safe ${expectedKind}: ${relativePath}`);
  }

  const resolvedPath = await realpath(absolutePath);
  if (!isInsideRealPath(rootRealPath, resolvedPath)) {
    throw lockPathUnsafe(relativePath, `Ingest lock path resolves outside the wiki repository: ${relativePath}`);
  }
}

function assertPathInsideRoot(rootPath: string, absolutePath: string, relativePath: string): void {
  const relativeToRoot = relative(rootPath, absolutePath);
  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw lockPathUnsafe(relativePath, `Ingest lock path must stay inside the wiki repository: ${relativePath}`);
  }
}

function isInsideRealPath(rootRealPath: string, resolvedPath: string): boolean {
  const relativePath = relative(rootRealPath, resolvedPath);

  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function lockPathUnsafe(path: string, message: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "INGEST_LOCK_PATH_UNSAFE",
    message,
    path,
    hint: "Ingest lock writes must stay inside the wiki repository and must not follow symlinks.",
  });
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
