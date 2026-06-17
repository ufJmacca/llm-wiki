import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { rebuildIndexCache } from "../src/index/rebuild.js";
import { captureFileSource, type SourceCaptureSuccess } from "../src/sourceCapture/index.js";
import { parseInitJson, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

type IndexRebuildEnvelope = {
  ok: true;
  command: "index rebuild";
  repo: string;
  data: {
    cache_files: string[];
    pages: number;
    sources: number;
    queue_items: number;
    links: number;
    content_hash: string;
  };
  warnings: string[];
};

type IndexRebuildFailureEnvelope = {
  ok: false;
  command: "index rebuild";
  repo: string;
  error: {
    code: "INDEX_REBUILD_FAILED";
    message: string;
    hint: string;
  };
  issues: Array<{
    severity: "error";
    code: "INDEX_REBUILD_FAILED";
    message: string;
    path: string;
    hint: string;
  }>;
};

type CacheMetadata = {
  generated_at: string;
  authoritative: false;
  content_hash: string;
  inputs: {
    markdown_pages: number;
    source_cards: number;
    queue_items: number;
    links: number;
  };
};

type PageCache = {
  pages: Array<{
    path: string;
    title: string;
    type: string;
    visibility: string | null;
    source_ids: string[];
    content_hash: string;
  }>;
};

type SourceCache = {
  sources: Array<{
    source_id: string;
    title: string;
    status: string;
    visibility: string;
    content_hash: string;
    original_path: string | null;
    card_path: string;
    hash_valid: boolean | null;
  }>;
};

type QueueCache = {
  queue: Array<{
    source_id: string;
    title: string;
    status: string;
    path: string;
    original_path: string;
  }>;
};

type GraphCache = {
  links: Array<{
    from: string;
    to: string;
    raw: string;
    resolved_path: string | null;
  }>;
};

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function captureSource(wikiDir: string, workspaceDir: string): Promise<SourceCaptureSuccess["source"]> {
  const sourcePath = resolve(workspaceDir, "Research Note.md");
  await writeFile(sourcePath, "# Research Note\n\nRaw observation.\n", "utf8");

  const capture = await captureFileSource({
    repoRoot: wikiDir,
    sourcePath,
    title: "Research Note",
    now: new Date("2026-06-17T11:28:42.778Z"),
    command: "llm-wiki add Research Note.md --title Research Note",
  });

  expect(capture.ok).toBe(true);
  if (!capture.ok) {
    throw new Error(capture.error.message);
  }

  return capture.value.source;
}

async function writeCuratedPage(
  wikiDir: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  const absolutePath = resolve(wikiDir, path);
  await mkdir(resolve(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body}`, "utf8");
}

function parseIndexEnvelope(stdout: string[]): IndexRebuildEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as IndexRebuildEnvelope;
}

function parseIndexFailureEnvelope(stdout: string[]): IndexRebuildFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as IndexRebuildFailureEnvelope;
}

async function readCache<T>(wikiDir: string, path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(wikiDir, path), "utf8")) as T;
}

describe("index rebuild command", () => {
  it("writes deterministic non-authoritative cache files from Markdown, queue, and raw state", async () => {
    await withTempWorkspace("llm-wiki-index-rebuild-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/clean-page.md",
        { type: "topic", title: "Clean Page", visibility: "private", source_ids: [source.source_id] },
        "# Clean Page\n\nReferences [[Home]].\n",
      );
      await mkdir(resolve(wikiDir, ".llm-wiki/cache"), { recursive: true });
      await writeFile(
        resolve(wikiDir, ".llm-wiki/cache/pages.json"),
        JSON.stringify({
          authoritative: true,
          pages: [{ path: "curated/private/leak.md", title: "Do not trust cache" }],
        }),
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["index", "rebuild", "--repo", wikiDir, "--json"]);
      const payload = parseIndexEnvelope(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.cache_files).toEqual([
        ".llm-wiki/cache/graph.json",
        ".llm-wiki/cache/metadata.json",
        ".llm-wiki/cache/pages.json",
        ".llm-wiki/cache/queue.json",
        ".llm-wiki/cache/sources.json",
      ]);
      expect(payload.data.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

      const metadata = await readCache<CacheMetadata>(wikiDir, ".llm-wiki/cache/metadata.json");
      const pages = await readCache<PageCache>(wikiDir, ".llm-wiki/cache/pages.json");
      const sources = await readCache<SourceCache>(wikiDir, ".llm-wiki/cache/sources.json");
      const queue = await readCache<QueueCache>(wikiDir, ".llm-wiki/cache/queue.json");
      const graph = await readCache<GraphCache>(wikiDir, ".llm-wiki/cache/graph.json");

      expect(metadata).toMatchObject({
        authoritative: false,
        content_hash: payload.data.content_hash,
        inputs: {
          markdown_pages: pages.pages.length,
          source_cards: sources.sources.length,
          queue_items: queue.queue.length,
          links: graph.links.length,
        },
      });
      expect(metadata.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(pages.pages.map((page) => page.path)).toContain("curated/topics/clean-page.md");
      expect(pages.pages.map((page) => page.path)).not.toContain("curated/private/leak.md");
      expect(pages.pages.find((page) => page.path === "curated/topics/clean-page.md")).toMatchObject({
        title: "Clean Page",
        type: "topic",
        visibility: "private",
        source_ids: [source.source_id],
        content_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(sources.sources).toEqual([
        expect.objectContaining({
          source_id: source.source_id,
          title: "Research Note",
          status: "queued",
          visibility: "private",
          original_path: source.original_path,
          card_path: source.source_card_path,
          hash_valid: true,
        }),
      ]);
      expect(queue.queue).toEqual([
        expect.objectContaining({
          source_id: source.source_id,
          status: "queued",
          path: source.source_card_path,
          original_path: source.original_path,
        }),
      ]);
      expect(graph.links).toEqual([
        expect.objectContaining({
          from: "curated/topics/clean-page.md",
          to: "Home",
          raw: "[[Home]]",
          resolved_path: "curated/home.md",
        }),
      ]);
    });
  });

  it("infers source originals and hash validity after ingested queue records are removed", async () => {
    await withTempWorkspace("llm-wiki-index-rebuild-ingested-source-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, source.source_card_path),
        (await readGeneratedFile(wikiDir, source.source_card_path)).replace("status: queued", "status: ingested"),
        "utf8",
      );
      await rm(resolve(wikiDir, source.queue_path));

      // Act
      const result = await runCliBuffered(["index", "rebuild", "--repo", wikiDir, "--json"]);
      const sources = await readCache<SourceCache>(wikiDir, ".llm-wiki/cache/sources.json");
      const queue = await readCache<QueueCache>(wikiDir, ".llm-wiki/cache/queue.json");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(sources.sources).toEqual([
        expect.objectContaining({
          source_id: source.source_id,
          status: "ingested",
          original_path: source.original_path,
          content_hash: source.content_hash,
          hash_valid: true,
        }),
      ]);
      expect(queue.queue).toEqual([]);
    });
  });

  it("writes graph cache edges for standard Markdown links", async () => {
    await withTempWorkspace("llm-wiki-index-rebuild-markdown-links-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/linked-target.md",
        { type: "topic", title: "Linked Target", visibility: "private", source_ids: [source.source_id] },
        "# Linked Target\n\nReached through a standard Markdown link.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/linking-page.md",
        { type: "topic", title: "Linking Page", visibility: "private", source_ids: [source.source_id] },
        "# Linking Page\n\nSee [Linked Target](linked-target.md).\n",
      );

      // Act
      const result = await runCliBuffered(["index", "rebuild", "--repo", wikiDir, "--json"]);
      const graph = await readCache<GraphCache>(wikiDir, ".llm-wiki/cache/graph.json");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(graph.links).toContainEqual({
        from: "curated/topics/linking-page.md",
        to: "linked-target.md",
        raw: "[Linked Target](linked-target.md)",
        resolved_path: "curated/topics/linked-target.md",
      });
    });
  });

  it("rebuilds identical cache content for unchanged wiki inputs except generated timestamps", async () => {
    await withTempWorkspace("llm-wiki-index-rebuild-deterministic-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/deterministic.md",
        { type: "topic", title: "Deterministic", visibility: "private", source_ids: [source.source_id] },
        "# Deterministic\n\nStable body.\n",
      );

      // Act
      const firstResult = await runCliBuffered(["index", "rebuild", "--repo", wikiDir, "--json"]);
      const firstPayload = parseIndexEnvelope(firstResult.stdout);
      const firstPages = await readGeneratedFile(wikiDir, ".llm-wiki/cache/pages.json");
      const firstSources = await readGeneratedFile(wikiDir, ".llm-wiki/cache/sources.json");
      const firstQueue = await readGeneratedFile(wikiDir, ".llm-wiki/cache/queue.json");
      const firstGraph = await readGeneratedFile(wikiDir, ".llm-wiki/cache/graph.json");
      const secondResult = await runCliBuffered(["index", "rebuild", "--repo", wikiDir, "--json"]);
      const secondPayload = parseIndexEnvelope(secondResult.stdout);

      // Assert
      expect(firstResult.exitCode).toBe(0);
      expect(secondResult.exitCode).toBe(0);
      expect(secondPayload.data.content_hash).toBe(firstPayload.data.content_hash);
      expect(await readGeneratedFile(wikiDir, ".llm-wiki/cache/pages.json")).toBe(firstPages);
      expect(await readGeneratedFile(wikiDir, ".llm-wiki/cache/sources.json")).toBe(firstSources);
      expect(await readGeneratedFile(wikiDir, ".llm-wiki/cache/queue.json")).toBe(firstQueue);
      expect(await readGeneratedFile(wikiDir, ".llm-wiki/cache/graph.json")).toBe(firstGraph);
    });
  });

  it("refuses a symlinked cache directory without overwriting outside files", async () => {
    await withTempWorkspace("llm-wiki-index-rebuild-cache-dir-symlink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const outsideCacheDir = resolve(workspaceDir, "outside-cache");
      const outsidePagesPath = resolve(outsideCacheDir, "pages.json");
      await mkdir(outsideCacheDir, { recursive: true });
      await writeFile(outsidePagesPath, "outside pages\n", "utf8");
      await rm(resolve(wikiDir, ".llm-wiki/cache"), { recursive: true, force: true });
      await symlink(outsideCacheDir, resolve(wikiDir, ".llm-wiki/cache"), "dir");

      // Act / Assert
      await expect(rebuildIndexCache(wikiDir)).rejects.toThrow("destination parent is a symlink: .llm-wiki/cache");
      expect(await readFile(outsidePagesPath, "utf8")).toBe("outside pages\n");
    });
  });

  it("returns a JSON failure envelope when rebuild fails after repo resolution", async () => {
    await withTempWorkspace("llm-wiki-index-rebuild-json-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const outsideCacheDir = resolve(workspaceDir, "outside-cache");
      const outsidePagesPath = resolve(outsideCacheDir, "pages.json");
      await mkdir(outsideCacheDir, { recursive: true });
      await writeFile(outsidePagesPath, "outside pages\n", "utf8");
      await rm(resolve(wikiDir, ".llm-wiki/cache"), { recursive: true, force: true });
      await symlink(outsideCacheDir, resolve(wikiDir, ".llm-wiki/cache"), "dir");

      // Act
      const result = await runCliBuffered(["index", "rebuild", "--repo", wikiDir, "--json"]);
      const payload = parseIndexFailureEnvelope(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "index rebuild",
        repo: wikiDir,
        error: {
          code: "INDEX_REBUILD_FAILED",
          message: expect.stringContaining("destination parent is a symlink: .llm-wiki/cache"),
          hint: expect.any(String),
        },
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "INDEX_REBUILD_FAILED",
          path: ".llm-wiki/cache",
          message: expect.stringContaining("destination parent is a symlink: .llm-wiki/cache"),
        }),
      ]);
      expect(await readFile(outsidePagesPath, "utf8")).toBe("outside pages\n");
    });
  });

  it("refuses symlinked cache files without overwriting outside files", async () => {
    await withTempWorkspace("llm-wiki-index-rebuild-cache-file-symlink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const outsidePagesPath = resolve(workspaceDir, "outside-pages.json");
      await mkdir(resolve(wikiDir, ".llm-wiki/cache"), { recursive: true });
      await writeFile(outsidePagesPath, "outside pages\n", "utf8");
      await rm(resolve(wikiDir, ".llm-wiki/cache/pages.json"), { force: true });
      await symlink(outsidePagesPath, resolve(wikiDir, ".llm-wiki/cache/pages.json"), "file");

      // Act / Assert
      await expect(rebuildIndexCache(wikiDir)).rejects.toThrow("destination file is a symlink: .llm-wiki/cache/pages.json");
      expect(await readFile(outsidePagesPath, "utf8")).toBe("outside pages\n");
    });
  });
});
