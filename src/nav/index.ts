import { basename } from "node:path";

import {
  createLinkResolutionIndex,
  resolveWikilinkTarget,
  type LinkResolutionIndex,
} from "../lint/index.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { type WikiLink } from "../scanner/index.js";
import {
  listRepositoryFilePaths,
  scanWikiRepository,
  type RepoMarkdownFile,
  type RepoScan,
  type SourceCard,
} from "../scanner/repo.js";

export type NavPage = {
  path: string;
  title: string;
  page_type: string;
  visibility: string | null;
  source_ids: string[];
};

export type NavLink = {
  from_path: string;
  to_path: string | null;
  target: string;
  alias: string | null;
  raw: string;
  line: number;
  target_title: string | null;
  target_type: string | null;
};

export type NavLinksResult = {
  page: NavPage;
  links: NavLink[];
};

export type NavSourcesResult = {
  page: NavPage;
  sources: Array<{
    source_id: string;
    title: string;
    status: string | null;
    visibility: string | null;
    source_card_path: string | null;
    summary_path: string | null;
    summary_title: string | null;
  }>;
};

export type NavOrphansResult = {
  orphans: NavPage[];
};

export type NavGraphResult = {
  nodes: Array<NavPage & { id: string; label: string }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string | null;
    raw: string;
  }>;
};

export async function getOutlinks(repoRoot: string, pageRef: string): Promise<NavLinksResult> {
  const context = await loadNavContext(repoRoot);
  const page = resolvePageRef(context.scan, pageRef);

  return {
    page: toNavPage(page),
    links: page.scan.wikilinks.map((link) => toNavLink(context.scan, context.linkIndex, page, link)),
  };
}

export async function getBacklinks(repoRoot: string, pageRef: string): Promise<NavLinksResult> {
  const context = await loadNavContext(repoRoot);
  const page = resolvePageRef(context.scan, pageRef);
  const links = context.scan.markdown.flatMap((candidate) =>
    candidate.scan.wikilinks
      .map((link) => toNavLink(context.scan, context.linkIndex, candidate, link))
      .filter((link) => link.to_path === page.path && link.from_path !== page.path),
  );

  return {
    page: toNavPage(page),
    links: links.sort(compareNavLinks),
  };
}

export async function getPageSources(repoRoot: string, pageRef: string): Promise<NavSourcesResult> {
  const context = await loadNavContext(repoRoot);
  const page = resolvePageRef(context.scan, pageRef);
  const cardsBySourceId = new Map(
    context.scan.sourceCards.flatMap((card) => (card.source_id === null ? [] : [[card.source_id, card] as const])),
  );
  const summariesBySourceId = new Map(
    context.scan.curatedPages
      .filter((candidate) => /^curated\/sources\/[^/]+\.md$/.test(candidate.path))
      .flatMap((summary) => sourceIdsForPage(summary).map((sourceId) => [sourceId, summary] as const)),
  );

  return {
    page: toNavPage(page),
    sources: sourceIdsForPage(page).map((sourceId) => {
      const card = cardsBySourceId.get(sourceId);
      const summary = summariesBySourceId.get(sourceId);

      return {
        source_id: sourceId,
        title: card?.title ?? summary?.scan.frontmatter?.title?.toString() ?? sourceId,
        status: card?.status ?? null,
        visibility: card?.visibility ?? null,
        source_card_path: card?.path ?? null,
        summary_path: summary?.path ?? null,
        summary_title: summary ? pageTitle(summary) : null,
      };
    }),
  };
}

export async function getOrphans(repoRoot: string): Promise<NavOrphansResult> {
  const context = await loadNavContext(repoRoot);
  const incoming = new Set<string>();

  for (const page of context.scan.curatedPages) {
    if (isNavigationSystemPage(page.path)) {
      continue;
    }

    for (const link of page.scan.wikilinks) {
      const resolvedPath = resolveWikilinkTarget(context.scan, page, link.target, context.linkIndex);
      if (resolvedPath?.startsWith("curated/") && resolvedPath !== page.path) {
        incoming.add(resolvedPath);
      }
    }
  }

  return {
    orphans: context.scan.curatedPages
      .filter((page) => isOrphanCandidate(page.path))
      .filter((page) => !incoming.has(page.path))
      .map(toNavPage)
      .sort(compareNavPages),
  };
}

