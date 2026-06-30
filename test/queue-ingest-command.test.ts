import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  AutoIngestBatchResult,
  AutoIngestOutcome,
  AutoIngestSourceResult,
} from "../src/autoIngest/index.js";
import { INGEST_LOCK_RELATIVE_PATH } from "../src/runtime/ingestLock.js";
import { createWiki } from "../src/scaffold/createWiki.js";
import { runCliBuffered, withTempWorkspace } from "./helpers/init.js";

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

type RuntimePartialFailureEnvelope<Command extends string, Data> =
  & RuntimeFailureEnvelope<Command>
  & {
    repo: string;
    data: Data;
    warnings: string[];
  };

type QueueIngestData = Omit<AutoIngestBatchResult, "agent"> & {
  agent: string | null;
};

type QueueStatus = "queued" | "ingesting" | "ingested" | "blocked";

type SourceFixture = {
  sourceId: string;
  title: string;
  capturedAt: string;
  queuePath: string;
  sourceCardPath: string;
  originalPath: string;
};

const TEST_CAPTURED_AT = "2999-06-30T09:00:00.000Z";
const TEST_LATER_CAPTURED_AT = "2999-06-30T09:05:00.000Z";

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

async function removeDefaultAgent(wikiDir: string): Promise<void> {
  const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
  await writeFile(
    configPath,
    (await readFile(configPath, "utf8")).replace("agent:\n  default: generic\n", ""),
    "utf8",
  );
}

async function createExecutable(workspaceDir: string, fileName: string, source: string): Promise<string> {
  const binDir = resolve(workspaceDir, "bin");
  const executablePath = resolve(binDir, fileName);
  await mkdir(binDir, { recursive: true });
  await writeFile(executablePath, source, "utf8");
  await chmod(executablePath, 0o755);

  return executablePath;
}

