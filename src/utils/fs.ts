import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";

import { err, ok, type Result } from "./result.js";

export type ScaffoldEntry = {
  path: string;
  content: string;
};

export type ScaffoldWriteOptions = {
  force: boolean;
};

export type ScaffoldWriteReport = {
  created: string[];
  overwritten: string[];
  skipped: string[];
};

export type BinaryWriteErrorCode =
  | "DESTINATION_EXISTS"
  | "DESTINATION_PARENT_UNSAFE"
  | "DESTINATION_PATH_UNSAFE";

export type BinaryWriteError = {
  code: BinaryWriteErrorCode;
  message: string;
  path: string;
  hint: string;
};

type TargetState =
  | { exists: false }
  | { exists: true; isDirectory: true; entries: string[] }
  | { exists: true; isDirectory: false };

export function resolveSafeTargetPath(targetPath: string): Result<string> {
  if (targetPath.trim() === "") {
    return err(new Error("unsafe target path: path must not be empty"));
  }

  if (targetPath.includes("\0")) {
    return err(new Error("unsafe target path: path must not contain null bytes"));
  }

  if (hasTraversalSegment(targetPath)) {
    return err(new Error(`unsafe target path: traversal segment is not allowed in ${targetPath}`));
  }

  return ok(resolve(targetPath));
}

export async function writeScaffold(
  targetPath: string,
  entries: readonly ScaffoldEntry[],
  options: ScaffoldWriteOptions,
): Promise<Result<ScaffoldWriteReport>> {
  const safeTarget = resolveSafeTargetPath(targetPath);
  if (!safeTarget.ok) {
    return safeTarget;
  }

  const orderedEntries = [...entries].sort((left, right) => comparePaths(left.path, right.path));
  const preflight = validateScaffoldEntries(safeTarget.value, orderedEntries);
  if (!preflight.ok) {
    return preflight;
  }

  const targetState = await readTargetState(safeTarget.value);
  if (!targetState.ok) {
    return targetState;
  }

  if (targetState.value.exists && !targetState.value.isDirectory) {
    return err(new Error(`target path exists and is not a directory: ${safeTarget.value}`));
  }

  if (targetState.value.exists && !options.force && targetState.value.entries.length > 0) {
    return err(new Error(`target directory is not empty; rerun with --force to update scaffold files`));
  }

  const report: ScaffoldWriteReport = {
    created: [],
    overwritten: [],
    skipped: [],
  };

  try {
    await mkdir(safeTarget.value, { recursive: true });
    const targetRealPath = await realpath(safeTarget.value);
    const writePreflight = await validateWritableScaffoldPaths(safeTarget.value, targetRealPath, orderedEntries);
    if (!writePreflight.ok) {
      return writePreflight;
    }

    for (const entry of orderedEntries) {
      const absolutePath = resolve(safeTarget.value, entry.path);
      const parentReady = await ensureSafeParentDirectory(safeTarget.value, targetRealPath, entry.path);
      if (!parentReady.ok) {
        return parentReady;
      }

      const existing = await readExistingFile(targetRealPath, entry.path, absolutePath);

      if (!existing.ok) {
        return existing;
      }

      if (existing.value.exists && existing.value.content === entry.content) {
        report.skipped.push(entry.path);
        continue;
      }

      if (existing.value.exists && !options.force) {
        return err(new Error(`scaffold path already exists; rerun with --force to overwrite: ${entry.path}`));
      }

      await writeFileNoFollow(absolutePath, entry.content, existing.value.exists);

      if (existing.value.exists) {
        report.overwritten.push(entry.path);
      } else {
        report.created.push(entry.path);
      }
    }
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }

  return ok(report);
}

