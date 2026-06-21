import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { showQueueSource, type QueueStatus } from "../runtime/queue.js";
import { parseSourceId } from "../scanner/index.js";
import { scanWikiRepository, type RepoMarkdownFile, type RepoScan, type SourceCard } from "../scanner/repo.js";
import { listGitChangedFiles } from "../utils/git.js";

export type IngestValidationSeverity = "error";

export type IngestValidationIssue = {
  rule_id: string;
  severity: IngestValidationSeverity;
  path: string;
  message: string;
  fix_hint: string;
};

export type IngestValidationResult = {
  source_id: string;
  passed: boolean;
  issues: IngestValidationIssue[];
  checked_paths: string[];
};

type NoGitValidationWindow = {
  start: string;
  end?: string;
};

export async function validateIngestReadiness(repoRoot: string, sourceId: string): Promise<IngestValidationResult> {
  const queueSource = await showQueueSource(repoRoot, sourceId);
  if (!queueSource.ok) {
    const issue = {
      rule_id: "ingest_queue_source_invalid",
      severity: "error" as const,
      path: queueSource.error.path,
      message: queueSource.error.message,
      fix_hint: queueSource.error.hint,
    };

    return {
      source_id: sourceId,
      passed: false,
      issues: [issue],
      checked_paths: [queueSource.error.path],
    };
  }

  const scan = await scanWikiRepository(repoRoot);
  const summaryPath = `curated/sources/${sourceId}.md`;
  const sourceSummary = scan.curatedPages.find((page) => page.path === summaryPath) ?? null;
  const issues: IngestValidationIssue[] = [];

  if (sourceSummary === null) {
    issues.push({
      rule_id: "ingest_source_summary_missing",
      severity: "error",
      path: summaryPath,
      message: `Ingested source summary is missing for ${sourceId}.`,
      fix_hint: `Create ${summaryPath} before validating ingest.`,
    });
  }

  const indexPage = scan.curatedPages.find((page) => page.path === "curated/index.md") ?? null;
  if (indexPage === null || !indexMentionsSourceSummary(indexPage, sourceId)) {
    issues.push({
      rule_id: "ingest_index_missing",
      severity: "error",
      path: "curated/index.md",
      message: `curated/index.md does not reference the source summary for ${sourceId}.`,
      fix_hint: `Update curated/index.md with a link to sources/${sourceId}.`,
    });
  }

  if (!hasAgentIngestLogEntry(scan, sourceId, summaryPath)) {
    issues.push({
      rule_id: "ingest_log_entry_missing",
      severity: "error",
      path: "curated/log.md",
      message: `curated/log.md has no ingest entry for ${sourceId} that references ${summaryPath}.`,
      fix_hint: `Append an ingest log entry with ${summaryPath} under created or updated paths.`,
    });
  }

  issues.push(
    ...rawHashIssues(scan, sourceId, {
      originalPath: String(queueSource.value.queue_record.original_path),
      queueHash: queueSource.value.queue_record.content_hash,
      queuePath: queueSource.value.queue_record.queue_path,
      sourceCardHash: queueSource.value.source_card.frontmatter.content_hash,
      sourceCardPath: queueSource.value.source_card.path,
    }),
    ...capturedRawHashIssues(scan, sourceId),
  );

  const changedFiles = await listGitChangedFiles(repoRoot, ["curated"]);
  if (changedFiles.error !== null) {
    issues.push({
      rule_id: "ingest_changed_files_unavailable",
      severity: "error",
      path: ".git",
      message: "Git changed-file detection failed during ingest validation.",
      fix_hint: changedFiles.error,
    });
  }

  const sourceIdPages = await relatedCuratedPagesNeedingSourceIds(
    repoRoot,
    scan,
    sourceId,
    sourceSummary,
    changedFiles,
    noGitValidationWindow(queueSource.value.queue_record),
    queueSource.value.queue_record.status,
  );
  for (const page of sourceIdPages) {
    if (!pageSourceIds(page).includes(sourceId)) {
      issues.push({
        rule_id: "ingest_source_ids_missing",
        severity: "error",
        path: page.path,
        message: `Edited curated page does not include ${sourceId} in source_ids frontmatter: ${page.path}.`,
        fix_hint: `Add ${sourceId} to source_ids for every curated page changed by this ingest.`,
      });
    }
  }

  const dedupedIssues = dedupeIssues(issues);

  return {
    source_id: sourceId,
    passed: dedupedIssues.length === 0,
    issues: dedupedIssues,
    checked_paths: checkedPaths(
      sourceId,
      queueSource.value.queue_record.original_path,
      dedupedIssues,
      sourceIdPages.map((page) => page.path),
    ),
  };
}

