import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { createWiki } from "../src/scaffold/createWiki.js";

afterEach(() => {
  vi.doUnmock("../src/runtime/log.js");
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

function formatSourceCard(sourceId: string): string {
  const frontmatter = stringify({
    type: "raw_source",
    source_id: sourceId,
    title: "Rollback Note",
    source_kind: "text",
    origin: "test",
    origin_url: null,
    captured_at: "2026-06-17T12:00:00.000Z",
    content_hash: "sha256:000000000000",
    status: "queued",
    visibility: "private",
  }).trimEnd();

  return `---\n${frontmatter}\n---\n\n# Rollback Note\n\n## Ingest status\n\n- Status: queued\n`;
}

function formatQueueRecord(sourceId: string, sourceDir: string): string {
  return `${JSON.stringify(
    {
      kind: "text",
      source_id: sourceId,
      title: "Rollback Note",
      source_kind: "text",
      origin: "test",
      captured_at: "2026-06-17T12:00:00.000Z",
      content_hash: "sha256:000000000000",
      status: "queued",
      visibility: "private",
      path: `${sourceDir}/_source.md`,
      original_path: `${sourceDir}/original.md`,
    },
    null,
    2,
  )}\n`;
}

describe("queue runtime status updates", () => {
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
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      const sourceCardPath = resolve(wikiDir, sourceDir, "_source.md");
      const queuePath = resolve(wikiDir, `raw/queue/${sourceId}.json`);
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, sourceDir), { recursive: true });
      await writeFile(resolve(wikiDir, sourceDir, "original.md"), "original", "utf8");
      await writeFile(sourceCardPath, formatSourceCard(sourceId), "utf8");
      await writeFile(queuePath, formatQueueRecord(sourceId, sourceDir), "utf8");
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
});