export async function getGraph(repoRoot: string): Promise<NavGraphResult> {
  const context = await loadNavContext(repoRoot);
  const markdownByPath = context.linkIndex.markdownByPath;
  const nodes = context.scan.markdown
    .filter((page) => isGraphPage(page.path))
    .map((page) => {
      const navPage = toNavPage(page);

      return {
        ...navPage,
        id: page.path,
        label: navPage.title,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = context.scan.markdown
    .filter((page) => isGraphPage(page.path))
    .flatMap((page) =>
      page.scan.wikilinks.flatMap((link) => {
        const target = resolveWikilinkTarget(context.scan, page, link.target, context.linkIndex);
        if (target === null || !nodeIds.has(target) || !markdownByPath.has(target)) {
          return [];
        }

        return [
          {
            id: `${page.path}->${target}:${link.line}:${link.column}`,
            source: page.path,
            target,
            label: link.alias,
            raw: link.raw,
          },
        ];
      }),
    )
    .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));

  return { nodes, edges };
}

async function loadNavContext(repoRoot: string): Promise<{
  scan: RepoScan;
  linkIndex: LinkResolutionIndex;
}> {
  const [scan, filePaths] = await Promise.all([
    scanWikiRepository(repoRoot, { mode: "liveMarkdown" }),
    listRepositoryFilePaths(repoRoot),
  ]);
  const linkIndex = createLinkResolutionIndex(scan);

  return {
    scan,
    linkIndex: {
      ...linkIndex,
      filePaths: new Set([...linkIndex.filePaths, ...filePaths]),
    },
  };
}

function toNavLink(
  scan: RepoScan,
  linkIndex: LinkResolutionIndex,
  fromPage: RepoMarkdownFile,
  link: WikiLink,
): NavLink {
  const toPath = resolveWikilinkTarget(scan, fromPage, link.target, linkIndex);
  const target = toPath === null ? null : (linkIndex.markdownByPath.get(toPath) ?? null);

  return {
    from_path: fromPage.path,
    to_path: toPath,
    target: link.target,
    alias: link.alias,
    raw: link.raw,
    line: link.line,
    target_title: target ? pageTitle(target) : null,
    target_type: target ? pageType(target) : null,
  };
}

function resolvePageRef(scan: RepoScan, pageRef: string): RepoMarkdownFile {
  const byPath = new Map(scan.markdown.map((page) => [page.path, page]));
  const normalizedRef = normalizePathRef(pageRef);
  const pathCandidates = [
    normalizedRef,
    normalizedRef.endsWith(".md") ? normalizedRef : `${normalizedRef}.md`,
    normalizedRef.startsWith("curated/") ? normalizedRef : `curated/${normalizedRef}`,
    normalizedRef.startsWith("curated/") || normalizedRef.endsWith(".md")
      ? normalizedRef
      : `curated/${normalizedRef}.md`,
  ];

  for (const candidate of pathCandidates) {
    const page = byPath.get(candidate);
    if (page !== undefined) {
      return page;
    }
  }

  const normalizedTitle = normalizeTitle(pageRef);
  const titleMatch = scan.markdown.find((page) => normalizeTitle(pageTitle(page)) === normalizedTitle);
  if (titleMatch !== undefined) {
    return titleMatch;
  }

  const basenameMatch = scan.markdown.find((page) => normalizeTitle(basename(page.path, ".md")) === normalizedTitle);
  if (basenameMatch !== undefined) {
    return basenameMatch;
  }

  throw new RuntimeCommandError({
    code: "NAV_PAGE_NOT_FOUND",
    message: `Page not found: ${pageRef}`,
    hint: "Pass an existing Markdown path, page title, or source card path.",
    path: pageRef,
  });
}

function toNavPage(page: RepoMarkdownFile): NavPage {
  return {
    path: page.path,
    title: pageTitle(page),
    page_type: pageType(page),
    visibility: visibility(page),
    source_ids: sourceIdsForPage(page),
  };
}

function pageTitle(page: RepoMarkdownFile | SourceCard): string {
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

function pageType(page: RepoMarkdownFile): string {
  const type = page.scan.frontmatter?.type;
  return typeof type === "string" && type.trim() !== "" ? type : "page";
}

function visibility(page: RepoMarkdownFile): string | null {
  const value = page.scan.frontmatter?.visibility;
  return typeof value === "string" && value.trim() !== "" ? value : null;
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

function compareNavLinks(left: NavLink, right: NavLink): number {
  return left.from_path.localeCompare(right.from_path) || left.line - right.line || left.raw.localeCompare(right.raw);
}

function compareNavPages(left: NavPage, right: NavPage): number {
  return left.path.localeCompare(right.path);
}

function isGraphPage(path: string): boolean {
  return path.startsWith("curated/") || isRawSourceCardPath(path);
}

function isRawSourceCardPath(path: string): boolean {
  return /^raw\/inputs\/.+\/_source\.md$/.test(path);
}

function isOrphanCandidate(path: string): boolean {
  return (
    !isSystemOrGeneratedCuratedPage(path) &&
    [
      "curated/concepts/",
      "curated/entities/",
      "curated/topics/",
      "curated/questions/",
      "curated/comparisons/",
    ].some((prefix) => path.startsWith(prefix))
  );
}

function isSystemOrGeneratedCuratedPage(path: string): boolean {
  return path === "curated/home.md" || isNavigationSystemPage(path);
}

function isNavigationSystemPage(path: string): boolean {
  return path === "curated/index.md" || path === "curated/log.md" || path.startsWith("curated/dashboards/");
}

function normalizePathRef(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\.md$/, "").replace(/[^a-z0-9]+/g, " ").trim();
}
