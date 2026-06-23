import { cp, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix, relative, resolve } from "node:path";

import { RuntimeCommandError } from "../runtime/errors.js";
import {
  readTextFileInsideRoot,
  validateTextFileWriteInsideRoot,
  writeTextFileInsideRoot,
} from "../utils/fs.js";

export type FileProposal = {
  path: string;
  content: string;
};

export type ProposalSet = {
  files: FileProposal[];
};

export type NormalizedFileProposal = FileProposal;

export type ProposalPathRejection = {
  message: string;
  hint: string;
  path?: string;
};

export type ProposalPolicy = {
  rejectionCode: string;
  writeFailedCode: string;
  rejectedPathHint: string;
  duplicatePathHint: string;
  writeRejectedHint: string;
  writeFailedHint: string;
  pathRejectedMessage: (path: string) => string;
  duplicatePathMessage: (path: string) => string;
  allowPath: (normalizedPath: string, originalPath: string) => ProposalPathRejection | null;
};

export type ProposalPolicyOptions = Partial<
  Pick<
    ProposalPolicy,
    | "rejectionCode"
    | "writeFailedCode"
    | "rejectedPathHint"
    | "duplicatePathHint"
    | "writeRejectedHint"
    | "writeFailedHint"
    | "pathRejectedMessage"
    | "duplicatePathMessage"
  >
>;

export type QueryProposalPolicyOptions = ProposalPolicyOptions & {
  sourceSummaryRejectedMessage?: (path: string) => string;
  sourceSummaryRejectedHint?: string;
  unexpectedPathRejectedMessage?: (path: string) => string;
  unexpectedPathRejectedHint?: (savePath: string) => string;
};

type ProposalSnapshot = {
  path: string;
  content: string | null;
};

const RUNTIME_LOG_PATH = "curated/log.md";

const DEFAULT_REJECTION_CODE = "PROPOSAL_REJECTED";
const DEFAULT_WRITE_FAILED_CODE = "PROPOSAL_WRITE_FAILED";
const DEFAULT_REJECTED_PATH_HINT = "File proposals must target allowed Markdown files.";
const DEFAULT_DUPLICATE_PATH_HINT = "Return one file proposal per path.";
const DEFAULT_WRITE_REJECTED_HINT = "File proposals must target safe Markdown files inside the repository.";
const DEFAULT_WRITE_FAILED_HINT = "Fix filesystem permissions or unsafe proposal paths, then rerun.";

export function createIngestProposalPolicy(options: ProposalPolicyOptions = {}): ProposalPolicy {
  return createBasePolicy(
    (normalizedPath) => isAllowedIngestProposalPath(normalizedPath),
    options,
  );
}

export function createQueryProposalPolicy(
  savePath: string,
  options: QueryProposalPolicyOptions = {},
): ProposalPolicy {
  const normalizedSavePath = normalizeProposalPath(savePath) ?? savePath;
  const allowedPaths = new Set([normalizedSavePath, "curated/index.md", RUNTIME_LOG_PATH]);
  const basePolicy = createBasePolicy(
    (normalizedPath) => normalizedPath.startsWith("curated/") && normalizedPath.endsWith(".md"),
    options,
  );

  return {
    ...basePolicy,
    allowPath: (normalizedPath, originalPath) => {
      const baseRejection = basePolicy.allowPath(normalizedPath, originalPath);
      if (baseRejection !== null) {
        return baseRejection;
      }

      if (allowedPaths.has(normalizedPath)) {
        return null;
      }

      if (isSourceSummaryPath(normalizedPath)) {
        return {
          message: options.sourceSummaryRejectedMessage?.(normalizedPath)
            ?? `Query proposals cannot create or modify source summaries: ${normalizedPath}.`,
          hint: options.sourceSummaryRejectedHint
            ?? "Query mode may cite only source summaries that existed before the proposal.",
          path: normalizedPath,
        };
      }

      return {
        message: options.unexpectedPathRejectedMessage?.(normalizedPath)
          ?? `Query proposal path is not an expected saved-query output: ${normalizedPath}.`,
        hint: options.unexpectedPathRejectedHint?.(normalizedSavePath)
          ?? `Query mode may only write ${normalizedSavePath}, curated/index.md, and curated/log.md.`,
        path: normalizedPath,
      };
    },
  };
}

