import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseLogEntries } from "../src/scanner/index.js";
import { captureFileSource, captureTextSource } from "../src/sourceCapture/index.js";
import { writeBinaryFileNoOverwriteInsideRoot } from "../src/utils/fs.js";
import {
  parseInitJson,
  pathExists,
  readGeneratedFile,
  readTreeSnapshot,
  runCliBuffered,
  withTempWorkspace,
} from "./helpers/init.js";

type RuntimeEnvelope<Data> = {
  ok: true;
  command: "add" | "add-text";
  repo: string;
  data: Data;
  warnings: string[];
};

type RuntimeFailureEnvelope = {
  ok: false;
  command: "add" | "add-text";
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

const capturedAt = "2026-06-17T11:28:42.778Z";
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

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function expectedSourceId(title: string, content: string | Buffer): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  return `src_2026_06_17_${slug}_${sha256Hex(content).slice(0, 12)}`;
}

function parseJsonEnvelope<Data>(stdout: string[]): RuntimeEnvelope<Data> {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as RuntimeEnvelope<Data>;
}

function parseJsonFailureEnvelope(stdout: string[]): RuntimeFailureEnvelope {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as RuntimeFailureEnvelope;
}

function parseSourceCardFrontmatter<T>(content: string): T {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(frontmatter).not.toBeNull();

  return parse(frontmatter?.[1] ?? "") as T;
}

