import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { syncQuartzContent } from "../src/quartz/index.js";
import { computeContentHash } from "../src/scanner/index.js";
import { parseInitJson, pathExists, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const execFileAsync = promisify(execFile);

type ExploreSyncEnvelope = {
  ok: true;
  command: "explore.sync";
  repo: string;
  data: {
    profile: "local" | "review" | "public" | "github-pages";
    source_profile: string;
    content_root: "quartz/content";
    manifest_path: string;
    materialized_paths: string[];
    generated_paths: string[];
    excluded_paths: string[];
    warnings: string[];
  };
  warnings: string[];
};

type ExploreSyncFailureEnvelope = {
  ok: false;
  command: "explore.sync";
  repo: string;
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

type QuartzManifest = {
  profile: string;
  source_profile: string;
  content_root: "quartz/content";
  files: Array<{
    source_path: string;
    content_path: string;
    content_hash: string;
    page_type: string | null;
    title: string | null;
    visibility: string | null;
  }>;
  generated_files: Array<{
    content_path: string;
    content_hash: string;
    title: string;
  }>;
  excluded_paths: string[];
};

type ReviewFrontmatter = {
  llm_wiki_review_panel?: boolean;
  llm_wiki_review_profile?: string;
  llm_wiki_review_generated_at?: string;
  llm_wiki_review_counts?: Record<string, number>;
  llm_wiki_review_links?: Array<{
    label: string;
    href: string;
    count_key?: string;
  }>;
};

type SourceCaptureData = {
  status: "added" | "duplicate";
  source: {
    source_id: string;
    title: string;
    source_kind: "file" | "text";
    origin: string;
    captured_at: string;
    content_hash: string;
    visibility: "private";
    queue_status: "queued" | "ingesting" | "ingested" | "blocked";
    original_path: string;
    source_card_path: string;
    queue_path: string;
  };
  created_paths: string[];
};

type ReviewSourceFixture = {
  sourceId: string;
  title: string;
  status: "queued" | "ingesting" | "ingested" | "blocked";
  sourceKind: "file" | "text" | "url";
  capturedAt: string;
  updatedAt: string | null;
  sourceCardPath: string;
  queuePath: string;
  originalPath: string;
  contentHash: string;
};

type ReviewSourceFixtureWriteOptions = {
  sourceCard?: Record<string, unknown>;
  queue?: Record<string, unknown>;
};

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function initializeQuartzRuntime(wikiDir: string): Promise<void> {
  const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);

  expect(result.exitCode).toBe(0);
}

async function prepareGitHubPagesSyncProfile(wikiDir: string): Promise<void> {
  await initializeQuartzRuntime(wikiDir);
  const publicProfile = await readFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "utf8");
  await writeFile(
    resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"),
    publicProfile.replace(
      /^name: public\nmode: deploy\n/u,
      "name: github-pages\nmode: deploy\nbase_url: https://docs.example.com\n",
    ),
    "utf8",
  );
}

async function initializeGitRepository(wikiDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: wikiDir });
}

async function withUnavailableGitPath<T>(workspaceDir: string, run: () => Promise<T>): Promise<T> {
  const oldPath = process.env.PATH;
  const binDir = resolve(workspaceDir, "no-git-bin");
  await mkdir(binDir, { recursive: true });
  process.env.PATH = binDir;

  try {
    return await run();
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
  }
}

async function gitIgnoresPath(wikiDir: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", path], { cwd: wikiDir });
    return true;
  } catch (error) {
    if (isExitCode(error, 1)) {
      return false;
    }

    throw error;
  }
}

function isExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

function parseExploreSync(stdout: string[]): ExploreSyncEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreSyncEnvelope;
}

function parseExploreSyncFailure(stdout: string[]): ExploreSyncFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreSyncFailureEnvelope;
}

function parseSourceCapture(stdout: string[]): SourceCaptureData {
  expect(stdout).toHaveLength(1);
  return (JSON.parse(stdout[0]) as { data: SourceCaptureData }).data;
}

async function readManifest(wikiDir: string, profile: string): Promise<QuartzManifest> {
  return JSON.parse(await readGeneratedFile(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`)) as QuartzManifest;
}

async function writeCuratedPage(
  wikiDir: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  const absolutePath = resolve(wikiDir, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body}`, "utf8");
}

function reviewSourceFixture(
  sourceId: string,
  title: string,
  status: ReviewSourceFixture["status"],
  sourceKind: ReviewSourceFixture["sourceKind"],
  capturedAt: string,
  updatedAt: string | null = null,
): ReviewSourceFixture {
  const originalContent = `${sourceId}\n`;
  const year = sourceId.slice(4, 8);
  const month = sourceId.slice(9, 11);
  const sourceCardPath = `raw/inputs/${year}/${month}/${sourceId}/_source.md`;
  const originalPath = `raw/inputs/${year}/${month}/${sourceId}/original.md`;

  return {
    sourceId,
    title,
    status,
    sourceKind,
    capturedAt,
    updatedAt,
    sourceCardPath,
    queuePath: `raw/queue/${sourceId}.json`,
    originalPath,
    contentHash: computeContentHash(Buffer.from(originalContent, "utf8")),
  };
}

async function writeReviewSourceFixture(
  wikiDir: string,
  source: ReviewSourceFixture,
  options: ReviewSourceFixtureWriteOptions = {},
): Promise<void> {
  const originalPath = resolve(wikiDir, source.originalPath);
  await mkdir(dirname(originalPath), { recursive: true });
  await writeFile(originalPath, `${source.sourceId}\n`, "utf8");

  const sourceCardFrontmatter = {
    type: "raw_source",
    source_id: source.sourceId,
    title: source.title,
    source_kind: source.sourceKind,
    origin: source.sourceKind === "url" ? "https://example.com/source" : "pasted_text",
    ...(source.sourceKind === "url" ? { origin_url: "https://example.com/source" } : {}),
    captured_at: source.capturedAt,
    content_hash: source.contentHash,
    status: source.status,
    visibility: "private",
    ...(source.updatedAt === null ? {} : { updated_at: source.updatedAt }),
    ...options.sourceCard,
  };
  const sourceCardPath = resolve(wikiDir, source.sourceCardPath);
  await mkdir(dirname(sourceCardPath), { recursive: true });
  await writeFile(
    sourceCardPath,
    `---\n${stringify(sourceCardFrontmatter).trimEnd()}\n---\n\n# ${source.title}\n\nOriginal file: [[original.md]]\n`,
    "utf8",
  );

  const queueItem = {
    kind: source.sourceKind,
    source_id: source.sourceId,
    title: source.title,
    source_kind: source.sourceKind,
    origin: source.sourceKind === "url" ? "https://example.com/source" : "pasted_text",
    ...(source.sourceKind === "url" ? { origin_url: "https://example.com/source" } : {}),
    captured_at: source.capturedAt,
    content_hash: source.contentHash,
    status: source.status,
    visibility: "private",
    path: source.sourceCardPath,
    original_path: source.originalPath,
    ...(source.updatedAt === null ? {} : { updated_at: source.updatedAt }),
    ...options.queue,
  };
  const queuePath = resolve(wikiDir, source.queuePath);
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify(queueItem, null, 2)}\n`, "utf8");
}

async function makeDefaultCuratedPagesPublic(wikiDir: string): Promise<void> {
  const pages = [
    ["curated/contradictions.md", "Contradictions"],
    ["curated/home.md", "Home"],
    ["curated/index.md", "Index"],
    ["curated/map.md", "Map"],
    ["curated/open-questions.md", "Open Questions"],
  ] as const;

  for (const [path, title] of pages) {
    await writeCuratedPage(
      wikiDir,
      path,
      {
        type: path === "curated/index.md" ? "index" : "page",
        title,
        visibility: "public",
        source_ids: [],
      },
      `# ${title}\n`,
    );
  }
}

