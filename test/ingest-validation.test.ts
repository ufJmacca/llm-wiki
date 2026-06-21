import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { computeContentHash } from "../src/scanner/index.js";
import { validateIngestReadiness } from "../src/validation/ingest.js";
import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const execFileAsync = promisify(execFile);

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
    content_hash: string;
    captured_at: string;
    original_path: string;
    source_card_path: string;
    queue_path: string;
  };
};

type QueueShowData = {
  queue_record: {
    source_id: string;
    status: "queued" | "ingesting" | "ingested" | "blocked";
    updated_at?: string;
  };
  source_card: {
    frontmatter: {
      status: "queued" | "ingesting" | "ingested" | "blocked";
    };
  };
};

type IngestValidationData = {
  mode: "validate";
  source: {
    source_id: string;
    status: "ingested";
  };
  validation: {
    passed: true;
    issues: [];
  };
  queue: {
    previous_status: "queued" | "ingesting" | "ingested";
    status: "ingested";
  };
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

async function captureTextSource(
  wikiDir: string,
  input: { title?: string; text?: string } = {},
): Promise<SourceCaptureData["source"]> {
  const result = await runCliBuffered([
    "add-text",
    "--repo",
    wikiDir,
    "--title",
    input.title ?? "Validation Paper",
    "--text",
    input.text ?? "immutable raw validation evidence",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

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

async function appendIngestLogEntry(wikiDir: string, sourceId: string, updatedPaths: string[]): Promise<void> {
  await appendFile(
    resolve(wikiDir, "curated/log.md"),
    [
      "",
      `## [2026-06-18T11:30:00.000Z] ingest | ${sourceId} | Agent ingest completed`,
      "",
      "- actor: test-agent",
      `- command: "llm-wiki ingest ${sourceId}"`,
      "- git_branch:",
      "- git_commit:",
      `- raw_source: raw/inputs/2026/06/${sourceId}/_source.md`,
      "- created:",
      `  - curated/sources/${sourceId}.md`,
      "- updated:",
      ...updatedPaths.map((path) => `  - ${path}`),
      "- contradictions:",
      "- follow_ups:",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function writeValidIngestArtifacts(
  wikiDir: string,
  source: SourceCaptureData["source"],
): Promise<{ summaryPath: string; topicPath: string }> {
  const summaryPath = `curated/sources/${source.source_id}.md`;
  const topicPath = "curated/topics/validated-raw-hash.md";

  await writeCuratedPage(
    wikiDir,
    summaryPath,
    {
      type: "source_summary",
      title: `${source.title} Summary`,
      visibility: "private",
      source_ids: [source.source_id],
    },
    `# ${source.title} Summary\n\nThe source provides immutable raw validation evidence.\n`,
  );
  await writeCuratedPage(
    wikiDir,
    topicPath,
    {
      type: "topic",
      title: "Validated Raw Hash",
      visibility: "private",
      source_ids: [source.source_id],
    },
    `# Validated Raw Hash\n\nUses [[sources/${source.source_id}|${source.title} Summary]].\n`,
  );
  await writeFile(
    resolve(wikiDir, "curated/index.md"),
    [
      "---",
      "type: index",
      "title: Index",
      "visibility: private",
      "source_ids: []",
      "---",
      "",
      "# Index",
      "",
      `- [[sources/${source.source_id}|${source.title} Summary]]`,
      "- [[topics/validated-raw-hash|Validated Raw Hash]]",
      "",
    ].join("\n"),
    "utf8",
  );
  await appendIngestLogEntry(wikiDir, source.source_id, [summaryPath, topicPath, "curated/index.md"]);

  return { summaryPath, topicPath };
}

async function setRepoPathMtime(wikiDir: string, path: string, date: Date): Promise<void> {
  await utimes(resolve(wikiDir, path), date, date);
}

async function commitWikiBaseline(wikiDir: string): Promise<void> {
  await execFileAsync("git", ["-C", wikiDir, "init"]);
  await execFileAsync("git", ["-C", wikiDir, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", wikiDir, "config", "user.name", "Test User"]);
  await commitWikiChanges(wikiDir, "test baseline");
}

async function commitWikiChanges(wikiDir: string, message: string): Promise<void> {
  await execFileAsync("git", ["-C", wikiDir, "add", "."]);
  await execFileAsync("git", ["-C", wikiDir, "commit", "-m", message]);
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

describe("ingest validation", () => {
  it("reports every hard gate and leaves queued status untouched when validation fails", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-fail-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T11:00:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/incomplete-ingest.md",
        {
          type: "topic",
          title: "Incomplete Ingest",
          visibility: "private",
        },
        `# Incomplete Ingest\n\nMentions ${source.source_id} without provenance frontmatter.\n`,
      );
      await writeFile(resolve(wikiDir, source.original_path), "raw content was edited after capture", "utf8");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues.map((issue) => issue.rule_id)).toEqual(
        expect.arrayContaining([
          "ingest_source_summary_missing",
          "ingest_index_missing",
          "ingest_log_entry_missing",
          "ingest_source_ids_missing",
          "ingest_raw_hash_drift",
        ]),
      );
      expect(cliResult.exitCode).toBe(1);
      expect(cliResult.stderr).toEqual([]);
      expect(failurePayload.error).toMatchObject({
        code: "INGEST_VALIDATION_FAILED",
      });
      expect(failurePayload.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "ingest_source_summary_missing",
          "ingest_index_missing",
          "ingest_log_entry_missing",
          "ingest_source_ids_missing",
          "ingest_raw_hash_drift",
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("validates raw immutability against the source-card hash even when queue hash is changed", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-source-card-hash-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeValidIngestArtifacts(wikiDir, source);
      const tamperedRaw = "raw content was edited after capture";
      await writeFile(resolve(wikiDir, source.original_path), tamperedRaw, "utf8");
      const queuePath = resolve(wikiDir, source.queue_path);
      const queueRecord = JSON.parse(await readFile(queuePath, "utf8")) as Record<string, unknown>;
      queueRecord.content_hash = computeContentHash(tamperedRaw);
      await writeFile(queuePath, `${JSON.stringify(queueRecord, null, 2)}\n`, "utf8");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_raw_hash_mismatch",
            path: source.queue_path,
          }),
          expect.objectContaining({
            rule_id: "ingest_raw_hash_drift",
            path: source.original_path,
          }),
        ]),
      );
    });
  });

  it("rejects raw tampering when both mutable metadata hashes are rewritten", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-captured-hash-prefix-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeValidIngestArtifacts(wikiDir, source);
      const tamperedRaw = "raw content and metadata were edited after capture";
      const tamperedHash = computeContentHash(tamperedRaw);
      await writeFile(resolve(wikiDir, source.original_path), tamperedRaw, "utf8");

      const queuePath = resolve(wikiDir, source.queue_path);
      const queueRecord = JSON.parse(await readFile(queuePath, "utf8")) as Record<string, unknown>;
      queueRecord.content_hash = tamperedHash;
      await writeFile(queuePath, `${JSON.stringify(queueRecord, null, 2)}\n`, "utf8");

      const sourceCardPath = resolve(wikiDir, source.source_card_path);
      const sourceCard = await readFile(sourceCardPath, "utf8");
      await writeFile(sourceCardPath, sourceCard.replace(source.content_hash, tamperedHash), "utf8");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_raw_hash_mismatch",
            path: source.source_card_path,
          }),
          expect.objectContaining({
            rule_id: "ingest_raw_hash_mismatch",
            path: source.queue_path,
          }),
          expect.objectContaining({
            rule_id: "ingest_raw_hash_drift",
            path: source.original_path,
          }),
        ]),
      );
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_raw_hash_drift",
            path: source.original_path,
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("fails ingest validation when the mutable queue hash is missing", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-missing-queue-hash-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeValidIngestArtifacts(wikiDir, source);
      const queuePath = resolve(wikiDir, source.queue_path);
      const queueRecord = JSON.parse(await readFile(queuePath, "utf8")) as Record<string, unknown>;
      delete queueRecord.content_hash;
      await writeFile(queuePath, `${JSON.stringify(queueRecord, null, 2)}\n`, "utf8");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_raw_hash_missing",
            path: source.queue_path,
          }),
        ]),
      );
    });
  });

  it("reports a log-listed edited curated page with spaces when source_ids frontmatter omits the source", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-log-source-ids-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T11:45:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const editedPagePath = "curated/topics/log listed without source id.md";
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        editedPagePath,
        {
          type: "topic",
          title: "Log Listed Without Source ID",
          visibility: "private",
        },
        "# Log Listed Without Source ID\n\nThis page was edited during ingest, but omits provenance.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await setRepoPathMtime(wikiDir, editedPagePath, new Date(Date.parse(source.captured_at) - 1000));
      await appendIngestLogEntry(wikiDir, source.source_id, [editedPagePath]);

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: editedPagePath,
          }),
        ]),
      );
      expect(validation.checked_paths).toContain(editedPagePath);
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: editedPagePath,
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("ignores clean unrelated curated pages in Git worktrees", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-unrelated-git-clean-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const unrelatedPagePath = "curated/topics/unrelated-dirty-page.md";
      await writeCuratedPage(
        wikiDir,
        unrelatedPagePath,
        {
          type: "topic",
          title: "Unrelated Dirty Page",
          visibility: "private",
        },
        "# Unrelated Dirty Page\n\nBaseline content unrelated to the ingest source.\n",
      );
      await commitWikiBaseline(wikiDir);
      await execFileAsync("git", ["-C", wikiDir, "switch", "-c", `ingest/${source.source_id}`]);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [
        `curated/sources/${source.source_id}.md`,
        "curated/index.md",
      ]);
      await commitWikiChanges(wikiDir, "test valid ingest artifacts");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);

      // Assert
      expect(validation.passed).toBe(true);
      expect(validation.issues).toEqual([]);
      expect(validation.checked_paths).not.toContain(unrelatedPagePath);
    });
  });

  it("fails closed when Git has no branch base for committed curated edits", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-no-base-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const committedPagePath = "curated/topics/main-committed-without-source-id.md";
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [
        `curated/sources/${source.source_id}.md`,
        "curated/index.md",
      ]);
      await commitWikiBaseline(wikiDir);
      await execFileAsync("git", ["-C", wikiDir, "branch", "-M", "main"]);
      await writeCuratedPage(
        wikiDir,
        committedPagePath,
        {
          type: "topic",
          title: "Main Committed Without Source ID",
          visibility: "private",
          source_ids: [],
        },
        "# Main Committed Without Source ID\n\nCommitted ingest output omitted source provenance.\n",
      );
      await commitWikiChanges(wikiDir, "test main ingest page without provenance");
      const { stdout: statusStdout } = await execFileAsync("git", ["-C", wikiDir, "status", "--porcelain=v1"]);
      expect(statusStdout).toBe("");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_changed_files_unavailable",
            path: ".git",
          }),
        ]),
      );
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_changed_files_unavailable",
            path: ".git",
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("allows uncommitted Git curated edits when branch-base lookup is unavailable", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-no-base-uncommitted-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await commitWikiBaseline(wikiDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [
        `curated/sources/${source.source_id}.md`,
        "curated/index.md",
      ]);
      const { stdout: statusStdout } = await execFileAsync("git", [
        "-C",
        wikiDir,
        "status",
        "--porcelain=v1",
        "--",
        "curated",
      ]);
      expect(statusStdout.trim()).not.toBe("");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const result = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const payload = parseJsonSuccess<"ingest", IngestValidationData>(result.stdout);

      // Assert
      expect(validation.passed).toBe(true);
      expect(validation.issues).toEqual([]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.validation.issues).toEqual([]);
      expect(payload.data.queue.status).toBe("ingested");
    });
  });

  it("checks committed curated edits with mtime fallback when branch-base lookup is unavailable but status has paths", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-no-base-mixed-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const summaryPath = `curated/sources/${source.source_id}.md`;
      const committedPagePath = "curated/topics/committed-without-source-id.md";
      await writeCuratedPage(
        wikiDir,
        summaryPath,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [summaryPath, "curated/index.md"]);
      await commitWikiBaseline(wikiDir);
      await execFileAsync("git", ["-C", wikiDir, "branch", "-M", "main"]);
      await writeCuratedPage(
        wikiDir,
        committedPagePath,
        {
          type: "topic",
          title: "Committed Without Source ID",
          visibility: "private",
          source_ids: [],
        },
        "# Committed Without Source ID\n\nCommitted ingest output omitted source provenance.\n",
      );
      await commitWikiChanges(wikiDir, "test committed ingest page without provenance");
      await setRepoPathMtime(wikiDir, committedPagePath, new Date(Date.parse(source.captured_at) + 1000));
      await appendFile(resolve(wikiDir, summaryPath), "\nAdditional uncommitted validation note.\n", "utf8");
      const { stdout: statusStdout } = await execFileAsync("git", [
        "-C",
        wikiDir,
        "status",
        "--porcelain=v1",
        "--",
        "curated",
      ]);
      expect(statusStdout.trim()).not.toBe("");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: committedPagePath,
          }),
        ]),
      );
      expect(validation.checked_paths).toContain(committedPagePath);
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: committedPagePath,
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("reports git-changed curated pages missing source_ids even when omitted from ingest log and source links", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-changed-source-ids-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const modifiedPagePath = "curated/topics/modified-without-source-id.md";
      const newPagePath = "curated/topics/untracked-edited-without-source-id.md";
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        modifiedPagePath,
        {
          type: "topic",
          title: "Modified Without Source ID",
          visibility: "private",
          source_ids: [],
        },
        "# Modified Without Source ID\n\nBaseline content unrelated to the ingest source.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [
        `curated/sources/${source.source_id}.md`,
        "curated/index.md",
      ]);
      await commitWikiBaseline(wikiDir);
      await writeCuratedPage(
        wikiDir,
        modifiedPagePath,
        {
          type: "topic",
          title: "Modified Without Source ID",
          visibility: "private",
          source_ids: [],
        },
        "# Modified Without Source ID\n\nEdited during ingest but still omitted from provenance.\n",
      );
      await writeCuratedPage(
        wikiDir,
        newPagePath,
        {
          type: "topic",
          title: "Untracked Edited Without Source ID",
          visibility: "private",
        },
        "# Untracked Edited Without Source ID\n\nNew ingest output with no source provenance.\n",
      );

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: modifiedPagePath,
          }),
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: newPagePath,
          }),
        ]),
      );
      expect(validation.checked_paths).toEqual(expect.arrayContaining([modifiedPagePath, newPagePath]));
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: modifiedPagePath,
          }),
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: newPagePath,
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("reports git-changed curated pages missing source_ids when mtimes predate the validation window", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-old-mtime-source-ids-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const summaryPath = `curated/sources/${source.source_id}.md`;
      const preservedMtimePagePath = "curated/topics/copied-with-preserved-mtime.md";
      await writeCuratedPage(
        wikiDir,
        summaryPath,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [summaryPath, "curated/index.md"]);
      await commitWikiBaseline(wikiDir);
      await execFileAsync("git", ["-C", wikiDir, "branch", "-M", "main"]);
      await execFileAsync("git", ["-C", wikiDir, "switch", "-c", `ingest/${source.source_id}`]);
      await writeCuratedPage(
        wikiDir,
        preservedMtimePagePath,
        {
          type: "topic",
          title: "Copied With Preserved Mtime",
          visibility: "private",
          source_ids: [],
        },
        "# Copied With Preserved Mtime\n\nCopied ingest output omitted source provenance.\n",
      );
      await setRepoPathMtime(wikiDir, preservedMtimePagePath, new Date(Date.parse(source.captured_at) - 1000));

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: preservedMtimePagePath,
          }),
        ]),
      );
      expect(validation.checked_paths).toContain(preservedMtimePagePath);
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: preservedMtimePagePath,
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("reports git-changed curated pages with quoted status paths missing source_ids", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-quoted-status-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const spacedPagePath = "curated/topics/has space.md";
      await writeValidIngestArtifacts(wikiDir, source);
      await writeCuratedPage(
        wikiDir,
        spacedPagePath,
        {
          type: "topic",
          title: "Has Space",
          visibility: "private",
          source_ids: [],
        },
        "# Has Space\n\nBaseline content unrelated to the ingest source.\n",
      );
      await commitWikiBaseline(wikiDir);
      await execFileAsync("git", ["-C", wikiDir, "branch", "-M", "main"]);
      await execFileAsync("git", ["-C", wikiDir, "switch", "-c", `ingest/${source.source_id}`]);
      await writeCuratedPage(
        wikiDir,
        spacedPagePath,
        {
          type: "topic",
          title: "Has Space",
          visibility: "private",
          source_ids: [],
        },
        "# Has Space\n\nEdited during ingest but still omitted from provenance.\n",
      );
      const { stdout: porcelainStdout } = await execFileAsync("git", [
        "-C",
        wikiDir,
        "status",
        "--porcelain=v1",
        "--",
        "curated",
      ]);
      expect(porcelainStdout).toContain(`"curated/topics/has space.md"`);

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: spacedPagePath,
          }),
        ]),
      );
      expect(validation.checked_paths).toContain(spacedPagePath);
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: spacedPagePath,
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("validates uncommitted ingest edits on a fresh ingest branch based at HEAD", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-fresh-branch-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await commitWikiBaseline(wikiDir);
      await execFileAsync("git", ["-C", wikiDir, "branch", "-M", "main"]);
      await execFileAsync("git", ["-C", wikiDir, "switch", "-c", `ingest/${source.source_id}`]);
      const { summaryPath, topicPath } = await writeValidIngestArtifacts(wikiDir, source);

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const successPayload = parseJsonSuccess<"ingest", IngestValidationData>(cliResult.stdout);

      // Assert
      expect(validation.passed).toBe(true);
      expect(validation.issues).toEqual([]);
      expect(validation.checked_paths).toEqual(expect.arrayContaining([summaryPath, topicPath]));
      expect(validation.checked_paths).not.toContain(".git");
      expect(cliResult.exitCode).toBe(0);
      expect(successPayload.data.validation.passed).toBe(true);
      expect(successPayload.data.queue).toMatchObject({
        previous_status: "ingesting",
        status: "ingested",
      });
      expect(successPayload.data.source.status).toBe("ingested");
    });
  });

  it("reports committed ingest-branch curated pages missing source_ids after the worktree is clean", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-branch-base-source-ids-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const committedPagePath = "curated/topics/committed-without-source-id.md";
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [
        `curated/sources/${source.source_id}.md`,
        "curated/index.md",
      ]);
      await commitWikiBaseline(wikiDir);
      await execFileAsync("git", ["-C", wikiDir, "switch", "-c", `ingest/${source.source_id}`]);
      await writeCuratedPage(
        wikiDir,
        committedPagePath,
        {
          type: "topic",
          title: "Committed Without Source ID",
          visibility: "private",
          source_ids: [],
        },
        "# Committed Without Source ID\n\nCommitted ingest output omitted source provenance.\n",
      );
      await commitWikiChanges(wikiDir, "test committed ingest page without provenance");
      const { stdout: statusStdout } = await execFileAsync("git", ["-C", wikiDir, "status", "--porcelain=v1"]);
      expect(statusStdout).toBe("");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: committedPagePath,
          }),
        ]),
      );
      expect(validation.checked_paths).toContain(committedPagePath);
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: committedPagePath,
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("validates committed ingest edits from a custom default branch", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-custom-base-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await commitWikiBaseline(wikiDir);
      await execFileAsync("git", ["-C", wikiDir, "branch", "-M", "dev"]);
      await execFileAsync("git", ["-C", wikiDir, "switch", "-c", `ingest/${source.source_id}`]);
      const { summaryPath, topicPath } = await writeValidIngestArtifacts(wikiDir, source);
      await commitWikiChanges(wikiDir, "test valid custom base ingest artifacts");
      const { stdout: statusStdout } = await execFileAsync("git", ["-C", wikiDir, "status", "--porcelain=v1"]);
      expect(statusStdout).toBe("");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const successPayload = parseJsonSuccess<"ingest", IngestValidationData>(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(true);
      expect(validation.issues).toEqual([]);
      expect(validation.checked_paths).toEqual(expect.arrayContaining([summaryPath, topicPath]));
      expect(validation.checked_paths).not.toContain(".git");
      expect(cliResult.exitCode).toBe(0);
      expect(successPayload.data.validation.passed).toBe(true);
      expect(queuePayload.data.queue_record.status).toBe("ingested");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("ingested");
    });
  });

  it("uses the repository base branch instead of feature upstream when validating committed curated pages", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-upstream-base-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const remoteDir = resolve(workspaceDir, "remote.git");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const pushedPagePath = "curated/topics/pushed-without-source-id.md";
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [
        `curated/sources/${source.source_id}.md`,
        "curated/index.md",
      ]);
      await commitWikiBaseline(wikiDir);
      await execFileAsync("git", ["-C", wikiDir, "branch", "-M", "main"]);
      await execFileAsync("git", ["init", "--bare", remoteDir]);
      await execFileAsync("git", ["-C", wikiDir, "remote", "add", "origin", remoteDir]);
      await execFileAsync("git", ["-C", wikiDir, "switch", "-c", `ingest/${source.source_id}`]);
      await writeCuratedPage(
        wikiDir,
        pushedPagePath,
        {
          type: "topic",
          title: "Pushed Without Source ID",
          visibility: "private",
          source_ids: [],
        },
        "# Pushed Without Source ID\n\nAlready-pushed ingest output omitted source provenance.\n",
      );
      await commitWikiChanges(wikiDir, "test pushed ingest page without provenance");
      await execFileAsync("git", ["-C", wikiDir, "push", "-u", "origin", `ingest/${source.source_id}`]);
      await appendFile(
        resolve(wikiDir, `curated/sources/${source.source_id}.md`),
        "\nAdditional local validation note.\n",
        "utf8",
      );
      await commitWikiChanges(wikiDir, "test local ingest follow-up");

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: pushedPagePath,
          }),
        ]),
      );
      expect(validation.checked_paths).toContain(pushedPagePath);
    });
  });

  it("keeps repeated git validation idempotent after unrelated later curated edits", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-git-revalidate-ingested-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstSource = await captureTextSource(wikiDir, {
        title: "First Validation Paper",
        text: "first independent validation evidence",
      });
      await commitWikiBaseline(wikiDir);
      await execFileAsync("git", ["-C", wikiDir, "branch", "-M", "main"]);
      await execFileAsync("git", ["-C", wikiDir, "switch", "-c", `ingest/${firstSource.source_id}`]);
      const { summaryPath: firstSummaryPath, topicPath: firstTopicPath } = await writeValidIngestArtifacts(
        wikiDir,
        firstSource,
      );
      const firstValidation = await runCliBuffered([
        "ingest",
        firstSource.source_id,
        "--repo",
        wikiDir,
        "--validate",
        "--json",
      ]);
      expect(firstValidation.exitCode).toBe(0);
      const firstQueueResult = await runCliBuffered([
        "queue",
        "show",
        firstSource.source_id,
        "--repo",
        wikiDir,
        "--json",
      ]);
      const firstQueuePayload = parseJsonSuccess<"queue show", QueueShowData>(firstQueueResult.stdout);
      const firstIngestedAt = firstQueuePayload.data.queue_record.updated_at;
      expect(typeof firstIngestedAt).toBe("string");

      const secondSource = await captureTextSource(wikiDir, {
        title: "Second Validation Paper",
        text: "second independent validation evidence",
      });
      const secondSummaryPath = `curated/sources/${secondSource.source_id}.md`;
      const secondTopicPath = "curated/topics/second-validation-paper.md";
      await writeCuratedPage(
        wikiDir,
        secondSummaryPath,
        {
          type: "source_summary",
          title: "Second Validation Paper Summary",
          visibility: "private",
          source_ids: [secondSource.source_id],
        },
        "# Second Validation Paper Summary\n\nThe second source provides independent evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        secondTopicPath,
        {
          type: "topic",
          title: "Second Validation Paper",
          visibility: "private",
          source_ids: [secondSource.source_id],
        },
        `# Second Validation Paper\n\nUses [[sources/${secondSource.source_id}|Second Validation Paper Summary]].\n`,
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${firstSource.source_id}|First Validation Paper Summary]]`,
          "- [[topics/validated-raw-hash|Validated Raw Hash]]",
          `- [[sources/${secondSource.source_id}|Second Validation Paper Summary]]`,
          "- [[topics/second-validation-paper|Second Validation Paper]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, secondSource.source_id, [
        secondSummaryPath,
        secondTopicPath,
        "curated/index.md",
      ]);
      const afterFirstIngest = new Date(Date.parse(firstIngestedAt as string) + 1000);
      await setRepoPathMtime(wikiDir, secondSummaryPath, afterFirstIngest);
      await setRepoPathMtime(wikiDir, secondTopicPath, afterFirstIngest);

      // Act
      const validation = await validateIngestReadiness(wikiDir, firstSource.source_id);
      const repeatedValidation = await runCliBuffered([
        "ingest",
        firstSource.source_id,
        "--repo",
        wikiDir,
        "--validate",
        "--json",
      ]);
      const payload = parseJsonSuccess<"ingest", IngestValidationData>(repeatedValidation.stdout);

      // Assert
      expect(validation.passed).toBe(true);
      expect(validation.issues).toEqual([]);
      expect(validation.checked_paths).toEqual(expect.arrayContaining([firstSummaryPath, firstTopicPath]));
      expect(validation.checked_paths).not.toContain(secondSummaryPath);
      expect(validation.checked_paths).not.toContain(secondTopicPath);
      expect(repeatedValidation.exitCode).toBe(0);
      expect(payload.data.queue.previous_status).toBe("ingested");
      expect(payload.data.queue.status).toBe("ingested");
    });
  });

  it("reports no-git curated content pages missing source_ids even when omitted from ingest log and source links", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-nogit-unlogged-source-ids-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const unloggedPagePath = "curated/topics/unlogged-without-source-id.md";
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        unloggedPagePath,
        {
          type: "topic",
          title: "Unlogged Without Source ID",
          visibility: "private",
        },
        "# Unlogged Without Source ID\n\nNew ingest output with no source provenance.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [
        `curated/sources/${source.source_id}.md`,
        "curated/index.md",
      ]);

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: unloggedPagePath,
          }),
        ]),
      );
      expect(validation.checked_paths).toContain(unloggedPagePath);
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: unloggedPagePath,
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("reports no-git root curated pages missing source_ids from mtime and log attribution", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-nogit-root-source-ids-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const summaryPath = `curated/sources/${source.source_id}.md`;
      const mtimeRootPagePath = "curated/open-questions.md";
      const logRootPagePath = "curated/contradictions.md";
      await writeCuratedPage(
        wikiDir,
        summaryPath,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        mtimeRootPagePath,
        {
          type: "page",
          title: "Open Questions",
          visibility: "private",
          source_ids: [],
        },
        "# Open Questions\n\nUpdated during ingest without source provenance.\n",
      );
      await writeCuratedPage(
        wikiDir,
        logRootPagePath,
        {
          type: "page",
          title: "Contradictions",
          visibility: "private",
          source_ids: [],
        },
        "# Contradictions\n\nLog-listed ingest output without source provenance.\n",
      );
      await setRepoPathMtime(wikiDir, logRootPagePath, new Date(Date.parse(source.captured_at) - 1000));
      await appendIngestLogEntry(wikiDir, source.source_id, [
        summaryPath,
        "curated/index.md",
        logRootPagePath,
      ]);

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: mtimeRootPagePath,
          }),
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: logRootPagePath,
          }),
        ]),
      );
      expect(validation.checked_paths).toEqual(expect.arrayContaining([mtimeRootPagePath, logRootPagePath]));
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: mtimeRootPagePath,
          }),
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: logRootPagePath,
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("reports no-git curated content pages with unrelated source_ids and leaves queue status untouched", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-nogit-unrelated-source-ids-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const wrongSourceIdPagePath = "curated/topics/wrong-source-id.md";
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Validation Paper Summary\n\nThe source provides immutable raw validation evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        wrongSourceIdPagePath,
        {
          type: "topic",
          title: "Wrong Source ID",
          visibility: "private",
          source_ids: ["src_2026_06_17_other_aaaaaaaaaaaa"],
        },
        "# Wrong Source ID\n\nNew ingest output that cites a different source.\n",
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${source.source_id}|Validation Paper Summary]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [
        `curated/sources/${source.source_id}.md`,
        "curated/index.md",
      ]);

      // Act
      const validation = await validateIngestReadiness(wikiDir, source.source_id);
      const cliResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const failurePayload = parseJsonFailure<"ingest">(cliResult.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: wrongSourceIdPagePath,
          }),
        ]),
      );
      expect(validation.checked_paths).toContain(wrongSourceIdPagePath);
      expect(cliResult.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            path: wrongSourceIdPagePath,
          }),
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("allows a valid second no-git ingest without requiring unrelated existing pages to cite the new source", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-nogit-second-source-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstSource = await captureTextSource(wikiDir, {
        title: "First Validation Paper",
        text: "first independent validation evidence",
      });
      const firstSummaryPath = `curated/sources/${firstSource.source_id}.md`;
      const firstTopicPath = "curated/topics/first-validation-paper.md";
      await writeCuratedPage(
        wikiDir,
        firstSummaryPath,
        {
          type: "source_summary",
          title: "First Validation Paper Summary",
          visibility: "private",
          source_ids: [firstSource.source_id],
        },
        "# First Validation Paper Summary\n\nThe first source provides independent evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        firstTopicPath,
        {
          type: "topic",
          title: "First Validation Paper",
          visibility: "private",
          source_ids: [firstSource.source_id],
        },
        `# First Validation Paper\n\nUses [[sources/${firstSource.source_id}|First Validation Paper Summary]].\n`,
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${firstSource.source_id}|First Validation Paper Summary]]`,
          "- [[topics/first-validation-paper|First Validation Paper]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, firstSource.source_id, [
        firstSummaryPath,
        firstTopicPath,
        "curated/index.md",
      ]);
      const firstValidation = await runCliBuffered([
        "ingest",
        firstSource.source_id,
        "--repo",
        wikiDir,
        "--validate",
        "--json",
      ]);
      expect(firstValidation.exitCode).toBe(0);

      const secondSource = await captureTextSource(wikiDir, {
        title: "Second Validation Paper",
        text: "second independent validation evidence",
      });
      const beforeSecondCapture = new Date(Date.parse(secondSource.captured_at) - 1000);
      await setRepoPathMtime(wikiDir, firstSummaryPath, beforeSecondCapture);
      await setRepoPathMtime(wikiDir, firstTopicPath, beforeSecondCapture);

      const secondSummaryPath = `curated/sources/${secondSource.source_id}.md`;
      const secondTopicPath = "curated/topics/second-validation-paper.md";
      await writeCuratedPage(
        wikiDir,
        secondSummaryPath,
        {
          type: "source_summary",
          title: "Second Validation Paper Summary",
          visibility: "private",
          source_ids: [secondSource.source_id],
        },
        "# Second Validation Paper Summary\n\nThe second source provides independent evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        secondTopicPath,
        {
          type: "topic",
          title: "Second Validation Paper",
          visibility: "private",
          source_ids: [secondSource.source_id],
        },
        `# Second Validation Paper\n\nUses [[sources/${secondSource.source_id}|Second Validation Paper Summary]].\n`,
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${firstSource.source_id}|First Validation Paper Summary]]`,
          "- [[topics/first-validation-paper|First Validation Paper]]",
          `- [[sources/${secondSource.source_id}|Second Validation Paper Summary]]`,
          "- [[topics/second-validation-paper|Second Validation Paper]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, secondSource.source_id, [
        secondSummaryPath,
        secondTopicPath,
        "curated/index.md",
      ]);

      // Act
      const validation = await validateIngestReadiness(wikiDir, secondSource.source_id);
      const result = await runCliBuffered([
        "ingest",
        secondSource.source_id,
        "--repo",
        wikiDir,
        "--validate",
        "--json",
      ]);
      const payload = parseJsonSuccess<"ingest", IngestValidationData>(result.stdout);
      const firstQueueResult = await runCliBuffered([
        "queue",
        "show",
        firstSource.source_id,
        "--repo",
        wikiDir,
        "--json",
      ]);
      const firstQueuePayload = parseJsonSuccess<"queue show", QueueShowData>(firstQueueResult.stdout);

      // Assert
      expect(validation.passed).toBe(true);
      expect(validation.issues).toEqual([]);
      expect(validation.checked_paths).not.toContain(firstSummaryPath);
      expect(validation.checked_paths).not.toContain(firstTopicPath);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.queue.status).toBe("ingested");
      expect(firstQueuePayload.data.queue_record.status).toBe("ingested");
      expect(firstQueuePayload.data.source_card.frontmatter.status).toBe("ingested");
    });
  });

  it("keeps repeated no-git validation idempotent for an already ingested source", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-nogit-revalidate-ingested-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstSource = await captureTextSource(wikiDir, {
        title: "First Validation Paper",
        text: "first independent validation evidence",
      });
      const firstSummaryPath = `curated/sources/${firstSource.source_id}.md`;
      const firstTopicPath = "curated/topics/first-validation-paper.md";
      await writeCuratedPage(
        wikiDir,
        firstSummaryPath,
        {
          type: "source_summary",
          title: "First Validation Paper Summary",
          visibility: "private",
          source_ids: [firstSource.source_id],
        },
        "# First Validation Paper Summary\n\nThe first source provides independent evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        firstTopicPath,
        {
          type: "topic",
          title: "First Validation Paper",
          visibility: "private",
          source_ids: [firstSource.source_id],
        },
        `# First Validation Paper\n\nUses [[sources/${firstSource.source_id}|First Validation Paper Summary]].\n`,
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${firstSource.source_id}|First Validation Paper Summary]]`,
          "- [[topics/first-validation-paper|First Validation Paper]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, firstSource.source_id, [
        firstSummaryPath,
        firstTopicPath,
        "curated/index.md",
      ]);
      const firstValidation = await runCliBuffered([
        "ingest",
        firstSource.source_id,
        "--repo",
        wikiDir,
        "--validate",
        "--json",
      ]);
      expect(firstValidation.exitCode).toBe(0);
      const firstQueueResult = await runCliBuffered([
        "queue",
        "show",
        firstSource.source_id,
        "--repo",
        wikiDir,
        "--json",
      ]);
      const firstQueuePayload = parseJsonSuccess<"queue show", QueueShowData>(firstQueueResult.stdout);
      const firstIngestedAt = firstQueuePayload.data.queue_record.updated_at;
      expect(typeof firstIngestedAt).toBe("string");

      const secondSource = await captureTextSource(wikiDir, {
        title: "Second Validation Paper",
        text: "second independent validation evidence",
      });
      const beforeSecondCapture = new Date(Date.parse(secondSource.captured_at) - 1000);
      await setRepoPathMtime(wikiDir, firstSummaryPath, beforeSecondCapture);
      await setRepoPathMtime(wikiDir, firstTopicPath, beforeSecondCapture);

      const secondSummaryPath = `curated/sources/${secondSource.source_id}.md`;
      const secondTopicPath = "curated/topics/second-validation-paper.md";
      await writeCuratedPage(
        wikiDir,
        secondSummaryPath,
        {
          type: "source_summary",
          title: "Second Validation Paper Summary",
          visibility: "private",
          source_ids: [secondSource.source_id],
        },
        "# Second Validation Paper Summary\n\nThe second source provides independent evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        secondTopicPath,
        {
          type: "topic",
          title: "Second Validation Paper",
          visibility: "private",
          source_ids: [secondSource.source_id],
        },
        `# Second Validation Paper\n\nUses [[sources/${secondSource.source_id}|Second Validation Paper Summary]].\n`,
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${firstSource.source_id}|First Validation Paper Summary]]`,
          "- [[topics/first-validation-paper|First Validation Paper]]",
          `- [[sources/${secondSource.source_id}|Second Validation Paper Summary]]`,
          "- [[topics/second-validation-paper|Second Validation Paper]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, secondSource.source_id, [
        secondSummaryPath,
        secondTopicPath,
        "curated/index.md",
      ]);
      const afterFirstIngest = new Date(
        Math.max(Date.parse(firstIngestedAt as string), Date.parse(secondSource.captured_at)) + 1000,
      );
      await setRepoPathMtime(wikiDir, secondSummaryPath, afterFirstIngest);
      await setRepoPathMtime(wikiDir, secondTopicPath, afterFirstIngest);
      const secondValidation = await runCliBuffered([
        "ingest",
        secondSource.source_id,
        "--repo",
        wikiDir,
        "--validate",
        "--json",
      ]);
      expect(secondValidation.exitCode).toBe(0);

      // Act
      const validation = await validateIngestReadiness(wikiDir, firstSource.source_id);
      const repeatedValidation = await runCliBuffered([
        "ingest",
        firstSource.source_id,
        "--repo",
        wikiDir,
        "--validate",
        "--json",
      ]);
      const payload = parseJsonSuccess<"ingest", IngestValidationData>(repeatedValidation.stdout);

      // Assert
      expect(validation.passed).toBe(true);
      expect(validation.issues).toEqual([]);
      expect(validation.checked_paths).not.toContain(secondSummaryPath);
      expect(validation.checked_paths).not.toContain(secondTopicPath);
      expect(repeatedValidation.exitCode).toBe(0);
      expect(repeatedValidation.stderr).toEqual([]);
      expect(payload.data.queue.previous_status).toBe("ingested");
      expect(payload.data.queue.status).toBe("ingested");
    });
  });

  it("rejects validation when any captured raw original has drifted", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-all-raw-drift-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstSource = await captureTextSource(wikiDir, {
        title: "First Validation Paper",
        text: "first independent validation evidence",
      });
      const firstSummaryPath = `curated/sources/${firstSource.source_id}.md`;
      const firstTopicPath = "curated/topics/first-validation-paper.md";
      await writeCuratedPage(
        wikiDir,
        firstSummaryPath,
        {
          type: "source_summary",
          title: "First Validation Paper Summary",
          visibility: "private",
          source_ids: [firstSource.source_id],
        },
        "# First Validation Paper Summary\n\nThe first source provides independent evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        firstTopicPath,
        {
          type: "topic",
          title: "First Validation Paper",
          visibility: "private",
          source_ids: [firstSource.source_id],
        },
        `# First Validation Paper\n\nUses [[sources/${firstSource.source_id}|First Validation Paper Summary]].\n`,
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${firstSource.source_id}|First Validation Paper Summary]]`,
          "- [[topics/first-validation-paper|First Validation Paper]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, firstSource.source_id, [
        firstSummaryPath,
        firstTopicPath,
        "curated/index.md",
      ]);
      const firstValidation = await runCliBuffered([
        "ingest",
        firstSource.source_id,
        "--repo",
        wikiDir,
        "--validate",
        "--json",
      ]);
      expect(firstValidation.exitCode).toBe(0);

      const secondSource = await captureTextSource(wikiDir, {
        title: "Second Validation Paper",
        text: "second independent validation evidence",
      });
      const beforeSecondCapture = new Date(Date.parse(secondSource.captured_at) - 1000);
      await setRepoPathMtime(wikiDir, firstSummaryPath, beforeSecondCapture);
      await setRepoPathMtime(wikiDir, firstTopicPath, beforeSecondCapture);

      const secondSummaryPath = `curated/sources/${secondSource.source_id}.md`;
      const secondTopicPath = "curated/topics/second-validation-paper.md";
      await writeCuratedPage(
        wikiDir,
        secondSummaryPath,
        {
          type: "source_summary",
          title: "Second Validation Paper Summary",
          visibility: "private",
          source_ids: [secondSource.source_id],
        },
        "# Second Validation Paper Summary\n\nThe second source provides independent evidence.\n",
      );
      await writeCuratedPage(
        wikiDir,
        secondTopicPath,
        {
          type: "topic",
          title: "Second Validation Paper",
          visibility: "private",
          source_ids: [secondSource.source_id],
        },
        `# Second Validation Paper\n\nUses [[sources/${secondSource.source_id}|Second Validation Paper Summary]].\n`,
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          `- [[sources/${firstSource.source_id}|First Validation Paper Summary]]`,
          "- [[topics/first-validation-paper|First Validation Paper]]",
          `- [[sources/${secondSource.source_id}|Second Validation Paper Summary]]`,
          "- [[topics/second-validation-paper|Second Validation Paper]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, secondSource.source_id, [
        secondSummaryPath,
        secondTopicPath,
        "curated/index.md",
      ]);
      await writeFile(resolve(wikiDir, firstSource.original_path), "first raw original was tampered", "utf8");

      // Act
      const validation = await validateIngestReadiness(wikiDir, secondSource.source_id);
      const result = await runCliBuffered([
        "ingest",
        secondSource.source_id,
        "--repo",
        wikiDir,
        "--validate",
        "--json",
      ]);
      const failurePayload = parseJsonFailure<"ingest">(result.stdout);
      const secondQueueResult = await runCliBuffered([
        "queue",
        "show",
        secondSource.source_id,
        "--repo",
        wikiDir,
        "--json",
      ]);
      const secondQueuePayload = parseJsonSuccess<"queue show", QueueShowData>(secondQueueResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_raw_hash_drift",
            path: firstSource.original_path,
          }),
        ]),
      );
      expect(validation.checked_paths).toContain(firstSource.original_path);
      expect(result.exitCode).toBe(1);
      expect(failurePayload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(failurePayload.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_raw_hash_drift",
            path: firstSource.original_path,
          }),
        ]),
      );
      expect(secondQueuePayload.data.queue_record.status).toBe("queued");
      expect(secondQueuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("marks the queue item ingested only after all validation gates pass", async () => {
    await withTempWorkspace("llm-wiki-ingest-validation-pass-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T12:00:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const taskResult = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--json"]);
      expect(taskResult.exitCode).toBe(0);
      for (const rootPagePath of [
        "curated/contradictions.md",
        "curated/home.md",
        "curated/map.md",
        "curated/open-questions.md",
      ]) {
        await setRepoPathMtime(wikiDir, rootPagePath, new Date("2026-06-18T11:59:59.000Z"));
      }
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        [
          "# Validation Paper Summary",
          "",
          "## Summary",
          "",
          "The source provides immutable raw validation evidence.",
          "",
        ].join("\n"),
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/validated-ingest.md",
        {
          type: "topic",
          title: "Validated Ingest",
          visibility: "private",
          source_ids: [source.source_id],
        },
        `# Validated Ingest\n\nUses [[sources/${source.source_id}|Validation Paper Summary]].\n`,
      );
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        [
          "---",
          "type: index",
          "title: Index",
          "visibility: private",
          "source_ids: []",
          "---",
          "",
          "# Index",
          "",
          "## Sources",
          "",
          "| Source | Status | Summary | Key pages |",
          "|---|---|---|---|",
          `| [[${source.source_card_path}|Validation Paper]] | ingesting | [[sources/${source.source_id}|Validation Paper Summary]] | |`,
          "",
          "## Topics",
          "",
          "- [[topics/validated-ingest|Validated Ingest]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendIngestLogEntry(wikiDir, source.source_id, [
        `curated/sources/${source.source_id}.md`,
        "curated/topics/validated-ingest.md",
        "curated/index.md",
      ]);

      // Act
      const result = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--validate", "--json"]);
      const payload = parseJsonSuccess<"ingest", IngestValidationData>(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
      const log = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        mode: "validate",
        validation: {
          passed: true,
          issues: [],
        },
        queue: {
          previous_status: "ingesting",
          status: "ingested",
        },
      });
      expect(queuePayload.data.queue_record.status).toBe("ingested");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("ingested");
      expect(log).toContain("ingesting -> ingested");
    });
  });
});
