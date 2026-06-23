import { isUtf8 } from "node:buffer";
import { cp, lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  LocalAgentExecutionError,
  runLocalAgentCommand,
  type LocalAgentCommandResult,
} from "./exec.js";
import {
  normalizeFileProposals,
  type FileProposal,
  type ProposalPolicy,
  type ProposalSet,
} from "../proposals/index.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import type { LocalAgentConfig } from "../runtime/config.js";

export type RunLocalAgentWorkspaceInput = {
  repoRoot: string;
  agent: LocalAgentConfig;
  taskPrompt: string;
  policy: ProposalPolicy;
  env?: NodeJS.ProcessEnv;
  outputLimitBytes?: number;
  platform?: NodeJS.Platform;
  timeoutKillGraceMs?: number;
};

export type LocalAgentWorkspaceResult = {
  execution: LocalAgentCommandResult;
  proposals: ProposalSet;
};

type SnapshotEntry =
  | {
    kind: "file";
    content: Buffer;
  }
  | {
    kind: "symlink" | "other";
  };

type WorkspaceSnapshot = Map<string, SnapshotEntry>;

const COPY_EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
const COPY_EXCLUDED_QUARTZ_PATHS = new Set([
  ".cache",
  ".quartz-cache",
  "cache",
  "dist",
  "node_modules",
  "public",
]);

export async function runLocalAgentInTemporaryWorkspace(
  input: RunLocalAgentWorkspaceInput,
): Promise<LocalAgentWorkspaceResult> {
  const repoRoot = await realpath(resolve(input.repoRoot));
  const tempParent = await mkdtemp(resolve(tmpdir(), "llm-wiki-agent-workspace-"));
  const tempRepoRoot = resolve(tempParent, "repo");

  let beforeSnapshot: WorkspaceSnapshot | null = null;
  try {
    await copyRepoForAgent(repoRoot, tempRepoRoot, input.policy);
    beforeSnapshot = await readWorkspaceSnapshot(tempRepoRoot);

    const execution = await runLocalAgentCommand({
      agent: input.agent,
      cwd: tempRepoRoot,
      taskPrompt: input.taskPrompt,
      changesObserved: false,
      env: input.env,
      outputLimitBytes: input.outputLimitBytes,
      platform: input.platform,
      timeoutKillGraceMs: input.timeoutKillGraceMs,
    });
    const proposals = await extractWorkspaceFileProposals(tempRepoRoot, beforeSnapshot, input.policy);

    return { execution, proposals };
  } catch (error) {
    if (error instanceof LocalAgentExecutionError && beforeSnapshot !== null) {
      const changesObserved = await hasWorkspaceChanges(tempRepoRoot, beforeSnapshot).catch(() => error.changesObserved);
      throw localAgentErrorWithObservedChanges(error, changesObserved);
    }

    throw error;
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
}

async function extractWorkspaceFileProposals(
  workspaceRoot: string,
  beforeSnapshot: WorkspaceSnapshot,
  policy: ProposalPolicy,
): Promise<ProposalSet> {
  const afterSnapshot = await readWorkspaceSnapshot(workspaceRoot);
  const proposalCandidates: FileProposal[] = [];
  const changedPaths = new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()]);

  for (const path of [...changedPaths].sort()) {
    const before = beforeSnapshot.get(path);
    const after = afterSnapshot.get(path);
    if (before !== undefined && after === undefined) {
      throw rejectedWorkspaceDiff(policy, path, `Agent workspace deleted a file: ${path}.`);
    }

    if (after === undefined || snapshotEntriesEqual(before, after)) {
      continue;
    }

    if (after.kind !== "file") {
      throw rejectedWorkspaceDiff(policy, path, `Agent workspace changed a non-regular file: ${path}.`);
    }

    if (before !== undefined && before.kind !== "file") {
      throw rejectedWorkspaceDiff(policy, path, `Agent workspace replaced a non-regular file: ${path}.`);
    }

    if (!isUtf8(after.content) || after.content.includes(0)) {
      throw rejectedWorkspaceDiff(policy, path, `Agent workspace changed a binary or non-UTF-8 file: ${path}.`);
    }

    proposalCandidates.push({
      path,
      content: after.content.toString("utf8"),
    });
  }

  return {
    files: normalizeFileProposals({ files: proposalCandidates }, policy),
  };
}

async function copyRepoForAgent(
  repoRoot: string,
  tempRepoRoot: string,
  policy: ProposalPolicy,
): Promise<void> {
  await cp(repoRoot, tempRepoRoot, {
    filter: async (source) => shouldCopySafeRepoPath(repoRoot, source, policy),
    preserveTimestamps: true,
    recursive: true,
    verbatimSymlinks: true,
  });
}

