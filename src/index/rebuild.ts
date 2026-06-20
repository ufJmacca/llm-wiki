import { dirname } from "node:path";

import { createLinkResolutionIndex, resolveLinks } from "../lint/index.js";
import { computeContentHash } from "../scanner/index.js";
import { scanWikiRepository, type RepoMarkdownFile, type RepoScan, type SourceCard } from "../scanner/repo.js";
import { validateTextFileWriteInsideRoot, writeTextFileInsideRoot } from "../utils/fs.js";

export type IndexRebuildResult = {
  cache_files: string[];
  pages: number;
  sources: number;
  queue_items: number;
  links: number;
  content_hash: string;
};

const CACHE_FILES = [
  ".llm-wiki/cache/graph.json",
  ".llm-wiki/cache/metadata.json",
  ".llm-wiki/cache/pages.json",
  ".llm-wiki/cache/queue.json",
  ".llm-wiki/cache/sources.json",
] as const;

export async function rebuildIndexCache(repoRoot: string): Promise<IndexRebuildResult> {
  const scan = await scanWikiRepository(repoRoot);
  const pages = buildPagesCache(scan);
  const sources = buildSourcesCache(scan);
  const queue = buildQueueCache(scan);
  const graph = buildGraphCache(scan);
  const contentHash = computeContentHash(stableJson({ pages, sources, queue, graph }));
  const metadata = {
    generated_at: new Date().toISOString(),
    authoritative: false,
    content_hash: contentHash,
    inputs: {
      markdown_pages: pages.pages.length,
      source_cards: sources.sources.length,
      queue_items: queue.queue.length,
      links: graph.links.length,
    },
  };

  await Promise.all(CACHE_FILES.map((path) => assertCacheWriteTarget(repoRoot, path)));
  await Promise.all([
    writeJson(repoRoot, ".llm-wiki/cache/pages.json", pages),
    writeJson(repoRoot, ".llm-wiki/cache/sources.json", sources),
    writeJson(repoRoot, ".llm-wiki/cache/queue.json", queue),
    writeJson(repoRoot, ".llm-wiki/cache/graph.json", graph),
    writeJson(repoRoot, ".llm-wiki/cache/metadata.json", metadata),
  ]);

  return {
    cache_files: [...CACHE_FILES],
    pages: pages.pages.length,
    sources: sources.sources.length,
    queue_items: queue.queue.length,
    links: graph.links.length,
    content_hash: contentHash,
  };
}

function buildPagesCache(scan: RepoScan) {
  return {
    pages: scan.curatedPages
      .filter((page) => page.scan.frontmatter !== undefined)
      .map((page) => ({
        path: page.path,
        title: stringFrontmatterValue(page, "title") ?? titleFromPath(page.path),
        type: stringFrontmatterValue(page, "type") ?? "page",
        visibility: stringFrontmatterValue(page, "visibility"),
        source_ids: stringArrayFrontmatterValue(page, "source_ids"),
        content_hash: page.content_hash,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function buildSourcesCache(scan: RepoScan) {
  const queueByCardPath = new Map(scan.queueItems.map((queueFile) => [String(queueFile.item.path), queueFile.item]));
  const originalsByPath = new Map(scan.rawOriginals.map((original) => [original.path, original]));

  return {
    sources: scan.sourceCards
      .filter((card) => card.source_id !== null)
      .map((card) => {
        const queueItem = queueByCardPath.get(card.path);
        const queuedOriginalPath = nonEmptyString(queueItem?.original_path);
        const adjacentOriginal = sourceCardOriginal(scan, card);
        const originalPath = queuedOriginalPath ?? adjacentOriginal?.path ?? null;
        const original = originalPath === null ? undefined : originalsByPath.get(originalPath);
        const expectedHash = nonEmptyString(queueItem?.content_hash) ?? card.content_hash_field ?? "";

        return {
          source_id: card.source_id ?? "",
          title: card.title ?? "",
          status: card.status ?? "",
          visibility: card.visibility ?? "",
          content_hash: expectedHash,
          original_path: originalPath,
          card_path: card.path,
          hash_valid: original === undefined || expectedHash === "" ? null : original.content_hash === expectedHash,
        };
      })
      .sort((left, right) => left.source_id.localeCompare(right.source_id)),
  };
}

function sourceCardOriginal(scan: RepoScan, card: SourceCard): RepoScan["rawOriginals"][number] | null {
  const expectedPrefix = `${dirname(card.path)}/original.`;
  return scan.rawOriginals.find((original) => original.path.startsWith(expectedPrefix)) ?? null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function buildQueueCache(scan: RepoScan) {
  return {
    queue: scan.queueItems
      .map((queueFile) => ({
        source_id: queueFile.item.source_id,
        title: queueFile.item.title,
        status: queueFile.item.status,
        path: String(queueFile.item.path),
        original_path: String(queueFile.item.original_path ?? ""),
      }))
      .sort((left, right) => left.source_id.localeCompare(right.source_id)),
  };
}

function buildGraphCache(scan: RepoScan) {
  const linkIndex = createLinkResolutionIndex(scan);
  const links = scan.curatedPages.flatMap((page) =>
    resolveLinks(scan, page, linkIndex).map((resolution) => ({
      from: page.path,
      to: resolution.link.target,
      raw: resolution.link.raw,
      resolved_path: resolution.resolved_path,
    })),
  );

  return {
    links: links.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
  };
}

function stringFrontmatterValue(page: RepoMarkdownFile, key: string): string | null {
  const value = page.scan.frontmatter?.[key];
  return typeof value === "string" ? value : null;
}

function stringArrayFrontmatterValue(page: RepoMarkdownFile, key: string): string[] {
  const value = page.scan.frontmatter?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function titleFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
}

async function assertCacheWriteTarget(repoRoot: string, path: string): Promise<void> {
  const result = await validateTextFileWriteInsideRoot(repoRoot, path);
  if (!result.ok) {
    throw new Error(`Refusing to write cache file ${path}: ${result.error.message}`);
  }
}

async function writeJson(repoRoot: string, path: string, value: unknown): Promise<void> {
  const result = await writeTextFileInsideRoot(repoRoot, path, stableJson(value));
  if (!result.ok) {
    throw new Error(`Failed to write cache file ${path} without following symlinks: ${result.error.message}`);
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
