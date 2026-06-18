import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

type RuntimeSuccessEnvelope<Command extends string, Data> = {
  ok: true;
  command: Command;
  repo: string;
  data: Data;
  warnings: string[];
};

type RuntimeFailureEnvelope<Command extends string> = {
  ok: false;
  command: Command;
  repo: string | null;
  error: {
    code: string;
    message: string;
    hint: string;
  };
  issues: Array<{
    severity: "error";
    code: string;
    message: string;
    path: string;
    hint: string;
  }>;
};

type SourceCaptureData = {
  status: "added" | "duplicate";
  source: {
    source_id: string;
    title: string;
    source_kind: "file" | "text" | "url";
    visibility: "private";
    queue_status: "queued";
    original_path: string;
    source_card_path: string;
    queue_path: string;
  };
};

type NavPage = {
  path: string;
  title: string;
  page_type: string;
  visibility: string | null;
  source_ids: string[];
};

type NavLink = {
  from_path: string;
  to_path: string | null;
  target: string;
  alias: string | null;
  raw: string;
  line: number;
  target_title: string | null;
  target_type: string | null;
};

type NavLinksData = {
  page: NavPage;
  links: NavLink[];
};

type NavSourcesData = {
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

type NavOrphansData = {
  orphans: NavPage[];
};

type NavGraphData = {
  nodes: Array<NavPage & { id: string; label: string }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string | null;
    raw: string;
  }>;
};

