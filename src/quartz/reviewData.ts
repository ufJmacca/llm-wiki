import { collectLintIssues, type LintIssue, type LintResult } from "../lint/index.js";
import { matchesFileProfile, selectMarkdownForProfile, type WikiProfile } from "../profiles/index.js";
import type { RuntimeLogEntry } from "../scanner/index.js";
import type { RepoMarkdownFile, RepoScan, SourceCard } from "../scanner/repo.js";

export type ReviewDataModel = {
  generated_at: string;
  profile: ReviewProfileMetadata | null;
  queue: ReviewQueueData;
  recent_ingests: ReviewCategory<ReviewRecentIngestItem>;
  needs_review: ReviewCategory<ReviewPageItem>;
  contradictions: ReviewCategory<ReviewContradictionItem>;
  stale_pages: ReviewCategory<ReviewStalePageItem>;
  orphans: ReviewCategory<ReviewLintPageItem>;
  visibility_warnings: ReviewCategory<ReviewLintIssueItem>;
};

export type ReviewProfileMetadata = {
  requested_name: WikiProfile["requestedName"];
  source_name: string;
  path: string;
  base_url: string | null;
  custom_domain: string | null;
  include: string[];
  exclude: string[];
  include_private: boolean;
  required_visibility: string | null;
};

export type ReviewQueueData = {
  counts: {
    total: number;
    queued: number;
    ingesting: number;
    blocked: number;
    completed: number;
  };
  items: ReviewQueueItem[];
};

export type ReviewQueueItem = {
  source_id: string;
  title: string;
  source_kind: string;
  status: "queued" | "ingesting" | "ingested" | "blocked";
  visibility: string | null;
  source_card_path: string | null;
  source_card_materialized: boolean;
  queue_path: string;
  original_path: string | null;
  captured_at: string | null;
  updated_at: string | null;
};

export type ReviewCategory<Item> = {
  count: number;
  items: Item[];
};

export type ReviewRecentIngestItem = {
  source_id: string;
  title: string;
  timestamp: string;
  log_path: string;
  log_line: number;
  source_card_path: string | null;
  queue_path: string | null;
};

export type ReviewPageItem = {
  path: string;
  title: string | null;
  page_type: string | null;
  visibility: string | null;
  source_ids: string[];
  review_status: string;
};

export type ReviewContradictionItem =
  | {
      source: "frontmatter";
      path: string;
      title: string | null;
      page_type: string | null;
      visibility: string | null;
      source_ids: string[];
    }
  | {
      source: "log";
      path: string;
      line: number;
      source_id: string;
      title: string;
      timestamp: string;
      text: string;
    };

export type ReviewStalePageItem =
  | {
      source: "lint";
      path: string;
      rule_id: string;
      severity: LintIssue["severity"];
      message: string;
      fix_hint: string;
    }
  | {
      source: "frontmatter";
      path: string;
      title: string | null;
      page_type: string | null;
      visibility: string | null;
      source_ids: string[];
      next_review: string;
    };

export type ReviewLintPageItem = ReviewLintIssueItem & {
  title: string | null;
  page_type: string | null;
  visibility: string | null;
  source_ids: string[];
};

export type ReviewLintIssueItem = {
  path: string;
  line: number | null;
  rule_id: string;
  severity: LintIssue["severity"];
  message: string;
  fix_hint: string;
};

export type BuildReviewDataModelOptions = {
  generatedAt?: Date;
  lintResult?: LintResult;
  materializedMarkdownPaths?: ReadonlySet<string>;
  profile?: WikiProfile;
};

const CONTRADICTION_TAGS = new Set(["contradiction", "contradictions"]);

