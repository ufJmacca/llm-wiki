import { constants } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

import { parseLogEntries } from "../src/scanner/index.js";
import { createWiki } from "../src/scaffold/createWiki.js";

afterEach(() => {
  vi.doUnmock("../src/runtime/log.js");
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

async function withTempWorkspace<T>(prefix: string, run: (workspaceDir: string) => Promise<T>): Promise<T> {
  const workspaceDir = await mkdtemp(resolve(tmpdir(), prefix));

  try {
    return await run(workspaceDir);
  } finally {
    await rm(workspaceDir, { force: true, recursive: true });
  }
}

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await createWiki(targetDir, {
    agent: "generic",
    obsidian: false,
    dataview: false,
    git: false,
    quartzReady: false,
    force: false,
  });

  expect(result.ok).toBe(true);
}

type QueueStatus = "queued" | "ingesting" | "ingested" | "blocked";

type AutoIngestMetadata = {
  enabled: boolean;
  attempt_count: number;
  last_attempt_at: string;
  last_result: string;
  last_error_code: string | null;
  last_error_message: string | null;
};

function formatSourceCard(
  sourceId: string,
  options: { status?: QueueStatus; autoIngest?: AutoIngestMetadata } = {},
): string {
  const status = options.status ?? "queued";
  const frontmatter = stringify({
    type: "raw_source",
    source_id: sourceId,
    title: "Rollback Note",
    source_kind: "text",
    origin: "test",
    origin_url: null,
    captured_at: "2026-06-17T12:00:00.000Z",
    content_hash: "sha256:000000000000",
    status,
    visibility: "private",
    ...(options.autoIngest === undefined ? {} : { auto_ingest: options.autoIngest }),
  }).trimEnd();

  return `---\n${frontmatter}\n---\n\n# Rollback Note\n\n## Ingest status\n\n- Status: ${status}\n`;
}

function formatQueueRecord(
  sourceId: string,
  sourceDir: string,
  options: { status?: QueueStatus; autoIngest?: AutoIngestMetadata } = {},
): string {
  const status = options.status ?? "queued";
  return `${JSON.stringify(
    {
      kind: "text",
      source_id: sourceId,
      title: "Rollback Note",
      source_kind: "text",
      origin: "test",
      captured_at: "2026-06-17T12:00:00.000Z",
      content_hash: "sha256:000000000000",
      status,
      visibility: "private",
      path: `${sourceDir}/_source.md`,
      original_path: `${sourceDir}/original.md`,
      ...(options.autoIngest === undefined ? {} : { auto_ingest: options.autoIngest }),
    },
    null,
    2,
  )}\n`;
}

function parseSourceCardFrontmatter<T>(content: string): T {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(frontmatter).not.toBeNull();

  return parse(frontmatter?.[1] ?? "") as T;
}

async function writeQueueFixture(
  wikiDir: string,
  sourceId: string,
  options: { status?: QueueStatus; autoIngest?: AutoIngestMetadata } = {},
): Promise<{ sourceDir: string; sourceCardPath: string; queuePath: string }> {
  const sourceDir = `raw/inputs/2026/06/${sourceId}`;
  const sourceCardPath = resolve(wikiDir, sourceDir, "_source.md");
  const queuePath = resolve(wikiDir, `raw/queue/${sourceId}.json`);

  await mkdir(resolve(wikiDir, sourceDir), { recursive: true });
  await writeFile(resolve(wikiDir, sourceDir, "original.md"), "original", "utf8");
  await writeFile(sourceCardPath, formatSourceCard(sourceId, options), "utf8");
  await writeFile(queuePath, formatQueueRecord(sourceId, sourceDir, options), "utf8");

  return { sourceDir, sourceCardPath, queuePath };
}

async function expectTransitionStateUnchanged(paths: {
  sourceCardPath: string;
  queuePath: string;
  logPath: string;
  originalSourceCard: string;
  originalQueue: string;
  originalLog: string;
  autoIngest: AutoIngestMetadata;
  status: QueueStatus;
}): Promise<void> {
  const sourceCard = await readFile(paths.sourceCardPath, "utf8");
  const queue = await readFile(paths.queuePath, "utf8");

  expect(sourceCard).toBe(paths.originalSourceCard);
  expect(queue).toBe(paths.originalQueue);
  expect(await readFile(paths.logPath, "utf8")).toBe(paths.originalLog);
  expect(JSON.parse(queue)).toMatchObject({
    status: paths.status,
    auto_ingest: paths.autoIngest,
  });
  expect(parseSourceCardFrontmatter(sourceCard)).toMatchObject({
    status: paths.status,
    auto_ingest: paths.autoIngest,
  });
  expect(sourceCard).toContain(`- Status: ${paths.status}`);
}

function mockWriteFailureForPath(absolutePath: string): void {
  vi.resetModules();
  vi.doMock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();

    return {
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        const [pathLike, flags] = args;
        const isTargetWrite =
          String(pathLike) === absolutePath &&
          typeof flags === "number" &&
          (flags & constants.O_WRONLY) === constants.O_WRONLY;

        if (isTargetWrite) {
          throw new Error(`mock write failure: ${absolutePath}`);
        }

        return actual.open(...args);
      },
    };
  });
}

