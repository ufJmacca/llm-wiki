import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

declare const ingestLockLeaseBrand: unique symbol;

export type IngestLockLease = {
  readonly repoRoot: string;
  readonly [ingestLockLeaseBrand]: true;
};

export const INGEST_LOCK_RELATIVE_PATH = ".llm-wiki/cache/locks/ingest.lock" as const;

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_LABEL = "ingest";
const LOCK_METADATA_RELATIVE_PATH = `${INGEST_LOCK_RELATIVE_PATH}/metadata.json`;
const LOCK_RECLAIM_RELATIVE_PATH = `${INGEST_LOCK_RELATIVE_PATH}/reclaiming`;
const LOCK_RECLAIM_MARKER_STALE_MS = 1_000;
const LOCK_UNOWNED_STALE_MS = 1_000;
const activeLeases = new WeakSet<object>();

export async function withIngestLock<T>(
  repoRoot: string,
  options: IngestLockOptions,
  fn: (lease: IngestLockLease) => Promise<T>,
): Promise<T> {
  await acquireIngestLock(repoRoot, options);
  const lease = { repoRoot: resolve(repoRoot) } as IngestLockLease;
  activeLeases.add(lease);

  try {
    return await fn(lease);
  } finally {
    activeLeases.delete(lease);
    await removeIngestLock(repoRoot);
  }
}

export function assertIngestLockLease(lease: IngestLockLease, repoRoot: string): void {
  if (!activeLeases.has(lease) || lease.repoRoot !== resolve(repoRoot)) {
    throw new RuntimeCommandError({
      code: "INGEST_LOCK_OWNERSHIP_INVALID",
      message: "The caller does not own the active repository ingest lock.",
      path: INGEST_LOCK_RELATIVE_PATH,
      hint: "Acquire the repository ingest lock and pass its active lease to the locked operation.",
    });
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

      if (await reclaimStaleIngestLock(repoRoot)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw lockBusyError();
      }

      await sleep(Math.min(retryDelayMs, Math.max(deadline - Date.now(), 0)));
    }
  }
}

async function reclaimStaleIngestLock(repoRoot: string): Promise<boolean> {
  const metadata = await readExistingLockMetadata(repoRoot);
  if (metadata === null) {
    if (!(await isUnownedLockStale(repoRoot))) {
      return false;
    }
  } else if (isProcessRunning(metadata.pid)) {
    return false;
  }

  if (!(await createLockReclaimMarker(repoRoot))) {
    return false;
  }

  try {
    const currentMetadata = await readExistingLockMetadata(repoRoot);
    if (currentMetadata === null) {
      await removeIngestLock(repoRoot);

      return true;
    }

    if (metadata !== null && !sameLockMetadata(metadata, currentMetadata)) {
      return false;
    }

    if (isProcessRunning(currentMetadata.pid)) {
      return false;
    }

    await removeIngestLock(repoRoot);
  } finally {
    await removeLockReclaimMarker(repoRoot);
  }

  return true;
}

async function isUnownedLockStale(repoRoot: string): Promise<boolean> {
  try {
    const lockStat = await lstat(resolve(repoRoot, INGEST_LOCK_RELATIVE_PATH));
    const metadataMtimeMs = await readLockMetadataMtime(repoRoot);
    const newestMtimeMs = Math.max(lockStat.mtimeMs, metadataMtimeMs ?? 0);

    return lockStat.isDirectory() && Date.now() - newestMtimeMs >= LOCK_UNOWNED_STALE_MS;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function readLockMetadataMtime(repoRoot: string): Promise<number | null> {
  try {
    const metadataStat = await lstat(resolve(repoRoot, LOCK_METADATA_RELATIVE_PATH));

    return metadataStat.isFile() ? metadataStat.mtimeMs : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readExistingLockMetadata(repoRoot: string): Promise<IngestLockMetadata | null> {
  return readLockMetadataFile(repoRoot, LOCK_METADATA_RELATIVE_PATH);
}

async function readLockReclaimMarkerMetadata(repoRoot: string): Promise<IngestLockMetadata | null> {
  return readLockMetadataFile(repoRoot, `${LOCK_RECLAIM_RELATIVE_PATH}/metadata.json`);
}

async function readLockMetadataFile(repoRoot: string, metadataRelativePath: string): Promise<IngestLockMetadata | null> {
  try {
    const safe = await readExistingLockPathSafety(repoRoot, metadataRelativePath, "file");
    if (!safe.exists) {
      return null;
    }

    const parsed = JSON.parse(await readFile(resolve(repoRoot, metadataRelativePath), "utf8")) as unknown;

    return isIngestLockMetadata(parsed) ? parsed : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

async function createLockReclaimMarker(repoRoot: string): Promise<boolean> {
  while (true) {
    try {
      await mkdir(resolve(repoRoot, LOCK_RECLAIM_RELATIVE_PATH));
      await writeLockReclaimMarkerMetadata(repoRoot);

      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        if (await removeStaleLockReclaimMarker(repoRoot)) {
          continue;
        }

        return false;
      }

      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }
}

async function writeLockReclaimMarkerMetadata(repoRoot: string): Promise<void> {
  const markerPath = resolve(repoRoot, LOCK_RECLAIM_RELATIVE_PATH);
  const metadata: IngestLockMetadata = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    label: "ingest-lock-reclaim",
  };

  try {
    await writeFile(resolve(markerPath, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  } catch (error) {
    await removeLockReclaimMarker(repoRoot);
    throw error;
  }
}

async function removeStaleLockReclaimMarker(repoRoot: string): Promise<boolean> {
  const metadata = await readLockReclaimMarkerMetadata(repoRoot);
  if (metadata !== null) {
    if (isProcessRunning(metadata.pid)) {
      return false;
    }

    await removeLockReclaimMarker(repoRoot);

    return true;
  }

  if (!(await isLockReclaimMarkerStale(repoRoot))) {
    return false;
  }

  await removeLockReclaimMarker(repoRoot);

  return true;
}

async function isLockReclaimMarkerStale(repoRoot: string): Promise<boolean> {
  try {
    const markerStat = await lstat(resolve(repoRoot, LOCK_RECLAIM_RELATIVE_PATH));

    return markerStat.isDirectory() && Date.now() - markerStat.mtimeMs >= LOCK_RECLAIM_MARKER_STALE_MS;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function removeLockReclaimMarker(repoRoot: string): Promise<void> {
  await rm(resolve(repoRoot, LOCK_RECLAIM_RELATIVE_PATH), { force: true, recursive: true });
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

function isIngestLockMetadata(value: unknown): value is IngestLockMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const metadata = value as Partial<IngestLockMetadata>;
  const parsedStartedAt = typeof metadata.started_at === "string"
    ? Date.parse(metadata.started_at)
    : Number.NaN;

  return Number.isSafeInteger(metadata.pid)
    && typeof metadata.label === "string"
    && typeof metadata.started_at === "string"
    && Number.isFinite(parsedStartedAt);
}

function isProcessRunning(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

function sameLockMetadata(left: IngestLockMetadata, right: IngestLockMetadata): boolean {
  return left.pid === right.pid && left.started_at === right.started_at && left.label === right.label;
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
