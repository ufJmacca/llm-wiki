import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { scanWikiRepository, isRawOriginalPath, type RepoMarkdownFile, type RepoScan, type SourceCard } from "../scanner/repo.js";
import { computeContentHash, parseSourceId, type MarkdownLink, type QueueItem, type WikiLink } from "../scanner/index.js";
import { writeTextFileInsideRoot } from "../utils/fs.js";

export type LintSeverity = "error" | "warning";

export type LintIssue = {
  rule_id: string;
  severity: LintSeverity;
  path: string;
  line?: number;
  message: string;
  fix_hint: string;
  fixable: boolean;
};

export type LintOptions = {
  profile?: string;
  strict?: boolean;
};

export type LintResult = {
  issues: LintIssue[];
  fixed_paths: string[];
  counts: {
    total: number;
    error: number;
    warning: number;
    fixed: number;
  };
};

type LinkResolution = {
  link: MarkdownLink | WikiLink;
  resolved_path: string | null;
  target: RepoMarkdownFile | null;
};

export type LinkResolutionIndex = {
  filePaths: ReadonlySet<string>;
  markdownByPath: ReadonlyMap<string, RepoMarkdownFile>;
  markdownByTitle: ReadonlyMap<string, RepoMarkdownFile>;
  markdownByBasename: ReadonlyMap<string, RepoMarkdownFile>;
};

const VALID_MARKDOWN_TYPES = new Set([
  "raw_source",
  "source_summary",
  "entity",
  "concept",
  "topic",
  "question",
  "comparison",
  "dashboard",
  "index",
  "log",
  "page",
]);

const VALID_CURATED_TYPES = new Set([...VALID_MARKDOWN_TYPES].filter((type) => type !== "raw_source"));
const VALID_SOURCE_KINDS = new Set(["file", "text", "url"]);
const VALID_SOURCE_STATUSES = new Set(["queued", "ingesting", "ingested", "blocked"]);
const VALID_VISIBILITIES = new Set(["private", "public"]);
const INDEXABLE_CURATED_DIRECTORIES = ["curated/concepts/", "curated/entities/", "curated/topics/", "curated/questions/", "curated/comparisons/"];
const PUBLIC_FORBIDDEN_SKIPPED_PROFILE_ROOTS = [
  {
    path: ".llm-wiki/cache",
    candidates: [
      ".llm-wiki/cache",
      ".llm-wiki/cache/pages.json",
      ".llm-wiki/cache/sources.json",
      ".llm-wiki/cache/queue.json",
      ".llm-wiki/cache/graph.json",
      ".llm-wiki/cache/metadata.json",
      ".llm-wiki/cache/__private__.json",
    ],
  },
] as const;
const PUBLIC_SKIPPED_NON_MARKDOWN_PROFILE_PATHS = [".llm-wiki/config.yml"] as const;

export async function lintWiki(repoRoot: string, options: LintOptions = {}): Promise<LintResult> {
  const scan = await scanWikiRepository(repoRoot);
  const issues = collectLintIssues(scan, options);

  return withCounts({ issues, fixed_paths: [] });
}

export async function lintWikiWithFix(repoRoot: string, options: LintOptions = {}): Promise<LintResult> {
  const firstScan = await scanWikiRepository(repoRoot);
  const firstIssues = collectLintIssues(firstScan, options);
  const shouldFixIndex = firstIssues.some(
    (issue) => (issue.rule_id === "index_stale" || issue.rule_id === "index_missing") && issue.fixable,
  );
  const fixedPaths: string[] = [];

  if (shouldFixIndex) {
    const indexWrite = await writeGeneratedIndex(repoRoot, buildIndexContent(firstScan));
    if (indexWrite.ok) {
      fixedPaths.push("curated/index.md");
    } else {
      const issues = sortIssues(dedupeIssues([...firstIssues, indexFixFailedIssue(indexWrite.error)]));
      return withCounts({ issues, fixed_paths: fixedPaths });
    }
  }

  const secondScan = shouldFixIndex ? await scanWikiRepository(repoRoot) : firstScan;
  const secondIssues = collectLintIssues(secondScan, options);

  return withCounts({ issues: secondIssues, fixed_paths: fixedPaths });
}

export async function rebuildCuratedIndex(repoRoot: string): Promise<string> {
  const scan = await scanWikiRepository(repoRoot);
  const content = buildIndexContent(scan);
  const writeResult = await writeGeneratedIndex(repoRoot, content);
  if (!writeResult.ok) {
    throw new Error(writeResult.error.message);
  }

  return computeContentHash(content);
}

async function writeGeneratedIndex(repoRoot: string, content: string): ReturnType<typeof writeTextFileInsideRoot> {
  return writeTextFileInsideRoot(repoRoot, "curated/index.md", content);
}

export function collectLintIssues(scan: RepoScan, options: LintOptions = {}): LintIssue[] {
  const linkIndex = createLinkResolutionIndex(scan);
  const issues: LintIssue[] = [
    ...markdownFrontmatterIssues(scan),
    ...profileScanIssues(scan, options.profile),
    ...sourceCardIssues(scan),
    ...queueSourceIssues(scan),
    ...rawHashIssues(scan),
    ...ingestedSummaryIssues(scan),
    ...curatedPageIssues(scan),
    ...runtimeLogIssues(scan),
    ...wikilinkIssues(scan, linkIndex),
    ...orphanIssues(scan, linkIndex),
    ...indexIssues(scan),
  ];

  if (options.strict) {
    issues.push(...publicProfileIssues(scan, options.profile ?? "public", linkIndex));
  }

  return sortIssues(dedupeIssues(issues));
}

function markdownFrontmatterIssues(scan: RepoScan): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const file of scan.markdown) {
    for (const scannerIssue of file.scan.issues) {
      if (file.path.includes("/_source.md")) {
        continue;
      }

      issues.push({
        rule_id: "frontmatter_malformed",
        severity: "error",
        path: scannerIssue.path,
        line: scannerIssue.line,
        message: scannerIssue.message,
        fix_hint: scannerIssue.hint,
        fixable: false,
      });
    }

    const type = file.scan.frontmatter?.type;
    if (type !== undefined && (typeof type !== "string" || !VALID_MARKDOWN_TYPES.has(type))) {
      issues.push({
        rule_id: "frontmatter_type_invalid",
        severity: "error",
        path: file.path,
        message: `Invalid frontmatter type in ${file.path}.`,
        fix_hint: "Use one of the supported llm-wiki page types.",
        fixable: false,
      });
    }
  }

  return issues;
}