function indexMentionsSourceSummary(page: RepoMarkdownFile, sourceId: string): boolean {
  return page.content.includes(`sources/${sourceId}`) || page.content.includes(`curated/sources/${sourceId}.md`);
}

function hasAgentIngestLogEntry(scan: RepoScan, sourceId: string, summaryPath: string): boolean {
  return (
    scan.log?.scan.entries.some(
      (entry) =>
        entry.operation === "ingest" &&
        entry.affectedId === sourceId &&
        (entry.body.includes(summaryPath) || entry.body.includes(`sources/${sourceId}`)),
    ) ?? false
  );
}

type RawHashInput = {
  originalPath: string;
  queueHash: string;
  queuePath: string;
  sourceCardHash: string;
  sourceCardPath: string;
};

function rawHashIssues(scan: RepoScan, sourceId: string, input: RawHashInput): IngestValidationIssue[] {
  const issues: IngestValidationIssue[] = [];
  const capturedHashPrefix = capturedHashPrefixFromSourceId(sourceId);
  const expectedHash = nonEmptyHash(input.sourceCardHash);
  const queueHash = nonEmptyHash(input.queueHash);
  const original = scan.rawOriginals.find((candidate) => candidate.path === input.originalPath) ?? null;

  if (expectedHash === null) {
    issues.push({
      rule_id: "ingest_raw_hash_missing",
      severity: "error",
      path: input.sourceCardPath,
      message: `Source card content_hash is missing for ${sourceId}.`,
      fix_hint: "Restore the source card content_hash captured with the immutable raw original.",
    });
  }

  if (queueHash === null) {
    issues.push({
      rule_id: "ingest_raw_hash_missing",
      severity: "error",
      path: input.queuePath,
      message: `Queue content_hash is missing for ${sourceId}.`,
      fix_hint: "Restore the queue content_hash so it matches the source card hash.",
    });
  }

  if (expectedHash !== null && queueHash !== null && queueHash !== expectedHash) {
    issues.push({
      rule_id: "ingest_raw_hash_mismatch",
      severity: "error",
      path: input.queuePath,
      message: `Queue content_hash disagrees with the source card hash for ${sourceId}.`,
      fix_hint: "Restore the queue content_hash to match the source card hash before validating ingest.",
    });
  }

  if (expectedHash !== null && capturedHashPrefix !== null && !expectedHash.startsWith(capturedHashPrefix)) {
    issues.push({
      rule_id: "ingest_raw_hash_mismatch",
      severity: "error",
      path: input.sourceCardPath,
      message: `Source card content_hash no longer matches the captured hash prefix for ${sourceId}.`,
      fix_hint: "Restore the source card content_hash captured with the immutable raw original.",
    });
  }

  if (queueHash !== null && capturedHashPrefix !== null && !queueHash.startsWith(capturedHashPrefix)) {
    issues.push({
      rule_id: "ingest_raw_hash_mismatch",
      severity: "error",
      path: input.queuePath,
      message: `Queue content_hash no longer matches the captured hash prefix for ${sourceId}.`,
      fix_hint: "Restore the queue content_hash captured with the immutable raw original.",
    });
  }

  if (original === null) {
    issues.push({
      rule_id: "ingest_raw_original_missing",
      severity: "error",
      path: input.originalPath,
      message: `Raw original is missing for ${sourceId}.`,
      fix_hint: "Restore the captured raw original before validating ingest.",
    });
    return issues;
  }

  if (capturedHashPrefix !== null && !original.content_hash.startsWith(capturedHashPrefix)) {
    issues.push({
      rule_id: "ingest_raw_hash_drift",
      severity: "error",
      path: original.path,
      message: `Raw original hash changed from the captured source ID hash for ${sourceId}.`,
      fix_hint: "Restore the immutable raw original content before validating ingest.",
    });
  }

  if (expectedHash !== null && original.content_hash !== expectedHash) {
    issues.push({
      rule_id: "ingest_raw_hash_drift",
      severity: "error",
      path: original.path,
      message: `Raw original hash changed for ${sourceId}.`,
      fix_hint: "Restore the immutable raw original content before validating ingest.",
    });
  }

  return issues;
}

