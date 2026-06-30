import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    auto_ingest?: AutoIngestMetadata;
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
      auto_ingest?: AutoIngestMetadata;
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

type AutoIngestMetadata = {
  enabled: boolean;
  attempt_count: number;
  last_attempt_at: string;
  last_result: string;
  last_error_code: string | null;
  last_error_message: string | null;
};

type AutoIngestSourceResult = {
  source_id: string;
  previous_status: QueueStatus | null;
  final_status: QueueStatus | null;
  outcome: "ingested" | "blocked" | "skipped" | "deferred";
  attempted: boolean;
  agent: string | null;
  applied_paths: string[];
  auto_ingest: AutoIngestMetadata | null;
  error: {
    code: string;
    message: string;
    path: string;
    hint: string;
  } | null;
};

type QueueIngestData = {
  agent: string | null;
  results: AutoIngestSourceResult[];
  counts: {
    selected: number;
    attempted: number;
    ingested: number;
    blocked: number;
    skipped: number;
    deferred: number;
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

async function captureTextSource(wikiDir: string, title: string, text: string): Promise<SourceCaptureData["source"]> {
  const result = await runCliBuffered(["add-text", "--repo", wikiDir, "--title", title, "--text", text, "--json"]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(payload.data.status).toBe("added");

  return payload.data.source;
}

async function configureDefaultAgent(wikiDir: string, command: string): Promise<void> {
  const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
  const config = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    [
      config.replace("default: generic", "default: codex").trimEnd(),
      "agents:",
      "  codex:",
      "    type: local-exec",
      `    command: ${JSON.stringify(command)}`,
      "    args:",
      "      - exec",
      "    timeout_seconds: 10",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function createFakeCodex(workspaceDir: string): Promise<string> {
  const binDir = resolve(workspaceDir, "fake-codex-bin");
  const executablePath = resolve(binDir, "codex");
  await mkdir(binDir, { recursive: true });
  await writeFile(executablePath, QUEUE_AUTO_CODEX_SOURCE, "utf8");
  await chmod(executablePath, 0o755);

  return executablePath;
}

const QUEUE_AUTO_CODEX_SOURCE = [
  `#!${process.execPath}`,
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const cwd = process.cwd();",
  "const prompt = fs.readFileSync(0, 'utf8') || process.argv[process.argv.length - 1] || '';",
  "const sourceId = prompt.match(/Source ID: (src_[^\\n]+)/)?.[1];",
  "if (!sourceId) {",
  "  console.error('missing source id');",
  "  process.exit(2);",
  "}",
  "if (!prompt.includes('Queue status: ingesting')) {",
  "  console.error('prompt was not rebuilt after queued -> ingesting');",
  "  process.exit(3);",
  "}",
  "const queue = JSON.parse(fs.readFileSync(path.join(cwd, 'raw/queue', sourceId + '.json'), 'utf8'));",
  "const title = String(queue.title || sourceId) + ' Summary';",
  "const sourceCardPath = String(queue.path || 'raw/queue/' + sourceId + '.json');",
  "const summary = [",
  "  '---',",
  "  'type: source_summary',",
  "  'title: ' + JSON.stringify(title),",
  "  'visibility: private',",
  "  'source_ids:',",
  "  '  - ' + sourceId,",
  "  'source_id: ' + sourceId,",
  "  '---',",
  "  '',",
  "  '# ' + title,",
  "  '',",
  "  'The source supports queue CLI auto-ingest.',",
  "  '',",
  "].join('\\n');",
  "const index = [",
  "  '---',",
  "  'type: index',",
  "  'title: Index',",
  "  'visibility: private',",
  "  'source_ids: []',",
  "  '---',",
  "  '',",
  "  '# Index',",
  "  '',",
  "  '- [[sources/' + sourceId + '|' + title + ']]',",
  "  '',",
  "].join('\\n');",
  "const log = [",
  "  '# Log',",
  "  '',",
  "  '## [2026-06-30T09:00:00.000Z] ingest | ' + sourceId + ' | Queue auto-ingest completed',",
  "  '',",
  "  '- actor: codex',",
  "  '- command: \"llm-wiki queue ingest --auto\"',",
  "  '- git_branch:',",
  "  '- git_commit:',",
  "  '- raw_source: ' + sourceCardPath,",
  "  '- created:',",
  "  '  - curated/sources/' + sourceId + '.md',",
  "  '- updated:',",
  "  '  - curated/index.md',",
  "  '- contradictions:',",
  "  '- follow_ups:',",
  "  '',",
  "].join('\\n');",
  "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true });",
  "fs.writeFileSync(path.join(cwd, 'curated/sources', sourceId + '.md'), summary, 'utf8');",
  "fs.writeFileSync(path.join(cwd, 'curated/index.md'), index, 'utf8');",
  "fs.writeFileSync(path.join(cwd, 'curated/log.md'), log, 'utf8');",
  "process.exit(0);",
  "",
].join("\n");

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
  it.each([
    {
      name: "queue --auto",
      command: "queue",
      option: "--auto",
      args: (wikiDir: string, _sourceId: string) => ["queue", "--auto", "--repo", wikiDir, "--json"],
    },
    {
      name: "queue --limit",
      command: "queue",
      option: "--limit",
      args: (wikiDir: string, _sourceId: string) => ["queue", "--limit", "1", "--repo", wikiDir, "--json"],
    },
    {
      name: "queue --source-id",
      command: "queue",
      option: "--source-id",
      args: (wikiDir: string, sourceId: string) => ["queue", "--source-id", sourceId, "--repo", wikiDir, "--json"],
    },
    {
      name: "queue show --auto",
      command: "queue show",
      option: "--auto",
      args: (wikiDir: string, sourceId: string) => ["queue", "show", sourceId, "--auto", "--repo", wikiDir, "--json"],
    },
    {
      name: "queue show --limit",
      command: "queue show",
      option: "--limit",
      args: (wikiDir: string, sourceId: string) => [
        "queue",
        "show",
        sourceId,
        "--limit",
        "1",
        "--repo",
        wikiDir,
        "--json",
      ],
    },
    {
      name: "queue show --source-id",
      command: "queue show",
      option: "--source-id",
      args: (wikiDir: string, sourceId: string) => [
        "queue",
        "show",
        sourceId,
        "--source-id",
        sourceId,
        "--repo",
        wikiDir,
        "--json",
      ],
    },
    {
      name: "queue set-status --auto",
      command: "queue set-status",
      option: "--auto",
      args: (wikiDir: string, sourceId: string) => [
        "queue",
        "set-status",
        sourceId,
        "ingesting",
        "--auto",
        "--repo",
        wikiDir,
        "--json",
      ],
    },
    {
      name: "queue set-status --limit",
      command: "queue set-status",
      option: "--limit",
      args: (wikiDir: string, sourceId: string) => [
        "queue",
        "set-status",
        sourceId,
        "ingesting",
        "--limit",
        "1",
        "--repo",
        wikiDir,
        "--json",
      ],
    },
    {
      name: "queue set-status --source-id",
      command: "queue set-status",
      option: "--source-id",
      args: (wikiDir: string, sourceId: string) => [
        "queue",
        "set-status",
        sourceId,
        "ingesting",
        "--source-id",
        sourceId,
        "--repo",
        wikiDir,
        "--json",
      ],
    },
  ])("rejects ingest-only option $name outside queue ingest", async ({ args, command, option }) => {
    await withTempWorkspace("llm-wiki-queue-ingest-only-options-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "Ingest Flag Guard", "alpha");

      // Act
      const result = await runCliBuffered(args(wikiDir, source.source_id));
      const payload = parseJsonFailure<typeof command>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command,
        error: {
          code: "QUEUE_INGEST_OPTION_INVALID",
        },
      });
      expect(payload.issues[0]).toMatchObject({
        path: option,
      });
    });
  });

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

  it("runs queue ingest --auto through the batch worker and honors --limit", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-auto-limit-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstSource = await captureTextSource(wikiDir, "Queue Auto First", "first queued source");
      const secondSource = await captureTextSource(wikiDir, "Queue Auto Second", "second queued source");
      await configureDefaultAgent(wikiDir, await createFakeCodex(workspaceDir));

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--limit",
        "1",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonSuccess<"queue ingest", QueueIngestData>(result.stdout);
      const firstQueueResult = await runCliBuffered(["queue", "show", firstSource.source_id, "--repo", wikiDir, "--json"]);
      const secondQueueResult = await runCliBuffered(["queue", "show", secondSource.source_id, "--repo", wikiDir, "--json"]);
      const firstQueue = parseJsonSuccess<"queue show", QueueShowData>(firstQueueResult.stdout);
      const secondQueue = parseJsonSuccess<"queue show", QueueShowData>(secondQueueResult.stdout);
      const statuses = [firstQueue.data.queue_record.status, secondQueue.data.queue_record.status];

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.counts).toMatchObject({
        selected: 1,
        attempted: 1,
        ingested: 1,
        blocked: 0,
        deferred: 0,
      });
      expect(payload.data.results).toHaveLength(1);
      expect(statuses.filter((status) => status === "ingested")).toHaveLength(1);
      expect(statuses.filter((status) => status === "queued")).toHaveLength(1);
      const ingestedQueue = firstQueue.data.queue_record.status === "ingested" ? firstQueue : secondQueue;
      expect(ingestedQueue.data.queue_record.auto_ingest).toMatchObject({
        enabled: true,
        attempt_count: 1,
        last_result: "ingested",
        last_error_code: null,
        last_error_message: null,
      });
    });
  });

  it("exits nonzero when batch queue ingest skips selected work", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-auto-batch-skipped-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "Broken Batch Queue Auto", "selected source has no card");
      await configureDefaultAgent(wikiDir, await createFakeCodex(workspaceDir));
      await rm(resolve(wikiDir, source.source_card_path));

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonSuccess<"queue ingest", QueueIngestData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.data.counts).toMatchObject({
        selected: 1,
        attempted: 0,
        ingested: 0,
        blocked: 0,
        skipped: 1,
        deferred: 0,
      });
      expect(payload.data.results).toEqual([
        expect.objectContaining({
          source_id: source.source_id,
          outcome: "skipped",
          attempted: false,
          error: expect.objectContaining({ code: "QUEUE_SOURCE_CARD_MISSING" }),
        }),
      ]);
    });
  });

  it("runs queue ingest --auto --source-id against only the targeted source", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-auto-source-id-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstSource = await captureTextSource(wikiDir, "Untouched Queue Auto", "source should stay queued");
      const secondSource = await captureTextSource(wikiDir, "Target Queue Auto", "source should be ingested");
      await configureDefaultAgent(wikiDir, await createFakeCodex(workspaceDir));

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--source-id",
        secondSource.source_id,
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonSuccess<"queue ingest", QueueIngestData>(result.stdout);
      const firstQueueResult = await runCliBuffered(["queue", "show", firstSource.source_id, "--repo", wikiDir, "--json"]);
      const secondQueueResult = await runCliBuffered(["queue", "show", secondSource.source_id, "--repo", wikiDir, "--json"]);
      const firstQueue = parseJsonSuccess<"queue show", QueueShowData>(firstQueueResult.stdout);
      const secondQueue = parseJsonSuccess<"queue show", QueueShowData>(secondQueueResult.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.counts).toMatchObject({
        selected: 1,
        attempted: 1,
        ingested: 1,
        blocked: 0,
        deferred: 0,
      });
      expect(payload.data.results.map((item) => item.source_id)).toEqual([secondSource.source_id]);
      expect(firstQueue.data.queue_record.status).toBe("queued");
      expect(secondQueue.data.queue_record.status).toBe("ingested");
      expect(secondQueue.data.queue_record.auto_ingest).toMatchObject({
        enabled: true,
        attempt_count: 1,
        last_result: "ingested",
      });
    });
  });

  it("exits nonzero when targeted queue ingest skips a missing source", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-auto-source-id-missing-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const missingSourceId = "src_2026_06_17_missing_target_000000";
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--source-id",
        missingSourceId,
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonSuccess<"queue ingest", QueueIngestData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.data.counts).toMatchObject({
        selected: 1,
        attempted: 0,
        ingested: 0,
        blocked: 0,
        skipped: 1,
        deferred: 0,
      });
      expect(payload.data.results).toEqual([
        expect.objectContaining({
          source_id: missingSourceId,
          outcome: "skipped",
          attempted: false,
          error: expect.objectContaining({ code: "QUEUE_ITEM_NOT_FOUND" }),
        }),
      ]);
    });
  });

  it("emits an error when quiet targeted queue ingest needs attention", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-auto-quiet-attention-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const missingSourceId = "src_2026_06_17_missing_quiet_000000";
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--source-id",
        missingSourceId,
        "--repo",
        wikiDir,
        "--quiet",
      ]);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toEqual(["Error: Auto-ingest completed with work requiring attention."]);
    });
  });

  it("bounds queue ingest --auto --watch result details while accumulating counts", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-auto-watch-bounded-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const invalidSourceId = "not-a-source-id";
      const beforeSigint = new Set(process.listeners("SIGINT"));
      const beforeSigterm = new Set(process.listeners("SIGTERM"));
      await initializeWiki(wikiDir);
      vi.useFakeTimers();

      try {
        // Act
        const watchResult = runCliBuffered([
          "queue",
          "ingest",
          "--auto",
          "--source-id",
          invalidSourceId,
          "--watch",
          "--repo",
          wikiDir,
          "--json",
        ]);
        let addedSigintListeners = process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener));
        for (let attempt = 0; attempt < 50 && addedSigintListeners.length === 0; attempt += 1) {
          await vi.advanceTimersByTimeAsync(0);
          addedSigintListeners = process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener));
        }
        expect(addedSigintListeners).toHaveLength(1);

        for (let tick = 0; tick < 30; tick += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        addedSigintListeners[0]?.("SIGINT");
        await vi.advanceTimersByTimeAsync(0);
        const result = await watchResult;
        const payload = parseJsonSuccess<"queue ingest", QueueIngestData>(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.data.counts).toMatchObject({
          selected: 31,
          attempted: 0,
          ingested: 0,
          blocked: 0,
          skipped: 31,
          deferred: 0,
        });
        expect(payload.data.results).toHaveLength(25);
        expect(payload.data.results.every((item) => item.source_id === invalidSourceId)).toBe(true);
        expect(payload.data.results.every((item) => item.outcome === "skipped")).toBe(true);
      } finally {
        for (const listener of process.listeners("SIGINT")) {
          if (!beforeSigint.has(listener)) {
            process.off("SIGINT", listener);
          }
        }
        for (const listener of process.listeners("SIGTERM")) {
          if (!beforeSigterm.has(listener)) {
            process.off("SIGTERM", listener);
          }
        }
      }
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

  it("rejects missing runtime logs before changing queue status", async () => {
    await withTempWorkspace("llm-wiki-queue-set-status-missing-log-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, "Missing Log Transition", "status stays queued");
      const queueBefore = await readFile(resolve(wikiDir, source.queue_path), "utf8");
      const sourceCardBefore = await readFile(resolve(wikiDir, source.source_card_path), "utf8");
      await rm(resolve(wikiDir, "curated/log.md"));

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
      const payload = parseJsonFailure<"queue set-status">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "queue set-status",
        repo: wikiDir,
        error: {
          code: "QUEUE_WRITE_FAILED",
          message: "Required runtime log file is missing: curated/log.md.",
          hint: "Restore curated/log.md from the scaffold before running workflows that append runtime log entries.",
        },
        issues: [
          {
            severity: "error",
            code: "QUEUE_WRITE_FAILED",
            message: "Required runtime log file is missing: curated/log.md.",
            path: "curated/log.md",
            hint: "Restore curated/log.md from the scaffold before running workflows that append runtime log entries.",
          },
        ],
      });
      expect(await readFile(resolve(wikiDir, source.queue_path), "utf8")).toBe(queueBefore);
      expect(await readFile(resolve(wikiDir, source.source_card_path), "utf8")).toBe(sourceCardBefore);
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