const originalTimezone = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  if (originalTimezone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
});

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function captureTextSource(wikiDir: string): Promise<SourceCaptureData["source"]> {
  const result = await runCliBuffered([
    "add-text",
    "--repo",
    wikiDir,
    "--title",
    "Transformer Paper",
    "--text",
    "raw evidence about retrieval memory",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(payload.data.status).toBe("added");

  return payload.data.source;
}

async function captureFileSource(wikiDir: string, workspaceDir: string): Promise<SourceCaptureData["source"]> {
  const sourcePath = resolve(workspaceDir, "evidence.txt");
  await writeFile(sourcePath, "raw evidence about retrieval memory", "utf8");

  const result = await runCliBuffered([
    "add",
    sourcePath,
    "--repo",
    wikiDir,
    "--title",
    "Transformer Text File",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(payload.data.status).toBe("added");

  return payload.data.source;
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

function parseJsonSuccess<Command extends string, Data>(
  stdout: string[],
): RuntimeSuccessEnvelope<Command, Data> {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as RuntimeSuccessEnvelope<Command, Data>;
}

function parseJsonFailure<Command extends string>(stdout: string[]): RuntimeFailureEnvelope<Command> {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as RuntimeFailureEnvelope<Command>;
}

async function arrangeNavigationWiki(workspaceDir: string): Promise<{
  wikiDir: string;
  sourceId: string;
  sourceCardPath: string;
}> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-17T11:28:42.778Z"));
  const wikiDir = resolve(workspaceDir, "wiki");
  await initializeWiki(wikiDir);
  const source = await captureTextSource(wikiDir);
  const sharedFrontmatter = {
    visibility: "private",
    source_ids: [source.source_id],
  };
  await writeCuratedPage(
    wikiDir,
    `curated/sources/${source.source_id}.md`,
    {
      ...sharedFrontmatter,
      type: "source_summary",
      title: "Transformer Paper Summary",
    },
    "# Transformer Paper Summary\n\nSummary body.\n",
  );
  await writeCuratedPage(
    wikiDir,
    "curated/topics/memory-retrieval.md",
    {
      ...sharedFrontmatter,
      type: "topic",
      title: "Memory Retrieval",
    },
    [
      "# Memory Retrieval",
      "",
      "See [[Concept Overview]] and [[Search Engine|search engine alias]].",
      "Use [[questions/ranking-question#Evidence|ranking evidence]].",
      "Cites [[sources/" + source.source_id + "|primary source summary]].",
      "",
    ].join("\n"),
  );
  await writeCuratedPage(
    wikiDir,
    "curated/concepts/concept-overview.md",
    {
      ...sharedFrontmatter,
      type: "concept",
      title: "Concept Overview",
    },
    "# Concept Overview\n\nBack to [[Memory Retrieval|memory system]].\n",
  );
  await writeCuratedPage(
    wikiDir,
    "curated/entities/search-engine.md",
    {
      ...sharedFrontmatter,
      type: "entity",
      title: "Search Engine",
    },
    "# Search Engine\n",
  );
  await writeCuratedPage(
    wikiDir,
    "curated/questions/ranking-question.md",
    {
      ...sharedFrontmatter,
      type: "question",
      title: "Ranking Question",
    },
    "# Ranking Question\n\n## Evidence\n\nDetails.\n",
  );
  await writeCuratedPage(
    wikiDir,
    "curated/topics/lonely-topic.md",
    {
      ...sharedFrontmatter,
      type: "topic",
      title: "Lonely Topic",
    },
    "# Lonely Topic\n\nNo inbound curated links.\n",
  );
  await writeCuratedPage(
    wikiDir,
    "curated/dashboards/review.md",
    {
      ...sharedFrontmatter,
      type: "dashboard",
      title: "Review Dashboard",
    },
    "# Review Dashboard\n\nGenerated dashboard content.\n",
  );

  return {
    wikiDir,
    sourceId: source.source_id,
    sourceCardPath: source.source_card_path,
  };
}

describe("nav command", () => {
  it("reports wikilink outlinks and backlinks with aliases resolved to Markdown pages", async () => {
    await withTempWorkspace("llm-wiki-nav-links-", async (workspaceDir) => {
      // Arrange
      const { wikiDir, sourceId } = await arrangeNavigationWiki(workspaceDir);

      // Act
      const outlinksResult = await runCliBuffered([
        "nav",
        "outlinks",
        "curated/topics/memory-retrieval.md",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const backlinksResult = await runCliBuffered([
        "nav",
        "backlinks",
        "curated/topics/memory-retrieval.md",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const outlinksPayload = parseJsonSuccess<"nav outlinks", NavLinksData>(outlinksResult.stdout);
      const backlinksPayload = parseJsonSuccess<"nav backlinks", NavLinksData>(backlinksResult.stdout);

      // Assert
      expect(outlinksResult.exitCode).toBe(0);
      expect(backlinksResult.exitCode).toBe(0);
      expect(outlinksPayload.data.page).toMatchObject({
        path: "curated/topics/memory-retrieval.md",
        title: "Memory Retrieval",
        page_type: "topic",
      });
      expect(outlinksPayload.data.links).toEqual([
        expect.objectContaining({
          target: "Concept Overview",
          alias: null,
          to_path: "curated/concepts/concept-overview.md",
          target_title: "Concept Overview",
          target_type: "concept",
        }),
        expect.objectContaining({
          target: "Search Engine",
          alias: "search engine alias",
          raw: "[[Search Engine|search engine alias]]",
          to_path: "curated/entities/search-engine.md",
        }),
        expect.objectContaining({
          target: "questions/ranking-question#Evidence",
          alias: "ranking evidence",
          to_path: "curated/questions/ranking-question.md",
        }),
        expect.objectContaining({
          target: `sources/${sourceId}`,
          alias: "primary source summary",
          to_path: `curated/sources/${sourceId}.md`,
        }),
      ]);
      expect(backlinksPayload.data.links).toEqual([
        expect.objectContaining({
          from_path: "curated/concepts/concept-overview.md",
          target: "Memory Retrieval",
          alias: "memory system",
          raw: "[[Memory Retrieval|memory system]]",
          to_path: "curated/topics/memory-retrieval.md",
        }),
      ]);
    });
  });

  it("resolves source-card wikilinks to existing raw original file paths", async () => {
    await withTempWorkspace("llm-wiki-nav-source-card-original-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureFileSource(wikiDir, workspaceDir);

      // Act
      const result = await runCliBuffered([
        "nav",
        "outlinks",
        source.source_card_path,
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonSuccess<"nav outlinks", NavLinksData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.page).toMatchObject({
        path: source.source_card_path,
        title: "Transformer Text File",
        page_type: "raw_source",
      });
      expect(payload.data.links).toEqual([
        expect.objectContaining({
          from_path: source.source_card_path,
          target: source.original_path,
          alias: "original.txt",
          raw: `[[${source.original_path}|original.txt]]`,
          to_path: source.original_path,
          target_title: null,
          target_type: null,
        }),
      ]);
    });
  });

  it("does not resolve wikilinks through slug fallbacks rejected by lint and index", async () => {
    await withTempWorkspace("llm-wiki-nav-strict-wikilinks-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/source-topic.md",
        { type: "topic", title: "Source Topic", visibility: "private", source_ids: [] },
        "# Source Topic\n\nUse [[questions/Ranking Question#Evidence|ranking evidence]].\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/questions/ranking-question.md",
        { type: "question", title: "Ranking Question", visibility: "private", source_ids: [] },
        "# Ranking Question\n\n## Evidence\n\nDetails.\n",
      );

      // Act
      const outlinksResult = await runCliBuffered([
        "nav",
        "outlinks",
        "curated/topics/source-topic.md",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const graphResult = await runCliBuffered(["nav", "graph", "--repo", wikiDir, "--json"]);
      const outlinksPayload = parseJsonSuccess<"nav outlinks", NavLinksData>(outlinksResult.stdout);
      const graphPayload = parseJsonSuccess<"nav graph", NavGraphData>(graphResult.stdout);

      // Assert
      expect(outlinksResult.exitCode).toBe(0);
      expect(graphResult.exitCode).toBe(0);
      expect(outlinksPayload.data.links).toEqual([
        expect.objectContaining({
          target: "questions/Ranking Question#Evidence",
          alias: "ranking evidence",
          to_path: null,
          target_title: null,
          target_type: null,
        }),
      ]);
      expect(graphPayload.data.edges).not.toContainEqual(
        expect.objectContaining({
          source: "curated/topics/source-topic.md",
          target: "curated/questions/ranking-question.md",
        }),
      );
    });
  });

  it("resolves source relations from source_ids to raw cards and curated summaries", async () => {
    await withTempWorkspace("llm-wiki-nav-sources-", async (workspaceDir) => {
      // Arrange
      const { wikiDir, sourceId, sourceCardPath } = await arrangeNavigationWiki(workspaceDir);

      // Act
      const result = await runCliBuffered([
        "nav",
        "sources",
        "curated/topics/memory-retrieval.md",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonSuccess<"nav sources", NavSourcesData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.sources).toEqual([
        {
          source_id: sourceId,
          title: "Transformer Paper",
          status: "queued",
          visibility: "private",
          source_card_path: sourceCardPath,
          summary_path: `curated/sources/${sourceId}.md`,
          summary_title: "Transformer Paper Summary",
        },
      ]);
    });
  });

  it("returns graph JSON and excludes configured system or generated pages from orphan reports", async () => {
    await withTempWorkspace("llm-wiki-nav-graph-orphans-", async (workspaceDir) => {
      // Arrange
      const { wikiDir, sourceCardPath } = await arrangeNavigationWiki(workspaceDir);
      await mkdir(resolve(wikiDir, ".llm-wiki/cache"), { recursive: true });
      await writeFile(resolve(wikiDir, ".llm-wiki/cache/generated.md"), "# Generated cache page\n", "utf8");

      // Act
      const graphResult = await runCliBuffered(["nav", "graph", "--repo", wikiDir, "--json"]);
      const orphansResult = await runCliBuffered(["nav", "orphans", "--repo", wikiDir, "--json"]);
      const graphPayload = parseJsonSuccess<"nav graph", NavGraphData>(graphResult.stdout);
      const orphansPayload = parseJsonSuccess<"nav orphans", NavOrphansData>(orphansResult.stdout);

      // Assert
      expect(graphResult.exitCode).toBe(0);
      expect(orphansResult.exitCode).toBe(0);
      expect(graphPayload.data.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "curated/topics/memory-retrieval.md",
            label: "Memory Retrieval",
            page_type: "topic",
            visibility: "private",
          }),
          expect.objectContaining({
            id: sourceCardPath,
            label: "Transformer Paper",
            page_type: "raw_source",
            visibility: "private",
          }),
        ]),
      );
      expect(graphPayload.data.nodes.map((node) => node.id)).not.toContain("raw/README.md");
      expect(graphPayload.data.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringMatching(
              /^curated\/topics\/memory-retrieval\.md->curated\/entities\/search-engine\.md:\d+:\d+$/,
            ),
            source: "curated/topics/memory-retrieval.md",
            target: "curated/entities/search-engine.md",
            label: "search engine alias",
            raw: "[[Search Engine|search engine alias]]",
          }),
        ]),
      );
      expect(orphansPayload.data.orphans.map((page) => page.path)).toEqual(["curated/topics/lonely-topic.md"]);
      expect(orphansPayload.data.orphans.map((page) => page.path)).not.toEqual(
        expect.arrayContaining([
          "curated/home.md",
          "curated/index.md",
          "curated/log.md",
          "curated/dashboards/review.md",
          ".llm-wiki/cache/generated.md",
        ]),
      );
    });
  });

  it("counts links from curated home when reporting orphan pages", async () => {
    await withTempWorkspace("llm-wiki-nav-home-orphans-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/home.md",
        { type: "page", title: "Home", visibility: "private", source_ids: [] },
        "# Home\n\nStart at [[Home Linked Topic]].\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/home-linked-topic.md",
        { type: "topic", title: "Home Linked Topic", visibility: "private", source_ids: [] },
        "# Home Linked Topic\n\nLinked from the landing page.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/unlinked-topic.md",
        { type: "topic", title: "Unlinked Topic", visibility: "private", source_ids: [] },
        "# Unlinked Topic\n\nNo inbound links.\n",
      );

      // Act
      const result = await runCliBuffered(["nav", "orphans", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"nav orphans", NavOrphansData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.orphans.map((page) => page.path)).toEqual(["curated/topics/unlinked-topic.md"]);
    });
  });

  it("counts only wikilinks as inbound links when reporting orphan pages", async () => {
    await withTempWorkspace("llm-wiki-nav-wikilink-orphans-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/linking-topic.md",
        { type: "topic", title: "Linking Topic", visibility: "private", source_ids: [] },
        "# Linking Topic\n\nSee [Markdown Linked Topic](markdown-linked-topic.md).\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/markdown-linked-topic.md",
        { type: "topic", title: "Markdown Linked Topic", visibility: "private", source_ids: [] },
        "# Markdown Linked Topic\n\nOnly ordinary Markdown links point here.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/wikilink-source-topic.md",
        { type: "topic", title: "Wikilink Source Topic", visibility: "private", source_ids: [] },
        "# Wikilink Source Topic\n\nSee [[Wikilinked Topic]].\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/wikilinked-topic.md",
        { type: "topic", title: "Wikilinked Topic", visibility: "private", source_ids: [] },
        "# Wikilinked Topic\n\nAn Obsidian wikilink points here.\n",
      );

      // Act
      const result = await runCliBuffered(["nav", "orphans", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"nav orphans", NavOrphansData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.orphans.map((page) => page.path)).toEqual([
        "curated/topics/linking-topic.md",
        "curated/topics/markdown-linked-topic.md",
        "curated/topics/wikilink-source-topic.md",
      ]);
    });
  });

  it("returns a JSON failure envelope when the requested nav page is missing", async () => {
    await withTempWorkspace("llm-wiki-nav-missing-page-", async (workspaceDir) => {
      // Arrange
      const { wikiDir } = await arrangeNavigationWiki(workspaceDir);

      // Act
      const result = await runCliBuffered(["nav", "outlinks", "missing", "--repo", wikiDir, "--json"]);
      const payload = parseJsonFailure<"nav outlinks">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: false,
        command: "nav outlinks",
        repo: wikiDir,
        error: {
          code: "NAV_PAGE_NOT_FOUND",
          message: "Page not found: missing",
          hint: "Pass an existing Markdown path, page title, or source card path.",
        },
        issues: [
          {
            severity: "error",
            code: "NAV_PAGE_NOT_FOUND",
            message: "Page not found: missing",
            path: "missing",
            hint: "Pass an existing Markdown path, page title, or source card path.",
          },
        ],
      });
    });
  });
});
