import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { buildReviewDataModel } from "../src/quartz/index.js";
import { computeContentHash } from "../src/scanner/index.js";
import { scanWikiRepository } from "../src/scanner/repo.js";
import type { WikiProfile } from "../src/profiles/index.js";
import { withTempWorkspace } from "./helpers/init.js";

const generatedAt = new Date("2026-06-23T10:30:00.000Z");

describe("review data model", () => {
  it("joins queue items with source-card metadata while preserving queue status and path", async () => {
    await withTempWorkspace("llm-wiki-review-data-join-", async (repoRoot) => {
      // Arrange
      const source = sourceFixture(
        "src_2026_06_23_joined_note_555555",
        "Card Title",
        "queued",
        "url",
        "2026-06-23T08:00:00.000Z",
        "2026-06-23T08:30:00.000Z",
      );
      await writeSourceFixture(repoRoot, source, {
        queue: {
          title: "Queue Title",
          kind: "text",
          source_kind: "text",
          status: "blocked",
          visibility: "public",
          path: "raw/inputs/2026/06/src_2026_06_23_joined_note_555555/stale-card.md",
          captured_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
      });
      const scan = await scanWikiRepository(repoRoot);

      // Act
      const reviewData = buildReviewDataModel(scan, {
        generatedAt,
        lintResult: emptyLintResult(),
      });

      // Assert
      expect(reviewData.queue.counts).toEqual({
        total: 1,
        queued: 0,
        ingesting: 0,
        blocked: 1,
        completed: 0,
      });
      expect(reviewData.queue.items).toEqual([
        {
          source_id: source.sourceId,
          title: "Card Title",
          source_kind: "url",
          status: "blocked",
          visibility: "private",
          source_card_path: source.sourceCardPath,
          source_card_materialized: true,
          queue_path: source.queuePath,
          original_path: source.originalPath,
          captured_at: "2026-06-23T08:00:00.000Z",
          updated_at: "2026-06-23T08:30:00.000Z",
        },
      ]);
    });
  });

  it("marks queue source card paths as not materialized when the source card is missing", async () => {
    await withTempWorkspace("llm-wiki-review-data-missing-source-card-", async (repoRoot) => {
      // Arrange
      const source = sourceFixture(
        "src_2026_06_23_missing_card_666666",
        "Missing Card",
        "queued",
        "text",
        "2026-06-23T08:00:00.000Z",
      );
      await writeRepoFile(
        repoRoot,
        source.queuePath,
        `${JSON.stringify(
          {
            kind: source.sourceKind,
            source_id: source.sourceId,
            title: source.title,
            source_kind: source.sourceKind,
            captured_at: source.capturedAt,
            content_hash: source.contentHash,
            status: source.status,
            visibility: "private",
            path: source.sourceCardPath,
            original_path: source.originalPath,
          },
          null,
          2,
        )}\n`,
      );
      const scan = await scanWikiRepository(repoRoot);

      // Act
      const reviewData = buildReviewDataModel(scan, {
        generatedAt,
        lintResult: emptyLintResult(),
      });

      // Assert
      expect(reviewData.queue.items).toEqual([
        expect.objectContaining({
          source_id: source.sourceId,
          source_card_path: source.sourceCardPath,
          source_card_materialized: false,
        }),
      ]);
    });
  });

  it("derives joined review dashboard data from queue JSON, source cards, frontmatter, logs, lint, profiles, and links", async () => {
    await withTempWorkspace("llm-wiki-review-data-", async (repoRoot) => {
      // Arrange
      const queued = sourceFixture("src_2026_06_23_queued_note_111111", "Queued Note", "queued", "text", "2026-06-23T09:00:00.000Z");
      const ingesting = sourceFixture("src_2026_06_23_ingesting_note_222222", "Ingesting Note", "ingesting", "file", "2026-06-23T09:05:00.000Z", "2026-06-23T10:00:00.000Z");
      const blocked = sourceFixture("src_2026_06_23_blocked_note_333333", "Blocked Note", "blocked", "url", "2026-06-23T09:10:00.000Z", "2026-06-23T10:05:00.000Z");
      const ingested = sourceFixture("src_2026_06_23_ingested_note_444444", "Ingested Note", "ingested", "text", "2026-06-23T09:15:00.000Z", "2026-06-23T10:10:00.000Z");
      const sources = [queued, ingesting, blocked, ingested];

      for (const source of sources) {
        await writeSourceFixture(repoRoot, source);
      }
      await writeCuratedPage(
        repoRoot,
        `curated/sources/${ingested.sourceId}.md`,
        {
          type: "source_summary",
          title: "Ingested Note Summary",
          visibility: "private",
          source_ids: [ingested.sourceId],
        },
        "# Ingested Note Summary\n",
      );
      await writeCuratedPage(
        repoRoot,
        "curated/topics/orphan-hub.md",
        {
          type: "topic",
          title: "Orphan Hub",
          visibility: "private",
          source_ids: [queued.sourceId],
        },
        "# Orphan Hub\n\nLinks to [[Stale Topic]] and [[Review Question]].\n",
      );
      await writeCuratedPage(
        repoRoot,
        "curated/topics/stale-topic.md",
        {
          type: "topic",
          title: "Stale Topic",
          visibility: "private",
          source_ids: [ingested.sourceId],
          next_review: "2026-06-01",
        },
        "# Stale Topic\n",
      );
      await writeCuratedPage(
        repoRoot,
        "curated/questions/review-question.md",
        {
          type: "question",
          title: "Review Question",
          visibility: "private",
          source_ids: [queued.sourceId],
          review_status: "needs-human-review",
        },
        "# Review Question\n",
      );
      await writeCuratedPage(
        repoRoot,
        "curated/contradictions/pricing-conflict.md",
        {
          type: "page",
          title: "Pricing Conflict",
          visibility: "private",
          source_ids: [blocked.sourceId],
          tags: ["contradiction"],
        },
        "# Pricing Conflict\n",
      );
      await writeCuratedPage(
        repoRoot,
        "curated/index.md",
        {
          type: "index",
          title: "Index",
          visibility: "public",
          source_ids: [],
        },
        "# Index\n\n## Topics\n\n- [[topics/deleted-page|Deleted Page]] - stale private row text\n",
      );
      await writeCuratedPage(
        repoRoot,
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
          `## [2026-06-23T10:10:00.000Z] ingest | ${ingested.sourceId} | Ingested Note`,
          "",
          "- actor: cli",
          "- command: \"llm-wiki ingest src_2026_06_23_ingested_note_444444\"",
          `- raw_source: ${ingested.sourceCardPath}`,
          "- created:",
          `  - curated/sources/${ingested.sourceId}.md`,
          "- updated:",
          "  - curated/topics/stale-topic.md",
          "- contradictions:",
          "  - Ingested note conflicts with Blocked Note on pricing.",
          "- follow_ups:",
          "",
        ].join("\n"),
      );
      await writeProfile(repoRoot, "public", {
        name: "public",
        mode: "deploy",
        include: ["curated/**", "raw/inputs/**/_source.md", "raw/queue/**"],
        exclude: [],
        visibility: {
          required_value: "public",
        },
      });
      await writeProfile(repoRoot, "review", {
        name: "review",
        mode: "review",
        include: ["curated/**", "raw/inputs/**/_source.md", "raw/queue/**"],
        exclude: [],
        visibility: {
          include_private: true,
        },
      });
      const reviewProfile = profileFixture("review");
      const scan = await scanWikiRepository(repoRoot);

      // Act
      const reviewData = buildReviewDataModel(scan, {
        generatedAt,
        profile: reviewProfile,
      });

      // Assert
      expect(reviewData.generated_at).toBe("2026-06-23T10:30:00.000Z");
      expect(reviewData.profile).toMatchObject({
        requested_name: "review",
        source_name: "review",
        include_private: true,
        required_visibility: null,
      });
      expect(reviewData.queue.counts).toEqual({
        total: 4,
        queued: 1,
        ingesting: 1,
        blocked: 1,
        completed: 1,
      });
      expect(reviewData.queue.items).toEqual([
        expect.objectContaining({
          source_id: ingested.sourceId,
          status: "ingested",
          source_card_path: ingested.sourceCardPath,
          queue_path: ingested.queuePath,
        }),
        expect.objectContaining({
          source_id: blocked.sourceId,
          title: "Blocked Note",
          source_kind: "url",
          status: "blocked",
          visibility: "private",
          source_card_path: blocked.sourceCardPath,
          source_card_materialized: true,
          queue_path: blocked.queuePath,
          original_path: blocked.originalPath,
          captured_at: "2026-06-23T09:10:00.000Z",
          updated_at: "2026-06-23T10:05:00.000Z",
        }),
        expect.objectContaining({
          source_id: ingesting.sourceId,
          status: "ingesting",
        }),
        expect.objectContaining({
          source_id: queued.sourceId,
          status: "queued",
        }),
      ]);
      expect(reviewData.recent_ingests).toMatchObject({
        count: 1,
        items: [
          {
            source_id: ingested.sourceId,
            title: "Ingested Note",
            timestamp: "2026-06-23T10:10:00.000Z",
            log_path: "curated/log.md",
            source_card_path: ingested.sourceCardPath,
          },
        ],
      });
      expect(reviewData.needs_review.count).toBe(1);
      expect(reviewData.needs_review.items).toEqual([
        expect.objectContaining({
          path: "curated/questions/review-question.md",
          title: "Review Question",
          review_status: "needs-human-review",
        }),
      ]);
      expect(reviewData.contradictions.count).toBe(2);
      expect(reviewData.contradictions.items).toEqual([
        expect.objectContaining({
          path: "curated/contradictions/pricing-conflict.md",
          title: "Pricing Conflict",
          source: "frontmatter",
        }),
        expect.objectContaining({
          path: "curated/log.md",
          title: "Ingested Note",
          source: "log",
          text: "Ingested note conflicts with Blocked Note on pricing.",
        }),
      ]);
      expect(reviewData.stale_pages.count).toBe(2);
      expect(reviewData.stale_pages.items).toEqual([
        expect.objectContaining({
          path: "curated/index.md",
          source: "lint",
          rule_id: "index_stale",
        }),
        expect.objectContaining({
          path: "curated/topics/stale-topic.md",
          title: "Stale Topic",
          source: "frontmatter",
          next_review: "2026-06-01",
        }),
      ]);
      expect(reviewData.orphans.count).toBe(1);
      expect(reviewData.orphans.items).toEqual([
        expect.objectContaining({
          path: "curated/topics/orphan-hub.md",
          title: "Orphan Hub",
          rule_id: "orphan_page",
        }),
      ]);
      expect(reviewData.visibility_warnings.count).toBe(28);
      expect(reviewData.visibility_warnings.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "curated/log.md",
            rule_id: "public_runtime_log_selected",
          }),
          expect.objectContaining({
            path: blocked.queuePath,
            rule_id: "public_raw_file_selected",
          }),
          expect.objectContaining({
            path: queued.sourceCardPath,
            rule_id: "public_raw_source_card_selected",
          }),
          expect.objectContaining({
            path: "curated/questions/review-question.md",
            rule_id: "public_private_page_selected",
          }),
        ]),
      );
    });
  });

  it("represents empty review categories with explicit zero counts and item arrays", async () => {
    await withTempWorkspace("llm-wiki-review-data-empty-", async (repoRoot) => {
      // Arrange
      await writeCuratedPage(
        repoRoot,
        "curated/index.md",
        {
          type: "index",
          title: "Index",
          visibility: "private",
          source_ids: [],
        },
        "# Index\n\n## Overview\n",
      );
      await writeCuratedPage(
        repoRoot,
        "curated/log.md",
        {
          type: "log",
          title: "Log",
          visibility: "private",
          source_ids: [],
        },
        "# Log\n",
      );
      const scan = await scanWikiRepository(repoRoot);

      // Act
      const reviewData = buildReviewDataModel(scan, { generatedAt });

      // Assert
      expect(reviewData.queue.counts).toEqual({
        total: 0,
        queued: 0,
        ingesting: 0,
        blocked: 0,
        completed: 0,
      });
      expectCategoryEmpty(reviewData.queue);
      expectCategoryEmpty(reviewData.recent_ingests);
      expectCategoryEmpty(reviewData.needs_review);
      expectCategoryEmpty(reviewData.contradictions);
      expectCategoryEmpty(reviewData.stale_pages);
      expectCategoryEmpty(reviewData.orphans);
      expectCategoryEmpty(reviewData.visibility_warnings);
      expect(reviewData.profile).toBeNull();
    });
  });
});