export async function writeBinaryFileNoOverwriteInsideRoot(
  rootDir: string,
  relativePath: string,
  content: Uint8Array,
): Promise<Result<void, BinaryWriteError>> {
  const normalizedPath = normalizeContainedRelativePath(relativePath);
  if (!normalizedPath.ok) {
    return normalizedPath;
  }

  const rootPath = resolve(rootDir);
  const absolutePath = resolve(rootPath, normalizedPath.value);
  const relativeToRoot = relative(rootPath, absolutePath);
  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    return err(destinationPathUnsafe(relativePath));
  }

  try {
    const rootRealPath = await realpath(rootPath);
    const parentReady = await ensureContainedParentDirectory(rootPath, rootRealPath, normalizedPath.value);
    if (!parentReady.ok) {
      return parentReady;
    }

    const destinationState = await readDestinationState(rootRealPath, normalizedPath.value, absolutePath);
    if (!destinationState.ok) {
      return destinationState;
    }

    const file = await open(
      absolutePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o666,
    );

    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return err(destinationExists(normalizedPath.value));
    }

    return err({
      code: "DESTINATION_PARENT_UNSAFE",
      message: error instanceof Error ? error.message : String(error),
      path: normalizedPath.value,
      hint: "Capture writes must stay inside the wiki repository and must not follow symlinks.",
    });
  }

  return ok(undefined);
}

export async function writeTextFileInsideRoot(
  rootDir: string,
  relativePath: string,
  content: string,
): Promise<Result<void, BinaryWriteError>> {
  const normalizedPath = normalizeContainedRelativePath(relativePath);
  if (!normalizedPath.ok) {
    return normalizedPath;
  }

  const rootPath = resolve(rootDir);
  const absolutePath = resolve(rootPath, normalizedPath.value);
  const relativeToRoot = relative(rootPath, absolutePath);
  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    return err(destinationPathUnsafe(relativePath));
  }

  try {
    const rootRealPath = await realpath(rootPath);
    const parentReady = await ensureContainedParentDirectory(rootPath, rootRealPath, normalizedPath.value);
    if (!parentReady.ok) {
      return parentReady;
    }

    const destinationReady = await readAppendDestinationState(rootRealPath, normalizedPath.value, absolutePath);
    if (!destinationReady.ok) {
      return destinationReady;
    }

    const file = await open(absolutePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o666);
    try {
      await file.writeFile(content, "utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    return err({
      code: "DESTINATION_PARENT_UNSAFE",
      message: error instanceof Error ? error.message : String(error),
      path: normalizedPath.value,
      hint: "Capture writes must stay inside the wiki repository and must not follow symlinks.",
    });
  }

  return ok(undefined);
}

export async function validateTextFileWriteInsideRoot(
  rootDir: string,
  relativePath: string,
): Promise<Result<void, BinaryWriteError>> {
  const target = await validateContainedWriteTarget(rootDir, relativePath);
  if (!target.ok) {
    return target;
  }

  if (!target.value.parentExists) {
    return ok(undefined);
  }

  return readAppendDestinationState(target.value.rootRealPath, target.value.normalizedPath, target.value.absolutePath);
}

export async function validateBinaryFileNoOverwriteInsideRoot(
  rootDir: string,
  relativePath: string,
): Promise<Result<void, BinaryWriteError>> {
  const target = await validateContainedWriteTarget(rootDir, relativePath);
  if (!target.ok) {
    return target;
  }

  if (!target.value.parentExists) {
    return ok(undefined);
  }

  return readDestinationState(target.value.rootRealPath, target.value.normalizedPath, target.value.absolutePath);
}

export async function validateAppendFileInsideRoot(
  rootDir: string,
  relativePath: string,
): Promise<Result<void, BinaryWriteError>> {
  const target = await validateContainedWriteTarget(rootDir, relativePath);
  if (!target.ok) {
    return target;
  }

  if (!target.value.parentExists) {
    return err(
      destinationParentUnsafe(
        target.value.normalizedPath,
        `destination parent does not exist: ${target.value.parentRelativePath}`,
      ),
    );
  }

  return readAppendDestinationState(target.value.rootRealPath, target.value.normalizedPath, target.value.absolutePath);
}

