import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { relative, resolve } from "node:path";

export type FileTreeSnapshotEntry =
  | { kind: "directory"; mode: number }
  | { kind: "file"; mode: number; hash: string; bytes: number }
  | { kind: "symlink"; target: string }
  | { kind: "other"; mode: number };

export type FileTreeSnapshot = Map<string, FileTreeSnapshotEntry>;

export async function readFileTreeSnapshot(root: string): Promise<FileTreeSnapshot> {
  const entries: FileTreeSnapshot = new Map();

  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = resolve(directory, name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        entries.set(path, { kind: "directory", mode: stat.mode });
        await visit(absolute);
      } else if (stat.isFile()) {
        const content = await readFile(absolute);
        entries.set(path, {
          kind: "file",
          mode: stat.mode,
          hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          bytes: content.length,
        });
      } else if (stat.isSymbolicLink()) {
        entries.set(path, { kind: "symlink", target: await readlink(absolute) });
      } else {
        entries.set(path, { kind: "other", mode: stat.mode });
      }
    }
  }

  await visit(root);
  return entries;
}

export function firstChangedFileTreePath(
  before: FileTreeSnapshot,
  after: FileTreeSnapshot,
  ignoredPaths: ReadonlySet<string> = new Set(),
): string | null {
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    if (ignoredPaths.has(path)) {
      continue;
    }
    if (!fileTreeEntriesEqual(before.get(path), after.get(path))) {
      return path;
    }
  }
  return null;
}

function fileTreeEntriesEqual(
  left: FileTreeSnapshotEntry | undefined,
  right: FileTreeSnapshotEntry | undefined,
): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind) {
    return left === right;
  }
  if (left.kind === "directory" && right.kind === "directory") {
    return left.mode === right.mode;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.mode === right.mode && left.hash === right.hash && left.bytes === right.bytes;
  }
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  return left.kind === "other" && right.kind === "other" && left.mode === right.mode;
}