export function normalizeFileProposals(
  proposals: ProposalSet,
  policy: ProposalPolicy,
): NormalizedFileProposal[] {
  const seen = new Set<string>();
  const normalized: NormalizedFileProposal[] = [];

  for (const proposal of proposals.files) {
    const path = normalizeProposalPath(proposal.path);
    if (path === null) {
      throw proposalRejected(policy, {
        message: policy.pathRejectedMessage(proposal.path),
        hint: policy.rejectedPathHint,
        path: proposal.path,
      });
    }

    const pathRejection = policy.allowPath(path, proposal.path);
    if (pathRejection !== null) {
      throw proposalRejected(policy, pathRejection);
    }

    if (seen.has(path)) {
      throw new RuntimeCommandError({
        code: policy.rejectionCode,
        message: policy.duplicatePathMessage(path),
        hint: policy.duplicatePathHint,
        path,
      });
    }

    seen.add(path);
    normalized.push({ path, content: proposal.content });
  }

  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

export async function validateProposalsOnTemporaryRepo(
  repoRoot: string,
  proposals: ProposalSet,
  policy: ProposalPolicy,
  validate: (tempRepoRoot: string) => Promise<void>,
): Promise<void> {
  const tempParent = await mkdtemp(resolve(tmpdir(), "llm-wiki-proposals-"));
  const tempRepoRoot = resolve(tempParent, "repo");

  try {
    await cp(repoRoot, tempRepoRoot, {
      filter: (source) => !isRootGitMetadataPath(repoRoot, source),
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    await applyProposals(tempRepoRoot, proposals, policy);
    await validate(tempRepoRoot);
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
}

export async function applyProposals(
  repoRoot: string,
  proposals: ProposalSet,
  policy: ProposalPolicy,
): Promise<string[]> {
  const result = await applyProposalsWithValidation(repoRoot, proposals, policy, async () => undefined);

  return result.appliedPaths;
}

export async function applyProposalsWithValidation<ValidationResult>(
  repoRoot: string,
  proposals: ProposalSet,
  policy: ProposalPolicy,
  validate: () => Promise<ValidationResult>,
): Promise<{ appliedPaths: string[]; validation: ValidationResult }> {
  const normalizedProposals = normalizeFileProposals(proposals, policy);
  const snapshots: ProposalSnapshot[] = [];

  for (const proposal of normalizedProposals) {
    const writeTarget = await validateTextFileWriteInsideRoot(repoRoot, proposal.path);
    if (!writeTarget.ok) {
      throw new RuntimeCommandError({
        code: policy.rejectionCode,
        message: writeTarget.error.message,
        hint: policy.writeRejectedHint,
        path: writeTarget.error.path,
      });
    }
  }

  for (const proposal of normalizedProposals) {
    snapshots.push(await readProposalSnapshot(repoRoot, proposal.path, policy));
  }

  const writtenPaths: string[] = [];
  try {
    const snapshotByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot.content]));
    for (const proposal of normalizedProposals) {
      const write = await writeTextFileInsideRoot(
        repoRoot,
        proposal.path,
        proposalWriteContent(proposal, snapshotByPath.get(proposal.path) ?? null),
      );
      if (!write.ok) {
        throw new RuntimeCommandError({
          code: policy.writeFailedCode,
          message: write.error.message,
          hint: policy.writeFailedHint,
          path: write.error.path,
        });
      }

      writtenPaths.push(proposal.path);
    }

    const validation = await validate();

    return {
      appliedPaths: writtenPaths.sort(),
      validation,
    };
  } catch (error) {
    await rollbackProposalWrites(repoRoot, snapshots);
    throw error;
  }
}

function createBasePolicy(
  allowPath: (normalizedPath: string) => boolean,
  options: ProposalPolicyOptions,
): ProposalPolicy {
  return {
    rejectionCode: options.rejectionCode ?? DEFAULT_REJECTION_CODE,
    writeFailedCode: options.writeFailedCode ?? DEFAULT_WRITE_FAILED_CODE,
    rejectedPathHint: options.rejectedPathHint ?? DEFAULT_REJECTED_PATH_HINT,
    duplicatePathHint: options.duplicatePathHint ?? DEFAULT_DUPLICATE_PATH_HINT,
    writeRejectedHint: options.writeRejectedHint ?? DEFAULT_WRITE_REJECTED_HINT,
    writeFailedHint: options.writeFailedHint ?? DEFAULT_WRITE_FAILED_HINT,
    pathRejectedMessage: options.pathRejectedMessage ?? ((path) => `Proposal path is not allowed: ${path}.`),
    duplicatePathMessage: options.duplicatePathMessage ?? ((path) => `Proposed the same path more than once: ${path}.`),
    allowPath: (normalizedPath, originalPath) => {
      if (allowPath(normalizedPath) && !normalizedPath.split("/").includes(".git")) {
        return null;
      }

      return {
        message: options.pathRejectedMessage?.(originalPath) ?? `Proposal path is not allowed: ${originalPath}.`,
        hint: options.rejectedPathHint ?? DEFAULT_REJECTED_PATH_HINT,
        path: originalPath,
      };
    },
  };
}

function normalizeProposalPath(path: string): string | null {
  if (path.trim() === "" || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    return null;
  }

  const segments = path.split("/");
  if (segments.includes("..")) {
    return null;
  }

  return posix.normalize(path).replace(/\/+$/, "");
}

function isAllowedIngestProposalPath(path: string): boolean {
  return path.startsWith("curated/") && path.endsWith(".md");
}

function isSourceSummaryPath(path: string): boolean {
  return /^curated\/sources\/[^/]+\.md$/.test(path);
}

function isRootGitMetadataPath(repoRoot: string, sourcePath: string): boolean {
  const path = relative(repoRoot, sourcePath).replaceAll("\\", "/");
  return path === ".git" || path.startsWith(".git/");
}

function proposalRejected(policy: ProposalPolicy, rejection: ProposalPathRejection): RuntimeCommandError {
  return new RuntimeCommandError({
    code: policy.rejectionCode,
    message: rejection.message,
    hint: rejection.hint,
    path: rejection.path ?? ".",
  });
}

function proposalWriteContent(proposal: FileProposal, existingContent: string | null): string {
  if (proposal.path !== RUNTIME_LOG_PATH || existingContent === null) {
    return proposal.content;
  }

  return appendLogProposal(existingContent, proposal.content);
}

function appendLogProposal(existingContent: string, proposedContent: string): string {
  const normalizedExisting = normalizeMarkdownNewlines(existingContent).trim();
  const normalizedProposed = normalizeMarkdownNewlines(proposedContent).trim();
  if (normalizedExisting !== "" && normalizedProposed.startsWith(normalizedExisting)) {
    return proposedContent;
  }

  const proposedAppend = stripLogTitle(proposedContent).trimStart();
  if (proposedAppend === "") {
    return existingContent;
  }

  const existingWithNewline = existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
  const separator = existingWithNewline.endsWith("\n\n") ? "" : "\n";

  return `${existingWithNewline}${separator}${proposedAppend}`;
}

async function readProposalSnapshot(
  repoRoot: string,
  path: string,
  policy: ProposalPolicy,
): Promise<ProposalSnapshot> {
  const existing = await readTextFileInsideRoot(repoRoot, path);
  if (existing.ok) {
    return {
      path,
      content: existing.value,
    };
  }

  if (!(await proposalTargetExists(repoRoot, path))) {
    return {
      path,
      content: null,
    };
  }

  throw new RuntimeCommandError({
    code: policy.writeFailedCode,
    message: `Could not snapshot existing proposal target before writing: ${existing.error.message}`,
    hint: policy.writeFailedHint,
    path: existing.error.path,
  });
}

async function proposalTargetExists(repoRoot: string, path: string): Promise<boolean> {
  try {
    await lstat(resolve(repoRoot, path));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    return true;
  }
}

function stripLogTitle(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/^# Log[ \t]*\n+/, "");
}

function normalizeMarkdownNewlines(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

async function rollbackProposalWrites(repoRoot: string, snapshots: ProposalSnapshot[]): Promise<void> {
  for (const snapshot of snapshots.reverse()) {
    if (snapshot.content === null) {
      await rm(resolve(repoRoot, snapshot.path), { force: true }).catch(() => undefined);
      continue;
    }

    await writeTextFileInsideRoot(repoRoot, snapshot.path, snapshot.content);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
