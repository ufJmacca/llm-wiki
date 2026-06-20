import { createLinkResolutionIndex, resolveLinks } from "../lint/index.js";
import { scanWikiRepository, type RepoMarkdownFile } from "../scanner/repo.js";
import { searchWiki } from "./index.js";

export type QueryContextPageReason = "search" | "nav" | "source";

export type QueryContextPage = {
  path: string;
  title: string;
  reason: QueryContextPageReason;
  source_ids: string[];
  content: string;
};

export type QueryContext = {
  pages: QueryContextPage[];
  source_ids: string[];
};

export type QueryContextOptions = {
  excludePaths?: string[];
};

export async function buildQueryContext(
  repoRoot: string,
  question: string,
  options: QueryContextOptions = {},
): Promise<QueryContext> {
  const [searchResults, scan] = await Promise.all([
    searchWiki(repoRoot, question, { scope: "curated" }),
    scanWikiRepository(repoRoot, { mode: "liveMarkdown" }),
  ]);
  const excludedPaths = new Set(options.excludePaths ?? []);
  const linkIndex = createLinkResolutionIndex(scan);
  const markdownByPath = new Map(scan.markdown.map((page) => [page.path, page]));
  const pages = new Map<string, QueryContextPage>();

  for (const result of searchResults.results) {
    const page = markdownByPath.get(result.path);
    if (page === undefined || excludedPaths.has(page.path) || !isQueryContextPage(page.path)) {
      continue;
    }

    pages.set(page.path, toQueryContextPage(page, "search"));
  }

  for (const page of tokenOverlapPages(scan.markdown, question)) {
    if (!excludedPaths.has(page.path) && !pages.has(page.path)) {
      pages.set(page.path, toQueryContextPage(page, "search"));
    }
  }

  const searchedPages = [...pages.values()]
    .map((page) => markdownByPath.get(page.path))
    .filter((page): page is RepoMarkdownFile => page !== undefined);
  for (const page of searchedPages) {
    for (const link of resolveLinks(scan, page, linkIndex)) {
      const targetPath = link.resolved_path;
      if (targetPath === null || excludedPaths.has(targetPath) || pages.has(targetPath) || !isQueryContextPage(targetPath)) {
        continue;
      }

      const targetPage = markdownByPath.get(targetPath);
      if (targetPage !== undefined) {
        pages.set(targetPath, toQueryContextPage(targetPage, "nav"));
      }
    }
  }

  const sourceIds = new Set<string>();
  for (const page of pages.values()) {
    for (const sourceId of page.source_ids) {
      sourceIds.add(sourceId);
    }
  }

  for (const sourceId of sourceIds) {
    const summaryPath = `curated/sources/${sourceId}.md`;
    if (pages.has(summaryPath)) {
      const existing = pages.get(summaryPath);
      if (existing !== undefined && existing.reason !== "source") {
        pages.set(summaryPath, { ...existing, reason: "source" });
      }
      continue;
    }

    const sourceSummary = markdownByPath.get(summaryPath);
    if (sourceSummary !== undefined && !excludedPaths.has(sourceSummary.path)) {
      pages.set(summaryPath, toQueryContextPage(sourceSummary, "source"));
    }
  }

  const sortedPages = [...pages.values()].sort(compareQueryContextPages);

  return {
    pages: sortedPages,
    source_ids: [...new Set(sortedPages.flatMap((page) => page.source_ids))].sort(),
  };
}

function toQueryContextPage(page: RepoMarkdownFile, reason: QueryContextPageReason): QueryContextPage {
  return {
    path: page.path,
    title: pageTitle(page),
    reason,
    source_ids: sourceIdsForPage(page),
    content: page.content,
  };
}

function compareQueryContextPages(left: QueryContextPage, right: QueryContextPage): number {
  return reasonRank(left.reason) - reasonRank(right.reason) || left.path.localeCompare(right.path);
}

function reasonRank(reason: QueryContextPageReason): number {
  if (reason === "source") {
    return 0;
  }

  if (reason === "search") {
    return 1;
  }

  return 2;
}

function isQueryContextPage(path: string): boolean {
  return path.startsWith("curated/") && path !== "curated/index.md" && path !== "curated/log.md";
}

function tokenOverlapPages(pages: RepoMarkdownFile[], question: string): RepoMarkdownFile[] {
  const queryTokens = meaningfulTokens(question);
  if (queryTokens.length === 0) {
    return [];
  }

  return pages
    .filter((page) => isQueryContextPage(page.path))
    .map((page) => ({
      page,
      score: overlapScore(queryTokens, pageSearchText(page)),
    }))
    .filter((result) => result.score >= Math.min(2, queryTokens.length))
    .sort((left, right) => right.score - left.score || left.page.path.localeCompare(right.page.path))
    .slice(0, 8)
    .map((result) => result.page);
}

function overlapScore(queryTokens: string[], text: string): number {
  const pageTokens = new Set(meaningfulTokens(text));
  return queryTokens.filter((token) => pageTokens.has(token)).length;
}

function pageSearchText(page: RepoMarkdownFile): string {
  return [
    pageTitle(page),
    page.scan.headings.map((heading) => heading.text).join(" "),
    page.scan.body,
    sourceIdsForPage(page).join(" "),
  ].join(" ");
}

function meaningfulTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 2 && !QUERY_STOP_WORDS.has(token)),
    ),
  ].sort();
}

const QUERY_STOP_WORDS = new Set([
  "and",
  "are",
  "can",
  "does",
  "for",
  "from",
  "how",
  "the",
  "this",
  "use",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

function pageTitle(page: RepoMarkdownFile): string {
  const title = page.scan.frontmatter?.title;
  if (typeof title === "string" && title.trim() !== "") {
    return title;
  }

  const heading = page.scan.headings.find((candidate) => candidate.depth === 1);
  if (heading !== undefined && heading.text.trim() !== "") {
    return heading.text;
  }

  return page.path.split("/").pop()?.replace(/\.md$/, "") ?? page.path;
}

function sourceIdsForPage(page: RepoMarkdownFile): string[] {
  const ids = new Set<string>();
  const sourceIds = page.scan.frontmatter?.source_ids;
  if (Array.isArray(sourceIds)) {
    for (const sourceId of sourceIds) {
      if (typeof sourceId === "string" && sourceId.trim() !== "") {
        ids.add(sourceId);
      }
    }
  }

  const sourceId = page.scan.frontmatter?.source_id;
  if (typeof sourceId === "string" && sourceId.trim() !== "") {
    ids.add(sourceId);
  }

  return [...ids].sort();
}