function mockPartialWriteFailureOnceForPath(
  absolutePath: string,
  partialContent: string,
): { readonly partialWriteCount: number } {
  vi.resetModules();
  let partialWriteCount = 0;

  vi.doMock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();

    return {
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        const [pathLike, flags] = args;
        const file = await actual.open(...args);
        const isTargetWrite =
          String(pathLike) === absolutePath &&
          typeof flags === "number" &&
          (flags & constants.O_WRONLY) === constants.O_WRONLY;

        if (!isTargetWrite) {
          return file;
        }

        return new Proxy(file, {
          get(target, property, receiver) {
            if (property === "writeFile" && partialWriteCount === 0) {
              return async () => {
                await target.writeFile(partialContent, "utf8");
                partialWriteCount += 1;
                throw new Error(`mock partial write failure: ${absolutePath}`);
              };
            }

            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
  });

  return {
    get partialWriteCount() {
      return partialWriteCount;
    },
  };
}

describe("queue runtime status updates", () => {
  it("writes auto-ingest metadata to queue JSON, source-card frontmatter, ingest status body, and one log entry", async () => {
    await withTempWorkspace("llm-wiki-queue-transition-auto-metadata-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourceId = "src_2026_06_17_auto_000000000001";
      await initializeWiki(wikiDir);
      const { sourceCardPath, queuePath } = await writeQueueFixture(wikiDir, sourceId);
      const { transitionQueueStatus } = await import("../src/runtime/queue.js");

      // Act
      const result = await transitionQueueStatus(wikiDir, sourceId, "ingesting", {
        now: new Date("2026-06-17T12:30:00.000Z"),
        command: "test auto ingest",
        autoIngest: {
          enabled: true,
          result: "ingesting",
          errorCode: null,
          errorMessage: null,
        },
      });

      // Assert
      expect(result).toMatchObject({ ok: true, value: { status: "ingesting", previous_status: "queued" } });
      const expectedAutoIngest = {
        enabled: true,
        attempt_count: 1,
        last_attempt_at: "2026-06-17T12:30:00.000Z",
        last_result: "ingesting",
        last_error_code: null,
        last_error_message: null,
      };
      expect(JSON.parse(await readFile(queuePath, "utf8"))).toMatchObject({
        status: "ingesting",
        updated_at: "2026-06-17T12:30:00.000Z",
        auto_ingest: expectedAutoIngest,
      });
      expect(
        parseSourceCardFrontmatter(await readFile(sourceCardPath, "utf8")),
      ).toMatchObject({
        status: "ingesting",
        updated_at: "2026-06-17T12:30:00.000Z",
        auto_ingest: expectedAutoIngest,
      });
      expect(await readFile(sourceCardPath, "utf8")).toContain("- Status: ingesting");
      const parsedLog = parseLogEntries({ path: "curated/log.md", content: await readFile(resolve(wikiDir, "curated/log.md"), "utf8") });
      expect(parsedLog.issues).toEqual([]);
      expect(parsedLog.entries.filter((entry) => entry.affectedId === sourceId)).toEqual([
        expect.objectContaining({
          operation: "ingest",
          affectedId: sourceId,
          title: "Status changed to ingesting",
        }),
      ]);
    });
  });

  it("preserves auto-ingest attempt count after completion and records blocked failure metadata", async () => {
    await withTempWorkspace("llm-wiki-queue-transition-auto-preserve-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const ingestedSourceId = "src_2026_06_17_auto_000000000002";
      const blockedSourceId = "src_2026_06_17_auto_000000000003";
      const existingAutoIngest: AutoIngestMetadata = {
        enabled: true,
        attempt_count: 1,
        last_attempt_at: "2026-06-17T12:30:00.000Z",
        last_result: "ingesting",
        last_error_code: null,
        last_error_message: null,
      };
      await initializeWiki(wikiDir);
      const ingestedFixture = await writeQueueFixture(wikiDir, ingestedSourceId, {
        status: "ingesting",
        autoIngest: existingAutoIngest,
      });
      const blockedFixture = await writeQueueFixture(wikiDir, blockedSourceId, {
        status: "ingesting",
        autoIngest: existingAutoIngest,
      });
      const { transitionQueueStatus } = await import("../src/runtime/queue.js");

      // Act
      const ingestedResult = await transitionQueueStatus(wikiDir, ingestedSourceId, "ingested", {
        now: new Date("2026-06-17T12:35:00.000Z"),
        command: "test auto ingest success",
        autoIngest: {
          enabled: true,
          result: "ingested",
          errorCode: null,
          errorMessage: null,
        },
      });
      const blockedResult = await transitionQueueStatus(wikiDir, blockedSourceId, "blocked", {
        now: new Date("2026-06-17T12:36:00.000Z"),
        command: "test auto ingest failure",
        autoIngest: {
          enabled: true,
          result: "blocked",
          errorCode: "INGEST_VALIDATION_FAILED",
          errorMessage: "curated/sources/example.md was not created.",
        },
      });

      // Assert
      expect(ingestedResult).toMatchObject({ ok: true, value: { status: "ingested" } });
      expect(blockedResult).toMatchObject({ ok: true, value: { status: "blocked" } });
      expect(JSON.parse(await readFile(ingestedFixture.queuePath, "utf8")).auto_ingest).toEqual({
        enabled: true,
        attempt_count: 1,
        last_attempt_at: "2026-06-17T12:30:00.000Z",
        last_result: "ingested",
        last_error_code: null,
        last_error_message: null,
      });
      expect(
        parseSourceCardFrontmatter<{ auto_ingest: AutoIngestMetadata }>(
          await readFile(ingestedFixture.sourceCardPath, "utf8"),
        ).auto_ingest,
      ).toEqual(JSON.parse(await readFile(ingestedFixture.queuePath, "utf8")).auto_ingest);
      expect(JSON.parse(await readFile(blockedFixture.queuePath, "utf8")).auto_ingest).toEqual({
        enabled: true,
        attempt_count: 1,
        last_attempt_at: "2026-06-17T12:30:00.000Z",
        last_result: "blocked",
        last_error_code: "INGEST_VALIDATION_FAILED",
        last_error_message: "curated/sources/example.md was not created.",
      });
      expect(
        parseSourceCardFrontmatter<{ auto_ingest: AutoIngestMetadata }>(
          await readFile(blockedFixture.sourceCardPath, "utf8"),
        ).auto_ingest,
      ).toEqual(JSON.parse(await readFile(blockedFixture.queuePath, "utf8")).auto_ingest);
    });
  });

  it("leaves manual setQueueStatus JSON compatible without adding auto-ingest metadata", async () => {
    await withTempWorkspace("llm-wiki-queue-transition-manual-compatible-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourceId = "src_2026_06_17_manual_000000000004";
      await initializeWiki(wikiDir);
      const { sourceCardPath, queuePath } = await writeQueueFixture(wikiDir, sourceId);
      const { setQueueStatus, showQueueSource } = await import("../src/runtime/queue.js");

      // Act
      const result = await setQueueStatus(wikiDir, sourceId, "ingesting", {
        now: new Date("2026-06-17T12:40:00.000Z"),
        command: "test manual ingest",
      });
      const shown = await showQueueSource(wikiDir, sourceId);

      // Assert
      expect(result).toMatchObject({ ok: true, value: { status: "ingesting" } });
      const queueRecord = JSON.parse(await readFile(queuePath, "utf8")) as Record<string, unknown>;
      const sourceCardFrontmatter = parseSourceCardFrontmatter<Record<string, unknown>>(
        await readFile(sourceCardPath, "utf8"),
      );
      expect(queueRecord).not.toHaveProperty("auto_ingest");
      expect(sourceCardFrontmatter).not.toHaveProperty("auto_ingest");
      expect(shown).toMatchObject({
        ok: true,
        value: {
          queue_record: { status: "ingesting" },
          source_card: { frontmatter: { status: "ingesting" } },
        },
      });
    });
  });

  it("rolls back source card and queue JSON when the required log append fails", async () => {
    await withTempWorkspace("llm-wiki-queue-status-rollback-", async (workspaceDir) => {
      // Arrange
      vi.resetModules();
      vi.doMock("../src/runtime/log.js", () => ({
        validateRuntimeLogAppendTarget: async () => ({ ok: true, value: undefined }),
        appendRuntimeLogEntry: async () => ({
          ok: false,
          error: {
            code: "DESTINATION_PARENT_UNSAFE",
            message: "append failed",
            path: "curated/log.md",
            hint: "test failure",
          },
        }),
      }));

      const wikiDir = resolve(workspaceDir, "wiki");
      const sourceId = "src_2026_06_17_rollback_000000000000";
      await initializeWiki(wikiDir);
      const { sourceCardPath, queuePath } = await writeQueueFixture(wikiDir, sourceId);
      const originalSourceCard = await readFile(sourceCardPath, "utf8");
      const originalQueue = await readFile(queuePath, "utf8");
      const { setQueueStatus } = await import("../src/runtime/queue.js");

      // Act
      const result = await setQueueStatus(wikiDir, sourceId, "ingesting", {
        now: new Date("2026-06-17T12:30:00.000Z"),
        command: "test",
      });

      // Assert
      expect(result).toEqual({
        ok: false,
        error: {
          code: "QUEUE_WRITE_FAILED",
          message: "append failed",
          path: "curated/log.md",
          hint: "test failure",
        },
      });
      expect(await readFile(sourceCardPath, "utf8")).toBe(originalSourceCard);
      expect(await readFile(queuePath, "utf8")).toBe(originalQueue);
    });
  });

  it("rolls back auto-ingest metadata, status body, and queue JSON when the log append fails", async () => {
    await withTempWorkspace("llm-wiki-queue-transition-auto-rollback-", async (workspaceDir) => {
      // Arrange
      vi.resetModules();
      vi.doMock("../src/runtime/log.js", () => ({
        validateRuntimeLogAppendTarget: async () => ({ ok: true, value: undefined }),
        appendRuntimeLogEntry: async () => ({
          ok: false,
          error: {
            code: "DESTINATION_PARENT_UNSAFE",
            message: "append failed",
            path: "curated/log.md",
            hint: "test failure",
          },
        }),
      }));

      const wikiDir = resolve(workspaceDir, "wiki");
      const sourceId = "src_2026_06_17_rollback_000000000005";
      await initializeWiki(wikiDir);
      const { sourceCardPath, queuePath } = await writeQueueFixture(wikiDir, sourceId);
      const originalSourceCard = await readFile(sourceCardPath, "utf8");
      const originalQueue = await readFile(queuePath, "utf8");
      const { transitionQueueStatus } = await import("../src/runtime/queue.js");

      // Act
      const result = await transitionQueueStatus(wikiDir, sourceId, "ingesting", {
        now: new Date("2026-06-17T12:45:00.000Z"),
        command: "test auto ingest",
        autoIngest: {
          enabled: true,
          result: "ingesting",
          errorCode: null,
          errorMessage: null,
        },
      });

      // Assert
      expect(result).toEqual({
        ok: false,
        error: {
          code: "QUEUE_WRITE_FAILED",
          message: "append failed",
          path: "curated/log.md",
          hint: "test failure",
        },
      });
      expect(await readFile(sourceCardPath, "utf8")).toBe(originalSourceCard);
      expect(await readFile(queuePath, "utf8")).toBe(originalQueue);
    });
  });

  it("leaves queue JSON, source-card content, auto-ingest metadata, and runtime log unchanged when the source-card write fails", async () => {
    await withTempWorkspace("llm-wiki-queue-transition-source-card-write-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourceId = "src_2026_06_17_rollback_000000000006";
      const existingAutoIngest: AutoIngestMetadata = {
        enabled: true,
        attempt_count: 2,
        last_attempt_at: "2026-06-17T12:00:00.000Z",
        last_result: "blocked",
        last_error_code: "INGEST_VALIDATION_FAILED",
        last_error_message: "Previous proposal did not create curated output.",
      };
      await initializeWiki(wikiDir);
      const { sourceCardPath, queuePath } = await writeQueueFixture(wikiDir, sourceId, {
        status: "queued",
        autoIngest: existingAutoIngest,
      });
      const logPath = resolve(wikiDir, "curated/log.md");
      const originalSourceCard = await readFile(sourceCardPath, "utf8");
      const originalQueue = await readFile(queuePath, "utf8");
      const originalLog = await readFile(logPath, "utf8");

      // Act
      const partialWrite = mockPartialWriteFailureOnceForPath(
        sourceCardPath,
        "---\nstatus: ingesting\n---\n\npartial source-card rewrite\n",
      );
      const { transitionQueueStatus } = await import("../src/runtime/queue.js");
      const result = await transitionQueueStatus(wikiDir, sourceId, "ingesting", {
        now: new Date("2026-06-17T12:45:00.000Z"),
        command: "test auto ingest",
        autoIngest: {
          enabled: true,
          result: "ingesting",
          errorCode: null,
          errorMessage: null,
        },
      });

      // Assert
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "QUEUE_WRITE_FAILED",
          path: "raw/inputs/2026/06/src_2026_06_17_rollback_000000000006/_source.md",
        },
      });
      expect(partialWrite.partialWriteCount).toBe(1);
      await expectTransitionStateUnchanged({
        sourceCardPath,
        queuePath,
        logPath,
        originalSourceCard,
        originalQueue,
        originalLog,
        autoIngest: existingAutoIngest,
        status: "queued",
      });
    });
  });

  it("rolls back source-card content and leaves queue JSON, auto-ingest metadata, and runtime log unchanged when the queue JSON write fails", async () => {
    await withTempWorkspace("llm-wiki-queue-transition-queue-write-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourceId = "src_2026_06_17_rollback_000000000007";
      const existingAutoIngest: AutoIngestMetadata = {
        enabled: true,
        attempt_count: 2,
        last_attempt_at: "2026-06-17T12:00:00.000Z",
        last_result: "blocked",
        last_error_code: "INGEST_VALIDATION_FAILED",
        last_error_message: "Previous proposal did not create curated output.",
      };
      await initializeWiki(wikiDir);
      const { sourceCardPath, queuePath } = await writeQueueFixture(wikiDir, sourceId, {
        status: "queued",
        autoIngest: existingAutoIngest,
      });
      const logPath = resolve(wikiDir, "curated/log.md");
      const originalSourceCard = await readFile(sourceCardPath, "utf8");
      const originalQueue = await readFile(queuePath, "utf8");
      const originalLog = await readFile(logPath, "utf8");

      // Act
      mockWriteFailureForPath(queuePath);
      const { transitionQueueStatus } = await import("../src/runtime/queue.js");
      const result = await transitionQueueStatus(wikiDir, sourceId, "ingesting", {
        now: new Date("2026-06-17T12:45:00.000Z"),
        command: "test auto ingest",
        autoIngest: {
          enabled: true,
          result: "ingesting",
          errorCode: null,
          errorMessage: null,
        },
      });

      // Assert
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "QUEUE_WRITE_FAILED",
          path: "raw/queue/src_2026_06_17_rollback_000000000007.json",
        },
      });
      await expectTransitionStateUnchanged({
        sourceCardPath,
        queuePath,
        logPath,
        originalSourceCard,
        originalQueue,
        originalLog,
        autoIngest: existingAutoIngest,
        status: "queued",
      });
    });
  });
});
