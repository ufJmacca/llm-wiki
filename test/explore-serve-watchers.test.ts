import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const fsWatchMock = vi.hoisted(() => ({
  watch: vi.fn(),
  watchers: new Map<string, { listener: (eventType: string, filename: string | Buffer | null) => void }>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();

  return {
    ...actual,
    watch: fsWatchMock.watch,
  };
});

import { serveQuartzExplorer } from "../src/quartz/server.js";
import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

type SourceCaptureEnvelope = {
  data: {
    source: {
      source_id: string;
      source_card_path: string;
      queue_path: string;
    };
  };
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

async function markQuartzDependenciesInstalled(wikiDir: string): Promise<void> {
  await mkdir(resolve(wikiDir, "quartz/node_modules/.bin"), { recursive: true });
  await writeFile(resolve(wikiDir, "quartz/node_modules/.bin/quartz"), "#!/usr/bin/env node\n", "utf8");
  await mkdir(resolve(wikiDir, "quartz/quartz/components"), { recursive: true });
  await mkdir(resolve(wikiDir, "quartz/quartz/plugins"), { recursive: true });
  await writeFile(resolve(wikiDir, "quartz/quartz/build.ts"), "export {}\n", "utf8");
  await writeFile(resolve(wikiDir, "quartz/quartz/components/index.ts"), "export {}\n", "utf8");
  await writeFile(resolve(wikiDir, "quartz/quartz/plugins/index.ts"), "export {}\n", "utf8");
}

function installWatchMock(): void {
  fsWatchMock.watch.mockImplementation((
    path: string | Buffer | URL,
    _options: unknown,
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ) => {
    const key = path.toString();
    const watcher = new EventEmitter() as EventEmitter & { close: () => void };
    watcher.close = vi.fn(() => {
      fsWatchMock.watchers.delete(key);
    });
    fsWatchMock.watchers.set(key, { listener });
    return watcher;
  });
}

function emitWatchEvent(path: string, filename: string): boolean {
  const watcher = fsWatchMock.watchers.get(path);
  if (watcher === undefined) {
    return false;
  }

  watcher.listener("change", filename);
  return true;
}

function mockLongRunningSpawn(): {
  close: () => void;
  waitUntilStarted: () => Promise<void>;
} {
  let child: ChildProcessWithoutNullStreams | null = null;
  let closed = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => {
    markStarted = resolveStarted;
  });

  spawnMock.mockImplementation((_command: string, args: string[], _options: SpawnOptionsWithoutStdio) => {
    child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      closeChild();
      return true;
    };
    queueMicrotask(() => {
      stdout.write(`Started a Quartz server listening at http://localhost:${servedPort(args)}\n`);
      setImmediate(markStarted);
    });

    return child;
  });

  function closeChild(): void {
    if (child === null || closed) {
      return;
    }

    closed = true;
    child.emit("close", 0, null);
  }

  return {
    close: closeChild,
    waitUntilStarted: () => started,
  };
}

function servedPort(args: string[]): string {
  const portIndex = args.indexOf("--port");

  return portIndex >= 0 ? args[portIndex + 1] ?? "8080" : "8080";
}