async function writeSourceFixture(
  wikiDir: string,
  input: {
    sourceId: string;
    title?: string;
    capturedAt: string;
    status?: QueueStatus;
  },
): Promise<SourceFixture> {
  const status = input.status ?? "queued";
  const title = input.title ?? input.sourceId;
  const sourceDir = `raw/inputs/test/${input.sourceId}`;
  const originalPath = `${sourceDir}/original.md`;
  const sourceCardPath = `${sourceDir}/_source.md`;
  const queuePath = `raw/queue/${input.sourceId}.json`;
  const originalContent = originalContentForSourceId(input.sourceId);
  const contentHash = `sha256:${createHash("sha256").update(originalContent).digest("hex")}`;

  await mkdir(resolve(wikiDir, sourceDir), { recursive: true });
  await writeFile(resolve(wikiDir, originalPath), originalContent, "utf8");
  await writeFile(
    resolve(wikiDir, sourceCardPath),
    [
      "---",
      "type: raw_source",
      `source_id: ${input.sourceId}`,
      `title: ${JSON.stringify(title)}`,
      "source_kind: text",
      "origin: test",
      "origin_url:",
      `captured_at: ${input.capturedAt}`,
      `content_hash: ${contentHash}`,
      `status: ${status}`,
      "visibility: private",
      "---",
      "",
      `# ${title}`,
      "",
      "## Ingest status",
      "",
      `- Status: ${status}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    resolve(wikiDir, queuePath),
    `${JSON.stringify(
      {
        kind: "text",
        source_id: input.sourceId,
        title,
        source_kind: "text",
        origin: "test",
        captured_at: input.capturedAt,
        content_hash: contentHash,
        status,
        visibility: "private",
        path: sourceCardPath,
        original_path: originalPath,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    sourceId: input.sourceId,
    title,
    capturedAt: input.capturedAt,
    queuePath,
    sourceCardPath,
    originalPath,
  };
}

async function readSourceState(wikiDir: string, source: SourceFixture): Promise<{
  queue: string;
  sourceCard: string;
  status: QueueStatus;
}> {
  const queue = await readFile(resolve(wikiDir, source.queuePath), "utf8");
  const sourceCard = await readFile(resolve(wikiDir, source.sourceCardPath), "utf8");

  return {
    queue,
    sourceCard,
    status: (JSON.parse(queue) as { status: QueueStatus }).status,
  };
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

function parseJsonPartialFailure<Command extends string, Data>(
  stdout: string[],
): RuntimePartialFailureEnvelope<Command, Data> {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as RuntimePartialFailureEnvelope<Command, Data>;
}

function sourceIdForSlug(slug: string): string {
  const hash = createHash("sha256").update(originalContentForSlug(slug)).digest("hex");

  return `src_2026_06_30_${slug}_${hash.slice(0, 12)}`;
}

function originalContentForSourceId(sourceId: string): string {
  const match = /^src_\d{4}_\d{2}_\d{2}_(.+?)_[a-f0-9]{6,16}$/.exec(sourceId);

  return originalContentForSlug(match?.[1] ?? sourceId);
}

function originalContentForSlug(slug: string): string {
  return `raw content for ${slug}\n`;
}

function successAgentSource(failSourceId: string | null = null): string {
  return [
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
    ...(failSourceId === null
      ? []
      : [
          `if (sourceId === ${JSON.stringify(failSourceId)}) {`,
          "  console.error('synthetic queue ingest failure');",
          "  process.exit(7);",
          "}",
        ]),
    "const title = 'Queue Ingest ' + sourceId;",
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
    "  'The source supports CLI queue auto-ingest orchestration.',",
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
    "  '## [2999-06-30T09:00:00.000Z] ingest | ' + sourceId + ' | Agent ingest completed',",
    "  '',",
    "  '- actor: codex',",
    "  '- command: \"llm-wiki queue ingest --auto\"',",
    "  '- git_branch:',",
    "  '- git_commit:',",
    "  '- raw_source: raw/inputs/test/' + sourceId + '/_source.md',",
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
    "",
  ].join("\n");
}

function expectSourceResult(
  result: AutoIngestSourceResult,
  expected: {
    sourceId: string;
    outcome: AutoIngestOutcome;
    attempted: boolean;
    finalStatus: QueueStatus | null;
  },
): void {
  expect(result).toMatchObject({
    source_id: expected.sourceId,
    outcome: expected.outcome,
    attempted: expected.attempted,
    final_status: expected.finalStatus,
  });
}

describe("queue ingest command", () => {
  it("rejects queue ingest without --auto before mutating queue files", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-auto-required-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("auto_required"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const before = await readSourceState(wikiDir, source);

      // Act
      const result = await runCliBuffered(["queue", "ingest", "--repo", wikiDir, "--json"]);
      const payload = parseJsonFailure<"queue ingest">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "queue ingest",
        error: {
          code: "QUEUE_INGEST_AUTO_REQUIRED",
        },
      });
      expect(await readSourceState(wikiDir, source)).toEqual(before);
    });
  });

  it("rejects an invalid limit before mutating queue files", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-invalid-limit-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("invalid_limit"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const before = await readSourceState(wikiDir, source);

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--limit",
        "one",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonFailure<"queue ingest">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUEUE_INGEST_LIMIT_INVALID");
      expect(await readSourceState(wikiDir, source)).toEqual(before);
    });
  });

  it("rejects positional source targets before mutating queue files", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-positional-target-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-positional-target", successAgentSource());
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("positional_target"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const before = await readSourceState(wikiDir, source);

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        source.sourceId,
        "--auto",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonFailure<"queue ingest">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUEUE_INGEST_ARGUMENT_INVALID");
      expect(await readSourceState(wikiDir, source)).toEqual(before);
    });
  });

  it("rejects --limit with --source-id before mutating queue files", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-source-id-limit-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-source-id-limit", successAgentSource());
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("source_id_limit"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const before = await readSourceState(wikiDir, source);

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--source-id",
        source.sourceId,
        "--limit",
        "0",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonFailure<"queue ingest">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUEUE_INGEST_ARGUMENT_INVALID");
      expect(await readSourceState(wikiDir, source)).toEqual(before);
    });
  });

  it.each([
    {
      name: "missing default agent",
      configure: async (wikiDir: string, _workspaceDir: string) => {
        await removeDefaultAgent(wikiDir);
      },
      expectedCode: "AGENT_CONFIG_MISSING",
    },
    {
      name: "unavailable default agent command",
      configure: async (wikiDir: string, workspaceDir: string) => {
        await configureDefaultAgent(wikiDir, resolve(workspaceDir, "missing-agent-command"));
      },
      expectedCode: "AGENT_COMMAND_UNAVAILABLE",
    },
  ])("preflights $name before mutating queue files", async ({ configure, expectedCode }) => {
    await withTempWorkspace("llm-wiki-queue-ingest-preflight-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await configure(wikiDir, workspaceDir);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug(`preflight_${expectedCode.toLowerCase()}`),
        capturedAt: TEST_CAPTURED_AT,
      });
      const before = await readSourceState(wikiDir, source);

      // Act
      const result = await runCliBuffered(["queue", "ingest", "--auto", "--repo", wikiDir, "--json"]);
      const payload = parseJsonFailure<"queue ingest">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe(expectedCode);
      expect(payload).not.toHaveProperty("data");
      expect(await readSourceState(wikiDir, source)).toEqual(before);
    });
  });

  it("emits a zero-selected success envelope without mutating ineligible queue items", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-zero-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-zero", successAgentSource());
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("already_ingested"),
        capturedAt: TEST_CAPTURED_AT,
        status: "ingested",
      });
      const before = await readSourceState(wikiDir, source);

      // Act
      const result = await runCliBuffered(["queue", "ingest", "--auto", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"queue ingest", QueueIngestData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: true,
        command: "queue ingest",
        repo: wikiDir,
        data: {
          agent: "codex",
          results: [],
          counts: {
            selected: 0,
            attempted: 0,
            ingested: 0,
            blocked: 0,
            skipped: 0,
            deferred: 0,
          },
        },
        warnings: [],
      });
      expect(await readSourceState(wikiDir, source)).toEqual(before);
    });
  });

  it("processes queued sources oldest first and --limit 1 selects exactly one", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-limit-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-limit", successAgentSource());
      await configureDefaultAgent(wikiDir, executablePath);
      const later = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("newer"),
        capturedAt: TEST_LATER_CAPTURED_AT,
      });
      const older = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("older"),
        capturedAt: TEST_CAPTURED_AT,
      });

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

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.counts).toEqual({
        selected: 1,
        attempted: 1,
        ingested: 1,
        blocked: 0,
        skipped: 0,
        deferred: 0,
      });
      expect(payload.data.results.map((item) => item.source_id)).toEqual([older.sourceId]);
      expect(payload.data.results[0]?.applied_paths).toEqual([
        "curated/index.md",
        "curated/log.md",
        `curated/sources/${older.sourceId}.md`,
      ]);
      const runtimeLog = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");
      expect(runtimeLog.split("\n").filter((line) => line === '- command: "llm-wiki queue ingest --auto --limit 1"')).toHaveLength(2);
      expect(runtimeLog).toContain("- status: queued -> ingesting");
      expect(runtimeLog).toContain("- status: ingesting -> ingested");
      await expect(readSourceState(wikiDir, older)).resolves.toMatchObject({ status: "ingested" });
      await expect(readSourceState(wikiDir, later)).resolves.toMatchObject({ status: "queued" });
    });
  });

  it("targets only --source-id in human mode and leaves other queued sources alone", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-source-id-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-source-id", successAgentSource());
      await configureDefaultAgent(wikiDir, executablePath);
      const other = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("target_other"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const target = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("target_selected"),
        capturedAt: TEST_LATER_CAPTURED_AT,
      });

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--source-id",
        target.sourceId,
        "--repo",
        wikiDir,
      ]);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(result.stdout.join("\n")).toContain("Queue auto-ingest results");
      expect(result.stdout.join("\n")).toContain(`Selected: 1`);
      expect(result.stdout.join("\n")).toContain(`${target.sourceId} | ingested | attempted`);
      expect(result.stdout.join("\n")).not.toContain(other.sourceId);
      await expect(readSourceState(wikiDir, target)).resolves.toMatchObject({ status: "ingested" });
      await expect(readSourceState(wikiDir, other)).resolves.toMatchObject({ status: "queued" });
    });
  });

  it("prints a human blocked result with status transition and actionable error text", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-human-blocked-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("human_blocked"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const executablePath = await createExecutable(workspaceDir, "agent-human-blocked", successAgentSource(source.sourceId));
      await configureDefaultAgent(wikiDir, executablePath);

      // Act
      const result = await runCliBuffered(["queue", "ingest", "--auto", "--repo", wikiDir]);
      const output = result.stdout.join("\n");
      const errors = result.stderr.join("\n");

      // Assert
      expect(result.exitCode).toBe(1);
      expect(output).toContain("Queue auto-ingest results");
      expect(output).toContain("Counts: ingested 0, blocked 1, skipped 0, deferred 0");
      expect(output).toContain(`${source.sourceId} | blocked | attempted`);
      expect(output).toContain("Status: queued -> blocked");
      expect(output).toContain("Error: AGENT_COMMAND_FAILED: Agent command failed for codex.");
      expect(output).toContain("Hint: Inspect the stderr tail and rerun after fixing the local agent command failure.");
      expect(errors).toContain("Error: Queue auto-ingest completed with 1 incomplete result.");
      expect(errors).toContain("Hint: Review the per-source results, fix blocked or deferred sources, then rerun llm-wiki queue ingest --auto.");
      await expect(readSourceState(wikiDir, source)).resolves.toMatchObject({ status: "blocked" });
    });
  });

  it("prints a human skipped result for an ineligible targeted source without queue mutation", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-human-skipped-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("human_skipped"),
        capturedAt: TEST_CAPTURED_AT,
        status: "ingested",
      });
      const before = await readSourceState(wikiDir, source);

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--source-id",
        source.sourceId,
        "--repo",
        wikiDir,
      ]);
      const output = result.stdout.join("\n");
      const errors = result.stderr.join("\n");

      // Assert
      expect(result.exitCode).toBe(1);
      expect(output).toContain("Queue auto-ingest results");
      expect(output).toContain("Counts: ingested 0, blocked 0, skipped 1, deferred 0");
      expect(output).toContain(`${source.sourceId} | skipped | not attempted`);
      expect(output).toContain("Status: ingested -> ingested");
      expect(output).toContain("Error: AUTO_INGEST_SOURCE_NOT_ELIGIBLE: Auto-ingest only processes queued sources; current status is ingested.");
      expect(output).toContain("Hint: Only queued sources are eligible for auto-ingest.");
      expect(errors).toContain("Error: Queue auto-ingest completed with 1 incomplete result.");
      expect(await readSourceState(wikiDir, source)).toEqual(before);
    });
  });

  it("prints a human deferred result for an already ingesting targeted source without queue mutation", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-human-deferred-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("human_deferred"),
        capturedAt: TEST_CAPTURED_AT,
        status: "ingesting",
      });
      const before = await readSourceState(wikiDir, source);

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--source-id",
        source.sourceId,
        "--repo",
        wikiDir,
      ]);
      const output = result.stdout.join("\n");
      const errors = result.stderr.join("\n");

      // Assert
      expect(result.exitCode).toBe(1);
      expect(output).toContain("Queue auto-ingest results");
      expect(output).toContain("Counts: ingested 0, blocked 0, skipped 0, deferred 1");
      expect(output).toContain(`${source.sourceId} | deferred | not attempted`);
      expect(output).toContain("Status: ingesting -> ingesting");
      expect(output).toContain("Error: AUTO_INGEST_SOURCE_NOT_ELIGIBLE: Auto-ingest only processes queued sources; current status is ingesting.");
      expect(output).toContain("Hint: Another ingest is already processing this source.");
      expect(errors).toContain("Error: Queue auto-ingest completed with 1 incomplete result.");
      expect(await readSourceState(wikiDir, source)).toEqual(before);
    });
  });

  it.each([
    {
      name: "ingested",
      setup: async (wikiDir: string) =>
        writeSourceFixture(wikiDir, {
          sourceId: sourceIdForSlug("target_ingested"),
          capturedAt: TEST_CAPTURED_AT,
          status: "ingested",
        }),
      target: (source: SourceFixture) => source.sourceId,
      expectedOutcome: "skipped" as const,
      expectedFinalStatus: "ingested" as const,
      expectedCode: "AUTO_INGEST_SOURCE_NOT_ELIGIBLE",
    },
    {
      name: "blocked",
      setup: async (wikiDir: string) =>
        writeSourceFixture(wikiDir, {
          sourceId: sourceIdForSlug("target_blocked"),
          capturedAt: TEST_CAPTURED_AT,
          status: "blocked",
        }),
      target: (source: SourceFixture) => source.sourceId,
      expectedOutcome: "skipped" as const,
      expectedFinalStatus: "blocked" as const,
      expectedCode: "AUTO_INGEST_SOURCE_NOT_ELIGIBLE",
    },
    {
      name: "ingesting",
      setup: async (wikiDir: string) =>
        writeSourceFixture(wikiDir, {
          sourceId: sourceIdForSlug("target_ingesting"),
          capturedAt: TEST_CAPTURED_AT,
          status: "ingesting",
        }),
      target: (source: SourceFixture) => source.sourceId,
      expectedOutcome: "deferred" as const,
      expectedFinalStatus: "ingesting" as const,
      expectedCode: "AUTO_INGEST_SOURCE_NOT_ELIGIBLE",
    },
    {
      name: "missing",
      setup: async (_wikiDir: string) => null,
      target: () => sourceIdForSlug("target_missing"),
      expectedOutcome: "skipped" as const,
      expectedFinalStatus: null,
      expectedCode: "QUEUE_ITEM_NOT_FOUND",
    },
    {
      name: "invalid",
      setup: async (_wikiDir: string) => null,
      target: () => "not a source id",
      expectedOutcome: "skipped" as const,
      expectedFinalStatus: null,
      expectedCode: "SOURCE_ID_INVALID",
    },
  ])("reports targeted $name sources without queue mutation", async (caseInput) => {
    await withTempWorkspace("llm-wiki-queue-ingest-target-ineligible-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await caseInput.setup(wikiDir);
      const before = source === null ? null : await readSourceState(wikiDir, source);
      const sourceId = caseInput.target(source as SourceFixture);

      // Act
      const result = await runCliBuffered([
        "queue",
        "ingest",
        "--auto",
        "--source-id",
        sourceId,
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonPartialFailure<"queue ingest", QueueIngestData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "queue ingest",
        repo: wikiDir,
        error: {
          code: "QUEUE_INGEST_INCOMPLETE",
        },
        data: {
          agent: null,
          counts: {
            selected: 1,
          },
        },
      });
      expectSourceResult(payload.data.results[0] as AutoIngestSourceResult, {
        sourceId,
        outcome: caseInput.expectedOutcome,
        attempted: false,
        finalStatus: caseInput.expectedFinalStatus,
      });
      expect(payload.data.results[0]?.error?.code).toBe(caseInput.expectedCode);
      if (source !== null) {
        expect(await readSourceState(wikiDir, source)).toEqual(before);
      }
    });
  });

  it("keeps per-source data in a partial JSON envelope when one source is blocked", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-partial-blocked-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const succeeds = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("partial_success"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const fails = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("partial_failure"),
        capturedAt: TEST_LATER_CAPTURED_AT,
      });
      const executablePath = await createExecutable(workspaceDir, "agent-partial", successAgentSource(fails.sourceId));
      await configureDefaultAgent(wikiDir, executablePath);

      // Act
      const result = await runCliBuffered(["queue", "ingest", "--auto", "--repo", wikiDir, "--json"]);
      const payload = parseJsonPartialFailure<"queue ingest", QueueIngestData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUEUE_INGEST_INCOMPLETE");
      expect(payload.data.counts).toEqual({
        selected: 2,
        attempted: 2,
        ingested: 1,
        blocked: 1,
        skipped: 0,
        deferred: 0,
      });
      expect(payload.data.results.map((item) => item.source_id)).toEqual([succeeds.sourceId, fails.sourceId]);
      expect(payload.issues.map((issue) => issue.code)).toContain("AGENT_COMMAND_FAILED");
      expectSourceResult(payload.data.results[0] as AutoIngestSourceResult, {
        sourceId: succeeds.sourceId,
        outcome: "ingested",
        attempted: true,
        finalStatus: "ingested",
      });
      expectSourceResult(payload.data.results[1] as AutoIngestSourceResult, {
        sourceId: fails.sourceId,
        outcome: "blocked",
        attempted: true,
        finalStatus: "blocked",
      });
      await expect(readSourceState(wikiDir, succeeds)).resolves.toMatchObject({ status: "ingested" });
      await expect(readSourceState(wikiDir, fails)).resolves.toMatchObject({ status: "blocked" });
    });
  });

  it("reports lock-busy queued work as deferred with retained JSON data and no queue mutation", async () => {
    await withTempWorkspace("llm-wiki-queue-ingest-lock-busy-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-lock", successAgentSource());
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("lock_busy"),
        capturedAt: TEST_CAPTURED_AT,
      });
      await mkdir(resolve(wikiDir, INGEST_LOCK_RELATIVE_PATH), { recursive: true });
      const before = await readSourceState(wikiDir, source);

      // Act
      const result = await runCliBuffered(["queue", "ingest", "--auto", "--repo", wikiDir, "--json"]);
      const payload = parseJsonPartialFailure<"queue ingest", QueueIngestData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.data.counts).toEqual({
        selected: 1,
        attempted: 0,
        ingested: 0,
        blocked: 0,
        skipped: 0,
        deferred: 1,
      });
      expectSourceResult(payload.data.results[0] as AutoIngestSourceResult, {
        sourceId: source.sourceId,
        outcome: "deferred",
        attempted: false,
        finalStatus: "queued",
      });
      expect(payload.data.results[0]?.error?.code).toBe("INGEST_LOCK_BUSY");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          code: "INGEST_LOCK_BUSY",
          path: INGEST_LOCK_RELATIVE_PATH,
        }),
      ]);
      expect(await readSourceState(wikiDir, source)).toEqual(before);
    });
  });
});