export async function validateReadFileInsideRoot(
  rootDir: string,
  relativePath: string,
): Promise<Result<{ absolutePath: string }, BinaryWriteError>> {
  const target = await validateContainedWriteTarget(rootDir, relativePath);
  if (!target.ok) {
    return target;
  }

  if (!target.value.parentExists) {
    return err(
      destinationParentUnsafe(
        target.value.normalizedPath,
        `destination parent does not exist: ${target.value.parentRelativePath}`,
      ),
    );
  }

  const fileState = await readExistingContainedFileState(
    target.value.rootRealPath,
    target.value.normalizedPath,
    target.value.absolutePath,
  );
  if (!fileState.ok) {
    return fileState;
  }

  return ok({ absolutePath: target.value.absolutePath });
}

async function validateWritableScaffoldPaths(
  rootPath: string,
  rootRealPath: string,
  entries: readonly ScaffoldEntry[],
): Promise<Result<void>> {
  for (const entry of entries) {
    const validation = await validateExistingScaffoldPath(rootPath, rootRealPath, entry.path);
    if (!validation.ok) {
      return validation;
    }
  }

  return ok(undefined);
}

function validateScaffoldEntries(rootPath: string, entries: readonly ScaffoldEntry[]): Result<void> {
  const seen = new Set<string>();
  const plannedPaths: Array<{ entryPath: string; normalizedPath: string }> = [];

  for (const entry of entries) {
    const pathError = validateScaffoldPath(entry.path);
    if (pathError) {
      return err(new Error(pathError));
    }

    const normalizedPath = normalizeScaffoldPath(entry.path);
    const absolutePath = resolve(rootPath, normalizedPath);
    const relativePath = relative(rootPath, absolutePath);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return err(new Error(`unsafe scaffold path escapes target directory: ${entry.path}`));
    }

    if (seen.has(normalizedPath)) {
      return err(new Error(`duplicate scaffold path after normalization: ${entry.path}`));
    }
    seen.add(normalizedPath);
    plannedPaths.push({ entryPath: entry.path, normalizedPath });
  }

  for (const plannedPath of plannedPaths) {
    const segments = plannedPath.normalizedPath.split("/");

    for (let segmentCount = 1; segmentCount < segments.length; segmentCount += 1) {
      const parentPath = segments.slice(0, segmentCount).join("/");
      if (seen.has(parentPath)) {
        return err(new Error(`scaffold path collision: ${parentPath} cannot also be a parent of ${plannedPath.entryPath}`));
      }
    }
  }

  return ok(undefined);
}

function normalizeContainedRelativePath(path: string): Result<string, BinaryWriteError> {
  if (path.trim() === "") {
    return err(destinationPathUnsafe(path));
  }

  if (path.includes("\0")) {
    return err(destinationPathUnsafe(path));
  }

  if (isAbsolute(path)) {
    return err(destinationPathUnsafe(path));
  }

  if (path.includes("\\")) {
    return err(destinationPathUnsafe(path));
  }

  if (hasTraversalSegment(path)) {
    return err(destinationPathUnsafe(path));
  }

  return ok(posix.normalize(path).replace(/\/+$/, ""));
}

async function ensureContainedParentDirectory(
  rootPath: string,
  rootRealPath: string,
  relativePath: string,
): Promise<Result<void, BinaryWriteError>> {
  const segments = relativePath.split("/").slice(0, -1);
  let currentPath = rootPath;
  let currentRelativePath = "";

  for (const segment of segments) {
    currentRelativePath = currentRelativePath === "" ? segment : `${currentRelativePath}/${segment}`;
    currentPath = resolve(currentPath, segment);

    const relativeToRoot = relative(rootPath, currentPath);
    if (relativeToRoot === "" || relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
      return err(destinationPathUnsafe(relativePath));
    }

    const existingParent = await readParentDirectoryState(rootRealPath, currentRelativePath, currentPath);
    if (!existingParent.ok) {
      if (existingParent.error.code !== "DESTINATION_PARENT_UNSAFE") {
        return existingParent;
      }

      try {
        await mkdir(currentPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          return err(destinationParentUnsafe(relativePath, error instanceof Error ? error.message : String(error)));
        }
      }

      const createdParent = await readParentDirectoryState(rootRealPath, currentRelativePath, currentPath);
      if (!createdParent.ok) {
        return createdParent;
      }
    }
  }

  return ok(undefined);
}