async function waitFor<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  description: string,
): Promise<T> {
  const startedAt = Date.now();
  let lastObserved: unknown;

  while (Date.now() - startedAt < 8_000) {
    try {
      const value = await read();
      lastObserved = value;
      if (matches(value)) {
        return value;
      }
    } catch (error) {
      lastObserved = error;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  throw new Error(`Timed out waiting for ${description}. Last observed: ${String(lastObserved)}`);
}

async function waitForFileContent(
  wikiDir: string,
  path: string,
  expectedText: string,
): Promise<string> {
  return waitFor(
    async () => readFile(resolve(wikiDir, path), "utf8"),
    (content) => content.includes(expectedText),
    `${path} to contain ${expectedText}`,
  );
}

function parseSourceCapture(stdout: string[]): SourceCaptureEnvelope["data"] {
  expect(stdout).toHaveLength(1);
  return (JSON.parse(stdout[0]) as SourceCaptureEnvelope).data;
}

describe("explore serve watcher target refresh", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    fsWatchMock.watch.mockReset();
    fsWatchMock.watchers.clear();
    installWatchMock();
  });

  it("keeps queue JSON and source-card transition directories in the serve watch targets", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-queue-source-watchers-", async (workspaceDir) => {
      // Arrange
      const quartz = mockLongRunningSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourceDir = resolve(wikiDir, "raw/inputs/2026/06/src_2026_06_23_watch_auto_777777");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await mkdir(sourceDir, { recursive: true });
      await mkdir(resolve(wikiDir, "raw/queue"), { recursive: true });

      // Act
      const serveResult = serveQuartzExplorer(wikiDir, {
        profile: "local",
        port: 8782,
      });
      await quartz.waitUntilStarted();
      const hasQueueWatcher = fsWatchMock.watchers.has(resolve(wikiDir, "raw/queue"));
      const hasSourceCardWatcher = fsWatchMock.watchers.has(sourceDir);
      quartz.close();
      const result = await serveResult;

      // Assert
      expect(hasQueueWatcher).toBe(true);
      expect(hasSourceCardWatcher).toBe(true);
      expect(result.data.watch_paths).toEqual(
        expect.arrayContaining(["raw/inputs/**/_source.md", "raw/queue/*.json"]),
      );
    });
  }, 15_000);

  it("refreshes generated review queue content after queue and source-card watch events", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-queue-transition-watch-", async (workspaceDir) => {
      // Arrange
      const quartz = mockLongRunningSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      let syncCount = 0;
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Watcher Queued Source",
        "--text",
        "PRIVATE RAW UPLOAD BODY api_key=sk-watch-leak\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      const queuePath = resolve(wikiDir, capture.source.queue_path);
      const sourceCardPath = resolve(wikiDir, capture.source.source_card_path);
      const sourceCardDir = dirname(sourceCardPath);
      const safeErrorMessage =
        "Validation failed while checking source text: [raw upload content redacted] api_key=[redacted] token=[redacted]";
      const safeTableErrorMessage = safeErrorMessage.replaceAll("[", "\\[").replaceAll("]", "\\]");

      // Act
      const serveResult = serveQuartzExplorer(wikiDir, {
        profile: "local",
        port: 8783,
        onSynced: async () => {
          syncCount += 1;
        },
      });
      await quartz.waitUntilStarted();

      const queueRecord = JSON.parse(await readFile(queuePath, "utf8")) as Record<string, unknown>;
      await writeFile(
        queuePath,
        `${JSON.stringify(
          {
            ...queueRecord,
            status: "blocked",
            updated_at: "2026-06-23T10:04:00.000Z",
            auto_ingest: {
              enabled: true,
              attempt_count: 1,
              last_attempt_at: "2026-06-23T10:04:00.000Z",
              last_result: "blocked",
              last_error_code: "INGEST_VALIDATION_FAILED",
              last_error_message:
                "Validation failed while checking source text: PRIVATE RAW UPLOAD BODY api_key=sk-watch-leak token=watch-upload-token",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const updatedSourceCard = (await readFile(sourceCardPath, "utf8"))
        .replace("title: Watcher Queued Source", "title: Watcher Blocked Source")
        .replace("status: queued", "status: blocked")
        .replace(
          "\n---\n",
          [
            "",
            "auto_ingest:",
            "  enabled: true",
            "  attempt_count: 1",
            "  last_attempt_at: \"2026-06-23T10:04:00.000Z\"",
            "  last_result: \"blocked\"",
            "  last_error_code: \"INGEST_VALIDATION_FAILED\"",
            "  last_error_message: \"Validation failed while checking source text: PRIVATE RAW UPLOAD BODY api_key=sk-watch-leak token=watch-upload-token\"",
            "---",
            "",
          ].join("\n"),
        );
      await writeFile(sourceCardPath, updatedSourceCard, "utf8");
      expect(emitWatchEvent(resolve(wikiDir, "raw/queue"), `${capture.source.source_id}.json`)).toBe(true);
      expect(emitWatchEvent(sourceCardDir, "_source.md")).toBe(true);
      const sourceQueue = await waitFor(
        async () => readFile(resolve(wikiDir, "quartz/content/_llm-wiki/review/source-queue.md"), "utf8"),
        (content) =>
          content.includes("| Blocked | 1 |") &&
          content.includes("Watcher Blocked Source") &&
          content.includes(`blocked - INGEST_VALIDATION_FAILED: ${safeTableErrorMessage}`) &&
          !content.includes("PRIVATE RAW UPLOAD BODY") &&
          !content.includes("sk-watch-leak") &&
          !content.includes("watch-upload-token"),
        "source queue review content to refresh after queue and source-card watch events",
      );
      await waitFor(async () => syncCount, (count) => count >= 2, "watcher sync callback after queue transition");
      quartz.close();
      const result = await serveResult;

      // Assert
      expect(result.data.url).toBe("http://127.0.0.1:8783/");
      expect(syncCount).toBeGreaterThanOrEqual(2);
      expect(sourceQueue).toContain("| Queued | 0 |");
      expect(sourceQueue).toContain("| Blocked | 1 |");
      expect(sourceQueue).not.toContain("Watcher Queued Source");
    });
  }, 15_000);

  it("refreshes watch targets after a successful watcher sync before later changes in newly created targets", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-post-sync-watch-refresh-", async (workspaceDir) => {
      // Arrange
      const quartz = mockLongRunningSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      const lateDir = resolve(wikiDir, "curated/post-sync-refresh");
      const latePage = resolve(lateDir, "page.md");
      let syncCount = 0;
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      // Act
      const serveResult = serveQuartzExplorer(wikiDir, {
        profile: "local",
        port: 8781,
        onSynced: async () => {
          syncCount += 1;
          if (syncCount !== 2) {
            return;
          }

          await mkdir(lateDir, { recursive: true });
          await writeFile(
            latePage,
            "---\ntype: page\ntitle: Post Sync Refresh\nvisibility: private\nsource_ids: []\n---\n\n# Post Sync Refresh\n\nInitial post-sync marker.\n",
            "utf8",
          );
        },
      });
      await quartz.waitUntilStarted();
      const homePath = resolve(wikiDir, "curated/home.md");
      await writeFile(homePath, `${await readFile(homePath, "utf8")}\nPost-sync refresh trigger.\n`, "utf8");
      expect(emitWatchEvent(resolve(wikiDir, "curated"), "home.md")).toBe(true);
      await waitFor(async () => syncCount, (count) => count >= 2, "watcher sync callback to create a late target");
      await waitFor(
        async () => fsWatchMock.watchers.has(lateDir),
        (isWatched) => isWatched,
        "post-sync-created directory to become watched",
      );

      await writeFile(
        latePage,
        "---\ntype: page\ntitle: Post Sync Refresh\nvisibility: private\nsource_ids: []\n---\n\n# Post Sync Refresh\n\nUpdated post-sync marker.\n",
        "utf8",
      );
      expect(emitWatchEvent(lateDir, "page.md")).toBe(true);
      const syncedLatePage = await waitForFileContent(
        wikiDir,
        "quartz/content/curated/post-sync-refresh/page.md",
        "Updated post-sync marker.",
      );
      await waitFor(async () => syncCount, (count) => count >= 3, "third watcher sync callback to complete");
      quartz.close();
      const result = await serveResult;

      // Assert
      expect(result.data.url).toBe("http://127.0.0.1:8781/");
      expect(syncedLatePage).toContain("Updated post-sync marker.");
      expect(syncCount).toBeGreaterThanOrEqual(3);
    });
  }, 15_000);
});
