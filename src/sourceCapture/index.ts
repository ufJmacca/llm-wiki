import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { stringify } from "yaml";

import { appendRuntimeLogEntry, validateRuntimeLogAppendTarget } from "../runtime/log.js";
import { scanMarkdownDocument } from "../scanner/index.js";
import {
  validateBinaryFileNoOverwriteInsideRoot,
  writeBinaryFileNoOverwriteInsideRoot,
  type BinaryWriteError,
} from "../utils/fs.js";
import { err, ok, type Result } from "../utils/result.js";

export type SourceKind = "file" | "text" | "url";
export type QueueStatus = "queued" | "ingesting" | "ingested" | "blocked";

export type CapturedSource = {
  source_id: string;
  title: string;
  source_kind: SourceKind;
  origin: string;
  origin_url?: string;
  captured_at: string;
  content_hash: string;
  visibility: "private";
  queue_status: QueueStatus;
  original_path: string;
  source_card_path: string;
  queue_path: string;
};

export type SourceCaptureSuccess = {
  status: "added" | "duplicate";
  source: CapturedSource;
  created_paths: string[];
};

export type SourceCaptureErrorCode =
  | BinaryWriteError["code"]
  | "QUEUE_SCAN_FAILED"
  | "SOURCE_PATH_NOT_FILE"
  | "SOURCE_PATH_NOT_FOUND"
  | "SOURCE_PATH_REQUIRED"
  | "SOURCE_PATH_UNSAFE"
  | "SOURCE_READ_FAILED"
  | "TEXT_REQUIRED"
  | "TITLE_REQUIRED"
  | "URL_EMPTY_RESPONSE"
  | "URL_FETCH_FAILED"
  | "URL_INVALID"
  | "URL_UNSUPPORTED_RESPONSE";

export type SourceCaptureError = {
  code: SourceCaptureErrorCode;
  message: string;
  path: string;
  hint: string;
};

export type CaptureFileSourceOptions = {
  repoRoot: string;
  sourcePath: string;
  title?: string;
  now?: Date;
  command?: string;
};

export type CaptureTextSourceOptions = {
  repoRoot: string;
  text: string;
  title: string;
  now?: Date;
  command?: string;
};

export type CaptureUploadedFileSourceOptions = {
  repoRoot: string;
  fileName: string;
  content: Buffer;
  title?: string;
  now?: Date;
  command?: string;
};

export type CaptureUrlSourceOptions = {
  repoRoot: string;
  url: string;
  title?: string;
  now?: Date;
  command?: string;
};

export type PreparedUrlSource = {
  url: string;
  title: string;
  text: string;
};

export type CapturePreparedUrlSourceOptions = {
  repoRoot: string;
  source: PreparedUrlSource;
  now?: Date;
  command?: string;
};

type CaptureInput = {
  repoRoot: string;
  title: string;
  sourceKind: SourceKind;
  origin: string;
  originUrl?: string;
  originalExtension: string;
  content: Buffer;
  now: Date;
  command: string;
};

type FetchedUrlText = {
  url: string;
  text: string;
};

type QueueJson = {
  kind: SourceKind;
  source_id: string;
  title: string;
  source_kind: SourceKind;
  origin: string;
  origin_url?: string;
  captured_at: string;
  content_hash: string;
  status: QueueStatus;
  visibility: "private";
  path: string;
  original_path: string;
};

type SourceCardDuplicateMetadata = {
  source_id: string;
  title: string;
  source_kind: SourceKind;
  origin: string;
  origin_url?: string | null;
  captured_at: string;
  content_hash: string;
  status: QueueStatus;
  visibility: "private";
};

export async function captureFileSource(
  options: CaptureFileSourceOptions,
): Promise<Result<SourceCaptureSuccess, SourceCaptureError>> {
  const sourcePath = resolve(options.sourcePath);
  const sourceState = await readSafeSourceFile(sourcePath);
  if (!sourceState.ok) {
    return sourceState;
  }

  const title = normalizeTitle(options.title, basename(sourcePath, extname(sourcePath)));
  if (!title.ok) {
    return title;
  }

  const content = await readSourceContent(sourcePath);
  if (!content.ok) {
    return content;
  }

  return captureSource({
    repoRoot: options.repoRoot,
    title: title.value,
    sourceKind: "file",
    origin: sourcePath,
    originalExtension: normalizeOriginalExtension(extname(sourcePath), "bin"),
    content: content.value,
    now: options.now ?? new Date(),
    command: options.command ?? `llm-wiki add ${sourcePath}`,
  });
}