async function readParentDirectoryState(
  rootRealPath: string,
  relativePath: string,
  absolutePath: string,
): Promise<Result<void, BinaryWriteError>> {
  try {
    const pathStat = await lstat(absolutePath);
    if (pathStat.isSymbolicLink()) {
      return err(destinationParentUnsafe(relativePath, `destination parent is a symlink: ${relativePath}`));
    }

    if (!pathStat.isDirectory()) {
      return err(destinationParentUnsafe(relativePath, `destination parent is not a directory: ${relativePath}`));
    }

    const resolvedPath = await realpath(absolutePath);
    if (!isInsideRealPath(rootRealPath, resolvedPath)) {
      return err(destinationPathUnsafe(relativePath));
    }

    return ok(undefined);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return err(destinationParentUnsafe(relativePath, `destination parent does not exist: ${relativePath}`));
    }

    return err(destinationParentUnsafe(relativePath, error instanceof Error ? error.message : String(error)));
  }
}

async function readDestinationState(
  rootRealPath: string,
  relativePath: string,
  absolutePath: string,
): Promise<Result<void, BinaryWriteError>> {
  try {
    const resolvedParentPath = await realpath(dirname(absolutePath));
    if (!isInsideRealPath(rootRealPath, resolvedParentPath)) {
      return err(destinationPathUnsafe(relativePath));
    }
  } catch (error) {
    return err(destinationParentUnsafe(relativePath, error instanceof Error ? error.message : String(error)));
  }

  try {
    const pathStat = await lstat(absolutePath);
    if (pathStat.isSymbolicLink() || pathStat.isFile() || pathStat.isDirectory()) {
      return err(destinationExists(relativePath));
    }

    return err(destinationExists(relativePath));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return ok(undefined);
    }

    return err(destinationParentUnsafe(relativePath, error instanceof Error ? error.message : String(error)));
  }
}

type ContainedWriteTarget = {
  rootRealPath: string;
  normalizedPath: string;
  absolutePath: string;
  parentExists: boolean;
  parentRelativePath: string;
};

async function validateContainedWriteTarget(
  rootDir: string,
  relativePath: string,
): Promise<Result<ContainedWriteTarget, BinaryWriteError>> {
  const normalizedPath = normalizeContainedRelativePath(relativePath);
  if (!normalizedPath.ok) {
    return normalizedPath;
  }

  const rootPath = resolve(rootDir);
  const absolutePath = resolve(rootPath, normalizedPath.value);
  const relativeToRoot = relative(rootPath, absolutePath);
  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    return err(destinationPathUnsafe(relativePath));
  }

  try {
    const rootRealPath = await realpath(rootPath);
    const parentState = await validateContainedParentDirectoryPlan(rootPath, rootRealPath, normalizedPath.value);
    if (!parentState.ok) {
      return parentState;
    }

    return ok({
      rootRealPath,
      normalizedPath: normalizedPath.value,
      absolutePath,
      parentExists: parentState.value.exists,
      parentRelativePath: parentState.value.relativePath,
    });
  } catch (error) {
    return err(destinationParentUnsafe(normalizedPath.value, error instanceof Error ? error.message : String(error)));
  }
}