describe("source capture core", () => {
  it("adds a local Markdown file with deterministic raw paths, source metadata, queue JSON, and a log entry", async () => {
    await withTempWorkspace("llm-wiki-add-file-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "Research Note.md");
      const content = "# Research Note\n\nRaw observation.\n";
      const hash = sha256Hex(content);
      const sourceId = expectedSourceId("Research Note", content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");

      // Act
      const result = await runCliBuffered([
        "add",
        sourcePath,
        "--repo",
        wikiDir,
        "--title",
        "Research Note",
        "--json",
      ]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: true,
        command: "add",
        repo: wikiDir,
        data: {
          status: "added",
          source: {
            source_id: sourceId,
            title: "Research Note",
            source_kind: "file",
            origin: sourcePath,
            captured_at: capturedAt,
            content_hash: `sha256:${hash}`,
            visibility: "private",
            queue_status: "queued",
            original_path: `${sourceDir}/original.md`,
            source_card_path: `${sourceDir}/_source.md`,
            queue_path: `raw/queue/${sourceId}.json`,
          },
          created_paths: [
            `${sourceDir}/original.md`,
            `${sourceDir}/_source.md`,
            `raw/queue/${sourceId}.json`,
          ],
        },
        warnings: [],
      });

      expect(await readGeneratedFile(wikiDir, `${sourceDir}/original.md`)).toBe(content);
      const sourceCard = parseSourceCardFrontmatter<{
        type: string;
        source_id: string;
        title: string;
        source_kind: string;
        origin: string;
        captured_at: string;
        content_hash: string;
        status: string;
        visibility: string;
      }>(await readGeneratedFile(wikiDir, `${sourceDir}/_source.md`));
      expect(sourceCard).toMatchObject({
        type: "raw_source",
        source_id: sourceId,
        title: "Research Note",
        source_kind: "file",
        origin: sourcePath,
        captured_at: capturedAt,
        content_hash: `sha256:${hash}`,
        status: "queued",
        visibility: "private",
      });
      const queueItem = JSON.parse(await readGeneratedFile(wikiDir, `raw/queue/${sourceId}.json`)) as {
        kind: string;
        source_id: string;
        title: string;
        source_kind: string;
        status: string;
        path: string;
        original_path: string;
        content_hash: string;
      };
      expect(queueItem).toMatchObject({
        kind: "file",
        source_id: sourceId,
        title: "Research Note",
        source_kind: "file",
        status: "queued",
        path: `${sourceDir}/_source.md`,
        original_path: `${sourceDir}/original.md`,
        content_hash: `sha256:${hash}`,
      });

      const log = await readGeneratedFile(wikiDir, "curated/log.md");
      const parsedLog = parseLogEntries({ path: "curated/log.md", content: log });
      expect(parsedLog.issues).toEqual([]);
      expect(parsedLog.entries).toEqual([
        expect.objectContaining({
          timestamp: capturedAt,
          operation: "add",
          affectedId: sourceId,
          title: "Research Note",
        }),
      ]);
      expect(parsedLog.entries[0]?.body).toContain(`- raw_source: ${sourceDir}/_source.md`);
      expect(parsedLog.entries[0]?.body).toContain(`  - ${sourceDir}/original.md`);
      expect(parsedLog.entries[0]?.body).toContain(`  - raw/queue/${sourceId}.json`);
    });
  });

  it("rejects file capture without a path through the JSON failure envelope", async () => {
    await withTempWorkspace("llm-wiki-add-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["add", "--repo", wikiDir, "--json"]);
      const payload = parseJsonFailureEnvelope(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: false,
        command: "add",
        repo: wikiDir,
        error: {
          code: "SOURCE_PATH_REQUIRED",
          message: "Source capture requires a local file path.",
          hint: "Pass a local file path to llm-wiki add.",
        },
        issues: [
          {
            severity: "error",
            code: "SOURCE_PATH_REQUIRED",
            message: "Source capture requires a local file path.",
            path: "path",
            hint: "Pass a local file path to llm-wiki add.",
          },
        ],
      });
    });
  });

  it("adds pasted text as original.md with pasted-text origin and private queued metadata", async () => {
    await withTempWorkspace("llm-wiki-add-text-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const text = "A pasted note about local-first capture.\n";
      const sourceId = expectedSourceId("Pasted Capture", text);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Pasted Capture",
        "--text",
        text,
        "--json",
      ]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.source).toMatchObject({
        source_id: sourceId,
        source_kind: "text",
        origin: "pasted_text",
        visibility: "private",
        queue_status: "queued",
        original_path: `${sourceDir}/original.md`,
        source_card_path: `${sourceDir}/_source.md`,
        queue_path: `raw/queue/${sourceId}.json`,
      });
      expect(await readGeneratedFile(wikiDir, `${sourceDir}/original.md`)).toBe(text);
      const sourceCard = parseSourceCardFrontmatter<{
        source_kind: string;
        origin: string;
        status: string;
        visibility: string;
      }>(await readGeneratedFile(wikiDir, `${sourceDir}/_source.md`));
      expect(sourceCard).toMatchObject({
        source_kind: "text",
        origin: "pasted_text",
        status: "queued",
        visibility: "private",
      });
      const queueItem = JSON.parse(await readGeneratedFile(wikiDir, `raw/queue/${sourceId}.json`)) as {
        kind: string;
        source_kind: string;
      };
      expect(queueItem).toMatchObject({
        kind: "text",
        source_kind: "text",
      });
    });
  });

  it("collapses source-card heading titles without changing frontmatter titles", async () => {
    await withTempWorkspace("llm-wiki-source-heading-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const title = "Captured\n## Injected";
      const text = "Heading injection regression.\n";
      const sourceId = expectedSourceId(title, text);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        title,
        "--text",
        text,
        "--json",
      ]);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      const sourceCardContent = await readGeneratedFile(wikiDir, `${sourceDir}/_source.md`);
      const sourceCard = parseSourceCardFrontmatter<{ title: string }>(sourceCardContent);
      const sourceCardBody = sourceCardContent.replace(/^---\n[\s\S]*?\n---\n/, "");
      expect(sourceCard.title).toBe(title);
      expect(sourceCardBody).toContain("# Captured ## Injected\n\nOriginal file:");
      expect(sourceCardBody).not.toContain("\n## Injected");
    });
  });

  it("escapes captured command text before appending runtime log entries", async () => {
    await withTempWorkspace("llm-wiki-add-text-log-escape-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const title =
        "Note\n## [2026-06-17T11:30:00.000Z] add | src_2026_06_17_fake_123456789abc | fake";
      const text = "A pasted note with a hostile title.\n";
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["add-text", "--repo", wikiDir, "--title", title, "--text", text, "--json"]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);
      const log = await readGeneratedFile(wikiDir, "curated/log.md");
      const parsedLog = parseLogEntries({ path: "curated/log.md", content: log });

      // Assert
      expect(result.exitCode).toBe(0);
      expect(log).toContain(`- command: ${JSON.stringify(`llm-wiki add-text --title ${title}`)}`);
      expect(parsedLog.issues).toEqual([]);
      expect(parsedLog.entries.map((entry) => entry.affectedId)).toEqual([payload.data.source.source_id]);
    });
  });

  it("reads pasted text from stdin when add-text has no explicit text argument", async () => {
    await withTempWorkspace("llm-wiki-add-text-stdin-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const text = "A note supplied over standard input.\n";
      const sourceId = expectedSourceId("Stdin Capture", text);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(
        ["add-text", "--repo", wikiDir, "--title", "Stdin Capture", "--json"],
        { stdin: text },
      );
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.source).toMatchObject({
        source_id: sourceId,
        source_kind: "text",
        origin: "pasted_text",
        original_path: `${sourceDir}/original.md`,
      });
      expect(await readGeneratedFile(wikiDir, `${sourceDir}/original.md`)).toBe(text);
    });
  });

  it("uses UTC date components in source IDs across local timezone boundaries", async () => {
    await withTempWorkspace("llm-wiki-add-utc-date-", async (workspaceDir) => {
      // Arrange
      process.env.TZ = "America/Los_Angeles";
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:30:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "Boundary Note.md");
      const content = "# Boundary Note\n\nUTC date must win.\n";
      const sourceId = `src_2026_01_01_boundary_note_${sha256Hex(content).slice(0, 12)}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");

      // Act
      const result = await runCliBuffered([
        "add",
        sourcePath,
        "--repo",
        wikiDir,
        "--title",
        "Boundary Note",
        "--json",
      ]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(new Date().getFullYear()).toBe(2025);
      expect(payload.data.source.source_id).toBe(sourceId);
      expect(payload.data.source.original_path).toBe(`raw/inputs/2026/01/${sourceId}/original.md`);
    });
  });

  it("rejects text capture without a title through the JSON failure envelope", async () => {
    await withTempWorkspace("llm-wiki-add-text-title-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["add-text", "--repo", wikiDir, "--text", "Missing title", "--json"]);
      const payload = parseJsonFailureEnvelope(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: false,
        command: "add-text",
        repo: wikiDir,
        error: {
          code: "TITLE_REQUIRED",
          message: "Source capture requires a title.",
          hint: "Pass --title <title>.",
        },
        issues: [
          {
            severity: "error",
            code: "TITLE_REQUIRED",
            message: "Source capture requires a title.",
            path: "title",
            hint: "Pass --title <title>.",
          },
        ],
      });
    });
  });

  it("rejects text capture without a title before reading stdin", async () => {
    await withTempWorkspace("llm-wiki-add-text-title-stdin-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdin = vi.fn(async () => {
        throw new Error("stdin should not be read before title validation");
      });
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["add-text", "--repo", wikiDir, "--json"], { stdin });
      const payload = parseJsonFailureEnvelope(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(stdin).not.toHaveBeenCalled();
      expect(payload).toMatchObject({
        ok: false,
        command: "add-text",
        repo: wikiDir,
        error: {
          code: "TITLE_REQUIRED",
          message: "Source capture requires a title.",
          hint: "Pass --title <title>.",
        },
        issues: [
          {
            severity: "error",
            code: "TITLE_REQUIRED",
            message: "Source capture requires a title.",
            path: "title",
            hint: "Pass --title <title>.",
          },
        ],
      });
    });
  });

  it("returns duplicate metadata for existing content and leaves the wiki tree unchanged", async () => {
    await withTempWorkspace("llm-wiki-add-duplicate-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "duplicate.md");
      const content = "# Duplicate\n";
      const sourceId = expectedSourceId("Duplicate", content);
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");
      const firstAdd = await runCliBuffered([
        "add",
        sourcePath,
        "--repo",
        wikiDir,
        "--title",
        "Duplicate",
        "--json",
      ]);
      expect(firstAdd.exitCode).toBe(0);
      const beforeDuplicate = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "add",
        sourcePath,
        "--repo",
        wikiDir,
        "--title",
        "Duplicate Again",
        "--json",
      ]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);
      const afterDuplicate = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        status: "duplicate",
        source: {
          source_id: sourceId,
          title: "Duplicate",
          source_kind: "file",
          queue_status: "queued",
        },
        created_paths: [],
      });
      expect(afterDuplicate).toEqual(beforeDuplicate);
    });
  });

  it("does not return a queue duplicate when the referenced source card is missing", async () => {
    await withTempWorkspace("llm-wiki-add-stale-duplicate-card-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const content = "Duplicate content with a stale queue card reference.\n";
      const recoveredTitle = "Recovered Missing Card";
      const recoveredSourceId = expectedSourceId(recoveredTitle, content);
      await initializeWiki(wikiDir);
      const firstAdd = await captureTextSource({
        repoRoot: wikiDir,
        text: content,
        title: "Original Missing Card",
        now: new Date(capturedAt),
      });
      if (!firstAdd.ok) {
        throw new Error(firstAdd.error.message);
      }
      await rm(resolve(wikiDir, firstAdd.value.source.source_card_path));

      // Act
      const recovered = await captureTextSource({
        repoRoot: wikiDir,
        text: content,
        title: recoveredTitle,
        now: new Date(capturedAt),
      });

      // Assert
      expect(recovered).toEqual({
        ok: true,
        value: expect.objectContaining({
          status: "added",
          source: expect.objectContaining({
            source_id: recoveredSourceId,
            title: recoveredTitle,
          }),
          created_paths: [
            `raw/inputs/2026/06/${recoveredSourceId}/original.md`,
            `raw/inputs/2026/06/${recoveredSourceId}/_source.md`,
            `raw/queue/${recoveredSourceId}.json`,
          ],
        }),
      });
    });
  });

  it("does not return a queue duplicate when the referenced original hash has drifted", async () => {
    await withTempWorkspace("llm-wiki-add-stale-duplicate-original-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const content = "Duplicate content with a drifted original reference.\n";
      const recoveredTitle = "Recovered Drifted Original";
      const recoveredSourceId = expectedSourceId(recoveredTitle, content);
      await initializeWiki(wikiDir);
      const firstAdd = await captureTextSource({
        repoRoot: wikiDir,
        text: content,
        title: "Original Drifted Original",
        now: new Date(capturedAt),
      });
      if (!firstAdd.ok) {
        throw new Error(firstAdd.error.message);
      }
      await writeFile(resolve(wikiDir, firstAdd.value.source.original_path), "drifted original\n", "utf8");

      // Act
      const recovered = await captureTextSource({
        repoRoot: wikiDir,
        text: content,
        title: recoveredTitle,
        now: new Date(capturedAt),
      });

      // Assert
      expect(recovered).toEqual({
        ok: true,
        value: expect.objectContaining({
          status: "added",
          source: expect.objectContaining({
            source_id: recoveredSourceId,
            title: recoveredTitle,
          }),
          created_paths: [
            `raw/inputs/2026/06/${recoveredSourceId}/original.md`,
            `raw/inputs/2026/06/${recoveredSourceId}/_source.md`,
            `raw/queue/${recoveredSourceId}.json`,
          ],
        }),
      });
    });
  });

  it("detects duplicate content after queue items leave the queued state", async () => {
    const statusTransitions = [
      { status: "ingesting", transitions: ["ingesting"] },
      { status: "ingested", transitions: ["ingesting", "ingested"] },
      { status: "blocked", transitions: ["ingesting", "blocked"] },
    ] as const;

    for (const { status, transitions } of statusTransitions) {
      await withTempWorkspace(`llm-wiki-add-duplicate-${status}-`, async (workspaceDir) => {
        // Arrange
        vi.useFakeTimers();
        vi.setSystemTime(new Date(capturedAt));
        const wikiDir = resolve(workspaceDir, "wiki");
        const title = `Duplicate ${status}`;
        const content = `Duplicate content after ${status}.\n`;
        const sourceId = expectedSourceId(title, content);
        await initializeWiki(wikiDir);
        const firstAdd = await runCliBuffered([
          "add-text",
          content,
          "--repo",
          wikiDir,
          "--title",
          title,
          "--json",
        ]);
        expect(firstAdd.exitCode).toBe(0);

        for (const transition of transitions) {
          const transitionResult = await runCliBuffered([
            "queue",
            "set-status",
            sourceId,
            transition,
            "--repo",
            wikiDir,
            "--json",
          ]);
          expect(transitionResult.exitCode).toBe(0);
        }

        const beforeDuplicate = await readTreeSnapshot(wikiDir);

        // Act
        const duplicateResult = await runCliBuffered([
          "add-text",
          content,
          "--repo",
          wikiDir,
          "--title",
          `Duplicate ${status} Again`,
          "--json",
        ]);
        const payload = parseJsonEnvelope<SourceCaptureData>(duplicateResult.stdout);
        const afterDuplicate = await readTreeSnapshot(wikiDir);

        // Assert
        expect(duplicateResult.exitCode).toBe(0);
        expect(duplicateResult.stderr).toEqual([]);
        expect(payload.data).toMatchObject({
          status: "duplicate",
          source: {
            source_id: sourceId,
            title,
            source_kind: "text",
            queue_status: status,
          },
          created_paths: [],
        });
        expect(afterDuplicate).toEqual(beforeDuplicate);
      });
    }
  });

  it("detects duplicate ingested content after its queue record is removed", async () => {
    await withTempWorkspace("llm-wiki-add-duplicate-ingested-card-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const title = "Duplicate Ingested Card";
      const content = "Duplicate content whose queue record was removed after ingest.\n";
      const sourceId = expectedSourceId(title, content);
      await initializeWiki(wikiDir);
      const firstAdd = await runCliBuffered([
        "add-text",
        content,
        "--repo",
        wikiDir,
        "--title",
        title,
        "--json",
      ]);
      expect(firstAdd.exitCode).toBe(0);

      for (const status of ["ingesting", "ingested"]) {
        const transitionResult = await runCliBuffered([
          "queue",
          "set-status",
          sourceId,
          status,
          "--repo",
          wikiDir,
          "--json",
        ]);
        expect(transitionResult.exitCode).toBe(0);
      }

      await mkdir(resolve(wikiDir, "curated/sources"), { recursive: true });
      await writeFile(
        resolve(wikiDir, `curated/sources/${sourceId}.md`),
        `---\ntype: source_summary\ntitle: ${title}\nvisibility: private\nsource_ids:\n  - ${sourceId}\n---\n\n# ${title}\n\nValidated ingested summary.\n`,
        "utf8",
      );
      await rm(resolve(wikiDir, `raw/queue/${sourceId}.json`));
      const beforeDuplicate = await readTreeSnapshot(wikiDir);

      // Act
      const duplicateResult = await runCliBuffered([
        "add-text",
        content,
        "--repo",
        wikiDir,
        "--title",
        "Duplicate Ingested Card Again",
        "--json",
      ]);
      const payload = parseJsonEnvelope<SourceCaptureData>(duplicateResult.stdout);
      const afterDuplicate = await readTreeSnapshot(wikiDir);

      // Assert
      expect(duplicateResult.exitCode).toBe(0);
      expect(duplicateResult.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        status: "duplicate",
        source: {
          source_id: sourceId,
          title,
          source_kind: "text",
          queue_status: "ingested",
          queue_path: `raw/queue/${sourceId}.json`,
        },
        created_paths: [],
      });
      expect(afterDuplicate).toEqual(beforeDuplicate);
    });
  });

  it("skips malformed queue JSON while scanning for duplicates", async () => {
    await withTempWorkspace("llm-wiki-add-malformed-queue-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "fresh.md");
      const content = "# Fresh\n";
      const sourceId = expectedSourceId("Fresh", content);
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, "raw/queue/malformed.json"), "{not json", "utf8");
      await writeFile(sourcePath, content, "utf8");

      // Act
      const result = await runCliBuffered(["add", sourcePath, "--repo", wikiDir, "--title", "Fresh", "--json"]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        status: "added",
        source: {
          source_id: sourceId,
          queue_path: `raw/queue/${sourceId}.json`,
        },
      });
    });
  });

  it("skips schema-invalid queue JSON while scanning for duplicates", async () => {
    await withTempWorkspace("llm-wiki-add-invalid-queue-object-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "fresh.md");
      const content = "# Fresh\n";
      const sourceId = expectedSourceId("Fresh", content);
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, "raw/queue/invalid-object.json"),
        `${JSON.stringify({
          source_id: 123,
          content_hash: `sha256:${sha256Hex(content)}`,
        })}\n`,
        "utf8",
      );
      await writeFile(sourcePath, content, "utf8");

      // Act
      const result = await runCliBuffered(["add", sourcePath, "--repo", wikiDir, "--title", "Fresh", "--json"]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        status: "added",
        source: {
          source_id: sourceId,
          queue_path: `raw/queue/${sourceId}.json`,
        },
      });
    });
  });

  it("does not treat symlinked queue files as duplicates", async () => {
    await withTempWorkspace("llm-wiki-add-queue-file-symlink-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "fresh.md");
      const outsideQueuePath = resolve(workspaceDir, "outside-queue.json");
      const content = "# Fresh\n";
      const sourceId = expectedSourceId("Fresh", content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");
      await writeFile(
        outsideQueuePath,
        `${JSON.stringify({
          kind: "file",
          source_id: "src_2026_06_17_outside_000000000000",
          title: "Outside",
          source_kind: "file",
          origin: "outside",
          captured_at: capturedAt,
          content_hash: `sha256:${sha256Hex(content)}`,
          status: "queued",
          visibility: "private",
          path: "raw/inputs/2026/06/src_2026_06_17_outside_000000000000/_source.md",
          original_path: "raw/inputs/2026/06/src_2026_06_17_outside_000000000000/original.md",
        })}\n`,
        "utf8",
      );
      await symlink(outsideQueuePath, resolve(wikiDir, "raw/queue/outside.json"), "file");

      // Act
      const result = await runCliBuffered(["add", sourcePath, "--repo", wikiDir, "--title", "Fresh", "--json"]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        status: "added",
        source: {
          source_id: sourceId,
          queue_path: `raw/queue/${sourceId}.json`,
        },
      });
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/original.md`))).toBe(true);
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/_source.md`))).toBe(true);
      expect(await pathExists(resolve(wikiDir, `raw/queue/${sourceId}.json`))).toBe(true);
    });
  });

  it("rejects symlinked queue directories before scanning duplicates", async () => {
    await withTempWorkspace("llm-wiki-add-queue-symlink-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const outsideQueueDir = resolve(workspaceDir, "outside-queue");
      const sourcePath = resolve(workspaceDir, "fresh.md");
      const content = "# Fresh\n";
      const sourceId = expectedSourceId("Fresh", content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");
      await mkdir(outsideQueueDir);
      await writeFile(
        resolve(outsideQueueDir, "outside.json"),
        `${JSON.stringify({
          kind: "file",
          source_id: "src_2026_06_17_outside_000000000000",
          title: "Outside",
          source_kind: "file",
          origin: "outside",
          captured_at: capturedAt,
          content_hash: `sha256:${sha256Hex(content)}`,
          status: "queued",
          visibility: "private",
          path: "raw/inputs/2026/06/src_2026_06_17_outside_000000000000/_source.md",
          original_path: "raw/inputs/2026/06/src_2026_06_17_outside_000000000000/original.md",
        })}\n`,
        "utf8",
      );
      await rm(resolve(wikiDir, "raw/queue"), { recursive: true, force: true });
      await symlink(outsideQueueDir, resolve(wikiDir, "raw/queue"), "dir");

      // Act
      const result = await runCliBuffered(["add", sourcePath, "--repo", wikiDir, "--title", "Fresh", "--json"]);
      const payload = parseJsonFailureEnvelope(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "add",
        repo: wikiDir,
        error: {
          code: "QUEUE_SCAN_FAILED",
          message: "Could not scan source queue: raw/queue",
          hint: "Ensure raw/queue is a readable directory, then try again.",
        },
        issues: [
          {
            severity: "error",
            code: "QUEUE_SCAN_FAILED",
            message: "Could not scan source queue: raw/queue",
            path: "raw/queue",
            hint: "Ensure raw/queue is a readable directory, then try again.",
          },
        ],
      });
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/original.md`))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/_source.md`))).toBe(false);
      expect(await pathExists(resolve(outsideQueueDir, "outside.json"))).toBe(true);
    });
  });

  it("wraps invalid queue directory scan failures in a JSON failure envelope", async () => {
    await withTempWorkspace("llm-wiki-add-invalid-queue-dir-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "fresh.md");
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, "# Fresh\n", "utf8");
      await rm(resolve(wikiDir, "raw/queue"), { recursive: true, force: true });
      await writeFile(resolve(wikiDir, "raw/queue"), "not a directory", "utf8");

      // Act
      const result = await runCliBuffered(["add", sourcePath, "--repo", wikiDir, "--title", "Fresh", "--json"]);
      const payload = parseJsonFailureEnvelope(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "add",
        repo: wikiDir,
        error: {
          code: "QUEUE_SCAN_FAILED",
          message: "Could not scan source queue: raw/queue",
          hint: "Ensure raw/queue is a readable directory, then try again.",
        },
        issues: [
          {
            severity: "error",
            code: "QUEUE_SCAN_FAILED",
            message: "Could not scan source queue: raw/queue",
            path: "raw/queue",
            hint: "Ensure raw/queue is a readable directory, then try again.",
          },
        ],
      });
    });
  });

  it("preflights same-ID queue collisions before writing the raw original", async () => {
    await withTempWorkspace("llm-wiki-add-stale-queue-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "stale.md");
      const content = "# Stale\n";
      const sourceId = expectedSourceId("Stale", content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");
      await writeFile(resolve(wikiDir, `raw/queue/${sourceId}.json`), "{not json", "utf8");

      // Act
      const result = await captureFileSource({
        repoRoot: wikiDir,
        sourcePath,
        title: "Stale",
        now: new Date(capturedAt),
      });

      // Assert
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "DESTINATION_EXISTS",
          path: `raw/queue/${sourceId}.json`,
        }),
      });
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/original.md`))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/_source.md`))).toBe(false);
    });
  });

  it("preflights stale source cards before writing the raw original", async () => {
    await withTempWorkspace("llm-wiki-add-stale-source-card-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "stale-card.md");
      const content = "# Stale Card\n";
      const sourceId = expectedSourceId("Stale Card", content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");
      await mkdir(resolve(wikiDir, sourceDir), { recursive: true });
      await writeFile(resolve(wikiDir, `${sourceDir}/_source.md`), "sentinel", "utf8");

      // Act
      const result = await captureFileSource({
        repoRoot: wikiDir,
        sourcePath,
        title: "Stale Card",
        now: new Date(capturedAt),
      });

      // Assert
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "DESTINATION_EXISTS",
          path: `${sourceDir}/_source.md`,
        }),
      });
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/original.md`))).toBe(false);
      expect(await readGeneratedFile(wikiDir, `${sourceDir}/_source.md`)).toBe("sentinel");
      expect(await pathExists(resolve(wikiDir, `raw/queue/${sourceId}.json`))).toBe(false);
    });
  });

  it("preserves binary file bytes and extension while hashing exact source bytes", async () => {
    await withTempWorkspace("llm-wiki-add-binary-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "scan.bin");
      const bytes = Buffer.from([0x00, 0xff, 0x10, 0x41, 0x42, 0x00]);
      const sourceId = expectedSourceId("Binary Scan", bytes);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, bytes);

      // Act
      const result = await runCliBuffered([
        "add",
        sourcePath,
        "--repo",
        wikiDir,
        "--title",
        "Binary Scan",
        "--json",
      ]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.source.original_path).toBe(`${sourceDir}/original.bin`);
      expect(await readFile(resolve(wikiDir, `${sourceDir}/original.bin`))).toEqual(bytes);
      expect(payload.data.source.content_hash).toBe(`sha256:${sha256Hex(bytes)}`);
      expect(await readGeneratedFile(wikiDir, `${sourceDir}/_source.md`)).toContain(
        `Original file: [[${sourceDir}/original.bin|original.bin]]`,
      );
    });
  });

  it("rejects symlink inputs with a JSON failure envelope instead of capturing through an unsafe path", async () => {
    await withTempWorkspace("llm-wiki-add-symlink-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const targetPath = resolve(workspaceDir, "target.md");
      const linkPath = resolve(workspaceDir, "linked.md");
      await initializeWiki(wikiDir);
      await writeFile(targetPath, "# Target\n", "utf8");
      await symlink(targetPath, linkPath);

      // Act
      const result = await runCliBuffered(["add", linkPath, "--repo", wikiDir, "--title", "Linked", "--json"]);
      const payload = parseJsonFailureEnvelope(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: false,
        command: "add",
        repo: wikiDir,
        error: {
          code: "SOURCE_PATH_UNSAFE",
          message: `Source path must not be a symlink: ${linkPath}`,
          hint: "Pass the real source file path so capture provenance is explicit.",
        },
        issues: [
          {
            severity: "error",
            code: "SOURCE_PATH_UNSAFE",
            message: `Source path must not be a symlink: ${linkPath}`,
            path: linkPath,
            hint: "Pass the real source file path so capture provenance is explicit.",
          },
        ],
      });
    });
  });

  it("rejects symlinked runtime logs before writing source artifacts", async () => {
    await withTempWorkspace("llm-wiki-add-log-symlink-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "log-link.md");
      const outsideLogPath = resolve(workspaceDir, "outside-log.md");
      const content = "# Log Link\n";
      const sourceId = expectedSourceId("Log Link", content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");
      await writeFile(outsideLogPath, "outside\n", "utf8");
      await rm(resolve(wikiDir, "curated/log.md"));
      await symlink(outsideLogPath, resolve(wikiDir, "curated/log.md"));

      // Act
      const result = await runCliBuffered(["add", sourcePath, "--repo", wikiDir, "--title", "Log Link", "--json"]);
      const payload = parseJsonFailureEnvelope(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "add",
        repo: wikiDir,
        error: {
          code: "DESTINATION_PARENT_UNSAFE",
          message: "destination file is a symlink: curated/log.md",
          hint: "Capture writes must stay inside the wiki repository and must not follow symlinks.",
        },
        issues: [
          {
            severity: "error",
            code: "DESTINATION_PARENT_UNSAFE",
            message: "destination file is a symlink: curated/log.md",
            path: "curated/log.md",
            hint: "Capture writes must stay inside the wiki repository and must not follow symlinks.",
          },
        ],
      });
      expect(await readFile(outsideLogPath, "utf8")).toBe("outside\n");
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/original.md`))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/_source.md`))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `raw/queue/${sourceId}.json`))).toBe(false);
    });
  });

  it("rejects missing runtime logs before writing source artifacts", async () => {
    await withTempWorkspace("llm-wiki-add-log-missing-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "missing-log.md");
      const content = "# Missing Log\n";
      const sourceId = expectedSourceId("Missing Log", content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");
      await rm(resolve(wikiDir, "curated/log.md"));

      // Act
      const result = await runCliBuffered(["add", sourcePath, "--repo", wikiDir, "--title", "Missing Log", "--json"]);
      const payload = parseJsonFailureEnvelope(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "add",
        repo: wikiDir,
        error: {
          code: "DESTINATION_PARENT_UNSAFE",
          message: "Required runtime log file is missing: curated/log.md.",
          hint: "Restore curated/log.md from the scaffold before running workflows that append runtime log entries.",
        },
        issues: [
          {
            severity: "error",
            code: "DESTINATION_PARENT_UNSAFE",
            message: "Required runtime log file is missing: curated/log.md.",
            path: "curated/log.md",
            hint: "Restore curated/log.md from the scaffold before running workflows that append runtime log entries.",
          },
        ],
      });
      expect(await pathExists(resolve(wikiDir, "curated/log.md"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/original.md`))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/_source.md`))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `raw/queue/${sourceId}.json`))).toBe(false);
    });
  });

  it("rolls back raw artifacts when the queue write fails after preflight", async () => {
    await withTempWorkspace("llm-wiki-add-unwritable-queue-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const queueDir = resolve(wikiDir, "raw/queue");
      const sourcePath = resolve(workspaceDir, "queue-permission.md");
      const content = "# Queue Permission\n";
      const sourceId = expectedSourceId("Queue Permission", content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");
      await chmod(queueDir, 0o555);

      try {
        const probePath = resolve(queueDir, "__probe__.json");
        const queueIsWritable = await writeFile(probePath, "probe", "utf8").then(
          async () => {
            await rm(probePath, { force: true });
            return true;
          },
          () => false,
        );
        if (queueIsWritable) {
          return;
        }

        // Act
        const result = await runCliBuffered([
          "add",
          sourcePath,
          "--repo",
          wikiDir,
          "--title",
          "Queue Permission",
          "--json",
        ]);
        const payload = parseJsonFailureEnvelope(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload).toMatchObject({
          ok: false,
          command: "add",
          repo: wikiDir,
          error: {
            code: "DESTINATION_PARENT_UNSAFE",
            hint: "Capture writes must stay inside the wiki repository and must not follow symlinks.",
          },
          issues: [
            {
              severity: "error",
              code: "DESTINATION_PARENT_UNSAFE",
              path: `raw/queue/${sourceId}.json`,
              hint: "Capture writes must stay inside the wiki repository and must not follow symlinks.",
            },
          ],
        });
        expect(await pathExists(resolve(wikiDir, `${sourceDir}/original.md`))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `${sourceDir}/_source.md`))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `raw/queue/${sourceId}.json`))).toBe(false);
        expect(await pathExists(resolve(wikiDir, sourceDir))).toBe(false);
      } finally {
        await chmod(queueDir, 0o755).catch(() => undefined);
      }
    });
  });

  it("rolls back raw artifacts and returns JSON when the runtime log append fails", async () => {
    await withTempWorkspace("llm-wiki-add-unwritable-log-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const logPath = resolve(wikiDir, "curated/log.md");
      const sourcePath = resolve(workspaceDir, "log-permission.md");
      const content = "# Log Permission\n";
      const sourceId = expectedSourceId("Log Permission", content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");
      const originalLog = await readFile(logPath, "utf8");
      await chmod(logPath, 0o444);

      try {
        const logIsWritable = await writeFile(logPath, "", { flag: "a" }).then(
          () => true,
          () => false,
        );
        if (logIsWritable) {
          return;
        }

        // Act
        const result = await runCliBuffered([
          "add",
          sourcePath,
          "--repo",
          wikiDir,
          "--title",
          "Log Permission",
          "--json",
        ]);
        const payload = parseJsonFailureEnvelope(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload).toMatchObject({
          ok: false,
          command: "add",
          repo: wikiDir,
          error: {
            code: "DESTINATION_PARENT_UNSAFE",
            hint: "Capture writes must stay inside the wiki repository and must not follow symlinks.",
          },
          issues: [
            {
              severity: "error",
              code: "DESTINATION_PARENT_UNSAFE",
              path: "curated/log.md",
              hint: "Capture writes must stay inside the wiki repository and must not follow symlinks.",
            },
          ],
        });
        expect(await readFile(logPath, "utf8")).toBe(originalLog);
        expect(await pathExists(resolve(wikiDir, `${sourceDir}/original.md`))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `${sourceDir}/_source.md`))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `raw/queue/${sourceId}.json`))).toBe(false);
        expect(await pathExists(resolve(wikiDir, sourceDir))).toBe(false);
      } finally {
        await chmod(logPath, 0o644).catch(() => undefined);
      }
    });
  });

  it("wraps source read failures in a JSON failure envelope", async () => {
    await withTempWorkspace("llm-wiki-add-unreadable-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "unreadable.md");
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, "# Unreadable\n", "utf8");
      await chmod(sourcePath, 0o000);

      try {
        try {
          await readFile(sourcePath);
          return;
        } catch {
          // Permission enforcement varies by runtime user; when enforced, assert the CLI contract below.
        }

        // Act
        const result = await runCliBuffered(["add", sourcePath, "--repo", wikiDir, "--title", "Unreadable", "--json"]);
        const payload = parseJsonFailureEnvelope(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload).toMatchObject({
          ok: false,
          command: "add",
          repo: wikiDir,
          error: {
            code: "SOURCE_READ_FAILED",
            hint: "Check that the file exists and can be read, then try again.",
          },
          issues: [
            {
              severity: "error",
              code: "SOURCE_READ_FAILED",
              path: sourcePath,
              hint: "Check that the file exists and can be read, then try again.",
            },
          ],
        });
      } finally {
        await chmod(sourcePath, 0o600).catch(() => undefined);
      }
    });
  });

  it("uses binary no-overwrite writes inside the repo and rejects destination path traversal", async () => {
    await withTempWorkspace("llm-wiki-binary-writer-", async (workspaceDir) => {
      // Arrange
      const rootDir = resolve(workspaceDir, "root");
      await mkdir(rootDir);

      // Act
      const writeResult = await writeBinaryFileNoOverwriteInsideRoot(rootDir, "nested/original.bin", Buffer.from("ok"));
      const overwriteResult = await writeBinaryFileNoOverwriteInsideRoot(
        rootDir,
        "nested/original.bin",
        Buffer.from("bad"),
      );
      const traversalResult = await writeBinaryFileNoOverwriteInsideRoot(
        rootDir,
        "../escape.bin",
        Buffer.from("bad"),
      );

      // Assert
      expect(writeResult).toEqual({ ok: true, value: undefined });
      expect(await readFile(resolve(rootDir, "nested/original.bin"), "utf8")).toBe("ok");
      expect(overwriteResult).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "DESTINATION_EXISTS",
        }),
      });
      expect(traversalResult).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "DESTINATION_PATH_UNSAFE",
        }),
      });
      expect(await pathExists(resolve(workspaceDir, "escape.bin"))).toBe(false);
      expect(await readFile(resolve(rootDir, "nested/original.bin"), "utf8")).toBe("ok");
    });
  });

  it("rejects destination parent symlinks so raw originals cannot be redirected outside the repo", async () => {
    await withTempWorkspace("llm-wiki-binary-writer-symlink-", async (workspaceDir) => {
      // Arrange
      const rootDir = resolve(workspaceDir, "root");
      const outsideDir = resolve(workspaceDir, "outside");
      const sourceDir = "raw/inputs/2026/06/src_2026_06_17_linked_parent_123456789abc";
      await mkdir(resolve(rootDir, "raw/inputs/2026/06"), { recursive: true });
      await mkdir(outsideDir);
      await symlink(outsideDir, resolve(rootDir, sourceDir));

      // Act
      const result = await writeBinaryFileNoOverwriteInsideRoot(rootDir, `${sourceDir}/original.bin`, Buffer.from("bad"));

      // Assert
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "DESTINATION_PARENT_UNSAFE",
          path: sourceDir,
        }),
      });
      expect(await pathExists(resolve(outsideDir, "original.bin"))).toBe(false);
    });
  });

  it("does not overwrite an existing raw original when a deterministic destination already exists", async () => {
    await withTempWorkspace("llm-wiki-add-existing-original-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const sourcePath = resolve(workspaceDir, "collision.txt");
      const content = "Collision content\n";
      const sourceId = expectedSourceId("Collision", content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      await initializeWiki(wikiDir);
      await writeFile(sourcePath, content, "utf8");
      await mkdir(resolve(wikiDir, sourceDir), { recursive: true });
      await writeFile(resolve(wikiDir, `${sourceDir}/original.txt`), "sentinel", "utf8");

      // Act
      const result = await captureFileSource({
        repoRoot: wikiDir,
        sourcePath,
        title: "Collision",
        now: new Date(capturedAt),
      });

      // Assert
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "DESTINATION_EXISTS",
          path: `${sourceDir}/original.txt`,
        }),
      });
      expect(await readGeneratedFile(wikiDir, `${sourceDir}/original.txt`)).toBe("sentinel");
      expect(await pathExists(resolve(wikiDir, `${sourceDir}/_source.md`))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `raw/queue/${sourceId}.json`))).toBe(false);
    });
  });
});
