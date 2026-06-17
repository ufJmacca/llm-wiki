import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseLogEntries } from "../src/scanner/index.js";
import { parseInitJson, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

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

type SourceCaptureData = {
  status: "added" | "duplicate";
  source: {
    source_id: string;
    title: string;
    source_kind: "file" | "text" | "url";
    captured_at: string;
    visibility: "private";
    queue_status: "queued";
    original_path: string;
    source_card_path: string;
    queue_path: string;
  };
};

type QueueListData = {
  items: Array<{
    source_id: string;
    title: string;
    kind: "file" | "text" | "url";
    source_kind: "file" | "text" | "url";
    status: "queued" | "ingesting" | "ingested" | "blocked";
    visibility: "private" | "public";
    source_card_path: string;
    queue_path: string;
    original_path: string;
    updated_at: string;
  }>;
  counts: {
    total: number;
    queued: number;
    ingesting: number;
    ingested: number;
    blocked: number;
  };
};

type QueueStatus = QueueListData["items"][number]["status"];

type QueueShowData = {
  queue_record: {
    source_id: string;
    title: string;
    status: string;
    visibility: string;
    path: string;
    original_path: string;
  };
  source_card: {
    path: string;
    frontmatter: {
      type: "raw_source";
      source_id: string;
      title: string;
      source_kind: string;
      status: string;
      visibility: string;
    };
  };
};

type QueueSetStatusData = {
  source_id: string;
  previous_status: "queued" | "ingesting" | "ingested" | "blocked";
  status: "queued" | "ingesting" | "ingested" | "blocked";
  source_card_path: string;
  queue_path: string;
  updated_at: string;
  log_path: "curated/log.md";
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

async function captureTextSource(wikiDir: string, title: string, text: string): Promise<SourceCaptureData["source"]> {
  const result = await runCliBuffered(["add-text", "--repo", wikiDir, "--title", title, "--text", text, "--json"]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(payload.data.status).toBe("added");

  return payload.data.source;
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

function parseSourceCardFrontmatter<T>(content: string): T {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(frontmatter).not.toBeNull();

  return parse(frontmatter?.[1] ?? "") as T;
}

function expectQueueListStatuses(
  payload: RuntimeSuccessEnvelope<"queue", QueueListData>,
  expectedStatuses: Record<string, QueueStatus>,
  expectedCounts: QueueListData["counts"],
): void {
  const statusesBySourceId = Object.fromEntries(payload.data.items.map((item) => [item.source_id, item.status]));

  expect(statusesBySourceId).toEqual(expectedStatuses);
  expect(payload.data.counts).toEqual(expectedCounts);
}

async function rewriteSourceCardFrontmatter(
  wikiDir: string,
  sourceCardPath: string,
  update: (frontmatter: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const absolutePath = resolve(wikiDir, sourceCardPath);
  const content = await readFile(absolutePath, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  expect(match).not.toBeNull();
  const nextFrontmatter = stringify(update(parse(match?.[1] ?? "") as Record<string, unknown>)).trimEnd();

  await writeFile(absolutePath, `---\n${nextFrontmatter}\n---\n${match?.[2] ?? ""}`, "utf8");
}

function formatSourceCardFixture(fields: {
  source_id: string;
  title: string;
  status: QueueStatus;
  source_kind: "file" | "text" | "url";
  visibility: "private" | "public";
}): string {
  const frontmatter = stringify({
    type: "raw_source",
    source_id: fields.source_id,
    title: fields.title,
    source_kind: fields.source_kind,
    origin: "test",
    origin_url: null,
    captured_at: "2026-06-17T12:00:00.000Z",
    content_hash: "sha256:000000000000",
    status: fields.status,
    visibility: fields.visibility,
  }).trimEnd();

  return `---\n${frontmatter}\n---\n\n# ${fields.title}\n\n## Ingest status\n\n- Status: ${fields.status}\n`;
}

describe("queue command", () => {
  it("lists queued sources in stable JSON with source paths, updated time, and status counts", async () => {
    await withTempWorkspace("llm-wiki-queue-list-json-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T11:28:42.778Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstSource = await captureTextSource(wikiDir, "First Note", "alpha");
      const secondSource = await captureTextSource(wikiDir, "Second Note", "beta");

      // Act
      const result = await runCliBuffered(["queue", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"queue", QueueListData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: true,
        command: "queue",
        repo: wikiDir,
        data: {
          items: [
            {
              source_id: firstSource.source_id,
              title: "First Note",
              kind: "text",
              source_kind: "text",
              status: "queued",
              visibility: "private",
              source_card_path: firstSource.source_card_path,
              queue_path: firstSource.queue_path,
              original_path: firstSource.original_path,
              updated_at: firstSource.captured_at,
            },
            {
              source_id: secondSource.source_id,
              title: "Second Note",
              kind: "text",
              source_kind: "text",
              status: "queued",
              visibility: "private",
              source_card_path: secondSource.source_card_path,
              queue_path: secondSource.queue_path,
              original_path: secondSource.original_path,
              updated_at: secondSource.captured_at,
            },
          ],
          counts: {
            total: 2,
            queued: 2,
            ingesting: 0,
            ingested: 0,
            blocked: 0,
          },
        },
        warnings: [],
      });
    });
  });

  it("prints a readable human queue list and honors quiet mode", async () => {
    await withTempWorkspace("llm-wiki-queue-list-human-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "Human Note", "visible queue item");

      // Act
      const humanResult = await runCliBuffered(["queue", "--repo", wikiDir]);
      const quietResult = await runCliBuffered(["queue", "--repo", wikiDir, "--quiet"]);

      // Assert
      expect(humanResult.exitCode).toBe(0);
      expect(humanResult.stdout.join("\n")).toContain("Queue items: 1");
      expect(humanResult.stdout.join("\n")).toContain(source.source_id);
      expect(humanResult.stdout.join("\n")).toContain("Human Note");
      expect(humanResult.stdout.join("\n")).toContain("text");
      expect(humanResult.stdout.join("\n")).toContain("queued");
      expect(humanResult.stdout.join("\n")).toContain(source.source_card_path);
      expect(quietResult.exitCode).toBe(0);
      expect(quietResult.stdout).toEqual([]);
      expect(quietResult.stderr).toEqual([]);
    });
  });

  it("shows one queue record with matching source-card frontmatter in JSON and human modes", async () => {
    await withTempWorkspace("llm-wiki-queue-show-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "Show Note", "details");

      // Act
      const jsonResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const humanResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir]);
      const payload = parseJsonSuccess<"queue show", QueueShowData>(jsonResult.stdout);

      // Assert
      expect(jsonResult.exitCode).toBe(0);
      expect(jsonResult.stderr).toEqual([]);
      expect(payload.data.queue_record).toMatchObject({
        source_id: source.source_id,
        title: "Show Note",
        status: "queued",
        visibility: "private",
        path: source.source_card_path,
        original_path: source.original_path,
      });
      expect(payload.data.source_card).toEqual({
        path: source.source_card_path,
        frontmatter: expect.objectContaining({
          type: "raw_source",
          source_id: source.source_id,
          title: "Show Note",
          source_kind: "text",
          status: "queued",
          visibility: "private",
        }),
      });
      expect(humanResult.exitCode).toBe(0);
      expect(humanResult.stdout.join("\n")).toContain(`Source ID: ${source.source_id}`);
      expect(humanResult.stdout.join("\n")).toContain(`Queue: ${source.queue_path}`);
      expect(humanResult.stdout.join("\n")).toContain(`Source card: ${source.source_card_path}`);
    });
  });

  it("ignores unrelated malformed queue files for per-source show and set-status", async () => {
    await withTempWorkspace("llm-wiki-queue-per-source-malformed-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "Per Source Note", "valid source");
      await writeFile(resolve(wikiDir, "raw/queue/src_2026_06_17_broken_000000000000.json"), "{", "utf8");

      // Act
      const showResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const setStatusResult = await runCliBuffered([
        "queue",
        "set-status",
        source.source_id,
        "ingesting",
        "--repo",
        wikiDir,
        "--json",
      ]);

      // Assert
      expect(showResult.exitCode).toBe(0);
      expect(parseJsonSuccess<"queue show", QueueShowData>(showResult.stdout).data.queue_record.source_id).toBe(
        source.source_id,
      );
      expect(setStatusResult.exitCode).toBe(0);
      expect(parseJsonSuccess<"queue set-status", QueueSetStatusData>(setStatusResult.stdout).data.status).toBe(
        "ingesting",
      );
    });
  });

  it("rejects missing source cards, missing queue items, and mismatched source cards with stable JSON errors", async () => {
    await withTempWorkspace("llm-wiki-queue-show-errors-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const missingCardSource = await captureTextSource(wikiDir, "Missing Card", "one");
      const missingQueueSource = await captureTextSource(wikiDir, "Missing Queue", "two");
      const mismatchedSource = await captureTextSource(wikiDir, "Mismatch", "three");
      await rm(resolve(wikiDir, missingCardSource.source_card_path));
      await rm(resolve(wikiDir, missingQueueSource.queue_path));
      await rewriteSourceCardFrontmatter(wikiDir, mismatchedSource.source_card_path, (frontmatter) => ({
        ...frontmatter,
        status: "blocked",
      }));

      // Act
      const missingCardResult = await runCliBuffered([
        "queue",
        "show",
        missingCardSource.source_id,
        "--repo",
        wikiDir,
        "--json",
      ]);
      const missingQueueResult = await runCliBuffered([
        "queue",
        "show",
        missingQueueSource.source_id,
        "--repo",
        wikiDir,
        "--json",
      ]);
      const mismatchResult = await runCliBuffered([
        "queue",
        "show",
        mismatchedSource.source_id,
        "--repo",
        wikiDir,
        "--json",
      ]);

      // Assert
      expect(missingCardResult.exitCode).toBe(1);
      expect(parseJsonFailure<"queue show">(missingCardResult.stdout).error.code).toBe("QUEUE_SOURCE_CARD_MISSING");
      expect(missingQueueResult.exitCode).toBe(1);
      expect(parseJsonFailure<"queue show">(missingQueueResult.stdout).error.code).toBe("QUEUE_ITEM_MISSING");
      expect(mismatchResult.exitCode).toBe(1);
      expect(parseJsonFailure<"queue show">(mismatchResult.stdout).error.code).toBe("QUEUE_SOURCE_CARD_MISMATCH");
    });
  });

  it("rejects source-card paths that resolve through symlinked parents outside the wiki", async () => {
    await withTempWorkspace("llm-wiki-queue-show-parent-symlink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const outsideYearDir = resolve(workspaceDir, "outside-raw", "2026");
      const sourceId = "src_2026_06_17_outside_parent_000000000000";
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      const sourceCardPath = `${sourceDir}/_source.md`;
      const originalPath = `${sourceDir}/original.md`;
      const outsideSourceDir = resolve(outsideYearDir, "06", sourceId);
      await initializeWiki(wikiDir);
      await mkdir(outsideSourceDir, { recursive: true });
      await rm(resolve(wikiDir, "raw/inputs/2026"), { force: true, recursive: true });
      await symlink(outsideYearDir, resolve(wikiDir, "raw/inputs/2026"), "dir");
      await writeFile(
        resolve(outsideSourceDir, "_source.md"),
        formatSourceCardFixture({
          source_id: sourceId,
          title: "Outside Parent",
          status: "queued",
          source_kind: "text",
          visibility: "private",
        }),
        "utf8",
      );
      await writeFile(resolve(outsideSourceDir, "original.md"), "outside", "utf8");
      await writeFile(
        resolve(wikiDir, `raw/queue/${sourceId}.json`),
        `${JSON.stringify(
          {
            kind: "text",
            source_id: sourceId,
            title: "Outside Parent",
            source_kind: "text",
            origin: "test",
            captured_at: "2026-06-17T12:00:00.000Z",
            content_hash: "sha256:000000000000",
            status: "queued",
            visibility: "private",
            path: sourceCardPath,
            original_path: originalPath,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      // Act
      const showResult = await runCliBuffered(["queue", "show", sourceId, "--repo", wikiDir, "--json"]);
      const setStatusResult = await runCliBuffered([
        "queue",
        "set-status",
        sourceId,
        "ingesting",
        "--repo",
        wikiDir,
        "--json",
      ]);

      // Assert
      expect(showResult.exitCode).toBe(1);
      expect(parseJsonFailure<"queue show">(showResult.stdout).error.code).toBe("QUEUE_PATH_UNSAFE");
      expect(setStatusResult.exitCode).toBe(1);
      expect(parseJsonFailure<"queue set-status">(setStatusResult.stdout).error.code).toBe("QUEUE_PATH_UNSAFE");
      expect(await readFile(resolve(outsideSourceDir, "_source.md"), "utf8")).toContain("- Status: queued");
    });
  });

  it("rejects original paths that resolve through symlinked parents outside the wiki", async () => {
    await withTempWorkspace("llm-wiki-queue-show-original-parent-symlink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const outsideOriginalDir = resolve(workspaceDir, "outside-originals");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "Unsafe Original", "safe source card");
      await mkdir(outsideOriginalDir);
      await symlink(outsideOriginalDir, resolve(wikiDir, "raw/assets/outside-originals"), "dir");
      await writeFile(resolve(outsideOriginalDir, "original.md"), "outside", "utf8");
      const queuePath = resolve(wikiDir, source.queue_path);
      const queueRecord = JSON.parse(await readFile(queuePath, "utf8")) as Record<string, unknown>;
      queueRecord.original_path = "raw/assets/outside-originals/original.md";
      await writeFile(queuePath, `${JSON.stringify(queueRecord, null, 2)}\n`, "utf8");

      // Act
      const showResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const setStatusResult = await runCliBuffered([
        "queue",
        "set-status",
        source.source_id,
        "ingesting",
        "--repo",
        wikiDir,
        "--json",
      ]);

      // Assert
      expect(showResult.exitCode).toBe(1);
      expect(parseJsonFailure<"queue show">(showResult.stdout).error.code).toBe("QUEUE_PATH_UNSAFE");
      expect(setStatusResult.exitCode).toBe(1);
      expect(parseJsonFailure<"queue set-status">(setStatusResult.stdout).error.code).toBe("QUEUE_PATH_UNSAFE");
    });
  });

  it("validates status transitions, mirrors queue and source-card status, and appends structured log entries", async () => {
    await withTempWorkspace("llm-wiki-queue-set-status-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T12:00:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const ingestedSource = await captureTextSource(wikiDir, "Ingested Note", "ready");
      const blockedSource = await captureTextSource(wikiDir, "Blocked Note", "blocked");

      // Act
      const ingestingResult = await runCliBuffered([
        "queue",
        "set-status",
        ingestedSource.source_id,
        "ingesting",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const afterIngestingListResult = await runCliBuffered(["queue", "--repo", wikiDir, "--json"]);
      vi.setSystemTime(new Date("2026-06-17T12:05:00.000Z"));
      const ingestedResult = await runCliBuffered([
        "queue",
        "set-status",
        ingestedSource.source_id,
        "ingested",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const afterIngestedListResult = await runCliBuffered(["queue", "--repo", wikiDir, "--json"]);
      const blockedIngestingResult = await runCliBuffered([
        "queue",
        "set-status",
        blockedSource.source_id,
        "ingesting",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const afterBlockedIngestingListResult = await runCliBuffered(["queue", "--repo", wikiDir, "--json"]);
      const blockedResult = await runCliBuffered([
        "queue",
        "set-status",
        blockedSource.source_id,
        "blocked",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const afterBlockedListResult = await runCliBuffered(["queue", "--repo", wikiDir, "--json"]);
      const requeuedResult = await runCliBuffered([
        "queue",
        "set-status",
        blockedSource.source_id,
        "queued",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const afterRequeuedListResult = await runCliBuffered(["queue", "--repo", wikiDir, "--json"]);
      const ingestedPayload = parseJsonSuccess<"queue set-status", QueueSetStatusData>(ingestedResult.stdout);
      const afterIngestingList = parseJsonSuccess<"queue", QueueListData>(afterIngestingListResult.stdout);
      const afterIngestedList = parseJsonSuccess<"queue", QueueListData>(afterIngestedListResult.stdout);
      const afterBlockedIngestingList = parseJsonSuccess<"queue", QueueListData>(
        afterBlockedIngestingListResult.stdout,
      );
      const afterBlockedList = parseJsonSuccess<"queue", QueueListData>(afterBlockedListResult.stdout);
      const afterRequeuedList = parseJsonSuccess<"queue", QueueListData>(afterRequeuedListResult.stdout);

      // Assert
      expect(ingestingResult.exitCode).toBe(0);
      expect(ingestedResult.exitCode).toBe(0);
      expect(blockedIngestingResult.exitCode).toBe(0);
      expect(blockedResult.exitCode).toBe(0);
      expect(requeuedResult.exitCode).toBe(0);
      expect(afterIngestingListResult.exitCode).toBe(0);
      expect(afterIngestedListResult.exitCode).toBe(0);
      expect(afterBlockedIngestingListResult.exitCode).toBe(0);
      expect(afterBlockedListResult.exitCode).toBe(0);
      expect(afterRequeuedListResult.exitCode).toBe(0);
      expect(ingestedPayload.data).toEqual({
        source_id: ingestedSource.source_id,
        previous_status: "ingesting",
        status: "ingested",
        source_card_path: ingestedSource.source_card_path,
        queue_path: ingestedSource.queue_path,
        updated_at: "2026-06-17T12:05:00.000Z",
        log_path: "curated/log.md",
      });
      expectQueueListStatuses(
        afterIngestingList,
        {
          [blockedSource.source_id]: "queued",
          [ingestedSource.source_id]: "ingesting",
        },
        { total: 2, queued: 1, ingesting: 1, ingested: 0, blocked: 0 },
      );
      expectQueueListStatuses(
        afterIngestedList,
        {
          [blockedSource.source_id]: "queued",
          [ingestedSource.source_id]: "ingested",
        },
        { total: 2, queued: 1, ingesting: 0, ingested: 1, blocked: 0 },
      );
      expectQueueListStatuses(
        afterBlockedIngestingList,
        {
          [blockedSource.source_id]: "ingesting",
          [ingestedSource.source_id]: "ingested",
        },
        { total: 2, queued: 0, ingesting: 1, ingested: 1, blocked: 0 },
      );
      expectQueueListStatuses(
        afterBlockedList,
        {
          [blockedSource.source_id]: "blocked",
          [ingestedSource.source_id]: "ingested",
        },
        { total: 2, queued: 0, ingesting: 0, ingested: 1, blocked: 1 },
      );
      expectQueueListStatuses(
        afterRequeuedList,
        {
          [blockedSource.source_id]: "queued",
          [ingestedSource.source_id]: "ingested",
        },
        { total: 2, queued: 1, ingesting: 0, ingested: 1, blocked: 0 },
      );

      const ingestedQueue = JSON.parse(await readGeneratedFile(wikiDir, ingestedSource.queue_path)) as {
        status: string;
        updated_at: string;
      };
      expect(ingestedQueue.status).toBe("ingested");
      expect(ingestedQueue.updated_at).toBe("2026-06-17T12:05:00.000Z");
      expect(
        parseSourceCardFrontmatter<{ status: string; updated_at: string }>(
          await readGeneratedFile(wikiDir, ingestedSource.source_card_path),
        ),
      ).toMatchObject({
        status: "ingested",
        updated_at: "2026-06-17T12:05:00.000Z",
      });
      expect((await readGeneratedFile(wikiDir, ingestedSource.source_card_path))).toContain("- Status: ingested");

      const requeuedQueue = JSON.parse(await readGeneratedFile(wikiDir, blockedSource.queue_path)) as {
        status: string;
      };
      expect(requeuedQueue.status).toBe("queued");
      expect(
        parseSourceCardFrontmatter<{ status: string }>(await readGeneratedFile(wikiDir, blockedSource.source_card_path)),
      ).toMatchObject({ status: "queued" });

      const parsedLog = parseLogEntries({ path: "curated/log.md", content: await readGeneratedFile(wikiDir, "curated/log.md") });
      expect(parsedLog.issues).toEqual([]);
      expect(parsedLog.entries.filter((entry) => entry.operation === "ingest")).toEqual([
        expect.objectContaining({
          affectedId: ingestedSource.source_id,
          title: "Status changed to ingesting",
        }),
        expect.objectContaining({
          affectedId: ingestedSource.source_id,
          title: "Status changed to ingested",
        }),
        expect.objectContaining({
          affectedId: blockedSource.source_id,
          title: "Status changed to ingesting",
        }),
        expect.objectContaining({
          affectedId: blockedSource.source_id,
          title: "Status changed to blocked",
        }),
        expect.objectContaining({
          affectedId: blockedSource.source_id,
          title: "Status changed to queued",
        }),
      ]);
      expect(parsedLog.entries.find((entry) => entry.title === "Status changed to ingested")?.body).toContain(
        "- status: ingesting -> ingested",
      );
    });
  });

  it("preserves CRLF source-card body content when setting status", async () => {
    await withTempWorkspace("llm-wiki-queue-set-status-crlf-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T12:10:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "CRLF Note", "body stays intact");
      const sourceCardPath = resolve(wikiDir, source.source_card_path);
      const sourceCardContent = await readFile(sourceCardPath, "utf8");
      await writeFile(
        sourceCardPath,
        `${sourceCardContent}\n## Human notes\n\nKeep this note.\n`.replaceAll("\n", "\r\n"),
        "utf8",
      );

      // Act
      const result = await runCliBuffered([
        "queue",
        "set-status",
        source.source_id,
        "ingesting",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const updatedSourceCard = await readFile(sourceCardPath, "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(parseJsonSuccess<"queue set-status", QueueSetStatusData>(result.stdout).data.status).toBe("ingesting");
      expect(updatedSourceCard).toContain("# CRLF Note");
      expect(updatedSourceCard).toContain("## Human notes");
      expect(updatedSourceCard).toContain("Keep this note.");
      expect(updatedSourceCard).toContain("- Status: ingesting");
      expect(updatedSourceCard).not.toContain("- Status: queued");
    });
  });

  it("updates the generated ingest status line without rewriting human status notes", async () => {
    await withTempWorkspace("llm-wiki-queue-set-status-human-note-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "Human Status Note", "body status stays separate");
      const sourceCardPath = resolve(wikiDir, source.source_card_path);
      const sourceCardContent = await readFile(sourceCardPath, "utf8");
      await writeFile(
        sourceCardPath,
        sourceCardContent.replace(
          "## Human notes\n\n## Ingest status",
          "## Human notes\n\n- Status: user draft\n\n## Ingest status",
        ),
        "utf8",
      );

      // Act
      const result = await runCliBuffered([
        "queue",
        "set-status",
        source.source_id,
        "ingesting",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const updatedSourceCard = await readFile(sourceCardPath, "utf8");
      const ingestStatusSection = updatedSourceCard.match(/## Ingest status[\s\S]*?(?=\n## |\n# |$)/)?.[0] ?? "";

      // Assert
      expect(result.exitCode).toBe(0);
      expect(parseJsonSuccess<"queue set-status", QueueSetStatusData>(result.stdout).data.status).toBe("ingesting");
      expect(updatedSourceCard).toContain("## Human notes\n\n- Status: user draft\n\n## Ingest status");
      expect(ingestStatusSection).toContain("- Status: ingesting");
      expect(ingestStatusSection).not.toContain("- Status: queued");
    });
  });

  it("prints a readable human status transition summary with changed paths", async () => {
    await withTempWorkspace("llm-wiki-queue-set-status-human-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-17T12:15:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "Human Transition", "show changed paths");

      // Act
      const result = await runCliBuffered([
        "queue",
        "set-status",
        source.source_id,
        "ingesting",
        "--repo",
        wikiDir,
      ]);

      // Assert
      const output = result.stdout.join("\n");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(output).toContain("Queue status updated");
      expect(output).toContain(`Source ID: ${source.source_id}`);
      expect(output).toContain("Status: queued -> ingesting");
      expect(output).toContain(`Queue: ${source.queue_path}`);
      expect(output).toContain(`Source card: ${source.source_card_path}`);
      expect(output).toContain("Log: curated/log.md");
    });
  });

  it("rejects invalid statuses and invalid transitions with stable JSON errors", async () => {
    await withTempWorkspace("llm-wiki-queue-set-status-errors-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "Transition Note", "cannot skip");

      // Act
      const invalidStatusResult = await runCliBuffered([
        "queue",
        "set-status",
        source.source_id,
        "done",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const invalidTransitionResult = await runCliBuffered([
        "queue",
        "set-status",
        source.source_id,
        "ingested",
        "--repo",
        wikiDir,
        "--json",
      ]);

      // Assert
      expect(invalidStatusResult.exitCode).toBe(1);
      expect(parseJsonFailure<"queue set-status">(invalidStatusResult.stdout).error.code).toBe("QUEUE_STATUS_INVALID");
      expect(invalidTransitionResult.exitCode).toBe(1);
      expect(parseJsonFailure<"queue set-status">(invalidTransitionResult.stdout).error.code).toBe(
        "QUEUE_STATUS_TRANSITION_INVALID",
      );
    });
  });
});