function expectedLocalReviewGeneratedPaths(options: { includeRoot?: boolean } = {}): string[] {
  const paths = [
    "quartz/content/_llm-wiki/review/contradictions.md",
    "quartz/content/_llm-wiki/review/needs-review.md",
    "quartz/content/_llm-wiki/review/orphans.md",
    "quartz/content/_llm-wiki/review/overview.md",
    "quartz/content/_llm-wiki/review/profile-summary.md",
    "quartz/content/_llm-wiki/review/recent-ingests.md",
    "quartz/content/_llm-wiki/review/source-queue.md",
    "quartz/content/_llm-wiki/review/stale-pages.md",
    "quartz/content/_llm-wiki/review/status.md",
    "quartz/content/_llm-wiki/review/visibility-warnings.md",
    "quartz/content/_llm-wiki/upload.md",
  ];
  if (options.includeRoot === true) {
    paths.push("quartz/content/index.md");
  }

  return paths.sort();
}

function generatedReviewPagePaths(): string[] {
  return expectedLocalReviewGeneratedPaths().filter((path) => path.startsWith("quartz/content/_llm-wiki/review/"));
}

function expectGeneratedReviewFrontmatter(content: string, title: string, component: string): void {
  expect(content).toContain(`title: ${title}`);
  expect(content).toContain("type: dashboard");
  expect(content).toContain("visibility: private");
  expect(content).toContain(`llm_wiki_component: ${component}`);
}

function parseGeneratedFrontmatter(content: string): ReviewFrontmatter {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(content);
  expect(match).not.toBeNull();

  return parse(match?.[1] ?? "") as ReviewFrontmatter;
}

function parseReviewCategoryItems(content: string): unknown[] {
  const blocks = parseReviewJsonItemBlocks(content);
  expect(blocks.length).toBeGreaterThan(0);
  return blocks[0] ?? [];
}

function parseReviewJsonItemBlocks(content: string): unknown[][] {
  const matches = [...content.matchAll(/```json\n([\s\S]*?)\n```/gu)];
  expect(matches.length).toBeGreaterThan(0);

  return matches.map((match) => {
    const value = JSON.parse(match[1] ?? "[]") as unknown;
    expect(Array.isArray(value)).toBe(true);
    return value as unknown[];
  });
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(content);
  expect(match).not.toBeNull();
  return parse(match?.[1] ?? "") as Record<string, unknown>;
}

async function listTree(rootDir: string, relativeDir: string): Promise<string[]> {
  const absoluteDir = resolve(rootDir, relativeDir);
  if (!(await pathExists(absoluteDir))) {
    return [];
  }

  const paths: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = resolve(dir, entry.name);
      const relativePath = absolutePath.slice(rootDir.length + 1).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        paths.push(relativePath);
      }
    }
  }

  await visit(absoluteDir);
  return paths;
}