export async function captureTextSource(
  options: CaptureTextSourceOptions,
): Promise<Result<SourceCaptureSuccess, SourceCaptureError>> {
  const title = normalizeTitle(options.title);
  if (!title.ok) {
    return title;
  }

  if (options.text.length === 0) {
    return err({
      code: "TEXT_REQUIRED",
      message: "Text capture requires non-empty text.",
      path: "pasted_text",
      hint: "Pass text with --text or through standard input.",
    });
  }

  return captureSource({
    repoRoot: options.repoRoot,
    title: title.value,
    sourceKind: "text",
    origin: "pasted_text",
    originalExtension: "md",
    content: Buffer.from(options.text, "utf8"),
    now: options.now ?? new Date(),
    command: options.command ?? `llm-wiki add-text --title ${title.value}`,
  });
}

export async function captureUploadedFileSource(
  options: CaptureUploadedFileSourceOptions,
): Promise<Result<SourceCaptureSuccess, SourceCaptureError>> {
  const safeFileName = basename(options.fileName.trim() || "upload.bin");
  const title = normalizeTitle(options.title, basename(safeFileName, extname(safeFileName)));
  if (!title.ok) {
    return title;
  }

  return captureSource({
    repoRoot: options.repoRoot,
    title: title.value,
    sourceKind: "file",
    origin: `upload:${safeFileName}`,
    originalExtension: normalizeOriginalExtension(extname(safeFileName), "bin"),
    content: options.content,
    now: options.now ?? new Date(),
    command: options.command ?? `llm-wiki explore serve --with-daemon upload ${safeFileName}`,
  });
}

export async function captureUrlSource(
  options: CaptureUrlSourceOptions,
): Promise<Result<SourceCaptureSuccess, SourceCaptureError>> {
  const prepared = await prepareUrlSource(options);
  if (!prepared.ok) {
    return prepared;
  }

  return capturePreparedUrlSource({
    repoRoot: options.repoRoot,
    source: prepared.value,
    now: options.now,
    command: options.command ?? `llm-wiki add-url ${prepared.value.url}`,
  });
}

export async function prepareUrlSource(
  options: Pick<CaptureUrlSourceOptions, "url" | "title">,
): Promise<Result<PreparedUrlSource, SourceCaptureError>> {
  const normalizedUrl = normalizeCaptureUrl(options.url);
  if (!normalizedUrl.ok) {
    return normalizedUrl;
  }

  const fetched = await fetchUrlText(normalizedUrl.value);
  if (!fetched.ok) {
    return fetched;
  }

  const title = normalizeTitle(options.title, deriveUrlTitle(fetched.value.url));
  if (!title.ok) {
    return title;
  }

  return ok({
    url: fetched.value.url,
    title: title.value,
    text: fetched.value.text,
  });
}

export async function capturePreparedUrlSource(
  options: CapturePreparedUrlSourceOptions,
): Promise<Result<SourceCaptureSuccess, SourceCaptureError>> {
  return captureSource({
    repoRoot: options.repoRoot,
    title: options.source.title,
    sourceKind: "url",
    origin: "url",
    originUrl: options.source.url,
    originalExtension: "md",
    content: Buffer.from(options.source.text, "utf8"),
    now: options.now ?? new Date(),
    command: options.command ?? `llm-wiki add-url ${options.source.url}`,
  });
}