async function validateContainedParentDirectoryPlan(
  rootPath: string,
  rootRealPath: string,
  relativePath: string,
): Promise<Result<{ exists: boolean; relativePath: string }, BinaryWriteError>> {
  const segments = relativePath.split("/").slice(0, -1);
  let currentPath = rootPath;
  let currentRelativePath = "";
  let parentExists = true;

  for (const segment of segments) {
    currentRelativePath = currentRelativePath === "" ? segment : `${currentRelativePath}/${segment}`;
    currentPath = resolve(currentPath, segment);

    const relativeToRoot = relative(rootPath, currentPath);
    if (relativeToRoot === "" || relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
      return err(destinationPathUnsafe(relativePath));
    }

    if (!parentExists) {
      continue;
    }

    try {
      const pathStat = await lstat(currentPath);
      if (pathStat.isSymbolicLink()) {
        return err(destinationParentUnsafe(currentRelativePath, `destination parent is a symlink: ${currentRelativePath}`));
      }

      if (!pathStat.isDirectory()) {
        return err(
          destinationParentUnsafe(currentRelativePath, `destination parent is not a directory: ${currentRelativePath}`),
        );
      }

      const resolvedPath = await realpath(currentPath);
      if (!isInsideRealPath(rootRealPath, resolvedPath)) {
        return err(destinationPathUnsafe(currentRelativePath));
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        parentExists = false;
        continue;
      }

      return err(destinationParentUnsafe(currentRelativePath, error instanceof Error ? error.message : String(error)));
    }
  }

  return ok({ exists: parentExists, relativePath: currentRelativePath || "." });
}

async function readAppendDestinationState(
  rootRealPath: string,
  relativePath: string,
  absolutePath: string,
): Promise<Result<void, BinaryWriteError>> {
  try {
    const pathStat = await lstat(absolutePath);
    if (pathStat.isSymbolicLink()) {
      return err(destinationParentUnsafe(relativePath, `destination file is a symlink: ${relativePath}`));
    }

    if (!pathStat.isFile()) {
      return err(destinationParentUnsafe(relativePath, `destination is not a regular file: ${relativePath}`));
    }

    const resolvedPath = await realpath(absolutePath);
    if (!isInsideRealPath(rootRealPath, resolvedPath)) {
      return err(destinationPathUnsafe(relativePath));
    }

    return ok(undefined);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return ok(undefined);
    }

    return err(destinationParentUnsafe(relativePath, error instanceof Error ? error.message : String(error)));
  }
}

async function readExistingContainedFileState(
  rootRealPath: string,
  relativePath: string,
  absolutePath: string,
): Promise<Result<void, BinaryWriteError>> {
  try {
    const pathStat = await lstat(absolutePath);
    if (pathStat.isSymbolicLink()) {
      return err(destinationParentUnsafe(relativePath, `destination file is a symlink: ${relativePath}`));
    }

    if (!pathStat.isFile()) {
      return err(destinationParentUnsafe(relativePath, `destination is not a regular file: ${relativePath}`));
    }

    const resolvedPath = await realpath(absolutePath);
    if (!isInsideRealPath(rootRealPath, resolvedPath)) {
      return err(destinationPathUnsafe(relativePath));
    }

    return ok(undefined);
  } catch (error) {
    return err(destinationParentUnsafe(relativePath, error instanceof Error ? error.message : String(error)));
  }
}

function destinationPathUnsafe(path: string): BinaryWriteError {
  return {
    code: "DESTINATION_PATH_UNSAFE",
    message: `Destination path must be a relative path inside the wiki repository: ${path}`,
    path,
    hint: "Use a normalized relative path without traversal segments.",
  };
}

function destinationExists(path: string): BinaryWriteError {
  return {
    code: "DESTINATION_EXISTS",
    message: `Capture destination already exists and will not be overwritten: ${path}`,
    path,
    hint: "Raw originals are immutable; choose a new source ID or inspect the existing capture.",
  };
}

function destinationParentUnsafe(path: string, message: string): BinaryWriteError {
  return {
    code: "DESTINATION_PARENT_UNSAFE",
    message,
    path,
    hint: "Capture writes must stay inside the wiki repository and must not follow symlinks.",
  };
}

function normalizeScaffoldPath(path: string): string {
  return posix.normalize(path).replace(/\/+$/, "");
}