describe("explore sync command", () => {
  it("materializes local Markdown, raw source cards, upload entrypoint, root page, and full review page set", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-local-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Queue Note",
        "--text",
        "Private queue text.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, "local");
      const syncedPaths = await listTree(wikiDir, "quartz/content");
      const overview = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/overview.md");
      const status = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/status.md");
      const sourceQueue = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/source-queue.md");
      const upload = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/upload.md");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.profile).toBe("local");
      expect(payload.data.materialized_paths).toContain("quartz/content/curated/home.md");
      expect(payload.data.materialized_paths).toContain("quartz/content/index.md");
      expect(payload.data.generated_paths).toEqual(expectedLocalReviewGeneratedPaths());
      expect(payload.data.excluded_paths).toEqual(expect.arrayContaining([expect.stringMatching(/original\.md$/)]));
      expect(syncedPaths).toContain("quartz/content/curated/home.md");
      expect(syncedPaths).toContain("quartz/content/index.md");
      expect(syncedPaths).toContain("quartz/content/_llm-wiki/upload.md");
      expect(syncedPaths).toContain("quartz/content/_llm-wiki/review/status.md");
      expect(syncedPaths).toContain("quartz/content/_llm-wiki/review/source-queue.md");
      expect(syncedPaths.some((path) => path.endsWith("/_source.md"))).toBe(true);
      expect(syncedPaths.some((path) => path.endsWith("/original.md"))).toBe(false);
      expect(manifest.profile).toBe("local");
      expect(manifest.files.some((file) => file.source_path.endsWith("/_source.md"))).toBe(true);
      expect(manifest.files.some((file) => file.source_path.endsWith("/original.md"))).toBe(false);
      expect(manifest.generated_files.map((file) => file.content_path)).toEqual(expectedLocalReviewGeneratedPaths());
      expect(upload).toContain("llm_wiki_component: LlmWikiUploadForm");
      expect(upload).toContain("llm_wiki_upload: true");
      expect(upload).not.toContain("<LlmWikiUploadForm");
      expect(overview).toContain("llm_wiki_component: LlmWikiReviewPanel");
      expect(overview).toContain("| Queue total | 1 |");
      expect(status).toContain("| Queued | 1 |");
      expect(sourceQueue).toContain("llm_wiki_component: LlmWikiQueueDashboard");
      expect(sourceQueue).toContain(capture.source.source_id);
      expect(sourceQueue).toContain("Queue Note");
    });
  });

  it("renders every generated review page with component gates and review data items", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-review-pages-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const queued = reviewSourceFixture(
        "src_2026_06_23_sync_queued_111111",
        "Sync Queued",
        "queued",
        "text",
        "2026-06-23T09:00:00.000Z",
      );
      const ingesting = reviewSourceFixture(
        "src_2026_06_23_sync_ingesting_222222",
        "Sync Ingesting",
        "ingesting",
        "file",
        "2026-06-23T09:05:00.000Z",
        "2026-06-23T10:00:00.000Z",
      );
      const blocked = reviewSourceFixture(
        "src_2026_06_23_sync_blocked_333333",
        "Sync Blocked",
        "blocked",
        "url",
        "2026-06-23T09:10:00.000Z",
        "2026-06-23T10:05:00.000Z",
      );
      const ingested = reviewSourceFixture(
        "src_2026_06_23_sync_ingested_444444",
        "Sync Ingested",
        "ingested",
        "text",
        "2026-06-23T09:15:00.000Z",
        "2026-06-23T10:10:00.000Z",
      );

      for (const source of [queued, ingesting, blocked, ingested]) {
        await writeReviewSourceFixture(wikiDir, source);
      }
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${ingested.sourceId}.md`,
        {
          type: "source_summary",
          title: "Sync Ingested Summary",
          visibility: "private",
          source_ids: [ingested.sourceId],
        },
        "# Sync Ingested Summary\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/home.md",
        {
          type: "page",
          title: "Home",
          visibility: "private",
          source_ids: [],
        },
        [
          "# Home",
          "",
          "Linked review pages:",
          "",
          "- [[topics/sync-stale|Sync Stale]]",
          "- [[questions/sync-review|Sync Review]]",
          `- [[sources/${ingested.sourceId}|Sync Ingested Summary]]`,
          "",
        ].join("\n"),
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/sync-orphan.md",
        {
          type: "topic",
          title: "Sync Orphan",
          visibility: "private",
          source_ids: [queued.sourceId],
        },
        "# Sync Orphan\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/sync-stale.md",
        {
          type: "topic",
          title: "Sync Stale",
          visibility: "private",
          source_ids: [ingested.sourceId],
          next_review: "2026-06-01",
        },
        "# Sync Stale\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/questions/sync-review.md",
        {
          type: "question",
          title: "Sync Review Question",
          visibility: "private",
          source_ids: [queued.sourceId],
          review_status: "needs-human-review",
        },
        "# Sync Review Question\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/contradictions/sync-conflict.md",
        {
          type: "page",
          title: "Sync Pricing Conflict",
          visibility: "private",
          source_ids: [blocked.sourceId],
          tags: ["contradiction"],
        },
        "# Sync Pricing Conflict\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/log.md",
        {
          type: "log",
          title: "Log",
          visibility: "private",
          source_ids: [],
        },
        [
          "# Log",
          "",
          `## [2026-06-23T10:10:00.000Z] ingest | ${ingested.sourceId} | Sync Ingested`,
          "",
          "- actor: cli",
          "- command: \"llm-wiki ingest src_2026_06_23_sync_ingested_444444\"",
          `- raw_source: ${ingested.sourceCardPath}`,
          "- created:",
          `  - curated/sources/${ingested.sourceId}.md`,
          "- updated:",
          "  - curated/topics/sync-stale.md",
          "- contradictions:",
          "  - Sync Ingested conflicts with Sync Blocked on pricing.",
          "- follow_ups:",
          "",
        ].join("\n"),
      );
      await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      await writeReviewSourceFixture(wikiDir, blocked, { sourceCard: { visibility: "public" } });

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "review", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, "review");
      const reviewPages = new Map(
        await Promise.all(
          generatedReviewPagePaths().map(async (path) => [path, await readGeneratedFile(wikiDir, path)] as const),
        ),
      );
      const recentIngests = reviewPages.get("quartz/content/_llm-wiki/review/recent-ingests.md") ?? "";
      const needsReview = reviewPages.get("quartz/content/_llm-wiki/review/needs-review.md") ?? "";
      const contradictions = reviewPages.get("quartz/content/_llm-wiki/review/contradictions.md") ?? "";
      const orphans = reviewPages.get("quartz/content/_llm-wiki/review/orphans.md") ?? "";
      const stalePages = reviewPages.get("quartz/content/_llm-wiki/review/stale-pages.md") ?? "";
      const visibilityWarnings = reviewPages.get("quartz/content/_llm-wiki/review/visibility-warnings.md") ?? "";
      const overview = reviewPages.get("quartz/content/_llm-wiki/review/overview.md") ?? "";
      const profileSummary = reviewPages.get("quartz/content/_llm-wiki/review/profile-summary.md") ?? "";
      const sourceQueue = reviewPages.get("quartz/content/_llm-wiki/review/source-queue.md") ?? "";
      const status = reviewPages.get("quartz/content/_llm-wiki/review/status.md") ?? "";
      const overviewFrontmatter = parseFrontmatter(overview);
      const sourceQueueFrontmatter = parseFrontmatter(sourceQueue);
      const statusFrontmatter = parseFrontmatter(status);
      const visibilityWarningItems = parseReviewCategoryItems(visibilityWarnings);
      const expectedCounts = {
        status: 4,
        source_queue: 4,
        recent_ingests: 1,
        needs_review: 1,
        contradictions: 2,
        orphans: 1,
        stale_pages: 1,
        visibility_warnings: visibilityWarningItems.length,
        profile_summary: 1,
      };
      const expectedLinks = [
        { label: "Overview", href: "_llm-wiki/review/overview" },
        { label: "Status", href: "_llm-wiki/review/status", count_key: "status" },
        { label: "Source queue", href: "_llm-wiki/review/source-queue", count_key: "source_queue" },
        { label: "Recent ingests", href: "_llm-wiki/review/recent-ingests", count_key: "recent_ingests" },
        { label: "Needs review", href: "_llm-wiki/review/needs-review", count_key: "needs_review" },
        { label: "Contradictions", href: "_llm-wiki/review/contradictions", count_key: "contradictions" },
        { label: "Orphans", href: "_llm-wiki/review/orphans", count_key: "orphans" },
        { label: "Stale pages", href: "_llm-wiki/review/stale-pages", count_key: "stale_pages" },
        {
          label: "Visibility warnings",
          href: "_llm-wiki/review/visibility-warnings",
          count_key: "visibility_warnings",
        },
        { label: "Profile summary", href: "_llm-wiki/review/profile-summary", count_key: "profile_summary" },
      ];

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.generated_paths).toEqual(expectedLocalReviewGeneratedPaths());
      expect(manifest.generated_files.map((file) => file.content_path)).toEqual(expectedLocalReviewGeneratedPaths());
      expect([...reviewPages.keys()].sort()).toEqual(generatedReviewPagePaths());
      const reviewPageFrontmatter = [...reviewPages.values()].map(parseGeneratedFrontmatter);
      expect(reviewPageFrontmatter.every((frontmatter) => frontmatter.llm_wiki_review_panel === true)).toBe(true);
      expect(reviewPageFrontmatter.every((frontmatter) => frontmatter.llm_wiki_review_profile === "review")).toBe(true);
      expect(new Set(reviewPageFrontmatter.map((frontmatter) => frontmatter.llm_wiki_review_generated_at)).size).toBe(1);
      expect(reviewPageFrontmatter[0]?.llm_wiki_review_generated_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
      );
      for (const frontmatter of reviewPageFrontmatter) {
        expect(frontmatter.llm_wiki_review_counts).toEqual(expectedCounts);
        expect(frontmatter.llm_wiki_review_links).toEqual(expectedLinks);
      }
      expectGeneratedReviewFrontmatter(overview, "Review Overview", "LlmWikiReviewPanel");
      expectGeneratedReviewFrontmatter(profileSummary, "Profile Summary", "LlmWikiReviewPanel");
      expectGeneratedReviewFrontmatter(sourceQueue, "Source Queue", "LlmWikiQueueDashboard");
      expectGeneratedReviewFrontmatter(status, "Review Status", "LlmWikiReviewPanel");
      for (const frontmatter of [overviewFrontmatter, sourceQueueFrontmatter, statusFrontmatter]) {
        expect(frontmatter).toMatchObject({
          llm_wiki_queue_dashboard: true,
          llm_wiki_queue_total: 4,
          llm_wiki_queue_queued: 1,
          llm_wiki_queue_ingesting: 1,
          llm_wiki_queue_blocked: 1,
          llm_wiki_queue_completed: 1,
        });
        expect(frontmatter.llm_wiki_queue_items).toEqual([
          expect.objectContaining({
            title: "Sync Ingested",
            source_id: ingested.sourceId,
            source_kind: "text",
            queue_status: "ingested",
            visibility: "private",
            source_card_path: ingested.sourceCardPath,
            queue_path: ingested.queuePath,
          }),
          expect.objectContaining({
            title: "Sync Blocked",
            source_id: blocked.sourceId,
            source_kind: "url",
            queue_status: "blocked",
            visibility: "public",
            source_card_path: blocked.sourceCardPath,
            queue_path: blocked.queuePath,
          }),
          expect.objectContaining({
            title: "Sync Ingesting",
            source_id: ingesting.sourceId,
            source_kind: "file",
            queue_status: "ingesting",
            visibility: "private",
            source_card_path: ingesting.sourceCardPath,
            queue_path: ingesting.queuePath,
          }),
          expect.objectContaining({
            title: "Sync Queued",
            source_id: queued.sourceId,
            source_kind: "text",
            queue_status: "queued",
            visibility: "private",
            source_card_path: queued.sourceCardPath,
            queue_path: queued.queuePath,
          }),
        ]);
      }
      expectGeneratedReviewFrontmatter(recentIngests, "Recent Ingests", "LlmWikiReviewPanel");
      expectGeneratedReviewFrontmatter(needsReview, "Needs Review", "LlmWikiReviewPanel");
      expectGeneratedReviewFrontmatter(contradictions, "Contradictions", "LlmWikiReviewPanel");
      expectGeneratedReviewFrontmatter(orphans, "Orphans", "LlmWikiReviewPanel");
      expectGeneratedReviewFrontmatter(stalePages, "Stale Pages", "LlmWikiReviewPanel");
      expectGeneratedReviewFrontmatter(visibilityWarnings, "Visibility Warnings", "LlmWikiVisibilityWarning");
      for (const pageWithSourceRows of [
        sourceQueue,
        recentIngests,
        needsReview,
        contradictions,
        orphans,
        stalePages,
        visibilityWarnings,
      ]) {
        expect(pageWithSourceRows).toContain("llm_wiki_source_badge: true");
      }
      expect(overview).toContain("| Source queue | 4 |");
      expect(overview).toContain("| Recent ingests | 1 |");
      expect(overview).toContain("| Needs review | 1 |");
      expect(overview).toContain("| Contradictions | 2 |");
      expect(overview).toContain("| Contradictions | 2 | [[_llm-wiki/review/contradictions|Contradictions]] |");
      expect(overview).not.toContain("[[contradictions|Contradictions]]");
      expect(overview).toContain("| Orphans | 1 |");
      expect(overview).toContain("| Stale pages | 1 |");
      expect(overview).toContain(`| Visibility warnings | ${visibilityWarningItems.length} |`);
      expect(overview).toContain("| Profile summary | 1 |");
      expect(overview).toContain("| Status | 4 |");
      expect(profileSummary).toContain("| Profile | review |");
      expect(profileSummary).toContain("| Queue items | 4 |");
      expect(profileSummary).toContain("| Raw source cards | 4 |");
      expect(sourceQueue).toContain("| Total | 4 |");
      expect(sourceQueue).toContain(`| ${blocked.sourceId} | Sync Blocked | blocked | url | public | ${blocked.sourceCardPath} | ${blocked.queuePath} | ${blocked.originalPath} |`);
      expect(parseReviewJsonItemBlocks(sourceQueue)[0] ?? []).toContainEqual(
        expect.objectContaining({
          source_id: blocked.sourceId,
          title: "Sync Blocked",
          source: expect.objectContaining({
            source_id: blocked.sourceId,
            title: "Sync Blocked",
            source_kind: "url",
            queue_status: "blocked",
            visibility: "public",
            source_card_path: blocked.sourceCardPath,
            page_path: blocked.sourceCardPath,
          }),
        }),
      );
      expect(status).toContain("| Queued | 1 |");
      expect(status).toContain("| Ingesting | 1 |");
      expect(status).toContain("| Blocked | 1 |");
      expect(status).toContain("| Ingested | 1 |");
      expect(recentIngests).toContain("Count: 1");
      expect(parseReviewCategoryItems(recentIngests)).toEqual([
        expect.objectContaining({
          source_id: ingested.sourceId,
          title: "Sync Ingested",
          source_card_path: ingested.sourceCardPath,
          queue_path: ingested.queuePath,
          source: expect.objectContaining({
            source_id: ingested.sourceId,
            title: "Sync Ingested",
            source_kind: "text",
            queue_status: "ingested",
            visibility: "private",
            source_card_path: ingested.sourceCardPath,
          }),
        }),
      ]);
      expect(needsReview).toContain("Count: 1");
      expect(parseReviewCategoryItems(needsReview)).toEqual([
        expect.objectContaining({
          path: "curated/questions/sync-review.md",
          title: "Sync Review Question",
          review_status: "needs-human-review",
          source_ids: [queued.sourceId],
          sources: [
            expect.objectContaining({
              source_id: queued.sourceId,
              title: "Sync Queued",
              source_kind: "text",
              queue_status: "queued",
              visibility: "private",
              source_card_path: queued.sourceCardPath,
            }),
          ],
        }),
      ]);
      expect(contradictions).toContain("Count: 2");
      expect(parseReviewCategoryItems(contradictions)).toEqual([
        expect.objectContaining({
          source: "frontmatter",
          path: "curated/contradictions/sync-conflict.md",
          title: "Sync Pricing Conflict",
          source_ids: [blocked.sourceId],
        }),
        expect.objectContaining({
          source: "log",
          path: "curated/log.md",
          source_id: ingested.sourceId,
          text: "Sync Ingested conflicts with Sync Blocked on pricing.",
        }),
      ]);
      expect(orphans).toContain("Count: 1");
      expect(parseReviewCategoryItems(orphans)).toEqual([
        expect.objectContaining({
          path: "curated/topics/sync-orphan.md",
          title: "Sync Orphan",
          rule_id: "orphan_page",
          source_ids: [queued.sourceId],
        }),
      ]);
      expect(stalePages).toContain("Count: 1");
      expect(parseReviewCategoryItems(stalePages)).toEqual([
        expect.objectContaining({
          source: "frontmatter",
          path: "curated/topics/sync-stale.md",
          title: "Sync Stale",
          next_review: "2026-06-01",
          source_ids: [ingested.sourceId],
          sources: [
            expect.objectContaining({
              source_id: ingested.sourceId,
              title: "Sync Ingested",
              source_kind: "text",
              queue_status: "ingested",
              visibility: "private",
              source_card_path: ingested.sourceCardPath,
            }),
          ],
        }),
      ]);
      expect(visibilityWarnings).toContain(`Count: ${visibilityWarningItems.length}`);
      expect(visibilityWarnings).toContain("| Severity | Reason | Affected path | Public impact | Recommended action |");
      expect(visibilityWarningItems).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: blocked.sourceCardPath,
          rule_id: "raw_sources_default_private",
          severity: "error",
          reason: expect.stringContaining("Raw source card"),
          public_impact: expect.stringContaining("public output"),
          recommended_action: "Keep raw source cards private and publish reviewed curated summaries instead.",
          source: expect.objectContaining({
            source_id: blocked.sourceId,
            title: "Sync Blocked",
            source_kind: "url",
            queue_status: "blocked",
            visibility: "public",
            source_card_path: blocked.sourceCardPath,
          }),
        }),
        expect.objectContaining({
          path: "curated/questions/sync-review.md",
          rule_id: "public_private_page_selected",
        }),
      ]));
    });
  });

  it("filters generated review data through profile exclusions and keeps selected visibility warnings", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-review-profile-filter-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const profilePath = resolve(wikiDir, ".llm-wiki/profiles/review.yml");
      const profileContent = await readFile(profilePath, "utf8");
      await writeFile(
        profilePath,
        profileContent.replace(
          "exclude:\n  - raw/inputs/**/original.*\n",
          "exclude:\n  - curated/private/**\n  - raw/inputs/**/original.*\n",
        ),
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/questions/visible-review.md",
        {
          type: "question",
          title: "Visible Review Question",
          visibility: "private",
          source_ids: [],
          review_status: "needs-human-review",
        },
        "# Visible Review Question\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/private/hidden-review.md",
        {
          type: "question",
          title: "Hidden Review Question",
          visibility: "private",
          source_ids: [],
          review_status: "needs-human-review",
        },
        "# Hidden Review Question\n",
      );

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "review", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const needsReview = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/needs-review.md");
      const visibilityWarnings = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/visibility-warnings.md");
      const needsReviewItems = parseReviewCategoryItems(needsReview);
      const visibilityWarningItems = parseReviewCategoryItems(visibilityWarnings);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.materialized_paths).toContain("quartz/content/curated/questions/visible-review.md");
      expect(payload.data.materialized_paths).not.toContain("quartz/content/curated/private/hidden-review.md");
      expect(needsReviewItems).toEqual([
        expect.objectContaining({
          path: "curated/questions/visible-review.md",
          title: "Visible Review Question",
          review_status: "needs-human-review",
        }),
      ]);
      expect(needsReviewItems).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "curated/private/hidden-review.md" }),
      ]));
      expect(visibilityWarningItems).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "curated/questions/visible-review.md",
          rule_id: "public_private_page_selected",
        }),
      ]));
      expect(visibilityWarningItems).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "curated/private/hidden-review.md" }),
      ]));
    });
  });

  it.each(["local", "review"] as const)(
    "materializes selected curated/index.md as the %s Quartz root page",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-selected-root-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSync(result.stdout);
        const sourceIndex = await readGeneratedFile(wikiDir, "curated/index.md");
        const rootIndex = await readGeneratedFile(wikiDir, "quartz/content/index.md");

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.generated_paths).toEqual(expectedLocalReviewGeneratedPaths());
        expect(payload.data.generated_paths).not.toContain("quartz/content/index.md");
        expect(payload.data.materialized_paths).toContain("quartz/content/curated/index.md");
        expect(payload.data.materialized_paths).toContain("quartz/content/index.md");
        expect(rootIndex).toBe(sourceIndex);
      });
    },
  );

  it.each(["local", "review"] as const)(
    "does not overwrite a selected top-level index.md for %s sync",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-top-level-root-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await writeCuratedPage(
          wikiDir,
          "index.md",
          {
            type: "index",
            title: "Custom Root",
            visibility: "private",
            source_ids: [],
          },
          "# Custom Root\n\nThis profile-owned root must survive sync.\n",
        );
        const profilePath = resolve(wikiDir, `.llm-wiki/profiles/${profile}.yml`);
        const profileContent = await readFile(profilePath, "utf8");
        await writeFile(
          profilePath,
          profileContent.replace("include:\n  - curated/**\n", "include:\n  - index.md\n  - curated/**\n"),
          "utf8",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSync(result.stdout);
        const manifest = await readManifest(wikiDir, profile);
        const rootIndex = await readGeneratedFile(wikiDir, "quartz/content/index.md");

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.generated_paths).toEqual(expectedLocalReviewGeneratedPaths());
        expect(payload.data.generated_paths).not.toContain("quartz/content/index.md");
        expect(payload.data.materialized_paths).toContain("quartz/content/index.md");
        expect(manifest.files).toContainEqual(expect.objectContaining({
          source_path: "index.md",
          content_path: "quartz/content/index.md",
        }));
        expect(rootIndex).toContain("# Custom Root");
        expect(rootIndex).toContain("This profile-owned root must survive sync.");
        expect(rootIndex).not.toContain("# Index");
        expect(rootIndex).not.toContain("# LLM Wiki Home");
      });
    },
  );

  it.each(["local", "review"] as const)(
    "generates a useful %s home page when curated/index.md is not selected",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-generated-home-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        const profilePath = resolve(wikiDir, `.llm-wiki/profiles/${profile}.yml`);
        const profileContent = await readFile(profilePath, "utf8");
        await writeFile(
          profilePath,
          profileContent.replace("exclude:\n  - raw/inputs/**/original.*\n", "exclude:\n  - curated/index.md\n  - raw/inputs/**/original.*\n"),
          "utf8",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSync(result.stdout);
        const rootIndex = await readGeneratedFile(wikiDir, "quartz/content/index.md");

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.generated_paths).toEqual(expectedLocalReviewGeneratedPaths({ includeRoot: true }));
        expect(payload.data.materialized_paths).not.toContain("quartz/content/curated/index.md");
        expect(rootIndex).toContain("[[curated/home|Curated home]]");
        expect(rootIndex).toContain("[[_llm-wiki/upload|Upload]]");
        expect(rootIndex).toContain("[[_llm-wiki/review/overview|Review overview]]");
        expect(rootIndex).toContain("[[_llm-wiki/review/status|Status]]");
        expect(rootIndex).toContain("[[_llm-wiki/review/source-queue|Source queue]]");
      });
    },
  );

  it("treats missing Git as no worktree for no-git sync", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-no-git-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "No Git Queue Note",
        "--text",
        "Private no-git queue text.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);

      // Act
      const result = await withUnavailableGitPath(workspaceDir, () =>
        runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]),
      );
      const payload = parseExploreSync(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.materialized_paths).toContain("quartz/content/curated/home.md");
      expect(await pathExists(resolve(wikiDir, "quartz/content/curated/home.md"))).toBe(true);
    });
  });

  it("loads supported .yaml profile files during sync", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-local-yaml-profile-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await rename(
        resolve(wikiDir, ".llm-wiki/profiles/local.yml"),
        resolve(wikiDir, ".llm-wiki/profiles/local.yaml"),
      );

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, "local");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.profile).toBe("local");
      expect(payload.data.source_profile).toBe("local");
      expect(payload.data.materialized_paths).toContain("quartz/content/curated/home.md");
      expect(manifest.source_profile).toBe("local");
    });
  });

  it.each(["public", "github-pages"] as const)("rejects duplicate public profile extensions before %s sync", async (profile) => {
    await withTempWorkspace(`llm-wiki-explore-sync-${profile}-duplicate-public-profile-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Private Local Fixture",
        "--text",
        "Private local sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      const localResult = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      expect(localResult.exitCode).toBe(0);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).toBe(true);
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.source_card_path}`))).toBe(true);

      const publicProfile = await readFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yaml"), publicProfile, "utf8");
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROFILE_INVALID");
      expect(payload.error.message).toContain("Duplicate profile files found for public");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PROFILE_INVALID",
          path: ".llm-wiki/profiles/public.yml",
        }),
      ]);
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.source_card_path}`))).toBe(true);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).toBe(true);
      expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
    });
  });

  it("rejects duplicate github-pages profile extensions before github-pages sync", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-duplicate-github-pages-profile-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const publicProfile = await readFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"), publicProfile, "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yaml"), publicProfile, "utf8");
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROFILE_INVALID");
      expect(payload.error.message).toContain("Duplicate profile files found for github-pages");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PROFILE_INVALID",
          path: ".llm-wiki/profiles/github-pages.yml",
        }),
      ]);
      expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
    });
  });

  it.each([
    {
      name: "missing base_url",
      profile: `name: github-pages