async function captureSource(input: CaptureInput): Promise<Result<SourceCaptureSuccess, SourceCaptureError>> {
  const contentHash = `sha256:${sha256Hex(input.content)}`;
  const duplicate = await findDuplicateSource(input.repoRoot, contentHash);
  if (!duplicate.ok) {
    return err(duplicate.error);
  }

  if (duplicate.value !== null) {
    return ok({
      status: "duplicate",
      source: duplicate.value,
      created_paths: [],
    });
  }

  const capturedAt = input.now.toISOString();
  const sourceId = buildSourceId(input.title, input.content, input.now);
  const year = sourceId.slice(4, 8);
  const month = sourceId.slice(9, 11);
  const sourceDir = `raw/inputs/${year}/${month}/${sourceId}`;
  const originalPath = `${sourceDir}/original.${input.originalExtension}`;
  const sourceCardPath = `${sourceDir}/_source.md`;
  const queuePath = `raw/queue/${sourceId}.json`;
  const source: CapturedSource = {
    source_id: sourceId,
    title: input.title,
    source_kind: input.sourceKind,
    origin: input.origin,
    ...(input.originUrl === undefined ? {} : { origin_url: input.originUrl }),
    captured_at: capturedAt,
    content_hash: contentHash,
    visibility: "private",
    queue_status: "queued",
    original_path: originalPath,
    source_card_path: sourceCardPath,
    queue_path: queuePath,
  };
  const queueJson = toQueueJson(source);
  const createdPaths = [originalPath, sourceCardPath, queuePath];

  const destinationPreflight = await validateCaptureDestinations(input.repoRoot, createdPaths);
  if (!destinationPreflight.ok) {
    return err(binaryWriteToCaptureError(destinationPreflight.error));
  }

  const logPreflight = await validateRuntimeLogAppendTarget(input.repoRoot);
  if (!logPreflight.ok) {
    return err(binaryWriteToCaptureError(logPreflight.error));
  }

  const writtenPaths: string[] = [];
  const originalWrite = await writeBinaryFileNoOverwriteInsideRoot(input.repoRoot, originalPath, input.content);
  if (!originalWrite.ok) {
    await rollbackCaptureArtifacts(
      input.repoRoot,
      pathsForFailedArtifactWrite(writtenPaths, originalPath, originalWrite.error),
      sourceDir,
    );
    return err(binaryWriteToCaptureError(originalWrite.error));
  }
  writtenPaths.push(originalPath);

  const sourceCardWrite = await writeBinaryFileNoOverwriteInsideRoot(
    input.repoRoot,
    sourceCardPath,
    Buffer.from(formatSourceCard(source), "utf8"),
  );
  if (!sourceCardWrite.ok) {
    await rollbackCaptureArtifacts(
      input.repoRoot,
      pathsForFailedArtifactWrite(writtenPaths, sourceCardPath, sourceCardWrite.error),
      sourceDir,
    );
    return err(binaryWriteToCaptureError(sourceCardWrite.error));
  }
  writtenPaths.push(sourceCardPath);

  const queueWrite = await writeBinaryFileNoOverwriteInsideRoot(
    input.repoRoot,
    queuePath,
    Buffer.from(`${JSON.stringify(queueJson, null, 2)}\n`, "utf8"),
  );
  if (!queueWrite.ok) {
    await rollbackCaptureArtifacts(
      input.repoRoot,
      pathsForFailedArtifactWrite(writtenPaths, queuePath, queueWrite.error),
      sourceDir,
    );
    return err(binaryWriteToCaptureError(queueWrite.error));
  }
  writtenPaths.push(queuePath);

  const logWrite = await appendRuntimeLogEntry(input.repoRoot, {
    timestamp: capturedAt,
    operation: "add",
    affectedId: sourceId,
    title: formatLogTitle(input.title),
    command: input.command,
    rawSource: sourceCardPath,
    created: createdPaths,
  });
  if (!logWrite.ok) {
    await rollbackCaptureArtifacts(input.repoRoot, writtenPaths, sourceDir);
    return err(binaryWriteToCaptureError(logWrite.error));
  }

  return ok({
    status: "added",
    source,
    created_paths: createdPaths,
  });
}

function pathsForFailedArtifactWrite(
  writtenPaths: string[],
  attemptedPath: string,
  error: BinaryWriteError,
): string[] {
  if (error.code === "DESTINATION_EXISTS" || error.code === "DESTINATION_PATH_UNSAFE") {
    return writtenPaths;
  }

  return [...writtenPaths, attemptedPath];
}

async function rollbackCaptureArtifacts(repoRoot: string, paths: string[], sourceDir: string): Promise<void> {
  for (const path of [...new Set(paths)].reverse()) {
    const absolutePath = resolve(repoRoot, path);

    try {
      const pathStat = await lstat(absolutePath);
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
        continue;
      }

      await rm(absolutePath, { force: true });
    } catch {
      // Rollback is best-effort; the original write error remains authoritative.
    }
  }

  try {
    const sourceDirPath = resolve(repoRoot, sourceDir);
    const sourceDirStat = await lstat(sourceDirPath);
    if (sourceDirStat.isDirectory() && !sourceDirStat.isSymbolicLink()) {
      await rmdir(sourceDirPath);
    }
  } catch {
    // Ignore non-empty, missing, or concurrently changed directories.
  }
}