type SourceFixture = {
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

type SourceFixtureWriteOptions = {
  sourceCard?: Record<string, unknown>;
  queue?: Record<string, unknown>;
};

function sourceFixture(
  sourceId: string,
  title: string,
  status: SourceFixture["status"],
  sourceKind: SourceFixture["sourceKind"],
  capturedAt: string,
  updatedAt: string | null = null,
): SourceFixture {
  const contentHash = computeContentHash(Buffer.from(`${sourceId}\n`, "utf8"));
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
    contentHash,
  };
}

async function writeSourceFixture(
  repoRoot: string,
  source: SourceFixture,
  options: SourceFixtureWriteOptions = {},
): Promise<void> {
  await writeRepoFile(repoRoot, source.originalPath, `${source.sourceId}\n`);
  const sourceCardFrontmatter = {
    type: "raw_source",
    source_id: source.sourceId,
    title: source.title,
    source_kind: source.sourceKind,
    origin: source.sourceKind === "url" ? "https://example.com/source" : "pasted_text",
    origin_url: source.sourceKind === "url" ? "https://example.com/source" : undefined,
    captured_at: source.capturedAt,
    content_hash: source.contentHash,
    status: source.status,
    visibility: "private",
    ...(source.updatedAt === null ? {} : { updated_at: source.updatedAt }),
    ...options.sourceCard,
  };
  await writeRepoFile(
    repoRoot,
    source.sourceCardPath,
    `---\n${stringify(sourceCardFrontmatter).trimEnd()}\n---\n\n# ${source.title}\n\nOriginal file: [[original.md]]\n`,
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
  await writeRepoFile(
    repoRoot,
    source.queuePath,
    `${JSON.stringify(queueItem, null, 2)}\n`,
  );
}

async function writeCuratedPage(
  repoRoot: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  await writeRepoFile(repoRoot, path, `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body}`);
}

async function writeProfile(repoRoot: string, name: string, content: Record<string, unknown>): Promise<void> {
  await writeRepoFile(repoRoot, `.llm-wiki/profiles/${name}.yml`, stringify(content));
}

async function writeRepoFile(repoRoot: string, path: string, content: string): Promise<void> {
  const absolutePath = resolve(repoRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function profileFixture(name: "public" | "review"): WikiProfile {
  const includePrivate = name === "review";

  return {
    requestedName: name,
    sourceName: name,
    path: `.llm-wiki/profiles/${name}.yml`,
    baseUrl: null,
    customDomain: null,
    include: ["curated/**", "raw/inputs/**/_source.md", "raw/queue/**"],
    exclude: [],
    includePrivate,
    requiredVisibility: includePrivate ? null : "public",
  };
}

function emptyLintResult() {
  return {
    issues: [],
    fixed_paths: [],
    counts: {
      total: 0,
      error: 0,
      warning: 0,
      fixed: 0,
    },
  };
}

function expectCategoryEmpty(category: { count?: number; counts?: { total: number }; items: unknown[] }): void {
  expect(category.items).toEqual([]);
  expect(category.count ?? category.counts?.total).toBe(0);
}