function validateScaffoldPath(path: string): string | undefined {
  if (path.trim() === "") {
    return "unsafe scaffold path: path must not be empty";
  }

  if (path.includes("\0")) {
    return `unsafe scaffold path contains null bytes: ${path}`;
  }

  if (isAbsolute(path)) {
    return `unsafe scaffold path must be relative: ${path}`;
  }

  if (path.includes("\\")) {
    return `unsafe scaffold path must use forward slashes: ${path}`;
  }

  if (hasTraversalSegment(path)) {
    return `unsafe scaffold path contains traversal segment: ${path}`;
  }

  return undefined;
}

function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

async function readTargetState(path: string): Promise<Result<TargetState>> {
  try {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink()) {
      return err(new Error(`target path must not be a symlink: ${path}`));
    }

    if (!pathStat.isDirectory()) {
      return ok({ exists: true, isDirectory: false });
    }

    return ok({ exists: true, isDirectory: true, entries: await readdir(path) });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return ok({ exists: false });
    }

    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

async function validateExistingScaffoldPath(
  rootPath: string,
  rootRealPath: string,
  entryPath: string,
): Promise<Result<void>> {
  const segments = entryPath.split("/");
  let currentPath = rootPath;

  for (let index = 0; index < segments.length; index += 1) {
    currentPath = resolve(currentPath, segments[index]);

    try {
      const pathStat = await lstat(currentPath);
      if (pathStat.isSymbolicLink()) {
        return err(new Error(`unsafe scaffold path includes symlink: ${entryPath}`));
      }

      if (index < segments.length - 1 && !pathStat.isDirectory()) {
        return err(new Error(`cannot create scaffold directory over non-directory path: ${currentPath}`));
      }

      if (index === segments.length - 1 && !pathStat.isFile()) {
        return err(new Error(`cannot write scaffold file over non-file path: ${currentPath}`));
      }

      const resolvedPath = await realpath(currentPath);
      if (!isInsideRealPath(rootRealPath, resolvedPath)) {
        return err(new Error(`unsafe scaffold path resolves outside target directory: ${entryPath}`));
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return ok(undefined);
      }

      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return ok(undefined);
}

async function ensureSafeParentDirectory(
  rootPath: string,
  rootRealPath: string,
  entryPath: string,
): Promise<Result<void>> {
  const absolutePath = resolve(rootPath, entryPath);
  await mkdir(dirname(absolutePath), { recursive: true });

  const segments = entryPath.split("/").slice(0, -1);
  let currentPath = rootPath;

  for (const segment of segments) {
    currentPath = resolve(currentPath, segment);

    try {
      const pathStat = await lstat(currentPath);
      if (pathStat.isSymbolicLink()) {
        return err(new Error(`unsafe scaffold path includes symlink: ${entryPath}`));
      }

      if (!pathStat.isDirectory()) {
        return err(new Error(`cannot create scaffold directory over non-directory path: ${currentPath}`));
      }

      const resolvedPath = await realpath(currentPath);
      if (!isInsideRealPath(rootRealPath, resolvedPath)) {
        return err(new Error(`unsafe scaffold path resolves outside target directory: ${entryPath}`));
      }
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return ok(undefined);
}

async function readExistingFile(
  rootRealPath: string,
  entryPath: string,
  path: string,
): Promise<Result<{ exists: false } | { exists: true; content: string }>> {
  try {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink()) {
      return err(new Error(`unsafe scaffold path includes symlink: ${entryPath}`));
    }

    if (!pathStat.isFile()) {
      return err(new Error(`cannot write scaffold file over non-file path: ${path}`));
    }

    const resolvedPath = await realpath(path);
    if (!isInsideRealPath(rootRealPath, resolvedPath)) {
      return err(new Error(`unsafe scaffold path resolves outside target directory: ${entryPath}`));
    }

    return ok({ exists: true, content: await readFile(path, "utf8") });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return ok({ exists: false });
    }

    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

async function writeFileNoFollow(path: string, content: string, exists: boolean): Promise<void> {
  const flags = exists
    ? constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const file = await open(path, flags, 0o666);

  try {
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
}

function isInsideRealPath(rootRealPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootRealPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function comparePaths(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