function profileScanIssues(scan: RepoScan, profileName?: string): LintIssue[] {
  const profiles = profileName === undefined ? scan.profiles : scan.profiles.filter((profile) => profile.name === profileName);
  if (profileName !== undefined && profiles.length === 0) {
    return [missingProfileIssue(profileName)];
  }

  return profiles.flatMap((profile) =>
    profile.scan.issues.map((scannerIssue) => ({
      rule_id: "profile_malformed",
      severity: scannerIssue.severity,
      path: scannerIssue.path,
      line: scannerIssue.line,
      message: scannerIssue.message,
      fix_hint: scannerIssue.hint,
      fixable: false,
    })),
  );
}

function sourceCardIssues(scan: RepoScan): LintIssue[] {
  const issues: LintIssue[] = [];
  const requiredFields = [
    "type",
    "source_id",
    "title",
    "source_kind",
    "origin",
    "captured_at",
    "content_hash",
    "status",
    "visibility",
  ];

  for (const card of scan.sourceCards) {
    for (const scannerIssue of card.scan.issues) {
      issues.push({
        rule_id: "source_card_malformed",
        severity: "error",
        path: card.path,
        line: scannerIssue.line,
        message: scannerIssue.message,
        fix_hint: scannerIssue.hint,
        fixable: false,
      });
    }

    if (!card.scan.frontmatter) {
      if (card.scan.issues.length > 0) {
        continue;
      }

      issues.push({
        rule_id: "source_card_malformed",
        severity: "error",
        path: card.path,
        message: `Source card has no parseable frontmatter: ${card.path}.`,
        fix_hint: "Restore a valid raw source card frontmatter block.",
        fixable: false,
      });
      continue;
    }

    const invalidRequiredField = requiredFields.find((field) => {
      const value = card.scan.frontmatter?.[field];
      return typeof value !== "string" || value.trim() === "";
    });
    if (invalidRequiredField !== undefined || card.scan.frontmatter.type !== "raw_source") {
      issues.push({
        rule_id: "source_card_malformed",
        severity: "error",
        path: card.path,
        message: `Source card is missing required raw source metadata: ${card.path}.`,
        fix_hint: "Restore type, source_id, title, source_kind, origin, captured_at, content_hash, status, and visibility.",
        fixable: false,
      });
    }

    const sourceKind = card.scan.frontmatter.source_kind;
    if (typeof sourceKind === "string" && sourceKind.trim() !== "" && !VALID_SOURCE_KINDS.has(sourceKind)) {
      issues.push({
        rule_id: "source_card_malformed",
        severity: "error",
        path: card.path,
        message: `Source card has unsupported source_kind "${sourceKind}".`,
        fix_hint: "Use file, text, or url.",
        fixable: false,
      });
    }

    if (card.status !== null && !VALID_SOURCE_STATUSES.has(card.status)) {
      issues.push({
        rule_id: "source_card_malformed",
        severity: "error",
        path: card.path,
        message: `Source card has unsupported status "${card.status}".`,
        fix_hint: "Use queued, ingesting, ingested, or blocked.",
        fixable: false,
      });
    }

    if (card.visibility !== null && !VALID_VISIBILITIES.has(card.visibility)) {
      issues.push({
        rule_id: "source_card_malformed",
        severity: "error",
        path: card.path,
        message: `Source card has unsupported visibility "${card.visibility}".`,
        fix_hint: "Use private or public visibility.",
        fixable: false,
      });
    }

    if (card.visibility === "public") {
      issues.push({
        rule_id: "raw_sources_default_private",
        severity: "error",
        path: card.path,
        message: `Raw source card must remain visibility: private: ${card.path}.`,
        fix_hint: "Keep raw source cards private and publish reviewed curated summaries instead.",
        fixable: false,
      });
    }
  }

  return issues;
}

function queueSourceIssues(scan: RepoScan): LintIssue[] {
  const issues: LintIssue[] = [];
  const cardsById = new Map(scan.sourceCards.filter((card) => card.source_id !== null).map((card) => [card.source_id, card]));
  const queueById = new Map(scan.queueItems.map((queueFile) => [queueFile.item.source_id, queueFile]));

  for (const queueFile of scan.queueFiles) {
    for (const scannerIssue of queueFile.scan.issues) {
      issues.push({
        rule_id: "queue_item_malformed",
        severity: "error",
        path: queueFile.path,
        line: scannerIssue.line,
        message: scannerIssue.message,
        fix_hint: scannerIssue.hint,
        fixable: false,
      });
    }
  }

  for (const queueFile of scan.queueItems) {
    const queueValueIssue = queueItemValueIssue(queueFile.item);
    if (queueValueIssue !== null) {
      issues.push({
        rule_id: "queue_item_malformed",
        severity: "error",
        path: queueFile.path,
        message: `Queue item has unsupported ${queueValueIssue} for ${queueFile.item.source_id}.`,
        fix_hint: "Use supported kind/source_kind values and keep them aligned.",
        fixable: false,
      });
    }

    if (queueFile.item.visibility === "public") {
      issues.push({
        rule_id: "raw_sources_default_private",
        severity: "error",
        path: queueFile.path,
        message: `Raw source queue item must remain visibility: private: ${queueFile.path}.`,
        fix_hint: "Keep raw source queue metadata private and publish reviewed curated summaries instead.",
        fixable: false,
      });
    }

    const filenameSourceId = basename(queueFile.path, ".json");
    if (filenameSourceId !== queueFile.item.source_id) {
      issues.push({
        rule_id: "queue_item_malformed",
        severity: "error",
        path: queueFile.path,
        message: `Queue file name does not match source ID: ${queueFile.path}.`,
        fix_hint: "Name queue files as raw/queue/<source_id>.json.",
        fixable: false,
      });
    }

    const card = cardsById.get(queueFile.item.source_id);
    if (!card) {
      issues.push({
        rule_id: "queue_source_card_missing",
        severity: "error",
        path: queueFile.path,
        message: `Queue item has no source card: ${queueFile.item.source_id}.`,
        fix_hint: "Restore the source card path referenced by this queue item.",
        fixable: false,
      });
      continue;
    }

    const mismatchedField = firstQueueSourceCardMismatch(queueFile.item, card);
    if (mismatchedField !== null) {
      issues.push({
        rule_id: "queue_source_card_mismatch",
        severity: "error",
        path: queueFile.path,
        message: `Queue item and source card disagree on ${mismatchedField} for ${queueFile.item.source_id}.`,
        fix_hint: "Use llm-wiki queue set-status or restore matching queue/source-card metadata.",
        fixable: false,
      });
    }
  }

  for (const card of scan.sourceCards) {
    if (card.source_id === null || queueById.has(card.source_id) || card.status === "ingested") {
      continue;
    }

    issues.push({
      rule_id: "source_card_queue_missing",
      severity: "warning",
      path: card.path,
      message: `Source card has no queue item: ${card.source_id}.`,
      fix_hint: "Restore the raw/queue JSON item or mark the source ingested through the queue workflow.",
      fixable: false,
    });
  }

  return issues;
}