function capturedRawHashIssues(scan: RepoScan, targetSourceId: string): IngestValidationIssue[] {
  const issues: IngestValidationIssue[] = [];
  const originalsByPath = new Map(scan.rawOriginals.map((original) => [original.path, original]));
  const sourceCardsBySourceId = new Map(
    scan.sourceCards.flatMap((card) => (card.source_id === null ? [] : [[card.source_id, card]])),
  );
  const checkedSourceIds = new Set<string>();

  for (const queueFile of scan.queueItems) {
    const sourceId = queueFile.item.source_id;
    checkedSourceIds.add(sourceId);
    if (sourceId === targetSourceId) {
      continue;
    }

    issues.push(
      ...capturedHashIssues({
        sourceId,
        expectedHash: typeof queueFile.item.content_hash === "string" ? queueFile.item.content_hash : "",
        expectedHashPath: queueFile.path,
        originalPath: String(queueFile.item.original_path),
        originalHash: originalsByPath.get(String(queueFile.item.original_path))?.content_hash ?? null,
      }),
    );

    const sourceCard = sourceCardsBySourceId.get(sourceId);
    if (sourceCard !== undefined) {
      issues.push(
        ...capturedHashIssues({
          sourceId,
          expectedHash: sourceCard.content_hash_field ?? "",
          expectedHashPath: sourceCard.path,
          originalPath: String(queueFile.item.original_path),
          originalHash: originalsByPath.get(String(queueFile.item.original_path))?.content_hash ?? null,
        }),
      );
    }
  }

  for (const card of scan.sourceCards) {
    if (card.source_id === null || checkedSourceIds.has(card.source_id) || card.source_id === targetSourceId) {
      continue;
    }

    const original = sourceCardOriginal(scan, card);
    issues.push(
      ...capturedHashIssues({
        sourceId: card.source_id,
        expectedHash: card.content_hash_field ?? "",
        expectedHashPath: card.path,
        originalPath: original?.path ?? sourceCardOriginalPathHint(card.path),
        originalHash: original?.content_hash ?? null,
      }),
    );
  }

  return issues;
}

type CapturedHashInput = {
  sourceId: string;
  expectedHash: string;
  expectedHashPath: string;
  originalPath: string;
  originalHash: string | null;
};

