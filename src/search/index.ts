import { scanWikiRepository, type RepoMarkdownFile } from "../scanner/repo.js";

export type SearchScope = "raw" | "curated" | "all";
export type SearchMatchField = "title" | "alias" | "tag" | "heading" | "body" | "source_id";

export type SearchResult = {
  path: string;
  page_type: string;
  title: string;
  snippet: string;
  score: number;
  source_ids: string[];
  visibility: string | null;
  match_fields: SearchMatchField[];
};

export type SearchWikiResult = {
  query: string;
  scope: SearchScope;
  results: SearchResult[];
};

const FIELD_ORDER: SearchMatchField[] = ["title", "alias", "tag", "heading", "body", "source_id"];

export async function searchWiki(
  repoRoot: string,
  query: string,
  options: { scope?: SearchScope } = {},
): Promise<SearchWikiResult> {
  const scope = options.scope ?? "all";
  const normalizedQuery = normalizeSearchText(query);
  const scan = await scanWikiRepository(repoRoot, { mode: "liveMarkdown" });
  const results = normalizedQuery === ""
    ? []
    : scan.markdown
        .filter((page) => isSearchScopeMatch(page.path, scope))
        .flatMap((page) => {
          const result = scorePage(page, normalizedQuery);
          return result === null ? [] : [result];
        })
        .sort(compareSearchResults);

  return {
    query,
    scope,
    results,
  };
}

function scorePage(page: RepoMarkdownFile, normalizedQuery: string): SearchResult | null {
  const title = pageTitle(page);
  const pageType = pageTypeValue(page);
  const sourceIds = sourceIdsForPage(page);
  const aliases = frontmatterStringList(page, "aliases");
  const tags = frontmatterStringList(page, "tags");
  const headingMatch = page.scan.headings.find((heading) => fieldMatches(heading.text, normalizedQuery));
  const bodyMatch = bodyMatchLine(page, normalizedQuery);
  const matchFields = new Set<SearchMatchField>();
  let score = 0;
  let snippet = "";

  if (fieldMatches(title, normalizedQuery)) {
    score += 100;
    matchFields.add("title");
    snippet ||= title;
  }

  const aliasMatch = aliases.find((alias) => fieldMatches(alias, normalizedQuery));
  if (aliasMatch !== undefined) {
    score += 80;
    matchFields.add("alias");
    snippet ||= aliasMatch;
  }

  const tagMatch = tags.find((tag) => fieldMatches(tag, normalizedQuery));
  if (tagMatch !== undefined) {
    score += 60;
    matchFields.add("tag");
    snippet ||= tagMatch;
  }

  if (headingMatch !== undefined) {
    score += 50;
    matchFields.add("heading");
    snippet ||= headingMatch.text;
  }

  if (bodyMatch !== null) {
    score += 10;
    matchFields.add("body");
    snippet ||= bodyMatch;
  }

  if (sourceIds.some((sourceId) => fieldMatches(sourceId, normalizedQuery))) {
    score += pageType === "raw_source" ? 50 : 45;
    matchFields.add("source_id");
    snippet ||= sourceIds.find((sourceId) => fieldMatches(sourceId, normalizedQuery)) ?? "";
  }

  if (score === 0) {
    return null;
  }

  return {
    path: page.path,
    page_type: pageType,
    title,
    snippet,
    score,
    source_ids: sourceIds,
    visibility: visibilityValue(page),
    match_fields: FIELD_ORDER.filter((field) => matchFields.has(field)),
  };
}

function compareSearchResults(left: SearchResult, right: SearchResult): number {
  return (
    right.score - left.score ||
    pageTypeRank(left.page_type) - pageTypeRank(right.page_type) ||
    left.path.localeCompare(right.path)
  );
}

function pageTypeRank(pageType: string): number {
  return pageType === "raw_source" ? 0 : 1;
}

function isSearchScopeMatch(path: string, scope: SearchScope): boolean {
  if (!isSearchableWikiPath(path)) {
    return false;
  }

  if (scope === "raw") {
    return isRawSourceCardPath(path);
  }

  if (scope === "curated") {
    return path.startsWith("curated/");
  }

  return isRawSourceCardPath(path) || path.startsWith("curated/");
}

function isSearchableWikiPath(path: string): boolean {
  return (
    (isRawSourceCardPath(path) || path.startsWith("curated/")) &&
    path !== "curated/home.md" &&
    path !== "curated/index.md" &&
    path !== "curated/log.md" &&
    !path.startsWith("curated/dashboards/")
  );
}

function isRawSourceCardPath(path: string): boolean {
  return /^raw\/inputs\/.+\/_source\.md$/.test(path);
}

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

function pageTypeValue(page: RepoMarkdownFile): string {
  const type = page.scan.frontmatter?.type;
  return typeof type === "string" && type.trim() !== "" ? type : "page";
}

function visibilityValue(page: RepoMarkdownFile): string | null {
  const visibility = page.scan.frontmatter?.visibility;
  return typeof visibility === "string" && visibility.trim() !== "" ? visibility : null;
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

function frontmatterStringList(page: RepoMarkdownFile, key: string): string[] {
  const value = page.scan.frontmatter?.[key];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  }

  return typeof value === "string" && value.trim() !== "" ? [value] : [];
}

function bodyMatchLine(page: RepoMarkdownFile, normalizedQuery: string): string | null {
  for (const line of page.scan.body.split(/\r?\n/)) {
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) {
      continue;
    }

    const snippet = stripMarkdownForSnippet(line);
    if (snippet === "" || !fieldMatches(snippet, normalizedQuery)) {
      continue;
    }

    return snippet;
  }

  return null;
}

function stripMarkdownForSnippet(line: string): string {
  return line
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[\s>*_`#-]+/, "")
    .replace(/[*_`]+/g, "")
    .trim();
}

function fieldMatches(value: string, normalizedQuery: string): boolean {
  return normalizeSearchText(value).includes(normalizedQuery);
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