function queueItemValueIssue(item: QueueItem): string | null {
  if (!VALID_SOURCE_KINDS.has(item.kind)) {
    return `kind "${item.kind}"`;
  }

  if (typeof item.source_kind !== "string" || !VALID_SOURCE_KINDS.has(item.source_kind)) {
    return `source_kind "${String(item.source_kind)}"`;
  }

  if (item.kind !== item.source_kind) {
    return `kind/source_kind mismatch "${item.kind}" vs "${item.source_kind}"`;
  }

  return null;
}

function firstQueueSourceCardMismatch(item: QueueItem, card: SourceCard): string | null {
  const frontmatter = card.scan.frontmatter ?? {};
  const fields: Array<[field: string, queueValue: unknown, cardValue: unknown]> = [
    ["path", item.path, card.path],
    ["source_id", item.source_id, frontmatter.source_id],
    ["title", item.title, frontmatter.title],
    ["source_kind", item.source_kind, frontmatter.source_kind],
    ["origin", item.origin, frontmatter.origin],
    ["origin_url", item.origin_url, frontmatter.origin_url],
    ["captured_at", item.captured_at, frontmatter.captured_at],
    ["content_hash", item.content_hash, frontmatter.content_hash],
    ["status", item.status, frontmatter.status],
    ["visibility", item.visibility, frontmatter.visibility],
  ];

  return fields.find(([, queueValue, cardValue]) => comparableValue(queueValue) !== comparableValue(cardValue))?.[0] ?? null;
}

function comparableValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value) ?? String(value);
}

function rawHashIssues(scan: RepoScan): LintIssue[] {
  const issues: LintIssue[] = [];
  const originalsByPath = new Map(scan.rawOriginals.map((original) => [original.path, original]));
  const checkedSourceIds = new Set<string>();

  for (const queueFile of scan.queueItems) {
    checkedSourceIds.add(queueFile.item.source_id);
    const original = originalsByPath.get(String(queueFile.item.original_path));
    if (!original) {
      issues.push({
        rule_id: "raw_original_missing",
        severity: "error",
        path: String(queueFile.item.original_path),
        message: `Raw original is missing for ${queueFile.item.source_id}.`,
        fix_hint: "Restore the captured original from backup; lint will not recreate raw originals.",
        fixable: false,
      });
      continue;
    }

    if (original.content_hash !== queueFile.item.content_hash) {
      issues.push({
        rule_id: "raw_hash_drift",
        severity: "error",
        path: original.path,
        message: `Raw original hash drift detected for ${queueFile.item.source_id}.`,
        fix_hint: "Restore the captured original content; raw originals are immutable.",
        fixable: false,
      });
    }
  }

  for (const card of scan.sourceCards) {
    if (card.source_id === null || checkedSourceIds.has(card.source_id) || card.content_hash_field === null) {
      continue;
    }

    const original = sourceCardOriginal(scan, card);
    if (!original) {
      issues.push({
        rule_id: "raw_original_missing",
        severity: "error",
        path: sourceCardOriginalPathHint(card.path),
        message: `Raw original is missing for ${card.source_id}.`,
        fix_hint: "Restore the captured original from backup; lint will not recreate raw originals.",
        fixable: false,
      });
      continue;
    }

    if (original.content_hash !== card.content_hash_field) {
      issues.push({
        rule_id: "raw_hash_drift",
        severity: "error",
        path: original.path,
        message: `Raw original hash drift detected for ${card.source_id}.`,
        fix_hint: "Restore the captured original content; raw originals are immutable.",
        fixable: false,
      });
    }
  }

  return issues;
}

function ingestedSummaryIssues(scan: RepoScan): LintIssue[] {
  const curatedSummaryPaths = new Set(scan.curatedPages.map((file) => file.path));
  const issues: LintIssue[] = [];

  for (const card of scan.sourceCards) {
    if (card.source_id === null || card.status !== "ingested") {
      continue;
    }

    const expectedSummaryPath = `curated/sources/${card.source_id}.md`;
    if (!curatedSummaryPaths.has(expectedSummaryPath)) {
      issues.push({
        rule_id: "ingested_source_summary_missing",
        severity: "error",
        path: card.path,
        message: `Ingested source has no curated summary: ${card.source_id}.`,
        fix_hint: `Create ${expectedSummaryPath} before marking this source ingested.`,
        fixable: false,
      });
    }
  }

  return issues;
}

function curatedPageIssues(scan: RepoScan): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const page of scan.curatedPages) {
    if (page.path.endsWith("/.gitkeep")) {
      continue;
    }

    if (!page.scan.frontmatter) {
      issues.push({
        rule_id: "curated_frontmatter_missing",
        severity: "error",
        path: page.path,
        message: `Curated page is missing required frontmatter: ${page.path}.`,
        fix_hint: "Add frontmatter with type, title, visibility, and source_ids.",
        fixable: false,
      });
      continue;
    }

    const missingRequiredField = ["type", "title", "visibility"].find((field) => {
      const value = page.scan.frontmatter?.[field];
      return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    });
    if (missingRequiredField !== undefined) {
      issues.push({
        rule_id: "curated_frontmatter_required_missing",
        severity: "error",
        path: page.path,
        message: `Curated page is missing required ${missingRequiredField} frontmatter: ${page.path}.`,
        fix_hint: "Add frontmatter with type, title, visibility, and source_ids.",
        fixable: false,
      });
    }

    const type = page.scan.frontmatter.type;
    if (typeof type === "string" && VALID_MARKDOWN_TYPES.has(type) && !VALID_CURATED_TYPES.has(type)) {
      issues.push({
        rule_id: "curated_frontmatter_invalid",
        severity: "error",
        path: page.path,
        message: `Curated page type must not be ${type}: ${page.path}.`,
        fix_hint: "Use a curated page type; raw_source is only valid for raw source cards.",
        fixable: false,
      });
    }

    const title = page.scan.frontmatter.title;
    if (title !== undefined && title !== null && typeof title !== "string") {
      issues.push({
        rule_id: "curated_frontmatter_invalid",
        severity: "error",
        path: page.path,
        message: `Curated page title must be a string: ${page.path}.`,
        fix_hint: "Use a string title in curated page frontmatter.",
        fixable: false,
      });
    }

    const visibility = page.scan.frontmatter.visibility;
    if (
      visibility !== undefined &&
      visibility !== null &&
      (typeof visibility !== "string" || !VALID_VISIBILITIES.has(visibility))
    ) {
      issues.push({
        rule_id: "curated_frontmatter_invalid",
        severity: "error",
        path: page.path,
        message: `Curated page visibility must be private or public: ${page.path}.`,
        fix_hint: "Use visibility: private or visibility: public.",
        fixable: false,
      });
    }

    const sourceIds = page.scan.frontmatter.source_ids;
    if (!Array.isArray(sourceIds)) {
      issues.push({
        rule_id: "curated_source_ids_missing",
        severity: "error",
        path: page.path,
        message: `Curated page is missing source_ids frontmatter: ${page.path}.`,
        fix_hint: "Add source_ids from cited source summaries; lint will not invent provenance.",
        fixable: false,
      });
    } else {
      for (const [index, sourceId] of sourceIds.entries()) {
        if (typeof sourceId !== "string" || !parseSourceId(sourceId).ok) {
          issues.push({
            rule_id: "curated_source_ids_invalid",
            severity: "error",
            path: page.path,
            message: `Curated page source_ids entry ${index} must be a valid source ID: ${page.path}.`,
            fix_hint: "Use source IDs shaped like src_yyyy_mm_dd_slug_shorthex; lint will not invent provenance.",
            fixable: false,
          });
        }
      }
    }
  }

  return issues;
}

