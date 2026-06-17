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