async function shouldCopySafeRepoPath(
  repoRoot: string,
  sourcePath: string,
  policy: ProposalPolicy,
): Promise<boolean> {
  if (!shouldCopyRepoPath(repoRoot, sourcePath)) {
    return false;
  }

  const pathStat = await lstat(sourcePath);
  if (pathStat.isSymbolicLink()) {
    const relativePath = relativePathFromRoot(repoRoot, sourcePath);
    throw rejectedWorkspaceSourceSymlink(policy, relativePath === "" ? "." : (relativePath ?? sourcePath));
  }

  return true;
}

function shouldCopyRepoPath(repoRoot: string, sourcePath: string): boolean {
  const path = relativePathFromRoot(repoRoot, sourcePath);
  if (path === null || path === "") {
    return true;
  }

  const segments = path.split("/");
  if (segments.some((segment) => COPY_EXCLUDED_DIRECTORY_NAMES.has(segment))) {
    return false;
  }

  return !(segments[0] === "quartz" && segments[1] !== undefined && COPY_EXCLUDED_QUARTZ_PATHS.has(segments[1]));
}

async function readWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  await readWorkspaceSnapshotDirectory(resolve(root), resolve(root), snapshot);

  return snapshot;
}

async function readWorkspaceSnapshotDirectory(
  root: string,
  directory: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const entries = await readdir(directory);
  for (const entry of entries.sort()) {
    const absolutePath = resolve(directory, entry);
    const pathStat = await lstat(absolutePath);
    const relativePath = relativePathFromRoot(root, absolutePath);
    if (relativePath === null || relativePath === "") {
      throw rejectedInternalPath(absolutePath);
    }

    if (pathStat.isDirectory()) {
      await readWorkspaceSnapshotDirectory(root, absolutePath, snapshot);
      continue;
    }

    if (pathStat.isFile()) {
      snapshot.set(relativePath, {
        kind: "file",
        content: await readFile(absolutePath),
      });
      continue;
    }

    snapshot.set(relativePath, { kind: pathStat.isSymbolicLink() ? "symlink" : "other" });
  }
}

async function hasWorkspaceChanges(
  workspaceRoot: string,
  beforeSnapshot: WorkspaceSnapshot,
): Promise<boolean> {
  const afterSnapshot = await readWorkspaceSnapshot(workspaceRoot);
  const changedPaths = new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()]);

  for (const path of changedPaths) {
    if (!snapshotEntriesEqual(beforeSnapshot.get(path), afterSnapshot.get(path))) {
      return true;
    }
  }

  return false;
}

function snapshotEntriesEqual(left: SnapshotEntry | undefined, right: SnapshotEntry | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind !== "file" || right.kind !== "file") {
    return true;
  }

  return left.content.equals(right.content);
}

function relativePathFromRoot(root: string, path: string): string | null {
  const relativePath = relative(root, path);
  if (relativePath === "") {
    return "";
  }

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }

  return sep === "/" ? relativePath : relativePath.split(sep).join("/");
}

function rejectedWorkspaceDiff(
  policy: ProposalPolicy,
  path: string,
  message: string,
): RuntimeCommandError {
  return new RuntimeCommandError({
    code: policy.rejectionCode,
    message,
    hint: "Agent workspace changes must be created or modified UTF-8 Markdown files allowed by the active proposal policy.",
    path,
  });
}

function rejectedWorkspaceSourceSymlink(policy: ProposalPolicy, path: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code: policy.rejectionCode,
    message: `Agent workspace source path must not be a symlink: ${path}.`,
    hint: "Replace the symlink with a regular file or directory before running the local agent.",
    path,
  });
}

function rejectedInternalPath(path: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "PROPOSAL_REJECTED",
    message: `Agent workspace path escaped the temporary repository: ${path}.`,
    hint: "Agent workspace changes must stay inside the temporary repository copy.",
    path,
  });
}

function localAgentErrorWithObservedChanges(
  error: LocalAgentExecutionError,
  changesObserved: boolean,
): LocalAgentExecutionError {
  if (error.changesObserved === changesObserved) {
    return error;
  }

  return new LocalAgentExecutionError({
    code: error.code,
    message: error.message,
    hint: error.hint,
    agentName: error.agentName,
    command: error.command,
    executablePath: error.executablePath,
    argsSummary: error.argsSummary,
    exitCode: error.exitCode,
    signal: error.signal,
    timedOut: error.timedOut,
    stderrTail: error.stderrTail,
    changesObserved,
  });
}