function capturedHashIssues(input: CapturedHashInput): IngestValidationIssue[] {
  const issues: IngestValidationIssue[] = [];
  const capturedHashPrefix = capturedHashPrefixFromSourceId(input.sourceId);
  const expectedHash = nonEmptyHash(input.expectedHash);

  if (expectedHash === null) {
    issues.push({
      rule_id: "ingest_raw_hash_missing",
      severity: "error",
      path: input.expectedHashPath,
      message: `Captured content_hash is missing for ${input.sourceId}.`,
      fix_hint: "Restore the content_hash captured with the immutable raw original.",
    });
  }

  if (expectedHash !== null && capturedHashPrefix !== null && !expectedHash.startsWith(capturedHashPrefix)) {
    issues.push({
      rule_id: "ingest_raw_hash_mismatch",
      severity: "error",
      path: input.expectedHashPath,
      message: `Captured content_hash no longer matches the source ID hash for ${input.sourceId}.`,
      fix_hint: "Restore the content_hash captured with the immutable raw original.",
    });
  }

  if (input.originalHash === null) {
    issues.push({
      rule_id: "ingest_raw_original_missing",
      severity: "error",
      path: input.originalPath,
      message: `Raw original is missing for ${input.sourceId}.`,
      fix_hint: "Restore the captured raw original before validating ingest.",
    });
    return issues;
  }

  if (capturedHashPrefix !== null && !input.originalHash.startsWith(capturedHashPrefix)) {
    issues.push({
      rule_id: "ingest_raw_hash_drift",
      severity: "error",
      path: input.originalPath,
      message: `Raw original hash changed from the captured source ID hash for ${input.sourceId}.`,
      fix_hint: "Restore the immutable raw original content before validating ingest.",
    });
  }

  if (expectedHash !== null && input.originalHash !== expectedHash) {
    issues.push({
      rule_id: "ingest_raw_hash_drift",
      severity: "error",
      path: input.originalPath,
      message: `Raw original hash changed for ${input.sourceId}.`,
      fix_hint: "Restore the immutable raw original content before validating ingest.",
    });
  }

  return issues;
}

function sourceCardOriginal(scan: RepoScan, card: SourceCard): RepoScan["rawOriginals"][number] | null {
  const expectedPrefix = `${dirname(card.path)}/original.`;
  return scan.rawOriginals.find((original) => original.path.startsWith(expectedPrefix)) ?? null;
}

function sourceCardOriginalPathHint(cardPath: string): string {
  return `${dirname(cardPath)}/original.*`;
}

function capturedHashPrefixFromSourceId(sourceId: string): string | null {
  const parts = parseSourceId(sourceId);
  return parts.ok ? `sha256:${parts.value.shortHash}` : null;
}

function nonEmptyHash(value: string): string | null {
  return value.trim() === "" ? null : value;
}