function runtimeLogIssues(scan: RepoScan): LintIssue[] {
  if (scan.log === null) {
    return [
      {
        rule_id: "runtime_log_missing",
        severity: "error",
        path: "curated/log.md",
        message: "Required runtime log file is missing: curated/log.md.",
        fix_hint: "Restore curated/log.md from the scaffold before running workflows that depend on the runtime log.",
        fixable: false,
      },
    ];
  }

  return (
    scan.log?.scan.issues.map((issue) => ({
      rule_id: "log_heading_malformed",
      severity: "error" as const,
      path: issue.path,
      line: issue.line,
      message: issue.message,
      fix_hint: issue.hint,
      fixable: false,
    })) ?? []
  );
}

function wikilinkIssues(scan: RepoScan, linkIndex: LinkResolutionIndex): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const page of scan.markdown) {
    for (const resolution of resolveWikilinks(scan, page, linkIndex)) {
      if (resolution.resolved_path !== null) {
        continue;
      }

      issues.push({
        rule_id: "wikilink_broken",
        severity: "error",
        path: page.path,
        line: resolution.link.line,
        message: `Broken wikilink target "${resolution.link.target}" in ${page.path}.`,
        fix_hint: "Create the target page or update the wikilink to an existing page.",
        fixable: false,
      });
    }
  }

  return issues;
}

function orphanIssues(scan: RepoScan, linkIndex: LinkResolutionIndex): LintIssue[] {
  const incomingLinks = new Set<string>();

  for (const page of scan.curatedPages) {
    if (isNavigationSystemPage(page.path)) {
      continue;
    }

    for (const resolution of resolveLinks(scan, page, linkIndex)) {
      if (resolution.resolved_path?.startsWith("curated/") && resolution.resolved_path !== page.path) {
        incomingLinks.add(resolution.resolved_path);
      }
    }
  }

  return indexableCuratedTargets(scan)
    .filter((target) => !isSystemCuratedPage(target.path))
    .filter((target) => !incomingLinks.has(target.path))
    .map((target) => ({
      rule_id: "orphan_page",
      severity: "warning" as const,
      path: target.path,
      message: `Curated page has no inbound curated links: ${target.path}.`,
      fix_hint: "Link this page from a related curated page or index it intentionally in navigation.",
      fixable: false,
    }));
}

function indexIssues(scan: RepoScan): LintIssue[] {
  const indexPage = scan.curatedPages.find((page) => page.path === "curated/index.md");
  if (!indexPage) {
    return [
      {
        rule_id: "index_missing",
        severity: "error",
        path: "curated/index.md",
        message: "curated/index.md is missing.",
        fix_hint: "Run llm-wiki lint --fix to regenerate the index.",
        fixable: true,
      },
    ];
  }

  const expectedEntries = generatedIndexEntries(scan);
  const missing = expectedEntries.filter((entry) => !indexPage.content.includes(entry));
  if (missing.length === 0) {
    return [];
  }

  return [
    {
      rule_id: "index_stale",
      severity: "warning",
      path: "curated/index.md",
      message: `curated/index.md is missing ${missing.length} known page or source entr${missing.length === 1 ? "y" : "ies"}.`,
      fix_hint: "Run llm-wiki lint --fix to regenerate deterministic index entries.",
      fixable: true,
    },
  ];
}

function indexFixFailedIssue(error: { message: string }): LintIssue {
  return {
    rule_id: "index_fix_failed",
    severity: "error",
    path: "curated/index.md",
    message: `Failed to rewrite curated/index.md: ${error.message}`,
    fix_hint: "Fix filesystem permissions or unsafe symlinks, then rerun llm-wiki lint --fix.",
    fixable: false,
  };
}