async function readSafeSourceFile(path: string): Promise<Result<void, SourceCaptureError>> {
  try {
    const sourceStat = await lstat(path);
    if (sourceStat.isSymbolicLink()) {
      return err(sourcePathSymlink(path));
    }

    if (!sourceStat.isFile()) {
      return err(sourcePathNotFile(path));
    }

    const resolvedSourcePath = await realpath(path);
    if (resolvedSourcePath !== path) {
      return err(sourcePathResolvesThroughSymlinks(path));
    }

    return ok(undefined);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return err({
        code: "SOURCE_PATH_NOT_FOUND",
        message: `Source path does not exist: ${path}`,
        path,
        hint: "Pass an existing local file to llm-wiki add.",
      });
    }

    return err({
      code: "SOURCE_PATH_UNSAFE",
      message: error instanceof Error ? error.message : String(error),
      path,
      hint: "Pass an existing local file that can be read without following symlinks.",
    });
  }
}

async function readSourceContent(path: string): Promise<Result<Buffer, SourceCaptureError>> {
  let file: Awaited<ReturnType<typeof open>> | undefined;

  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedFileStat = await file.stat();
    if (!openedFileStat.isFile()) {
      return err(sourcePathNotFile(path));
    }

    const currentPathStat = await lstat(path);
    if (currentPathStat.isSymbolicLink()) {
      return err(sourcePathSymlink(path));
    }

    if (!currentPathStat.isFile()) {
      return err(sourcePathNotFile(path));
    }

    if (!isSameFile(openedFileStat, currentPathStat)) {
      return err(sourcePathChanged(path));
    }

    const resolvedSourcePath = await realpath(path);
    if (resolvedSourcePath !== path) {
      return err(sourcePathResolvesThroughSymlinks(path));
    }

    return ok(await file.readFile());
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      return err(sourcePathSymlink(path));
    }

    return err({
      code: "SOURCE_READ_FAILED",
      message: `Could not read source file: ${path}`,
      path,
      hint: "Check that the file exists and can be read, then try again.",
    });
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function findDuplicateSource(
  repoRoot: string,
  contentHash: string,
): Promise<Result<CapturedSource | null, SourceCaptureError>> {
  const queueDir = resolve(repoRoot, "raw", "queue");
  let queueFiles: string[] = [];
  let repoRealPath: string;
  let queueRealPath: string | null = null;

  try {
    repoRealPath = await realpath(resolve(repoRoot));
    const queueStat = await lstat(queueDir);
    if (queueStat.isSymbolicLink() || !queueStat.isDirectory()) {
      return err(queueScanFailed());
    }

    queueRealPath = await realpath(queueDir);
    if (!isInsidePath(repoRealPath, queueRealPath)) {
      return err(queueScanFailed());
    }

    queueFiles = await readdir(queueDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      repoRealPath = await realpath(resolve(repoRoot));
      queueFiles = [];
    } else {
      return err(queueScanFailed());
    }
  }

  for (const queueFile of queueFiles.sort()) {
    if (!queueFile.endsWith(".json")) {
      continue;
    }

    const queuePath = resolve(queueDir, queueFile);
    const queueContent = await readQueueFileForDuplicate(repoRealPath, queueRealPath, queuePath);
    if (queueContent === null) {
      continue;
    }

    let queueItem: unknown;
    try {
      queueItem = JSON.parse(queueContent) as unknown;
    } catch {
      continue;
    }

    if (!isValidDuplicateQueueItem(queueItem, contentHash)) {
      continue;
    }

    const duplicate = await validateQueueDuplicate(repoRoot, repoRealPath, queueFile, queueItem, contentHash);
    if (duplicate !== null) {
      return ok(duplicate);
    }
  }

  return findDuplicateSourceCard(repoRoot, repoRealPath, contentHash);
}