async function relatedCuratedPagesNeedingSourceIds(
  repoRoot: string,
  scan: RepoScan,
  sourceId: string,
  sourceSummary: RepoMarkdownFile | null,
  changedFiles: { enabled: boolean; paths: readonly string[]; committedPathsIncomplete?: boolean },
  noGitWindow: NoGitValidationWindow,
  queueStatus: QueueStatus,
): Promise<RepoMarkdownFile[]> {
  const paths = new Set<string>();

  if (sourceSummary !== null) {
    paths.add(sourceSummary.path);
  }

  for (const page of scan.curatedPages) {
    if (page.path === "curated/index.md" || page.path === "curated/log.md" || page.path.endsWith("/.gitkeep")) {
      continue;
    }

    if (page.content.includes(sourceId) || page.content.includes(`sources/${sourceId}`)) {
      paths.add(page.path);
    }
  }

  for (const entry of scan.log?.scan.entries ?? []) {
    if (entry.operation !== "ingest" || entry.affectedId !== sourceId) {
      continue;
    }

    for (const path of curatedPathsFromLogBody(entry.body)) {
      if (path !== "curated/index.md" && path !== "curated/log.md") {
        paths.add(path);
      }
    }
  }

  for (const path of changedFiles.paths) {
    if (!isCuratedContentPage(path)) {
      continue;
    }

    if (queueStatus !== "ingested") {
      paths.add(path);
    }
  }

  if (!changedFiles.enabled || changedFiles.committedPathsIncomplete === true) {
    for (const page of await noGitRecentlyChangedCuratedPages(repoRoot, scan.curatedPages, noGitWindow)) {
      paths.add(page.path);
    }
  }

  const pagesByPath = new Map(scan.curatedPages.map((page) => [page.path, page]));
  return [...paths]
    .flatMap((path) => {
      const page = pagesByPath.get(path);
      return page === undefined ? [] : [page];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function noGitValidationWindow(queueRecord: {
  captured_at?: unknown;
  status?: unknown;
  updated_at?: unknown;
}): NoGitValidationWindow {
  const capturedAt = typeof queueRecord.captured_at === "string" ? queueRecord.captured_at : "";
  if (queueRecord.status === "ingesting" && typeof queueRecord.updated_at === "string") {
    return { start: queueRecord.updated_at };
  }

  if (queueRecord.status === "ingested" && typeof queueRecord.updated_at === "string") {
    return { start: capturedAt, end: queueRecord.updated_at };
  }

  return { start: capturedAt };
}

async function noGitRecentlyChangedCuratedPages(
  repoRoot: string,
  pages: readonly RepoMarkdownFile[],
  window: NoGitValidationWindow,
): Promise<RepoMarkdownFile[]> {
  const startMs = Date.parse(window.start);
  const endMs = window.end === undefined ? null : Date.parse(window.end);
  const failClosed =
    !Number.isFinite(startMs) || (endMs !== null && (!Number.isFinite(endMs) || endMs < startMs));
  const changedPages: RepoMarkdownFile[] = [];

  for (const page of pages) {
    if (!isCuratedContentPage(page.path)) {
      continue;
    }

    if (failClosed || (await wasModifiedInNoGitWindow(repoRoot, page.path, startMs, endMs))) {
      changedPages.push(page);
    }
  }

  return changedPages;
}

async function wasModifiedInNoGitWindow(
  repoRoot: string,
  path: string,
  startMs: number,
  endMs: number | null,
): Promise<boolean> {
  try {
    const stat = await lstat(resolve(repoRoot, path));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return true;
    }

    return stat.mtimeMs >= startMs && (endMs === null || stat.mtimeMs <= endMs);
  } catch {
    return true;
  }
}

function isCuratedContentPage(path: string): boolean {
  return path.startsWith("curated/") && path.endsWith(".md") && path !== "curated/index.md" && path !== "curated/log.md";
}

function curatedPathsFromLogBody(body: string): string[] {
  const paths = new Set<string>();
  let activePathList = false;

  for (const line of body.split(/\r?\n/)) {
    const fieldMatch = /^-\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (fieldMatch !== null) {
      const [, field = "", inlineValue = ""] = fieldMatch;
      activePathList = field === "created" || field === "updated";
      if (activePathList) {
        addCuratedLogPath(paths, inlineValue);
      }
      continue;
    }

    if (!activePathList) {
      continue;
    }

    const itemMatch = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (itemMatch !== null) {
      addCuratedLogPath(paths, itemMatch[1] ?? "");
    }
  }

  return [...paths].filter((path) => path !== "").sort();
}

function addCuratedLogPath(paths: Set<string>, rawPath: string): void {
  const path = rawPath.trim();
  if (path.startsWith("curated/") && path.endsWith(".md")) {
    paths.add(path);
  }
}

function pageSourceIds(page: RepoMarkdownFile): string[] {
  const sourceIds = page.scan.frontmatter?.source_ids;
  if (!Array.isArray(sourceIds)) {
    return [];
  }

  return sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string" && sourceId.trim() !== "");
}

function dedupeIssues(issues: IngestValidationIssue[]): IngestValidationIssue[] {
  const seen = new Set<string>();
  const deduped: IngestValidationIssue[] = [];

  for (const issue of issues) {
    const key = `${issue.rule_id}:${issue.path}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(issue);
  }

  return deduped.sort((left, right) => left.path.localeCompare(right.path) || left.rule_id.localeCompare(right.rule_id));
}

function checkedPaths(
  sourceId: string,
  originalPath: unknown,
  issues: readonly IngestValidationIssue[],
  sourceIdPaths: readonly string[],
): string[] {
  return [
    `curated/sources/${sourceId}.md`,
    "curated/index.md",
    "curated/log.md",
    typeof originalPath === "string" ? originalPath : "",
    ...sourceIdPaths,
    ...issues.map((issue) => issue.path),
  ]
    .filter((path) => path !== "")
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort();
}