function publicProfileIssues(scan: RepoScan, profileName: string, linkIndex: LinkResolutionIndex): LintIssue[] {
  const profile = scan.profiles.find((candidate) => candidate.name === profileName);
  if (profile && !profile.scan.profile) {
    return [];
  }

  if (!profile?.scan.profile) {
    return [missingProfileIssue(profileName)];
  }

  const include = toStringArray(profile.scan.profile.include);
  const exclude = toStringArray(profile.scan.profile.exclude);
  const configuredRequiredVisibility = profileRequiredVisibility(profile.scan.profile);
  const requiredVisibility = "public";
  const selectedPaths = new Set([
    ...scan.files.map((file) => file.path).filter((path) => matchesProfile(path, include, exclude)),
    ...scan.linkableFilePaths.filter((path) => matchesProfile(path, include, exclude)),
    ...selectedSkippedNonMarkdownProfilePaths(include, exclude),
  ]);
  const markdownByPath = linkIndex.markdownByPath;
  const issues: LintIssue[] = [];

  if (configuredRequiredVisibility !== requiredVisibility) {
    issues.push({
      rule_id: "public_profile_visibility_invalid",
      severity: "error",
      path: profile.path,
      message: `Public strict profile must require visibility: public, not visibility: ${configuredRequiredVisibility}.`,
      fix_hint: "Set visibility.required_value: public before running strict public lint.",
      fixable: false,
    });
  }

  for (const path of [...selectedPaths].sort()) {
    if (isScaffoldPlaceholderPath(path)) {
      continue;
    }

    if (isRawOriginalPath(path)) {
      issues.push({
        rule_id: "public_raw_original_selected",
        severity: "error",
        path,
        message: `Public profile selects a raw original: ${path}.`,
        fix_hint: "Exclude raw/inputs/**/original.* from public profiles.",
        fixable: false,
      });
      continue;
    }

    if (path.startsWith("raw/") && !isRawSourceCardPath(path)) {
      issues.push({
        rule_id: "public_raw_file_selected",
        severity: "error",
        path,
        message: `Public profile selects a raw file: ${path}.`,
        fix_hint: "Exclude raw/** from public profiles and publish reviewed curated summaries instead.",
        fixable: false,
      });
      continue;
    }

    const page = markdownByPath.get(path);
    if (!page) {
      issues.push({
        rule_id: "public_non_markdown_file_selected",
        severity: "error",
        path,
        message: `Public profile selects a non-Markdown file without visibility metadata: ${path}.`,
        fix_hint: "Exclude non-Markdown files from public profiles or publish reviewed content through Markdown pages with visibility: public.",
        fixable: false,
      });
      continue;
    }

    if (isRawSourceCardPath(path)) {
      issues.push({
        rule_id: "public_raw_source_card_selected",
        severity: "error",
        path,
        message: `Public profile selects a raw source card: ${path}.`,
        fix_hint: "Exclude raw/inputs/**/_source.md from public profiles and publish reviewed curated summaries instead.",
        fixable: false,
      });
    }

    if (page.scan.frontmatter?.visibility !== requiredVisibility) {
      issues.push({
        rule_id: "public_private_page_selected",
        severity: "error",
        path,
        message: `Public profile selected a page that is not visibility: ${requiredVisibility}.`,
        fix_hint: "Set visibility: public only after review, or exclude the page from the public profile.",
        fixable: false,
      });
      issues.push({
        rule_id: "public_search_private_text_leak",
        severity: "error",
        path,
        message: `Public search output would include private text from ${path}.`,
        fix_hint: "Exclude private pages from public profile search inputs.",
        fixable: false,
      });
    }
  }

  for (const path of selectedForbiddenSkippedProfileRoots(include, exclude)) {
    issues.push({
      rule_id: "public_skipped_private_path_selected",
      severity: "error",
      path,
      message: `Public profile selects skipped generated/private data: ${path}.`,
      fix_hint: "Exclude .llm-wiki/cache/** from public profiles; rebuildable cache files are not public source inputs.",
      fixable: false,
    });
  }

  for (const path of [...selectedPaths].sort()) {
    const page = markdownByPath.get(path);
    if (!page || page.scan.frontmatter?.visibility !== requiredVisibility) {
      continue;
    }

    for (const resolution of publicProfileLinkResolutions(scan, page, linkIndex)) {
      const localFilePath = localFileLinkPath(resolution.link.target);
      if (localFilePath !== null) {
        if (hasRawPathSegment(localFilePath)) {
          issues.push({
            rule_id: "public_raw_link",
            severity: "error",
            path: page.path,
            line: resolution.link.line,
            message: `Public page links to raw content: ${resolution.link.raw}.`,
            fix_hint: "Replace raw links with public-safe source summaries or remove the link.",
            fixable: false,
          });
        } else {
          issues.push({
            rule_id: "public_local_file_link",
            severity: "error",
            path: page.path,
            line: resolution.link.line,
            message: `Public page links to a local file: ${resolution.link.raw}.`,
            fix_hint: "Remove file:// links from public pages before syncing or building public output.",
            fixable: false,
          });
        }
        continue;
      }

      const windowsDrivePath = windowsDriveLinkPath(resolution.link.target);
      if (windowsDrivePath !== null) {
        if (hasRawPathSegment(windowsDrivePath)) {
          issues.push({
            rule_id: "public_raw_link",
            severity: "error",
            path: page.path,
            line: resolution.link.line,
            message: `Public page links to raw content: ${resolution.link.raw}.`,
            fix_hint: "Replace raw links with public-safe source summaries or remove the link.",
            fixable: false,
          });
        } else {
          issues.push({
            rule_id: "public_local_file_link",
            severity: "error",
            path: page.path,
            line: resolution.link.line,
            message: `Public page links to a local file: ${resolution.link.raw}.`,
            fix_hint: "Remove local file links from public pages before syncing or building public output.",
            fixable: false,
          });
        }
        continue;
      }

      const targetPath = resolution.resolved_path;
      if (targetPath !== null) {
        if (targetPath === "raw" || targetPath.startsWith("raw/")) {
          issues.push({
            rule_id: "public_raw_link",
            severity: "error",
            path: page.path,
            line: resolution.link.line,
            message: `Public page links to raw content: ${resolution.link.raw}.`,
            fix_hint: "Replace raw links with public-safe source summaries or remove the link.",
            fixable: false,
          });
          continue;
        }

        if (resolution.target?.scan.frontmatter?.visibility !== requiredVisibility) {
          issues.push({
            rule_id: "public_private_link",
            severity: "error",
            path: page.path,
            line: resolution.link.line,
            message: `Public page links to a private page: ${resolution.link.raw}.`,
            fix_hint: "Publish the target page explicitly or remove the link from public output.",
            fixable: false,
          });
          issues.push({
            rule_id: "public_graph_private_node_leak",
            severity: "error",
            path: page.path,
            line: resolution.link.line,
            message: `Public graph would include a private node linked from ${page.path}.`,
            fix_hint: "Remove private links from public pages before syncing or building public output.",
            fixable: false,
          });
        }
        continue;
      }

      if (isRawLocalLinkTarget(page.path, resolution.link.target)) {
        issues.push({
          rule_id: "public_raw_link",
          severity: "error",
          path: page.path,
          line: resolution.link.line,
          message: `Public page links to raw content: ${resolution.link.raw}.`,
          fix_hint: "Replace raw links with public-safe source summaries or remove the link.",
          fixable: false,
        });
        continue;
      }
    }
  }

  issues.push(...publicRawSourceIndexLeakIssues(scan, selectedPaths, markdownByPath, requiredVisibility));

  return issues;
}