async function validateQueueDuplicate(
  repoRoot: string,
  repoRealPath: string,
  queueFile: string,
  queueItem: QueueJson,
  contentHash: string,
): Promise<CapturedSource | null> {
  const sourceCardPath = resolveRepositoryRelativePath(repoRoot, queueItem.path);
  const originalPath = resolveRepositoryRelativePath(repoRoot, queueItem.original_path);
  if (sourceCardPath === null || originalPath === null) {
    return null;
  }

  const sourceCardRelativePath = toRepositoryPath(repoRoot, sourceCardPath);
  const sourceCardContent = await readFileForDuplicate(repoRealPath, repoRealPath, sourceCardPath);
  if (sourceCardContent === null) {
    return null;
  }

  const sourceCard = parseDuplicateSourceCard(sourceCardRelativePath, sourceCardContent.toString("utf8"), contentHash);
  if (sourceCard === null || !queueDuplicateMatchesSourceCard(queueItem, sourceCard)) {
    return null;
  }

  const originalContent = await readFileForDuplicate(repoRealPath, repoRealPath, originalPath);
  if (originalContent === null || `sha256:${sha256Hex(originalContent)}` !== contentHash) {
    return null;
  }

  return {
    source_id: queueItem.source_id,
    title: queueItem.title,
    source_kind: queueItem.source_kind,
    origin: queueItem.origin,
    ...(typeof queueItem.origin_url === "string" ? { origin_url: queueItem.origin_url } : {}),
    captured_at: queueItem.captured_at,
    content_hash: contentHash,
    visibility: "private",
    queue_status: queueItem.status,
    original_path: toRepositoryPath(repoRoot, originalPath),
    source_card_path: sourceCardRelativePath,
    queue_path: `raw/queue/${queueFile}`,
  };
}

function resolveRepositoryRelativePath(repoRoot: string, path: string): string | null {
  if (path.includes("\0") || isAbsolute(path)) {
    return null;
  }

  const repoPath = resolve(repoRoot);
  const resolvedPath = resolve(repoPath, path);
  const relativePath = relative(repoPath, resolvedPath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }

  return resolvedPath;
}

function queueDuplicateMatchesSourceCard(queueItem: QueueJson, sourceCard: SourceCardDuplicateMetadata): boolean {
  const queueOriginUrl = queueItem.origin_url ?? null;
  const sourceCardOriginUrl = sourceCard.origin_url ?? null;
  return (
    queueItem.source_id === sourceCard.source_id &&
    queueItem.title === sourceCard.title &&
    queueItem.source_kind === sourceCard.source_kind &&
    queueItem.origin === sourceCard.origin &&
    queueOriginUrl === sourceCardOriginUrl &&
    queueItem.captured_at === sourceCard.captured_at &&
    queueItem.status === sourceCard.status &&
    queueItem.visibility === sourceCard.visibility
  );
}