export function buildReviewDataModel(
  scan: RepoScan,
  options: BuildReviewDataModelOptions = {},
): ReviewDataModel {
  const generatedAt = options.generatedAt ?? new Date();
  const reviewScan = options.profile === undefined ? scan : filterReviewScanForProfile(scan, options.profile);
  const lintIssues = options.lintResult?.issues ?? collectLintIssues(reviewScan, lintOptionsForProfile(options.profile));
  const visibilityLintIssues = options.lintResult?.issues ?? visibilityLintIssuesForProfile(reviewScan, options.profile, lintIssues);
  const materializedMarkdownPaths = options.materializedMarkdownPaths ?? defaultMaterializedMarkdownPaths(options.profile);

  return {
    generated_at: generatedAt.toISOString(),
    profile: options.profile === undefined ? null : toProfileMetadata(options.profile),
    queue: buildQueueData(reviewScan, materializedMarkdownPaths),
    recent_ingests: category(buildRecentIngestItems(reviewScan)),
    needs_review: category(buildNeedsReviewItems(reviewScan)),
    contradictions: category(buildContradictionItems(reviewScan)),
    stale_pages: category(buildStalePageItems(reviewScan, lintIssues, generatedAt)),
    orphans: category(buildOrphanItems(reviewScan, lintIssues)),
    visibility_warnings: category(buildVisibilityWarningItems(visibilityLintIssues, options.profile)),
  };
}

export function filterReviewScanForProfile(scan: RepoScan, profile: WikiProfile): RepoScan {
  const selection = selectMarkdownForProfile(profile, scan.markdown, scan.rawOriginals);
  const selectedMarkdownPaths = new Set(selection.markdown.map((file) => file.path));
  const queueFiles = scan.queueFiles.filter((file) => matchesFileProfile(file.path, profile));
  const selectedQueuePaths = new Set(queueFiles.map((file) => file.path));

  return {
    ...scan,
    files: scan.files.filter((file) => matchesFileProfile(file.path, profile)),
    linkableFilePaths: scan.linkableFilePaths.filter((path) => matchesFileProfile(path, profile)),
    markdown: selection.markdown,
    curatedPages: selection.markdown.filter((file) => file.path.startsWith("curated/")),
    sourceCards: scan.sourceCards.filter((card) => selectedMarkdownPaths.has(card.path)),
    queueFiles,
    queueItems: scan.queueItems.filter((file) => selectedQueuePaths.has(file.path)),
    rawOriginals: scan.rawOriginals.filter((file) => matchesFileProfile(file.path, profile)),
    log: scan.log !== null && selectedMarkdownPaths.has(scan.log.path) ? scan.log : null,
  };
}

function defaultMaterializedMarkdownPaths(profile: WikiProfile | undefined): ReadonlySet<string> | undefined {
  if (profile === undefined) {
    return undefined;
  }

  return new Set();
}

function lintOptionsForProfile(profile: WikiProfile | undefined): { profile?: string; strict?: boolean } {
  if (profile === undefined) {
    return {};
  }

  return {
    profile: profile.sourceName,
    strict: profile.requestedName === "public" || profile.requestedName === "github-pages",
  };
}

function visibilityLintIssuesForProfile(
  scan: RepoScan,
  profile: WikiProfile | undefined,
  lintIssues: readonly LintIssue[],
): readonly LintIssue[] {
  if (profile === undefined || profile.requestedName === "public" || profile.requestedName === "github-pages") {
    return lintIssues;
  }

  return collectLintIssues(scan, { profile: "public", strict: true });
}

function toProfileMetadata(profile: WikiProfile): ReviewProfileMetadata {
  return {
    requested_name: profile.requestedName,
    source_name: profile.sourceName,
    path: profile.path,
    base_url: profile.baseUrl,
    custom_domain: profile.customDomain,
    include: [...profile.include],
    exclude: [...profile.exclude],
    include_private: profile.includePrivate,
    required_visibility: profile.requiredVisibility,
  };
}

function buildQueueData(scan: RepoScan, materializedMarkdownPaths: ReadonlySet<string> | undefined): ReviewQueueData {
  const sourceCardsById = new Map(
    scan.sourceCards.flatMap((card) => (card.source_id === null ? [] : [[card.source_id, card] as const])),
  );
  const items = scan.queueItems
    .map((queueFile) => {
      const card = sourceCardsById.get(queueFile.item.source_id);
      const sourceKind = stringValue(card?.scan.frontmatter?.source_kind) ?? stringValue(queueFile.item.source_kind) ?? queueFile.item.kind;

      return {
        source_id: queueFile.item.source_id,
        title: card?.title ?? queueFile.item.title,
        source_kind: sourceKind,
        status: queueFile.item.status,
        visibility: card?.visibility ?? stringValue(queueFile.item.visibility),
        source_card_path: card?.path ?? stringValue(queueFile.item.path),
        source_card_materialized: card === undefined ? false : (materializedMarkdownPaths?.has(card.path) ?? true),
        queue_path: queueFile.path,
        original_path: stringValue(queueFile.item.original_path),
        captured_at: stringValue(card?.scan.frontmatter?.captured_at) ?? stringValue(queueFile.item.captured_at),
        updated_at: stringValue(card?.scan.frontmatter?.updated_at) ?? stringValue(queueFile.item.updated_at),
      };
    })
    .sort(compareQueueItemsNewestFirst);

  return {
    counts: {
      total: items.length,
      queued: items.filter((item) => item.status === "queued").length,
      ingesting: items.filter((item) => item.status === "ingesting").length,
      blocked: items.filter((item) => item.status === "blocked").length,
      completed: items.filter((item) => item.status === "ingested").length,
    },
    items,
  };
}