function publicRawSourceIndexLeakIssues(
  scan: RepoScan,
  selectedPaths: ReadonlySet<string>,
  markdownByPath: ReadonlyMap<string, RepoMarkdownFile>,
  requiredVisibility: string,
): LintIssue[] {
  if (!selectedPaths.has("curated/index.md")) {
    return [];
  }

  const indexPage = markdownByPath.get("curated/index.md");
  if (!indexPage || indexPage.scan.frontmatter?.visibility !== requiredVisibility) {
    return [];
  }

  const rawSourceCells = scan.sourceCards
    .filter((card) => card.source_id !== null && card.title !== null && !hasSourceCardErrors(card))
    .map((card) => `| ${sourceIndexSourceCell(card, requiredVisibility)} |`);
  if (rawSourceCells.length === 0) {
    return [];
  }

  const issues: LintIssue[] = [];
  const lines = indexPage.content.split(/\r?\n/);
  const reportedLines = new Set<number>();
  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    if (reportedLines.has(lineNumber) || !line.trimStart().startsWith("|")) {
      continue;
    }

    if (rawSourceCells.some((cell) => line.includes(cell))) {
      reportedLines.add(lineNumber);
      issues.push({
        rule_id: "public_raw_source_metadata_leak",
        severity: "error",
        path: "curated/index.md",
        line: lineNumber,
        message: "Public index contains raw source-card metadata.",
        fix_hint: "Run llm-wiki lint --fix and publish reviewed visibility: public source summaries instead of raw source-card rows.",
        fixable: false,
      });
    }
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

function isRawSourceCardPath(path: string): boolean {
  return /^raw\/inputs\/.+\/_source\.md$/.test(path);
}

function isScaffoldPlaceholderPath(path: string): boolean {
  return basename(path) === ".gitkeep";
}

function isRawLocalLinkTarget(fromPath: string, rawTarget: string): boolean {
  const fileUrlPath = localFileLinkPath(rawTarget);
  if (fileUrlPath !== null) {
    return hasRawPathSegment(fileUrlPath);
  }

  const windowsDrivePath = windowsDriveLinkPath(rawTarget);
  if (windowsDrivePath !== null) {
    return hasRawPathSegment(windowsDrivePath);
  }

  const target = normalizeLocalLinkTarget(stripUrlQueryAndFragment(rawTarget.trim()));
  if (target === "") {
    return false;
  }

  if (isExternalLinkTarget(target)) {
    return false;
  }

  if (isAbsolutePosixRawPath(target)) {
    return true;
  }

  return pathCandidates(fromPath, target).some((candidate) => candidate === "raw" || candidate.startsWith("raw/"));
}

function stripUrlQueryAndFragment(target: string): string {
  const queryIndex = target.indexOf("?");
  const fragmentIndex = target.indexOf("#");
  const endIndex = Math.min(
    queryIndex === -1 ? target.length : queryIndex,
    fragmentIndex === -1 ? target.length : fragmentIndex,
  );

  return target.slice(0, endIndex).trim();
}

function isExternalLinkTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

function isWindowsDrivePath(target: string): boolean {
  return /^[a-z]:[\\/]/i.test(target);
}

function windowsDriveLinkPath(rawTarget: string): string | null {
  const target = normalizeLocalLinkTarget(stripUrlQueryAndFragment(rawTarget.trim()));
  return isWindowsDrivePath(target) ? target : null;
}

function localFileLinkPath(rawTarget: string): string | null {
  const target = normalizeLocalLinkTarget(stripUrlQueryAndFragment(rawTarget.trim()));
  if (!/^file:/i.test(target)) {
    return null;
  }

  try {
    return normalizeLocalLinkTarget(new URL(target).pathname);
  } catch {
    return normalizeLocalLinkTarget(target.replace(/^file:/i, ""));
  }
}

function hasRawPathSegment(path: string): boolean {
  const normalized = normalizePath(path.replaceAll("\\", "/"));
  return normalized.split("/").includes("raw");
}

function isAbsolutePosixRawPath(path: string): boolean {
  return path.startsWith("/") && hasRawPathSegment(path);
}

function normalizeLocalLinkTarget(target: string): string {
  const withDecodedSeparators = target.replace(/%2f/gi, "/").replace(/%5c/gi, "\\");

  try {
    return decodeURI(withDecodedSeparators);
  } catch {
    return withDecodedSeparators;
  }
}

function buildIndexContent(scan: RepoScan): string {
  const visibility = existingIndexVisibility(scan);
  const sourceRows = sourceIndexRows(scan, visibility);
  const groupedPages = new Map<string, IndexTarget[]>();

  for (const target of indexableCuratedTargets(scan, visibility)) {
    const group = targetGroup(target.path);
    groupedPages.set(group, [...(groupedPages.get(group) ?? []), target]);
  }

  return `---
type: index
title: Index
visibility: ${visibility}
source_ids: []
---

# Index

## Overview

## Sources

| Source | Status | Summary | Key pages |
|---|---|---|---|
${sourceRows.join("\n")}

## Concepts

${formatIndexTargetList(groupedPages.get("Concepts") ?? [])}

## Entities

${formatIndexTargetList(groupedPages.get("Entities") ?? [])}

## Topics

${formatIndexTargetList(groupedPages.get("Topics") ?? [])}

## Questions

${formatIndexTargetList(groupedPages.get("Questions") ?? [])}

## Comparisons

${formatIndexTargetList(groupedPages.get("Comparisons") ?? [])}

## Dashboards

## Needs review

## Orphans / weakly connected pages
`;
}

function existingIndexVisibility(scan: RepoScan): string {
  const visibility = scan.curatedPages.find((page) => page.path === "curated/index.md")?.scan.frontmatter?.visibility;
  return typeof visibility === "string" && VALID_VISIBILITIES.has(visibility) ? visibility : "private";
}

function generatedIndexEntries(scan: RepoScan): string[] {
  const visibility = existingIndexVisibility(scan);
  const pageEntries = indexableCuratedTargets(scan, visibility).map((target) => `- ${target.link}`);
  return [...sourceIndexRows(scan, visibility), ...pageEntries].filter((entry) => entry.trim() !== "");
}

type IndexTarget = {
  path: string;
  title: string;
  link: string;
};

function indexableCuratedTargets(scan: RepoScan, indexVisibility = "private"): IndexTarget[] {
  return scan.curatedPages
    .filter((page) => INDEXABLE_CURATED_DIRECTORIES.some((prefix) => page.path.startsWith(prefix)))
    .filter((page) => hasValidCuratedIndexFrontmatter(page))
    .filter((page) => indexVisibility !== "public" || page.scan.frontmatter?.visibility === "public")
    .map((page) => {
      const title = page.scan.frontmatter?.title as string;
      return {
        path: page.path,
        title,
        link: curatedIndexLink(page.path, title),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function sourceSummaryTargets(scan: RepoScan, indexVisibility = "private"): IndexTarget[] {
  if (indexVisibility === "public") {
    return [];
  }

  const summaryPages = new Map(
    scan.curatedPages
      .filter((page) => /^curated\/sources\/[^/]+\.md$/.test(page.path))
      .filter((page) => hasValidCuratedIndexFrontmatter(page))
      .filter((page) => indexVisibility !== "public" || page.scan.frontmatter?.visibility === "public")
      .map((page) => {
        const title = page.scan.frontmatter?.title as string;
        return [
          page.path,
          {
            path: page.path,
            title,
            link: curatedIndexLink(page.path, title),
          },
        ] as const;
      }),
  );

  return scan.sourceCards
    .filter((card) => card.source_id !== null && card.title !== null && !hasSourceCardErrors(card))
    .flatMap((card) => {
      const target = summaryPages.get(`curated/sources/${card.source_id}.md`);
      return target === undefined ? [] : [target];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function sourceIndexRows(scan: RepoScan, indexVisibility: string): string[] {
  const sourceSummaryByPath = new Map(sourceSummaryTargets(scan, indexVisibility).map((target) => [target.path, target]));
  if (indexVisibility === "public") {
    return [...sourceSummaryByPath.values()].map((summary) => `| ${summary.link} | | | |`);
  }

  return scan.sourceCards
    .filter((card) => card.source_id !== null && card.title !== null && !hasSourceCardErrors(card))
    .map((card) => {
      const sourceId = card.source_id ?? "";
      const summaryLink = sourceSummaryByPath.get(`curated/sources/${sourceId}.md`)?.link ?? "";
      return `| ${sourceIndexSourceCell(card, indexVisibility)} | ${card.status ?? ""} | ${summaryLink} | |`;
    });
}

function formatIndexTargetList(targets: IndexTarget[]): string {
  if (targets.length === 0) {
    return "";
  }

  return targets.map((target) => `- ${target.link}`).join("\n");
}

function targetGroup(path: string): string {
  if (path.startsWith("curated/concepts/")) {
    return "Concepts";
  }
  if (path.startsWith("curated/entities/")) {
    return "Entities";
  }
  if (path.startsWith("curated/questions/")) {
    return "Questions";
  }
  if (path.startsWith("curated/comparisons/")) {
    return "Comparisons";
  }

  return "Topics";
}

function hasSourceCardErrors(card: SourceCard): boolean {
  return card.scan.issues.length > 0 || card.source_id === null || card.title === null;
}

function hasValidCuratedIndexFrontmatter(page: RepoMarkdownFile): boolean {
  const frontmatter = page.scan.frontmatter;
  if (!frontmatter) {
    return false;
  }

  const type = frontmatter.type;
  const title = frontmatter.title;
  const visibility = frontmatter.visibility;
  const sourceIds = frontmatter.source_ids;

  return (
    typeof type === "string" &&
    VALID_CURATED_TYPES.has(type) &&
    typeof title === "string" &&
    title.trim() !== "" &&
    typeof visibility === "string" &&
    VALID_VISIBILITIES.has(visibility) &&
    Array.isArray(sourceIds) &&
    sourceIds.every((sourceId) => typeof sourceId === "string" && parseSourceId(sourceId).ok)
  );
}

export function resolveLinks(scan: RepoScan, page: RepoMarkdownFile, linkIndex = createLinkResolutionIndex(scan)): LinkResolution[] {
  return [
    ...resolveWikilinks(scan, page, linkIndex),
    ...page.scan.markdownLinks.map((link) => {
      const resolvedPath = resolveLinkFileTarget(page, link.target, linkIndex);
      const target = resolvedPath === null ? null : (linkIndex.markdownByPath.get(resolvedPath) ?? null);

      return {
        link,
        resolved_path: resolvedPath,
        target,
      };
    }),
  ];
}

function resolveWikilinks(scan: RepoScan, page: RepoMarkdownFile, linkIndex: LinkResolutionIndex): LinkResolution[] {
  return page.scan.wikilinks.map((link) => {
    const resolvedPath = resolveWikilinkTarget(scan, page, link.target, linkIndex);
    const target = resolvedPath === null ? null : (linkIndex.markdownByPath.get(resolvedPath) ?? null);

    return {
      link,
      resolved_path: resolvedPath,
      target,
    };
  });
}

function publicProfileLinkResolutions(scan: RepoScan, page: RepoMarkdownFile, linkIndex: LinkResolutionIndex): LinkResolution[] {
  return [
    ...page.scan.wikilinks.map((link) => {
      const resolvedPath = resolveLinkFileTarget(page, link.target, linkIndex);
      const target = resolvedPath === null ? null : (linkIndex.markdownByPath.get(resolvedPath) ?? null);

      return {
        link,
        resolved_path: resolvedPath,
        target,
      };
    }),
    ...page.scan.markdownLinks.map((link) => {
      const resolvedPath = resolveLinkFileTarget(page, link.target, linkIndex);
      const target = resolvedPath === null ? null : (linkIndex.markdownByPath.get(resolvedPath) ?? null);

      return {
        link,
        resolved_path: resolvedPath,
        target,
      };
    }),
  ];
}

export function createLinkResolutionIndex(scan: RepoScan): LinkResolutionIndex {
  const filePaths = new Set([...scan.files.map((file) => file.path), ...scan.linkableFilePaths]);
  const markdownByPath = new Map<string, RepoMarkdownFile>();
  const markdownByTitle = new Map<string, RepoMarkdownFile>();
  const markdownByBasename = new Map<string, RepoMarkdownFile>();

  for (const file of scan.markdown) {
    markdownByPath.set(file.path, file);

    const title = normalizeTitle(String(file.scan.frontmatter?.title ?? ""));
    if (title !== "" && !markdownByTitle.has(title)) {
      markdownByTitle.set(title, file);
    }

    const basename = normalizeTitle(file.path.split("/").pop()?.replace(/\.md$/, "") ?? "");
    if (!markdownByBasename.has(basename)) {
      markdownByBasename.set(basename, file);
    }
  }

  return {
    filePaths,
    markdownByPath,
    markdownByTitle,
    markdownByBasename,
  };
}

export function resolveWikilinkTarget(
  scan: RepoScan,
  fromPage: RepoMarkdownFile,
  rawTarget: string,
  linkIndex = createLinkResolutionIndex(scan),
): string | null {
  return resolveWikilinkTargetWithOptions(fromPage, rawTarget, { validateHeading: true }, linkIndex);
}

function resolveLinkFileTarget(
  fromPage: RepoMarkdownFile,
  rawTarget: string,
  linkIndex: LinkResolutionIndex,
): string | null {
  return resolveWikilinkTargetWithOptions(fromPage, rawTarget, { validateHeading: false }, linkIndex);
}

function resolveWikilinkTargetWithOptions(
  fromPage: RepoMarkdownFile,
  rawTarget: string,
  options: { validateHeading: boolean },
  linkIndex: LinkResolutionIndex,
): string | null {
  const [targetPart = "", headingPart] = rawTarget.split("#", 2);
  const target = normalizeLocalLinkTarget(stripUrlQueryAndFragment(targetPart).trim());
  if (target === "") {
    return !options.validateHeading || (headingPart !== undefined && hasHeading(fromPage, headingPart)) ? fromPage.path : null;
  }

  const directCandidates = pathCandidates(fromPage.path, target);
  for (const candidate of directCandidates) {
    const markdownTarget = linkIndex.markdownByPath.get(candidate);
    if (markdownTarget !== undefined) {
      return !options.validateHeading || headingPart === undefined || hasHeading(markdownTarget, headingPart) ? candidate : null;
    }

    if (linkIndex.filePaths.has(candidate)) {
      return candidate;
    }
  }

  const normalizedTitle = normalizeTitle(target);
  const titleMatch = linkIndex.markdownByTitle.get(normalizedTitle);
  if (titleMatch) {
    return !options.validateHeading || headingPart === undefined || hasHeading(titleMatch, headingPart) ? titleMatch.path : null;
  }

  const basenameMatch = linkIndex.markdownByBasename.get(normalizedTitle);
  if (!basenameMatch) {
    return null;
  }

  return !options.validateHeading || headingPart === undefined || hasHeading(basenameMatch, headingPart) ? basenameMatch.path : null;
}

function missingProfileIssue(profileName: string): LintIssue {
  return {
    rule_id: "profile_missing",
    severity: "error",
    path: `.llm-wiki/profiles/${profileName}.yml`,
    message: `Profile is missing or invalid: ${profileName}.`,
    fix_hint: "Restore a valid profile YAML file before profile linting.",
    fixable: false,
  };
}

function hasHeading(page: RepoMarkdownFile, heading: string): boolean {
  const normalizedHeading = normalizeTitle(heading);
  if (normalizedHeading === "") {
    return false;
  }

  return page.scan.headings.some((candidate) => normalizeTitle(candidate.text) === normalizedHeading);
}

function pathCandidates(fromPath: string, target: string): string[] {
  const normalizedTarget = target.replaceAll("\\", "/");
  const isAbsoluteTarget = normalizedTarget.startsWith("/");
  const withoutLeadingSlash = normalizedTarget.replace(/^\/+/, "");
  const candidates = new Set<string>();
  const hasMarkdownExtension = /\.md$/i.test(withoutLeadingSlash);
  const add = (path: string) => {
    const normalized = normalizePath(path);
    candidates.add(normalized);
    if (!hasMarkdownExtension) {
      candidates.add(`${normalized}.md`);
    }
  };

  if (!isAbsoluteTarget) {
    add(`${dirname(fromPath)}/${withoutLeadingSlash}`);
  }

  add(withoutLeadingSlash);
  if (!withoutLeadingSlash.startsWith("curated/") && !withoutLeadingSlash.startsWith("raw/")) {
    add(`curated/${withoutLeadingSlash}`);
  }

  return [...candidates];
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.join("/");
}

function matchesProfile(path: string, include: string[], exclude: string[]): boolean {
  return include.some((pattern) => matchesGlob(path, pattern)) && !isProfileExcluded(path, exclude);
}

function selectedForbiddenSkippedProfileRoots(include: string[], exclude: string[]): string[] {
  return PUBLIC_FORBIDDEN_SKIPPED_PROFILE_ROOTS.flatMap((root) =>
    [...root.candidates, ...concreteForbiddenRootCandidates(root.path, include)].some((path) =>
      include.some((pattern) => matchesGlob(path, pattern)) && !isForbiddenRootCandidateExcluded(root.path, path, exclude),
    )
      ? [root.path]
      : [],
  );
}

function selectedSkippedNonMarkdownProfilePaths(include: string[], exclude: string[]): string[] {
  return PUBLIC_SKIPPED_NON_MARKDOWN_PROFILE_PATHS.filter((path) => matchesProfile(path, include, exclude));
}

function concreteForbiddenRootCandidates(rootPath: string, include: string[]): string[] {
  return include.filter((pattern) => pattern === rootPath || pattern.startsWith(`${rootPath}/`) || pattern.startsWith(`${rootPath}**`));
}

function isForbiddenRootCandidateExcluded(rootPath: string, path: string, exclude: string[]): boolean {
  return isProfileExcluded(path, exclude) || (path === rootPath && isProfileExcluded(`${rootPath}/__sentinel__`, exclude));
}

function isProfileExcluded(path: string, exclude: string[]): boolean {
  return exclude.some((pattern) => matchesGlob(path, pattern));
}

function matchesGlob(path: string, pattern: string): boolean {
  const globstarSlash = "\u0000";
  const globstar = "\u0001";
  const regexSource = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", globstarSlash)
    .replaceAll("**", globstar)
    .replaceAll("*", "[^/]*")
    .replaceAll(globstarSlash, "(?:.*/)?")
    .replaceAll(globstar, ".*");

  return new RegExp(`^${regexSource}$`).test(path);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function profileRequiredVisibility(profile: Record<string, unknown>): string {
  const visibility = profile.visibility;
  if (typeof visibility === "object" && visibility !== null && !Array.isArray(visibility)) {
    const requiredValue = (visibility as Record<string, unknown>).required_value;
    if (typeof requiredValue === "string" && requiredValue.trim() !== "") {
      return requiredValue;
    }
  }

  return "public";
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function sourceIndexSourceCell(card: SourceCard, indexVisibility: string): string {
  const title = card.title ?? card.source_id ?? card.path;
  if (indexVisibility === "public") {
    return escapeTableCell(title);
  }

  return sourceIndexLink(card.path, title);
}

function sourceIndexLink(path: string, title: string): string {
  return `[[../${path}|${escapeTableCell(title)}]]`;
}

function curatedIndexLink(path: string, title: string): string {
  return `[[${path.replace(/^curated\//, "").replace(/\.md$/, "")}|${escapeTableCell(title)}]]`;
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\.md$/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function isSystemCuratedPage(path: string): boolean {
  return path === "curated/home.md" || isNavigationSystemPage(path);
}

function isNavigationSystemPage(path: string): boolean {
  return path === "curated/index.md" || path === "curated/log.md" || path.startsWith("curated/dashboards/");
}

function withCounts(result: Pick<LintResult, "issues" | "fixed_paths">): LintResult {
  const error = result.issues.filter((issue) => issue.severity === "error").length;
  const warning = result.issues.filter((issue) => issue.severity === "warning").length;

  return {
    issues: result.issues,
    fixed_paths: result.fixed_paths,
    counts: {
      total: result.issues.length,
      error,
      warning,
      fixed: result.fixed_paths.length,
    },
  };
}

function sortIssues(issues: LintIssue[]): LintIssue[] {
  const severityOrder: Record<LintSeverity, number> = { error: 0, warning: 1 };
  return [...issues].sort((left, right) => {
    const severityDiff = severityOrder[left.severity] - severityOrder[right.severity];
    if (severityDiff !== 0) {
      return severityDiff;
    }

    return (
      left.path.localeCompare(right.path) ||
      left.rule_id.localeCompare(right.rule_id) ||
      (left.line ?? 0) - (right.line ?? 0)
    );
  });
}

function dedupeIssues(issues: LintIssue[]): LintIssue[] {
  const seen = new Set<string>();
  const deduped: LintIssue[] = [];

  for (const issue of issues) {
    const key = `${issue.rule_id}\0${issue.path}\0${issue.line ?? ""}\0${issue.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(issue);
  }

  return deduped;
}

export async function readText(repoRoot: string, path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}