mode: deploy
custom_domain: docs.example.com
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
      message: "GitHub Pages deploy profile must define base_url.",
    },
    {
      name: "unsafe base_url",
      profile: `name: github-pages
mode: deploy
base_url: https://docs.example.com/%2e%2e/private
custom_domain: docs.example.com
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
      message: "GitHub Pages deploy profile base_url must be an absolute HTTPS URL.",
    },
    {
      name: "invalid custom_domain",
      profile: `name: github-pages
mode: deploy
base_url: https://docs.example.com
custom_domain: docs.example.com/wiki
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
      message: "GitHub Pages deploy profile custom_domain must be a host name only.",
    },
    {
      name: "custom_domain and base_url host mismatch",
      profile: `name: github-pages
mode: deploy
base_url: https://org.github.io/repo
custom_domain: docs.example.com
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
      message: "GitHub Pages deploy profile base_url host must match custom_domain.",
    },
    {
      name: "custom_domain and base_url path prefix",
      profile: `name: github-pages
mode: deploy
base_url: https://docs.example.com/wiki
custom_domain: docs.example.com
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
      message: "GitHub Pages deploy profile base_url must use custom_domain at the domain root.",
    },
  ])("rejects edited github-pages deploy profile fields before applying them: $name", async ({ profile, message }) => {
    await withTempWorkspace("llm-wiki-explore-sync-invalid-github-pages-profile-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"), profile, "utf8");
      const configPath = resolve(wikiDir, "quartz/quartz.config.ts");
      const originalConfig = await readFile(configPath, "utf8");

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROFILE_INVALID");
      expect(payload.error.message).toBe(message);
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PROFILE_INVALID",
          path: ".llm-wiki/profiles/github-pages.yml",
        }),
      ]);
      await expect(readFile(configPath, "utf8")).resolves.toBe(originalConfig);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/github-pages-CNAME"))).toBe(false);
    });
  });

  it.each(["public", "github-pages"] as const)("rejects symlinked public profiles for %s sync", async (profile) => {
    await withTempWorkspace(`llm-wiki-explore-sync-${profile}-symlink-profile-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const publicProfilePath = resolve(wikiDir, ".llm-wiki/profiles/public.yml");
      const linkedProfilePath = resolve(wikiDir, ".llm-wiki/profiles/public.link-target.yml");
      await rename(publicProfilePath, linkedProfilePath);
      await symlink(linkedProfilePath, publicProfilePath);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nPublic body.\n",
      );

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROFILE_INVALID");
      expect(payload.error.message).toContain("symlink");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PROFILE_INVALID",
          path: ".llm-wiki/profiles/public.yml",
        }),
      ]);
      expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"))).toBe(false);
    });
  });

  it.each(["public", "github-pages"] as const)("rejects symlinked profile parent directories for %s sync", async (profile) => {
    await withTempWorkspace(`llm-wiki-explore-sync-${profile}-symlink-profile-parent-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const profilesPath = resolve(wikiDir, ".llm-wiki/profiles");
      const outsideProfilesPath = resolve(workspaceDir, "outside-profiles");
      await rename(profilesPath, outsideProfilesPath);
      await symlink(outsideProfilesPath, profilesPath, "dir");
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nPublic body.\n",
      );

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROFILE_INVALID");
      expect(payload.error.message).toContain("symlink");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PROFILE_INVALID",
          path: `.llm-wiki/profiles/${profile === "github-pages" ? "github-pages" : "public"}.yml`,
        }),
      ]);
      expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"))).toBe(false);
    });
  });

  it.each(["public", "github-pages"] as const)("creates an empty content root for %s sync with no public pages", async (profile) => {
    await withTempWorkspace(`llm-wiki-explore-sync-${profile}-empty-content-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      if (profile === "github-pages") {
        await prepareGitHubPagesSyncProfile(wikiDir);
      }

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, profile);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.content_root).toBe("quartz/content");
      expect(payload.data.materialized_paths).toEqual([]);
      expect(payload.data.generated_paths).toEqual([]);
      expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(true);
      expect(await listTree(wikiDir, "quartz/content")).toEqual([]);
      expect(manifest.files).toEqual([]);
      expect(manifest.generated_files).toEqual([]);
    });
  });

  it("materializes review profile content with upload, root, full review pages, and no raw originals", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-review-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Review Queue Note",
        "--text",
        "Needs review.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "review", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, "review");
      const overview = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/overview.md");
      const sourceQueue = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/source-queue.md");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.profile).toBe("review");
      expect(payload.data.generated_paths).toEqual(expectedLocalReviewGeneratedPaths());
      expect(manifest.profile).toBe("review");
      expect(manifest.files.some((file) => file.source_path.endsWith("/_source.md"))).toBe(true);
      expect(manifest.files.some((file) => file.source_path.includes("raw/queue/"))).toBe(false);
      expect(overview).toContain("| Source queue | 1 |");
      expect(sourceQueue).toContain(capture.source.source_id);
      expect(sourceQueue).toContain("Review Queue Note");
    });
  });

  it.each(["local", "review"] as const)("rewrites excluded raw original links in %s source cards", async (profile) => {
    await withTempWorkspace(`llm-wiki-explore-sync-${profile}-source-card-links-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Linked Original",
        "--text",
        "Private original body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
      const payload = parseExploreSync(result.stdout);
      const syncedSourceCard = await readGeneratedFile(wikiDir, `quartz/content/${capture.source.source_card_path}`);
      const sourceSourceCard = await readGeneratedFile(wikiDir, capture.source.source_card_path);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.materialized_paths).toContain(`quartz/content/${capture.source.source_card_path}`);
      expect(payload.data.excluded_paths).toContain(capture.source.original_path);
      expect(syncedSourceCard).toContain(`Original file: \`${capture.source.original_path}\` (excluded from Explorer sync)`);
      expect(syncedSourceCard).not.toContain(`[[${capture.source.original_path}`);
      expect(sourceSourceCard).toContain(`Original file: [[${capture.source.original_path}|original.md]]`);
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.original_path}`))).toBe(false);
    });
  });

  it("removes stale manifests for other profiles when replacing shared content", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-switch-manifest-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Private Local Fixture",
        "--text",
        "Private local sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nPublic body.\n",
      );
      const publicResult = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "public", "--json"]);
      expect(publicResult.exitCode).toBe(0);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.public.json"))).toBe(true);

      // Act
      const localResult = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const localPayload = parseExploreSync(localResult.stdout);

      // Assert
      expect(localResult.exitCode).toBe(0);
      expect(localPayload.data.profile).toBe("local");
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).toBe(true);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.public.json"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.source_card_path}`))).toBe(true);
    });
  });

  it("patches upgraded repo ignore rules before private-capable sync output", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-upgraded-gitignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".gitignore"), ".DS_Store\n.llm-wiki/cache/\nnode_modules/\n", "utf8");
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Upgraded Private Fixture",
        "--text",
        "Private upgraded sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual(["Added missing generated Quartz ignore rule: quartz/content/"]);
      expect(payload.data.warnings).toEqual(payload.warnings);
      expect(gitignore).toContain("quartz/content/\n");
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.source_card_path}`))).toBe(true);
    });
  });

  it("repairs later gitignore negations before private-capable sync output", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-negated-gitignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir);
      await writeFile(
        resolve(wikiDir, ".gitignore"),
        ".DS_Store\n.llm-wiki/cache/\nquartz/content/\n!quartz/content/\n!quartz/content/**\n",
        "utf8",
      );
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Negated Private Fixture",
        "--text",
        "Private negated sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      const privateContentPath = `quartz/content/${capture.source.source_card_path}`;
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(false);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual([`Repaired overridden generated Quartz ignore rule: quartz/content/`]);
      expect(payload.data.warnings).toEqual(payload.warnings);
      expect(gitignore.trimEnd().endsWith("quartz/content/")).toBe(true);
      expect(await pathExists(resolve(wikiDir, privateContentPath))).toBe(true);
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(true);
    });
  });

  it("repairs nested Quartz ignore rules outside the content root", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-nested-gitignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir);
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/.gitignore"), "!content/\n!content/**\n", "utf8");
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Nested Ignore Private Fixture",
        "--text",
        "Private nested ignore sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      const privateContentPath = `quartz/content/${capture.source.source_card_path}`;
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(false);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const quartzGitignore = await readFile(resolve(wikiDir, "quartz/.gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual(["Repaired nested generated Quartz ignore rule: quartz/.gitignore"]);
      expect(payload.data.warnings).toEqual(payload.warnings);
      expect(quartzGitignore.trimEnd().endsWith("content/")).toBe(true);
      expect(await pathExists(resolve(wikiDir, "quartz/content/.gitignore"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, privateContentPath))).toBe(true);
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(true);
    });
  });

  it("checks actual generated paths when nested Quartz ignore rules keep the probe ignored", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-specific-negated-gitignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Specific Ignore Private Fixture",
        "--text",
        "Private specific ignore sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      const privateContentPath = `quartz/content/${capture.source.source_card_path}`;
      const quartzIgnorePath = `content/${capture.source.source_card_path}`;
      const quartzIgnoreSegments = quartzIgnorePath.split("/");
      const quartzIgnoreRules = quartzIgnoreSegments.flatMap((_, index) => {
        const pattern = quartzIgnoreSegments.slice(0, index + 1).join("/");
        return index === quartzIgnoreSegments.length - 1 ? [`!${pattern}`] : [`!${pattern}/`, `${pattern}/*`];
      });
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/.gitignore"), `${quartzIgnoreRules.join("\n")}\n`, "utf8");
      expect(await gitIgnoresPath(wikiDir, "quartz/content/.llm-wiki-sync-probe.md")).toBe(true);
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(false);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const quartzGitignore = await readFile(resolve(wikiDir, "quartz/.gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual(["Repaired nested generated Quartz ignore rule: quartz/.gitignore"]);
      expect(quartzGitignore.trimEnd().endsWith("content/")).toBe(true);
      expect(await pathExists(resolve(wikiDir, "quartz/content/.gitignore"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, privateContentPath))).toBe(true);
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(true);
    });
  });

  it("checks local daemon runtime metadata in private-capable ignore repair without manifesting it", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-runtime-metadata-ignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir);
      const runtimeMetadataPath = "quartz/content/_llm-wiki/runtime/local-daemon.json";
      const quartzIgnorePath = "content/_llm-wiki/runtime/local-daemon.json";
      const quartzIgnoreSegments = quartzIgnorePath.split("/");
      const quartzIgnoreRules = quartzIgnoreSegments.flatMap((_, index) => {
        const pattern = quartzIgnoreSegments.slice(0, index + 1).join("/");
        return index === quartzIgnoreSegments.length - 1 ? [`!${pattern}`] : [`!${pattern}/`, `${pattern}/*`];
      });
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/.gitignore"), `${quartzIgnoreRules.join("\n")}\n`, "utf8");
      expect(await gitIgnoresPath(wikiDir, "quartz/content/.llm-wiki-sync-probe.md")).toBe(true);
      expect(await gitIgnoresPath(wikiDir, runtimeMetadataPath)).toBe(false);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const quartzGitignore = await readFile(resolve(wikiDir, "quartz/.gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual(["Repaired nested generated Quartz ignore rule: quartz/.gitignore"]);
      expect(quartzGitignore.trimEnd().endsWith("content/")).toBe(true);
      expect(await gitIgnoresPath(wikiDir, runtimeMetadataPath)).toBe(true);
      expect(payload.data.generated_paths).not.toContain(runtimeMetadataPath);
      expect(await pathExists(resolve(wikiDir, runtimeMetadataPath))).toBe(false);
    });
  });

  it("checks local daemon runtime metadata against content-level Quartz ignore rules", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-runtime-metadata-content-ignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/content"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/content/.gitignore"), "_llm-wiki/runtime/\n", "utf8");

      // Act / Assert
      await expect(syncQuartzContent(wikiDir, "local", { preserveContentRoot: true })).rejects.toMatchObject({
        code: "QUARTZ_CONTENT_UNSAFE",
        message: "Quartz content-level .gitignore would hide synced pages from Quartz.",
        path: "quartz/content/.gitignore",
      });
    });
  });

  it.each(["public", "github-pages"] as const)(
    "patches upgraded repo ignore rules before %s sync output",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-upgraded-gitignore-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await writeFile(resolve(wikiDir, ".gitignore"), ".DS_Store\n.llm-wiki/cache/\nnode_modules/\n", "utf8");
        await makeDefaultCuratedPagesPublic(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await writeCuratedPage(
          wikiDir,
          "curated/topics/public-topic.md",
          {
            type: "topic",
            title: "Public Topic",
            visibility: "public",
            source_ids: [],
          },
          "# Public Topic\n\nPublic body.\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSync(result.stdout);
        const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");

        // Assert
        expect(result.exitCode).toBe(0);
        expect(payload.warnings).toEqual(["Added missing generated Quartz ignore rule: quartz/content/"]);
        expect(payload.data.warnings).toEqual(payload.warnings);
        expect(gitignore).toContain("quartz/content/\n");
        expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"))).toBe(true);
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "rejects generated local Explorer leaks before %s sync output",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-generated-leak-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await makeDefaultCuratedPagesPublic(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        const leakedUploadPath = "quartz/content/_llm-wiki/upload.md";
        await mkdir(resolve(wikiDir, "quartz/content/_llm-wiki"), { recursive: true });
        await writeFile(
          resolve(wikiDir, leakedUploadPath),
          "---\ntype: dashboard\ntitle: Upload\nvisibility: private\nllm_wiki_upload: true\n---\n\n# Upload\n",
          "utf8",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error).toEqual({
          code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
          message: "Public profile leak check failed: public_quartz_upload_page_leak.",
          hint: "Remove generated upload pages from quartz/content before syncing or building public Quartz output.",
        });
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: leakedUploadPath,
            hint: "Remove generated upload pages from quartz/content before syncing or building public Quartz output.",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, leakedUploadPath))).toBe(true);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it("materializes public and github-pages profiles without private pages, raw cards, or raw originals", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-public-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const privateRawText = "Private raw capture sentence that must never reach public Quartz.";
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Public Sync Raw Fixture",
        "--text",
        privateRawText,
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await prepareGitHubPagesSyncProfile(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nPublic body.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        {
          type: "topic",
          title: "Private Topic",
          visibility: "private",
          source_ids: [],
        },
        "# Private Topic\n\nPrivate body.\n",
      );
      const publicLikeProfiles = ["public", "github-pages"] as const;

      for (const profile of publicLikeProfiles) {
        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSync(result.stdout);
        const manifest = await readManifest(wikiDir, profile);
        const syncedPaths = await listTree(wikiDir, "quartz/content");
        const syncedContent = await Promise.all(
          syncedPaths.map(async (path) => readFile(resolve(wikiDir, path), "utf8")),
        );

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.source_profile).toBe(profile === "github-pages" ? "github-pages" : "public");
        expect(manifest.profile).toBe(profile);
        expect(manifest.files.map((file) => file.source_path)).toContain("curated/topics/public-topic.md");
        expect(manifest.files.map((file) => file.source_path)).not.toContain("curated/topics/private-topic.md");
        await expect(readGeneratedFile(wikiDir, "quartz/content/curated/topics/public-topic.md")).resolves.toContain(
          "Public body.",
        );
        expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/private-topic.md"))).toBe(false);
        expect(syncedPaths).not.toContain(`quartz/content/${capture.source.source_card_path}`);
        expect(syncedPaths).not.toContain(`quartz/content/${capture.source.original_path}`);
        expect(syncedPaths).not.toContain(`quartz/content/${capture.source.queue_path}`);
        expect(syncedPaths.some((path) => path.startsWith("quartz/content/_llm-wiki/upload"))).toBe(false);
        expect(syncedPaths.some((path) => path.startsWith("quartz/content/_llm-wiki/review/"))).toBe(false);
        expect(syncedPaths.some((path) => path.startsWith("quartz/content/_llm-wiki/runtime/"))).toBe(false);
        expect(payload.data.generated_paths.some((path) => path.startsWith("quartz/content/_llm-wiki/upload"))).toBe(false);
        expect(payload.data.generated_paths.some((path) => path.startsWith("quartz/content/_llm-wiki/review/"))).toBe(false);
        expect(payload.data.generated_paths.some((path) => path.startsWith("quartz/content/_llm-wiki/runtime/"))).toBe(false);
        expect(syncedContent.join("\n")).not.toContain(privateRawText);
        expect(manifest.files.some((file) => file.source_path === capture.source.source_card_path)).toBe(false);
        expect(manifest.files.some((file) => file.source_path === capture.source.original_path)).toBe(false);
        expect(manifest.files.some((file) => file.source_path === capture.source.queue_path)).toBe(false);
        expect(JSON.stringify(payload.data)).not.toContain(capture.source.source_card_path);
        expect(JSON.stringify(payload.data)).not.toContain(capture.source.original_path);
        expect(JSON.stringify(payload.data)).not.toContain(capture.source.queue_path);
        expect(JSON.stringify(manifest)).not.toContain(capture.source.source_card_path);
        expect(JSON.stringify(manifest)).not.toContain(capture.source.original_path);
        expect(JSON.stringify(manifest)).not.toContain(capture.source.queue_path);
        expect(JSON.stringify(manifest)).not.toContain(privateRawText);
      }
    });
  });

  it.each(["public", "github-pages"] as const)(
    "fails %s sync when a selected page links to a public page excluded from output",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-excluded-public-link-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await makeDefaultCuratedPagesPublic(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await writeCuratedPage(
          wikiDir,
          "curated/sources/public-summary.md",
          {
            type: "source_summary",
            title: "Excluded Public Summary",
            visibility: "public",
            source_ids: [],
          },
          "# Excluded Public Summary\n\nThis page is public but excluded by the default public profile.\n",
        );
        await writeCuratedPage(
          wikiDir,
          "curated/topics/public-topic.md",
          {
            type: "topic",
            title: "Public Topic",
            visibility: "public",
            source_ids: [],
          },
          "# Public Topic\n\nSee [[Excluded Public Summary]].\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(payload.error.message).toContain("public_quartz_link_target_excluded");
        expect(payload.error.hint).toContain("curated/sources/public-summary.md");
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: "curated/topics/public-topic.md",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "fails %s sync without deleting an existing Explorer materialization when strict leak checks fail",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-leak-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await writeCuratedPage(
          wikiDir,
          "curated/topics/public-topic.md",
          {
            type: "topic",
            title: "Public Topic",
            visibility: "public",
            source_ids: [],
          },
          "# Public Topic\n\n[[Private Topic]]\n",
        );
        await writeCuratedPage(
          wikiDir,
          "curated/topics/private-topic.md",
          {
            type: "topic",
            title: "Private Topic",
            visibility: "private",
            source_ids: [],
          },
          "# Private Topic\n",
        );
        const localResult = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
        expect(localResult.exitCode).toBe(0);
        expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/private-topic.md"))).toBe(true);
        expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).toBe(true);

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: "curated/topics/public-topic.md",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/private-topic.md"))).toBe(true);
        expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).toBe(true);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "fails %s sync when selected page is missing visibility and another required field",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-missing-type-and-visibility-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await makeDefaultCuratedPagesPublic(wikiDir);
        await writeCuratedPage(
          wikiDir,
          "curated/topics/missing-required-field.md",
          {
            title: "Missing Type And Visibility",
            source_ids: [],
          },
          "# Missing Type And Visibility\n\nThis selected page has no type or visibility frontmatter.\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(payload.error.message).toContain("public_private_page_selected");
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: "curated/topics/missing-required-field.md",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "fails %s sync before materialization when a selected page is missing visibility",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-missing-visibility-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await makeDefaultCuratedPagesPublic(wikiDir);
        await writeCuratedPage(
          wikiDir,
          "curated/topics/missing-visibility.md",
          {
            type: "topic",
            title: "Missing Visibility",
            source_ids: [],
          },
          "# Missing Visibility\n\nThis selected page has no visibility frontmatter.\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(payload.error.message).toContain("curated_frontmatter_required_missing");
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: "curated/topics/missing-visibility.md",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "preserves last successful %s output when leak checks fail after a successful sync",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-stale-manifest-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await makeDefaultCuratedPagesPublic(wikiDir);
        await writeCuratedPage(
          wikiDir,
          "curated/topics/public-topic.md",
          {
            type: "topic",
            title: "Public Topic",
            visibility: "public",
            source_ids: [],
          },
          "# Public Topic\n\nPublic body.\n",
        );
        await writeCuratedPage(
          wikiDir,
          "curated/topics/private-topic.md",
          {
            type: "topic",
            title: "Private Topic",
            visibility: "private",
            source_ids: [],
          },
          "# Private Topic\n",
        );
        const initialSync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        expect(initialSync.exitCode).toBe(0);
        const manifestPath = resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`);
        expect(await pathExists(manifestPath)).toBe(true);
        expect((await readManifest(wikiDir, profile)).files.map((file) => file.source_path)).toContain(
          "curated/topics/public-topic.md",
        );
        expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"))).toBe(true);
        const previousManifest = await readFile(manifestPath, "utf8");
        const previousPublicTopic = await readFile(
          resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"),
          "utf8",
        );

        await writeCuratedPage(
          wikiDir,
          "curated/topics/public-topic.md",
          {
            type: "topic",
            title: "Public Topic",
            visibility: "public",
            source_ids: [],
          },
          "# Public Topic\n\n[[Private Topic]]\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(await readFile(manifestPath, "utf8")).toBe(previousManifest);
        await expect(readFile(resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"), "utf8")).resolves.toBe(
          previousPublicTopic,
        );
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "fails %s sync when selected public content has strict lint errors",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-public-lint-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await makeDefaultCuratedPagesPublic(wikiDir);
        await writeCuratedPage(
          wikiDir,
          "curated/topics/public-broken-link.md",
          {
            type: "topic",
            title: "Public Broken Link",
            visibility: "public",
            source_ids: [],
          },
          "# Public Broken Link\n\n[[Missing Public Target]]\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(payload.error.message).toContain("wikilink_broken");
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: "curated/topics/public-broken-link.md",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it("ignores excluded private raw lint errors during public materialization", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-public-raw-drift-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Private Drift Fixture",
        "--text",
        "Original private text.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      await writeFile(resolve(wikiDir, capture.source.original_path), "Tampered private text.\n", "utf8");
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nPublic body.\n",
      );
      const lintResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      expect(lintResult.exitCode).toBe(1);
      expect(lintResult.stdout.join("\n")).toContain("raw_hash_drift");

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, "public");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.materialized_paths).toContain("quartz/content/curated/topics/public-topic.md");
      expect(manifest.files.map((file) => file.source_path)).toContain("curated/topics/public-topic.md");
      expect(manifest.files.some((file) => file.source_path.startsWith("raw/"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.original_path}`))).toBe(false);
    });
  });

  it("refuses a symlinked Quartz parent before clearing content outside the wiki", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-quartz-symlink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const outsideQuartzDir = resolve(workspaceDir, "outside-quartz");
      const outsideContentPath = resolve(outsideQuartzDir, "content/keep.md");
      await mkdir(resolve(outsideQuartzDir, "content"), { recursive: true });
      await writeFile(outsideContentPath, "# Outside\n", "utf8");
      await symlink(outsideQuartzDir, resolve(wikiDir, "quartz"), "dir");

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUARTZ_CONTENT_UNSAFE");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "QUARTZ_CONTENT_UNSAFE",
          path: "quartz/content",
        }),
      ]);
      await expect(readFile(outsideContentPath, "utf8")).resolves.toBe("# Outside\n");
    });
  });
});