async function readQueueFileForDuplicate(
  repoRealPath: string,
  queueRealPath: string | null,
  queuePath: string,
): Promise<string | null> {
  if (queueRealPath === null) {
    return null;
  }

  try {
    const queueFileStat = await lstat(queuePath);
    if (queueFileStat.isSymbolicLink() || !queueFileStat.isFile()) {
      return null;
    }

    const queueFileRealPath = await realpath(queuePath);
    if (!isInsidePath(repoRealPath, queueFileRealPath) || !isInsidePath(queueRealPath, queueFileRealPath)) {
      return null;
    }

    const file = await open(queuePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedFileStat = await file.stat();
      if (!openedFileStat.isFile()) {
        return null;
      }

      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function findDuplicateSourceCard(
  repoRoot: string,
  repoRealPath: string,
  contentHash: string,
): Promise<Result<CapturedSource | null, SourceCaptureError>> {
  const rawInputsDir = resolve(repoRoot, "raw", "inputs");
  let rawInputsRealPath: string;
  let sourceCardPaths: string[];

  try {
    const rawInputsStat = await lstat(rawInputsDir);
    if (rawInputsStat.isSymbolicLink() || !rawInputsStat.isDirectory()) {
      return ok(null);
    }

    rawInputsRealPath = await realpath(rawInputsDir);
    if (!isInsidePath(repoRealPath, rawInputsRealPath)) {
      return ok(null);
    }

    sourceCardPaths = await listSourceCardPaths(repoRealPath, rawInputsRealPath, rawInputsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return ok(null);
    }

    return ok(null);
  }

  for (const sourceCardPath of sourceCardPaths) {
    const sourceCardRelativePath = toRepositoryPath(repoRoot, sourceCardPath);
    const sourceCardContent = await readFileForDuplicate(repoRealPath, rawInputsRealPath, sourceCardPath);
    if (sourceCardContent === null) {
      continue;
    }

    const sourceCard = parseDuplicateSourceCard(sourceCardRelativePath, sourceCardContent.toString("utf8"), contentHash);
    if (sourceCard === null) {
      continue;
    }

    const originalPath = await findMatchingOriginalPath(repoRoot, repoRealPath, sourceCardPath, contentHash);
    if (originalPath === null) {
      continue;
    }

    return ok({
      source_id: sourceCard.source_id,
      title: sourceCard.title,
      source_kind: sourceCard.source_kind,
      origin: sourceCard.origin,
      ...(typeof sourceCard.origin_url === "string" ? { origin_url: sourceCard.origin_url } : {}),
      captured_at: sourceCard.captured_at,
      content_hash: contentHash,
      visibility: "private",
      queue_status: sourceCard.status,
      original_path: originalPath,
      source_card_path: sourceCardRelativePath,
      queue_path: `raw/queue/${sourceCard.source_id}.json`,
    });
  }

  return ok(null);
}

async function listSourceCardPaths(
  repoRealPath: string,
  rawInputsRealPath: string,
  rawInputsDir: string,
): Promise<string[]> {
  const sourceCardPaths: string[] = [];

  async function visit(directoryPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(directoryPath);
    } catch {
      return;
    }

    for (const entry of entries.sort()) {
      const entryPath = resolve(directoryPath, entry);
      let entryStat: Stats;
      let entryRealPath: string;
      try {
        entryStat = await lstat(entryPath);
        if (entryStat.isSymbolicLink()) {
          continue;
        }

        entryRealPath = await realpath(entryPath);
      } catch {
        continue;
      }

      if (!isInsidePath(repoRealPath, entryRealPath) || !isInsidePath(rawInputsRealPath, entryRealPath)) {
        continue;
      }

      if (entryStat.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (entryStat.isFile() && entry === "_source.md") {
        sourceCardPaths.push(entryPath);
      }
    }
  }

  await visit(rawInputsDir);

  return sourceCardPaths.sort((left, right) => left.localeCompare(right));
}

async function findMatchingOriginalPath(
  repoRoot: string,
  repoRealPath: string,
  sourceCardPath: string,
  contentHash: string,
): Promise<string | null> {
  const sourceDir = dirname(sourceCardPath);
  let sourceDirRealPath: string;
  let entries: string[];

  try {
    const sourceDirStat = await lstat(sourceDir);
    if (sourceDirStat.isSymbolicLink() || !sourceDirStat.isDirectory()) {
      return null;
    }

    sourceDirRealPath = await realpath(sourceDir);
    if (!isInsidePath(repoRealPath, sourceDirRealPath)) {
      return null;
    }

    entries = await readdir(sourceDir);
  } catch {
    return null;
  }

  for (const entry of entries.sort()) {
    if (!/^original\.[^/]+$/.test(entry)) {
      continue;
    }

    const originalPath = resolve(sourceDir, entry);
    const originalContent = await readFileForDuplicate(repoRealPath, sourceDirRealPath, originalPath);
    if (originalContent !== null && `sha256:${sha256Hex(originalContent)}` === contentHash) {
      return toRepositoryPath(repoRoot, originalPath);
    }
  }

  return null;
}

async function readFileForDuplicate(
  repoRealPath: string,
  parentRealPath: string,
  path: string,
): Promise<Buffer | null> {
  try {
    const fileStat = await lstat(path);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return null;
    }

    const fileRealPath = await realpath(path);
    if (!isInsidePath(repoRealPath, fileRealPath) || !isInsidePath(parentRealPath, fileRealPath)) {
      return null;
    }

    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedFileStat = await file.stat();
      if (!openedFileStat.isFile()) {
        return null;
      }

      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

function queueScanFailed(): SourceCaptureError {
  return {
    code: "QUEUE_SCAN_FAILED",
    message: "Could not scan source queue: raw/queue",
    path: "raw/queue",
    hint: "Ensure raw/queue is a readable directory, then try again.",
  };
}

function isInsidePath(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isSameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sourcePathSymlink(path: string): SourceCaptureError {
  return {
    code: "SOURCE_PATH_UNSAFE",
    message: `Source path must not be a symlink: ${path}`,
    path,
    hint: "Pass the real source file path so capture provenance is explicit.",
  };
}

function sourcePathNotFile(path: string): SourceCaptureError {
  return {
    code: "SOURCE_PATH_NOT_FILE",
    message: `Source path is not a regular file: ${path}`,
    path,
    hint: "Pass a local file to llm-wiki add.",
  };
}

function sourcePathResolvesThroughSymlinks(path: string): SourceCaptureError {
  return {
    code: "SOURCE_PATH_UNSAFE",
    message: `Source path must not resolve through symlinks: ${path}`,
    path,
    hint: "Pass the real source file path so capture provenance is explicit.",
  };
}

function sourcePathChanged(path: string): SourceCaptureError {
  return {
    code: "SOURCE_PATH_UNSAFE",
    message: `Source path changed while it was being read: ${path}`,
    path,
    hint: "Retry with a stable regular file path that cannot be replaced during capture.",
  };
}

function isValidDuplicateQueueItem(value: unknown, contentHash: string): value is QueueJson {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.content_hash === contentHash &&
    isSourceId(value.source_id) &&
    isNonEmptyString(value.title) &&
    isSourceKind(value.kind) &&
    isSourceKind(value.source_kind) &&
    value.kind === value.source_kind &&
    isNonEmptyString(value.origin) &&
    (value.source_kind !== "url" || isNonEmptyString(value.origin_url)) &&
    isNonEmptyString(value.captured_at) &&
    isQueueStatus(value.status) &&
    value.visibility === "private" &&
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.original_path)
  );
}

function parseDuplicateSourceCard(
  path: string,
  content: string,
  contentHash: string,
): SourceCardDuplicateMetadata | null {
  const scan = scanMarkdownDocument({ path, content });
  if (scan.frontmatter === undefined || scan.issues.some((issue) => issue.severity === "error")) {
    return null;
  }

  if (!isValidDuplicateSourceCard(scan.frontmatter, contentHash)) {
    return null;
  }

  return scan.frontmatter;
}

function isValidDuplicateSourceCard(
  value: unknown,
  contentHash: string,
): value is SourceCardDuplicateMetadata {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.type === "raw_source" &&
    value.content_hash === contentHash &&
    isSourceId(value.source_id) &&
    isNonEmptyString(value.title) &&
    isSourceKind(value.source_kind) &&
    isNonEmptyString(value.origin) &&
    (value.source_kind !== "url" || isNonEmptyString(value.origin_url)) &&
    (value.source_kind === "url" || value.origin_url === undefined || typeof value.origin_url === "string" || value.origin_url === null) &&
    isNonEmptyString(value.captured_at) &&
    isQueueStatus(value.status) &&
    value.visibility === "private"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isSourceKind(value: unknown): value is SourceKind {
  return value === "file" || value === "text" || value === "url";
}

function isQueueStatus(value: unknown): value is QueueStatus {
  return value === "queued" || value === "ingesting" || value === "ingested" || value === "blocked";
}

function isSourceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^src_\d{4}_\d{2}_\d{2}_[a-z0-9]+(?:[_-][a-z0-9]+)*_[a-f0-9]{12}$/.test(value)
  );
}

function toRepositoryPath(repoRoot: string, path: string): string {
  return relative(resolve(repoRoot), path).replaceAll("\\", "/");
}

async function validateCaptureDestinations(
  repoRoot: string,
  paths: string[],
): Promise<Result<void, BinaryWriteError>> {
  for (const path of paths) {
    const result = await validateBinaryFileNoOverwriteInsideRoot(repoRoot, path);
    if (!result.ok) {
      return result;
    }
  }

  return ok(undefined);
}

function toQueueJson(source: CapturedSource): QueueJson {
  const queueJson: QueueJson = {
    kind: source.source_kind,
    source_id: source.source_id,
    title: source.title,
    source_kind: source.source_kind,
    origin: source.origin,
    captured_at: source.captured_at,
    content_hash: source.content_hash,
    status: source.queue_status,
    visibility: source.visibility,
    path: source.source_card_path,
    original_path: source.original_path,
  };

  if (source.origin_url !== undefined) {
    queueJson.origin_url = source.origin_url;
  }

  return queueJson;
}

function formatSourceCard(source: CapturedSource): string {
  const frontmatter = stringify({
    type: "raw_source",
    source_id: source.source_id,
    title: source.title,
    source_kind: source.source_kind,
    origin: source.origin,
    origin_url: source.origin_url ?? null,
    captured_at: source.captured_at,
    content_hash: source.content_hash,
    status: source.queue_status,
    visibility: source.visibility,
    tags: [],
    curated_summary: null,
    ingested_at: null,
    supersedes: null,
    superseded_by: null,
  }).trimEnd();

  return `---\n${frontmatter}\n---\n\n# ${formatMarkdownHeadingText(source.title)}\n\nOriginal file: ${formatOriginalFileLink(source.original_path)}\n\n## Capture notes\n\n## Human notes\n\n## Ingest status\n\n- Status: ${source.queue_status}\n- Curated summary:\n`;
}

function formatOriginalFileLink(originalPath: string): string {
  return `[[${originalPath}|${basename(originalPath)}]]`;
}

function formatMarkdownHeadingText(title: string): string {
  return title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function buildSourceId(title: string, content: Buffer, now: Date): string {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const slug = slugify(title);
  const shortHash = sha256Hex(content).slice(0, 12);

  return `src_${year}_${month}_${day}_${slug}_${shortHash}`;
}

function normalizeTitle(title: string | undefined, fallback?: string): Result<string, SourceCaptureError> {
  const normalizedTitle = title?.trim() || fallback?.trim() || "";
  if (normalizedTitle.length === 0) {
    return err({
      code: "TITLE_REQUIRED",
      message: "Source capture requires a title.",
      path: "title",
      hint: "Pass --title <title>.",
    });
  }

  return ok(normalizedTitle);
}

function normalizeOriginalExtension(extension: string, fallback: string): string {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  if (/^[a-z0-9]+$/.test(normalized)) {
    return normalized;
  }

  return fallback;
}

function normalizeCaptureUrl(url: string): Result<string, SourceCaptureError> {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url.trim());
  } catch {
    return err(invalidUrl());
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return err(invalidUrl());
  }

  return ok(parsedUrl.href);
}

async function fetchUrlText(url: string): Promise<Result<FetchedUrlText, SourceCaptureError>> {
  let response: Response;

  try {
    response = await fetch(url);
  } catch {
    return err({
      code: "URL_FETCH_FAILED",
      message: `Could not fetch URL: ${url}`,
      path: url,
      hint: "Check the URL and network connection, then try again.",
    });
  }

  const fetchedUrl = response.url || url;

  if (!response.ok) {
    return err({
      code: "URL_FETCH_FAILED",
      message: `URL fetch returned HTTP ${response.status} for ${fetchedUrl}`,
      path: fetchedUrl,
      hint: "Fetchable URLs must return a successful HTTP status.",
    });
  }

  const contentType = normalizeContentType(response.headers.get("content-type"));
  if (!isSupportedUrlContentType(contentType)) {
    return err({
      code: "URL_UNSUPPORTED_RESPONSE",
      message: `URL response content type is not supported: ${contentType}`,
      path: fetchedUrl,
      hint: "Capture URLs that return text, Markdown, HTML, XML, or JSON content.",
    });
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return err({
      code: "URL_FETCH_FAILED",
      message: `Could not read URL response: ${fetchedUrl}`,
      path: fetchedUrl,
      hint: "Check that the URL returns readable text content, then try again.",
    });
  }

  if (text.trim().length === 0) {
    return err({
      code: "URL_EMPTY_RESPONSE",
      message: `URL response was empty: ${fetchedUrl}`,
      path: fetchedUrl,
      hint: "Capture a URL that returns non-empty text content.",
    });
  }

  return ok({
    url: fetchedUrl,
    text,
  });
}

function invalidUrl(): SourceCaptureError {
  return {
    code: "URL_INVALID",
    message: "URL capture requires a valid http(s) URL.",
    path: "url",
    hint: "Pass an absolute http:// or https:// URL to llm-wiki add-url.",
  };
}

function normalizeContentType(contentType: string | null): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isSupportedUrlContentType(contentType: string): boolean {
  return (
    contentType === "" ||
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/ld+json" ||
    contentType === "application/markdown" ||
    contentType === "application/xhtml+xml" ||
    contentType === "application/xml" ||
    contentType.endsWith("+json") ||
    contentType.endsWith("+xml")
  );
}

function deriveUrlTitle(url: string): string {
  const parsedUrl = new URL(url);
  const lastPathSegment = parsedUrl.pathname.split("/").filter(Boolean).at(-1);
  if (lastPathSegment !== undefined) {
    return decodeUrlTitleSegment(lastPathSegment).replace(/\.[a-z0-9]+$/i, "");
  }

  return parsedUrl.hostname;
}

function decodeUrlTitleSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  return slug.length > 0 ? slug.slice(0, 64).replace(/_+$/g, "") : "source";
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function binaryWriteToCaptureError(error: BinaryWriteError): SourceCaptureError {
  return {
    code: error.code,
    message: error.message,
    path: error.path,
    hint: error.hint,
  };
}

function formatLogTitle(title: string): string {
  return title.replace(/\s+/g, " ").replaceAll("|", "/").trim();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