function compareQueueItemsNewestFirst(left: ReviewQueueItem, right: ReviewQueueItem): number {
  const leftKey = left.captured_at ?? left.updated_at ?? "";
  const rightKey = right.captured_at ?? right.updated_at ?? "";

  return rightKey.localeCompare(leftKey) || right.source_id.localeCompare(left.source_id);
}

function buildRecentIngestItems(scan: RepoScan): ReviewRecentIngestItem[] {
  const sourceCardsById = sourceCardsByIdMap(scan);
  const queuePathsById = new Map(scan.queueItems.map((queueFile) => [queueFile.item.source_id, queueFile.path]));

  return (scan.log?.scan.entries ?? [])
    .filter((entry) => entry.operation === "ingest")
    .map((entry) => ({
      source_id: entry.affectedId,
      title: entry.title,
      timestamp: entry.timestamp,
      log_path: entry.path,
      log_line: entry.line,
      source_card_path: sourceCardsById.get(entry.affectedId)?.path ?? null,
      queue_path: queuePathsById.get(entry.affectedId) ?? null,
    }))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || left.source_id.localeCompare(right.source_id));
}

function buildNeedsReviewItems(scan: RepoScan): ReviewPageItem[] {
  return scan.curatedPages
    .filter((page) => stringValue(page.scan.frontmatter?.review_status) === "needs-human-review")
    .map((page) => ({
      ...toPageItem(page),
      review_status: "needs-human-review",
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildContradictionItems(scan: RepoScan): ReviewContradictionItem[] {
  const frontmatterItems: ReviewContradictionItem[] = scan.curatedPages
    .filter(hasContradictionFrontmatterSignal)
    .map((page) => ({
      source: "frontmatter" as const,
      ...toPageItem(page),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const logItems = (scan.log?.scan.entries ?? []).flatMap(logContradictionItems);

  return [...frontmatterItems, ...logItems];
}

function hasContradictionFrontmatterSignal(page: RepoMarkdownFile): boolean {
  if (page.path.startsWith("curated/contradictions/")) {
    return true;
  }

  const tags = stringArrayValue(page.scan.frontmatter?.tags);
  if (tags.some((tag) => CONTRADICTION_TAGS.has(tag.trim().toLowerCase()))) {
    return true;
  }

  const contradictions = page.scan.frontmatter?.contradictions;
  return typeof contradictions === "string" ? contradictions.trim() !== "" : Array.isArray(contradictions) && contradictions.length > 0;
}

function logContradictionItems(entry: RuntimeLogEntry): ReviewContradictionItem[] {
  return readLogContradictions(entry.body).map((text) => ({
    source: "log",
    path: entry.path,
    line: entry.line,
    source_id: entry.affectedId,
    title: entry.title,
    timestamp: entry.timestamp,
    text,
  }));
}

function readLogContradictions(body: string): string[] {
  const lines = body.split(/\r?\n/u);
  const contradictions: string[] = [];
  let inContradictionSection = false;

  for (const line of lines) {
    const section = /^- contradictions:\s*(.*)$/u.exec(line);
    if (section) {
      inContradictionSection = true;
      const inlineValue = normalizeLogListValue(section[1] ?? "");
      if (isRealContradictionValue(inlineValue)) {
        contradictions.push(inlineValue);
      }
      continue;
    }

    if (!inContradictionSection) {
      continue;
    }

    if (/^- [^-\s][^:]*:/u.test(line)) {
      break;
    }

    const listValue = /^\s+-\s+(.*)$/u.exec(line);
    if (listValue) {
      const value = normalizeLogListValue(listValue[1] ?? "");
      if (isRealContradictionValue(value)) {
        contradictions.push(value);
      }
    }
  }

  return contradictions;
}

function normalizeLogListValue(value: string): string {
  return value.trim().replace(/^["']|["']$/gu, "");
}

function isRealContradictionValue(value: string): boolean {
  return value !== "" && value.toLowerCase() !== "none";
}

function buildStalePageItems(scan: RepoScan, lintIssues: readonly LintIssue[], generatedAt: Date): ReviewStalePageItem[] {
  const lintItems = lintIssues
    .filter((issue) => issue.rule_id === "index_stale")
    .map((issue) => ({
      source: "lint" as const,
      path: issue.path,
      rule_id: issue.rule_id,
      severity: issue.severity,
      message: issue.message,
      fix_hint: issue.fix_hint,
    }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.rule_id.localeCompare(right.rule_id));
  const frontmatterItems = scan.curatedPages
    .flatMap((page) => {
      const nextReview = stringValue(page.scan.frontmatter?.next_review);
      if (nextReview === null || !isDueBy(nextReview, generatedAt)) {
        return [];
      }

      return [
        {
          source: "frontmatter" as const,
          ...toPageItem(page),
          next_review: nextReview,
        },
      ];
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return [...lintItems, ...frontmatterItems];
}

function isDueBy(dateValue: string, generatedAt: Date): boolean {
  const parsed = Date.parse(dateValue);
  return Number.isFinite(parsed) && parsed <= generatedAt.getTime();
}

function buildOrphanItems(scan: RepoScan, lintIssues: readonly LintIssue[]): ReviewLintPageItem[] {
  const pagesByPath = new Map(scan.curatedPages.map((page) => [page.path, page]));

  return lintIssues
    .filter((issue) => issue.rule_id === "orphan_page")
    .map((issue) => {
      const page = pagesByPath.get(issue.path);

      return {
        ...toLintIssueItem(issue),
        title: page === undefined ? null : titleValue(page),
        page_type: page === undefined ? null : stringValue(page.scan.frontmatter?.type),
        visibility: page === undefined ? null : stringValue(page.scan.frontmatter?.visibility),
        source_ids: page === undefined ? [] : sourceIdsValue(page),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildVisibilityWarningItems(lintIssues: readonly LintIssue[], profile: WikiProfile | undefined): ReviewLintIssueItem[] {
  return lintIssues
    .filter((issue) => isVisibilityWarningRule(issue.rule_id))
    .filter((issue) => profile === undefined || matchesFileProfile(issue.path, profile))
    .map(toLintIssueItem)
    .sort((left, right) => left.path.localeCompare(right.path) || left.rule_id.localeCompare(right.rule_id));
}

function isVisibilityWarningRule(ruleId: string): boolean {
  return ruleId.startsWith("public_") || ruleId === "raw_sources_default_private";
}

function toLintIssueItem(issue: LintIssue): ReviewLintIssueItem {
  return {
    path: issue.path,
    line: issue.line ?? null,
    rule_id: issue.rule_id,
    severity: issue.severity,
    message: issue.message,
    fix_hint: issue.fix_hint,
  };
}

function toPageItem(page: RepoMarkdownFile): Omit<ReviewPageItem, "review_status"> {
  return {
    path: page.path,
    title: titleValue(page),
    page_type: stringValue(page.scan.frontmatter?.type),
    visibility: stringValue(page.scan.frontmatter?.visibility),
    source_ids: sourceIdsValue(page),
  };
}

function titleValue(page: RepoMarkdownFile): string | null {
  return stringValue(page.scan.frontmatter?.title) ?? page.scan.headings[0]?.text ?? null;
}

function sourceIdsValue(page: RepoMarkdownFile): string[] {
  return stringArrayValue(page.scan.frontmatter?.source_ids);
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sourceCardsByIdMap(scan: RepoScan): Map<string, SourceCard> {
  return new Map(scan.sourceCards.flatMap((card) => (card.source_id === null ? [] : [[card.source_id, card] as const])));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function category<Item>(items: Item[]): ReviewCategory<Item> {
  return {
    count: items.length,
    items,
  };
}
