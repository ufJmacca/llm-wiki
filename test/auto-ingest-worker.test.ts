import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  runAutoIngestBatch,
  runAutoIngestSource,
  type AutoIngestMetadata,
  type AutoIngestSourceResult,
} from "../src/autoIngest/index.js";
import { INGEST_LOCK_RELATIVE_PATH } from "../src/runtime/ingestLock.js";
import { transitionQueueStatus } from "../src/runtime/queue.js";
import { parseLogEntries } from "../src/scanner/index.js";
import { createWiki } from "../src/scaffold/createWiki.js";
import { pathExists, readTreeSnapshot, withTempWorkspace } from "./helpers/init.js";

const execFileAsync = promisify(execFile);

type QueueStatus = "queued" | "ingesting" | "ingested" | "blocked";

type SourceFixture = {
  sourceId: string;
  title: string;
  capturedAt: string;
  queuePath: string;
  sourceCardPath: string;
  originalPath: string;
};

type QueueRecord = {
  source_id: string;
  status: QueueStatus;
  captured_at: string;
  auto_ingest?: AutoIngestMetadata;
};

type SourceCardFrontmatter = {
  source_id: string;
  status: QueueStatus;
  auto_ingest?: AutoIngestMetadata;
};

const SUCCESS_AGENT_SOURCE = [
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
  "const title = 'Auto Ingest ' + sourceId;",
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
  "  'The source supports shared auto-ingest orchestration.',",
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
  "  '## [2026-06-30T09:00:00.000Z] ingest | ' + sourceId + ' | Agent ingest completed',",
  "  '',",
  "  '- actor: codex',",
  "  '- command: \"llm-wiki ingest ' + sourceId + ' --auto\"',",
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

const FAILING_AGENT_SOURCE = [
  `#!${process.execPath}`,
  "console.error('synthetic local agent failure');",
  "process.exit(7);",
  "",
].join("\n");

const RAW_REWRITE_AGENT_SOURCE = [
  `#!${process.execPath}`,
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const prompt = fs.readFileSync(0, 'utf8') || process.argv[process.argv.length - 1] || '';",
  "const sourceId = prompt.match(/Source ID: (src_[^\\n]+)/)?.[1];",
  "if (!sourceId) {",
  "  console.error('missing source id');",
  "  process.exit(2);",
  "}",
  "fs.writeFileSync(path.join(process.cwd(), 'raw/inputs/test', sourceId, 'original.md'), 'rewritten raw evidence\\n', 'utf8');",
  "",
].join("\n");

const DELETE_CURATED_AGENT_SOURCE = [
  `#!${process.execPath}`,
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "fs.rmSync(path.join(process.cwd(), 'curated/home.md'));",
  "",
].join("\n");

const INVALID_PROPOSAL_AGENT_SOURCE = [
  `#!${process.execPath}`,
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const prompt = fs.readFileSync(0, 'utf8') || process.argv[process.argv.length - 1] || '';",
  "const sourceId = prompt.match(/Source ID: (src_[^\\n]+)/)?.[1];",
  "fs.mkdirSync(path.join(process.cwd(), 'curated/sources'), { recursive: true });",
  "fs.writeFileSync(path.join(process.cwd(), 'curated/sources', sourceId + '.md'), [",
  "  '---',",
  "  'type: source_summary',",
  "  'title: Invalid Auto Ingest',",
  "  'visibility: private',",
  "  'source_ids: []',",
  "  'source_id: ' + sourceId,",
  "  '---',",
  "  '',",
  "  '# Invalid Auto Ingest',",
  "  '',",
  "  'This intentionally omits the required source_ids provenance.',",
  "  '',",
  "].join('\\n'), 'utf8');",
  "",
].join("\n");

const APPLY_WRITE_FAILURE_AGENT_SOURCE = [
  `#!${process.execPath}`,
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const prompt = fs.readFileSync(0, 'utf8') || process.argv[process.argv.length - 1] || '';",
  "const sourceId = prompt.match(/Source ID: (src_[^\\n]+)/)?.[1];",
  "if (!sourceId) {",
  "  console.error('missing source id');",
  "  process.exit(2);",
  "}",
  "const cwd = process.cwd();",
  "const workspaceDir = path.dirname(path.dirname(process.argv[1]));",
  "fs.chmodSync(path.join(workspaceDir, 'wiki/curated/index.md'), 0o400);",
  "const title = 'Auto Ingest ' + sourceId;",
  "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true });",
  "fs.writeFileSync(path.join(cwd, 'curated/sources', sourceId + '.md'), [",
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
  "  'The source supports shared auto-ingest orchestration.',",
  "  '',",
  "].join('\\n'), 'utf8');",
  "fs.writeFileSync(path.join(cwd, 'curated/index.md'), [",
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
  "].join('\\n'), 'utf8');",
  "fs.writeFileSync(path.join(cwd, 'curated/log.md'), [",
  "  '# Log',",
  "  '',",
  "  '## [2026-06-30T09:00:00.000Z] ingest | ' + sourceId + ' | Agent ingest completed',",
  "  '',",
  "  '- actor: codex',",
  "  '- command: \"llm-wiki ingest ' + sourceId + ' --auto\"',",
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
  "].join('\\n'), 'utf8');",
  "",
].join("\n");

const TEST_CAPTURED_AT = "2999-06-30T09:00:00.000Z";
const TEST_TIE_CAPTURED_AT = "2999-06-30T08:00:00.000Z";
const TEST_NOW = "2999-06-30T10:00:00.000Z";

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

async function createExecutable(workspaceDir: string, fileName: string, source: string): Promise<string> {
  const binDir = resolve(workspaceDir, "bin");
  const executablePath = resolve(binDir, fileName);
  await mkdir(binDir, { recursive: true });
  await writeFile(executablePath, source, "utf8");
  await chmod(executablePath, 0o755);

  return executablePath;
}

async function commitWikiBaseline(wikiDir: string): Promise<void> {
  await execFileAsync("git", ["-C", wikiDir, "init"]);
  await execFileAsync("git", ["-C", wikiDir, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", wikiDir, "config", "user.name", "Test User"]);
  await execFileAsync("git", ["-C", wikiDir, "add", "--all"]);
  await execFileAsync("git", ["-C", wikiDir, "commit", "-m", "test baseline"]);
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
      `type: raw_source`,
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

async function readQueueRecord(wikiDir: string, source: SourceFixture): Promise<QueueRecord> {
  return JSON.parse(await readFile(resolve(wikiDir, source.queuePath), "utf8")) as QueueRecord;
}

async function readSourceCardFrontmatter(
  wikiDir: string,
  source: SourceFixture,
): Promise<SourceCardFrontmatter> {
  const content = await readFile(resolve(wikiDir, source.sourceCardPath), "utf8");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(frontmatter).not.toBeNull();

  return parse(frontmatter?.[1] ?? "") as SourceCardFrontmatter;
}

async function readAutoIngestMetadataPair(wikiDir: string, source: SourceFixture): Promise<{
  queue: AutoIngestMetadata | undefined;
  sourceCard: AutoIngestMetadata | undefined;
}> {
  const [queueRecord, sourceCard] = await Promise.all([
    readQueueRecord(wikiDir, source),
    readSourceCardFrontmatter(wikiDir, source),
  ]);

  return {
    queue: queueRecord.auto_ingest,
    sourceCard: sourceCard.auto_ingest,
  };
}

async function transitionBodiesForSource(wikiDir: string, sourceId: string): Promise<string[]> {
  const log = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");
  const parsed = parseLogEntries({ path: "curated/log.md", content: log });
  expect(parsed.issues).toEqual([]);

  return parsed.entries
    .filter((entry) => entry.operation === "ingest" && entry.affectedId === sourceId && entry.title.startsWith("Status changed"))
    .map((entry) => entry.body);
}

async function expectAttemptTransitions(
  wikiDir: string,
  sourceId: string,
  finalStatus: "ingested" | "blocked",
): Promise<void> {
  const bodies = await transitionBodiesForSource(wikiDir, sourceId);

  expect(bodies).toHaveLength(2);
  expect(bodies.filter((body) => body.includes("- status: queued -> ingesting"))).toHaveLength(1);
  expect(bodies.filter((body) => body.includes(`- status: ingesting -> ${finalStatus}`))).toHaveLength(1);
}

async function expectAutoIngestMetadataSynced(
  wikiDir: string,
  source: SourceFixture,
  metadata: AutoIngestMetadata | null,
): Promise<void> {
  const [queueRecord, sourceCard] = await Promise.all([
    readQueueRecord(wikiDir, source),
    readSourceCardFrontmatter(wikiDir, source),
  ]);

  expect(queueRecord.auto_ingest ?? null).toEqual(metadata);
  expect(sourceCard.auto_ingest ?? null).toEqual(metadata);
}

function expectSafeError(error: AutoIngestSourceResult["error"], code: string): void {
  expect(error).toMatchObject({
    code,
    message: expect.any(String),
    path: expect.any(String),
    hint: expect.any(String),
  });
  expect(error?.message).not.toContain("raw content for");
  expect(error?.hint).not.toContain("raw content for");
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await pathExists(path)) {
      return;
    }

    await sleep(25);
  }

  throw new Error(`Timed out waiting for ${path}`);
}

function buildLockObservingAgentSource(firstSourceId: string): string {
  return [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const prompt = fs.readFileSync(0, 'utf8') || process.argv[process.argv.length - 1] || '';",
    "const sourceId = prompt.match(/Source ID: (src_[^\\n]+)/)?.[1];",
    "if (!sourceId) {",
    "  console.error('missing source id');",
    "  process.exit(2);",
    "}",
    "const workspaceDir = path.dirname(path.dirname(process.argv[1]));",
    "const repoRoot = path.join(workspaceDir, 'wiki');",
    `const firstSourceId = ${JSON.stringify(firstSourceId)};`,
    `const lockPath = path.join(repoRoot, ${JSON.stringify(INGEST_LOCK_RELATIVE_PATH)});`,
    "const queueStatus = (id) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'raw/queue', id + '.json'), 'utf8')).status;",
    "const writeObservation = (name, value) => fs.writeFileSync(path.join(workspaceDir, name), JSON.stringify(value, null, 2) + '\\n', 'utf8');",
    "if (sourceId === firstSourceId) {",
    "  writeObservation('first-agent-started.json', {",
    "    lockExists: fs.existsSync(lockPath),",
    "    firstStatus: queueStatus(firstSourceId),",
    "  });",
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);",
    "} else {",
    "  writeObservation('second-agent-started.json', {",
    "    lockExists: fs.existsSync(lockPath),",
    "    firstStatus: queueStatus(firstSourceId),",
    "    secondStatus: queueStatus(sourceId),",
    "  });",
    "}",
    "if (!prompt.includes('Queue status: ingesting')) {",
    "  console.error('prompt was not rebuilt after queued -> ingesting');",
    "  process.exit(3);",
    "}",
    "const cwd = process.cwd();",
    "const title = 'Auto Ingest ' + sourceId;",
    "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true });",
    "fs.writeFileSync(path.join(cwd, 'curated/sources', sourceId + '.md'), [",
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
    "  'The source supports shared auto-ingest orchestration.',",
    "  '',",
    "].join('\\n'), 'utf8');",
    "fs.writeFileSync(path.join(cwd, 'curated/index.md'), [",
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
    "].join('\\n'), 'utf8');",
    "fs.writeFileSync(path.join(cwd, 'curated/log.md'), [",
    "  '# Log',",
    "  '',",
    "  '## [2026-06-30T09:00:00.000Z] ingest | ' + sourceId + ' | Agent ingest completed',",
    "  '',",
    "  '- actor: codex',",
    "  '- command: \"llm-wiki ingest ' + sourceId + ' --auto\"',",
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
    "].join('\\n'), 'utf8');",
    "",
  ].join("\n");
}

describe("shared auto-ingest worker", () => {
  it("returns no source results when there are no eligible queued items", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-zero-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-zero", SUCCESS_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);

      // Act
      const result = await runAutoIngestBatch({
        repoRoot: wikiDir,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result).toMatchObject({
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
      });
    });
  });

  it("processes queued sources oldest first by captured_at then source_id and honors limit", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-order-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-order", SUCCESS_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);
      const newest = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("newest"),
        capturedAt: "2999-06-30T09:00:00.000Z",
      });
      const tieSecond = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("tie_b"),
        capturedAt: TEST_TIE_CAPTURED_AT,
      });
      const tieFirst = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("tie_a"),
        capturedAt: TEST_TIE_CAPTURED_AT,
      });
      const rawBefore = await readFile(resolve(wikiDir, tieFirst.originalPath), "utf8");

      // Act
      const result = await runAutoIngestBatch({
        repoRoot: wikiDir,
        limit: 2,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result.results.map((item) => item.source_id)).toEqual([tieFirst.sourceId, tieSecond.sourceId]);
      expect(result.counts).toMatchObject({ selected: 2, attempted: 2, ingested: 2, blocked: 0 });
      await expect(readQueueRecord(wikiDir, tieFirst)).resolves.toMatchObject({ status: "ingested" });
      await expect(readQueueRecord(wikiDir, tieSecond)).resolves.toMatchObject({ status: "ingested" });
      await expect(readQueueRecord(wikiDir, newest)).resolves.toMatchObject({ status: "queued" });
      expect(await readFile(resolve(wikiDir, tieFirst.originalPath), "utf8")).toBe(rawBefore);
    });
  });

  it("applies batch limit before validating unselected queued sources", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-limit-before-show-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-limit-before-show", SUCCESS_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);
      const selected = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("selected"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const unselected = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("broken_later"),
        capturedAt: "2999-06-30T09:01:00.000Z",
      });
      await rm(resolve(wikiDir, unselected.sourceCardPath), { force: true });

      // Act
      const result = await runAutoIngestBatch({
        repoRoot: wikiDir,
        limit: 1,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result.results.map((item) => item.source_id)).toEqual([selected.sourceId]);
      expect(result.counts).toMatchObject({ selected: 1, attempted: 1, ingested: 1, blocked: 0 });
      await expect(readQueueRecord(wikiDir, selected)).resolves.toMatchObject({ status: "ingested" });
      await expect(readQueueRecord(wikiDir, unselected)).resolves.toMatchObject({ status: "queued" });
      await expect(pathExists(resolve(wikiDir, unselected.sourceCardPath))).resolves.toBe(false);
    });
  });

  it("reports selected invalid queue sources and continues with later valid sources", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-selected-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-selected-invalid", SUCCESS_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);
      const broken = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("broken_selected"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const valid = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("valid_after_broken"),
        capturedAt: "2999-06-30T09:01:00.000Z",
      });
      await rm(resolve(wikiDir, broken.sourceCardPath), { force: true });

      // Act
      const result = await runAutoIngestBatch({
        repoRoot: wikiDir,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result.results.map((item) => item.source_id)).toEqual([broken.sourceId, valid.sourceId]);
      expect(result.results[0]).toMatchObject({
        source_id: broken.sourceId,
        previous_status: "queued",
        final_status: "queued",
        outcome: "skipped",
        attempted: false,
        agent: "codex",
        applied_paths: [],
        auto_ingest: null,
      });
      expectSafeError(result.results[0]?.error ?? null, "QUEUE_SOURCE_CARD_MISSING");
      expect(result.results[1]).toMatchObject({
        source_id: valid.sourceId,
        previous_status: "queued",
        final_status: "ingested",
        outcome: "ingested",
        attempted: true,
      });
      expect(result.counts).toMatchObject({
        selected: 2,
        attempted: 1,
        ingested: 1,
        blocked: 0,
        skipped: 1,
        deferred: 0,
      });
      await expect(readQueueRecord(wikiDir, broken)).resolves.toMatchObject({ status: "queued" });
      await expect(readQueueRecord(wikiDir, valid)).resolves.toMatchObject({ status: "ingested" });
    });
  });

  it.each([
    { status: "ingested" as const, outcome: "skipped" as const },
    { status: "blocked" as const, outcome: "skipped" as const },
    { status: "ingesting" as const, outcome: "deferred" as const },
  ])("does not start targeted $status sources", async ({ status, outcome }) => {
    await withTempWorkspace("llm-wiki-auto-ingest-target-status-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug(`target_${status}`),
        capturedAt: TEST_CAPTURED_AT,
        status,
      });
      const queueBefore = await readFile(resolve(wikiDir, source.queuePath), "utf8");
      const sourceCardBefore = await readFile(resolve(wikiDir, source.sourceCardPath), "utf8");

      // Act
      const result = await runAutoIngestSource({
        repoRoot: wikiDir,
        sourceId: source.sourceId,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result).toMatchObject({
        source_id: source.sourceId,
        previous_status: status,
        final_status: status,
        outcome,
        attempted: false,
        agent: null,
        applied_paths: [],
        auto_ingest: null,
      });
      expect(await readFile(resolve(wikiDir, source.queuePath), "utf8")).toBe(queueBefore);
      expect(await readFile(resolve(wikiDir, source.sourceCardPath), "utf8")).toBe(sourceCardBefore);
    });
  });

  it.each([
    {
      sourceId: sourceIdForSlug("missing"),
      expectedCode: "QUEUE_ITEM_NOT_FOUND",
    },
    {
      sourceId: "not a source id",
      expectedCode: "SOURCE_ID_INVALID",
    },
  ])("reports targeted missing or invalid sources without agent preflight", async ({ sourceId, expectedCode }) => {
    await withTempWorkspace("llm-wiki-auto-ingest-target-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runAutoIngestSource({
        repoRoot: wikiDir,
        sourceId,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result).toMatchObject({
        source_id: sourceId,
        previous_status: null,
        final_status: null,
        outcome: "skipped",
        attempted: false,
        agent: null,
        applied_paths: [],
        auto_ingest: null,
      });
      expectSafeError(result.error, expectedCode);
    });
  });

  it("marks a successful source ingested only after validated apply and synchronizes auto-ingest metadata", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-success-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-success", SUCCESS_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("success"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const rawBefore = await readFile(resolve(wikiDir, source.originalPath), "utf8");

      // Act
      const result = await runAutoIngestSource({
        repoRoot: wikiDir,
        sourceId: source.sourceId,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result).toMatchObject({
        source_id: source.sourceId,
        previous_status: "queued",
        final_status: "ingested",
        outcome: "ingested",
        attempted: true,
        agent: "codex",
        applied_paths: [
          "curated/index.md",
          "curated/log.md",
          `curated/sources/${source.sourceId}.md`,
        ],
        error: null,
      });
      expect(result.auto_ingest).toEqual({
        enabled: true,
        attempt_count: 1,
        last_attempt_at: TEST_NOW,
        last_result: "ingested",
        last_error_code: null,
        last_error_message: null,
      });
      expect(await readQueueRecord(wikiDir, source)).toMatchObject({
        status: "ingested",
        auto_ingest: result.auto_ingest,
      });
      await expect(readSourceCardFrontmatter(wikiDir, source)).resolves.toMatchObject({
        status: "ingested",
        auto_ingest: result.auto_ingest,
      });
      const metadata = await readAutoIngestMetadataPair(wikiDir, source);
      expect(metadata.queue).toEqual(metadata.sourceCard);
      expect(await readFile(resolve(wikiDir, source.originalPath), "utf8")).toBe(rawBefore);
      expect(await pathExists(resolve(wikiDir, `curated/sources/${source.sourceId}.md`))).toBe(true);
      expect(await transitionBodiesForSource(wikiDir, source.sourceId)).toEqual([
        expect.stringContaining("- status: queued -> ingesting"),
        expect.stringContaining("- status: ingesting -> ingested"),
      ]);
    });
  });

  it("isolates Git changed-file validation to each queued auto-ingest attempt", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-git-baseline-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-success", SUCCESS_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);
      await commitWikiBaseline(wikiDir);
      const firstSource = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("gitfirst"),
        capturedAt: TEST_TIE_CAPTURED_AT,
      });
      const secondSource = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("gitsecond"),
        capturedAt: TEST_CAPTURED_AT,
      });

      // Act
      const result = await runAutoIngestBatch({
        repoRoot: wikiDir,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result.counts).toMatchObject({
        selected: 2,
        attempted: 2,
        ingested: 2,
        blocked: 0,
      });
      expect(result.results.map((sourceResult) => sourceResult.source_id)).toEqual([
        firstSource.sourceId,
        secondSource.sourceId,
      ]);
      expect(result.results.map((sourceResult) => sourceResult.outcome)).toEqual(["ingested", "ingested"]);
      await expect(readQueueRecord(wikiDir, firstSource)).resolves.toMatchObject({ status: "ingested" });
      await expect(readQueueRecord(wikiDir, secondSource)).resolves.toMatchObject({ status: "ingested" });
      await expect(pathExists(resolve(wikiDir, `curated/sources/${firstSource.sourceId}.md`))).resolves.toBe(true);
      await expect(pathExists(resolve(wikiDir, `curated/sources/${secondSource.sourceId}.md`))).resolves.toBe(true);
    });
  });

  it("marks agent execution failure blocked once, keeps proposals unapplied, and records safe metadata", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-agent-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-fails", FAILING_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("agentfail"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const before = await readTreeSnapshot(wikiDir, {
        exclude: (path) => path === "curated/log.md" || path === source.queuePath || path === source.sourceCardPath,
      });
      const rawBefore = await readFile(resolve(wikiDir, source.originalPath), "utf8");

      // Act
      const result = await runAutoIngestSource({
        repoRoot: wikiDir,
        sourceId: source.sourceId,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result).toMatchObject({
        source_id: source.sourceId,
        previous_status: "queued",
        final_status: "blocked",
        outcome: "blocked",
        attempted: true,
        agent: "codex",
        applied_paths: [],
      });
      expectSafeError(result.error, "AGENT_COMMAND_FAILED");
      expect(result.auto_ingest).toMatchObject({
        enabled: true,
        attempt_count: 1,
        last_attempt_at: TEST_NOW,
        last_result: "blocked",
        last_error_code: "AGENT_COMMAND_FAILED",
      });
      expect(result.auto_ingest?.last_error_message).toBe(result.error?.message);
      await expect(readQueueRecord(wikiDir, source)).resolves.toMatchObject({
        status: "blocked",
        auto_ingest: result.auto_ingest,
      });
      await expect(readSourceCardFrontmatter(wikiDir, source)).resolves.toMatchObject({
        status: "blocked",
        auto_ingest: result.auto_ingest,
      });
      await expectAutoIngestMetadataSynced(wikiDir, source, result.auto_ingest);
      expect(await readTreeSnapshot(wikiDir, {
        exclude: (path) => path === "curated/log.md" || path === source.queuePath || path === source.sourceCardPath,
      })).toEqual(before);
      expect(await readFile(resolve(wikiDir, source.originalPath), "utf8")).toBe(rawBefore);
      await expectAttemptTransitions(wikiDir, source.sourceId, "blocked");
    });
  });

  it("marks validation failure blocked once with synchronized metadata and without applying invalid Markdown", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-validation-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-invalid", INVALID_PROPOSAL_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("validation"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const indexBefore = await readFile(resolve(wikiDir, "curated/index.md"), "utf8");
      const rawBefore = await readFile(resolve(wikiDir, source.originalPath), "utf8");

      // Act
      const result = await runAutoIngestSource({
        repoRoot: wikiDir,
        sourceId: source.sourceId,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result).toMatchObject({
        source_id: source.sourceId,
        previous_status: "queued",
        final_status: "blocked",
        outcome: "blocked",
        attempted: true,
        agent: "codex",
        applied_paths: [],
      });
      expectSafeError(result.error, "INGEST_VALIDATION_FAILED");
      expect(result.error?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "ingest_index_missing",
            message: expect.stringContaining(source.sourceId),
          }),
          expect.objectContaining({
            code: "ingest_log_entry_missing",
            message: expect.stringContaining(source.sourceId),
          }),
          expect.objectContaining({
            code: "ingest_source_ids_missing",
            message: expect.stringContaining(source.sourceId),
          }),
        ]),
      );
      expect(result.auto_ingest).toMatchObject({
        enabled: true,
        attempt_count: 1,
        last_attempt_at: TEST_NOW,
        last_result: "blocked",
        last_error_code: "INGEST_VALIDATION_FAILED",
        last_error_message: result.error?.message,
      });
      await expect(readQueueRecord(wikiDir, source)).resolves.toMatchObject({
        status: "blocked",
        auto_ingest: result.auto_ingest,
      });
      await expect(readSourceCardFrontmatter(wikiDir, source)).resolves.toMatchObject({
        status: "blocked",
        auto_ingest: result.auto_ingest,
      });
      await expectAutoIngestMetadataSynced(wikiDir, source, result.auto_ingest);
      await expect(pathExists(resolve(wikiDir, `curated/sources/${source.sourceId}.md`))).resolves.toBe(false);
      expect(await readFile(resolve(wikiDir, "curated/index.md"), "utf8")).toBe(indexBefore);
      expect(await readFile(resolve(wikiDir, source.originalPath), "utf8")).toBe(rawBefore);
      await expectAttemptTransitions(wikiDir, source.sourceId, "blocked");
    });
  });

  it.each([
    {
      name: "proposal path rejection",
      agentSource: RAW_REWRITE_AGENT_SOURCE,
      expectedCode: "AGENT_PROPOSAL_REJECTED",
      expectedPath: (source: SourceFixture) => source.originalPath,
    },
    {
      name: "proposal extraction rejection",
      agentSource: DELETE_CURATED_AGENT_SOURCE,
      expectedCode: "AGENT_PROPOSAL_REJECTED",
      expectedPath: () => "curated/home.md",
    },
  ])("converts $name after start into one blocked transition", async (caseInput) => {
    await withTempWorkspace("llm-wiki-auto-ingest-proposal-rejection-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-proposal-rejects", caseInput.agentSource);
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug(`proposal_${caseInput.name.replaceAll(" ", "_")}`),
        capturedAt: TEST_CAPTURED_AT,
      });
      const rawBefore = await readFile(resolve(wikiDir, source.originalPath), "utf8");
      const before = await readTreeSnapshot(wikiDir, {
        exclude: (path) => path === "curated/log.md" || path === source.queuePath || path === source.sourceCardPath,
      });

      // Act
      const result = await runAutoIngestSource({
        repoRoot: wikiDir,
        sourceId: source.sourceId,
        now: () => new Date(TEST_NOW),
      });

      // Assert
      expect(result).toMatchObject({
        source_id: source.sourceId,
        previous_status: "queued",
        final_status: "blocked",
        outcome: "blocked",
        attempted: true,
        agent: "codex",
        applied_paths: [],
      });
      expectSafeError(result.error, caseInput.expectedCode);
      expect(result.error?.path).toBe(caseInput.expectedPath(source));
      expect(result.auto_ingest).toMatchObject({
        enabled: true,
        attempt_count: 1,
        last_attempt_at: TEST_NOW,
        last_result: "blocked",
        last_error_code: caseInput.expectedCode,
        last_error_message: result.error?.message,
      });
      await expect(readQueueRecord(wikiDir, source)).resolves.toMatchObject({
        status: "blocked",
        auto_ingest: result.auto_ingest,
      });
      await expect(readSourceCardFrontmatter(wikiDir, source)).resolves.toMatchObject({
        status: "blocked",
        auto_ingest: result.auto_ingest,
      });
      await expectAutoIngestMetadataSynced(wikiDir, source, result.auto_ingest);
      expect(await readTreeSnapshot(wikiDir, {
        exclude: (path) => path === "curated/log.md" || path === source.queuePath || path === source.sourceCardPath,
      })).toEqual(before);
      expect(await readFile(resolve(wikiDir, source.originalPath), "utf8")).toBe(rawBefore);
      await expect(pathExists(resolve(wikiDir, `curated/sources/${source.sourceId}.md`))).resolves.toBe(false);
      await expectAttemptTransitions(wikiDir, source.sourceId, "blocked");
    });
  });

  it("converts proposal write failure after start into one blocked transition", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-apply-write-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-write-fails", APPLY_WRITE_FAILURE_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("writefail"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const indexPath = resolve(wikiDir, "curated/index.md");
      const indexBefore = await readFile(indexPath, "utf8");
      const rawBefore = await readFile(resolve(wikiDir, source.originalPath), "utf8");

      try {
        // Act
        const result = await runAutoIngestSource({
          repoRoot: wikiDir,
          sourceId: source.sourceId,
          now: () => new Date(TEST_NOW),
        });

        // Assert
        expect(result).toMatchObject({
          source_id: source.sourceId,
          previous_status: "queued",
          final_status: "blocked",
          outcome: "blocked",
          attempted: true,
          agent: "codex",
          applied_paths: [],
        });
        expectSafeError(result.error, "AGENT_PROPOSAL_WRITE_FAILED");
        expect(result.auto_ingest).toMatchObject({
          enabled: true,
          attempt_count: 1,
          last_attempt_at: TEST_NOW,
          last_result: "blocked",
          last_error_code: "AGENT_PROPOSAL_WRITE_FAILED",
          last_error_message: result.error?.message,
        });
        await expect(readQueueRecord(wikiDir, source)).resolves.toMatchObject({
          status: "blocked",
          auto_ingest: result.auto_ingest,
        });
        await expect(readSourceCardFrontmatter(wikiDir, source)).resolves.toMatchObject({
          status: "blocked",
          auto_ingest: result.auto_ingest,
        });
        await expectAutoIngestMetadataSynced(wikiDir, source, result.auto_ingest);
        expect(await readFile(indexPath, "utf8")).toBe(indexBefore);
        expect(await readFile(resolve(wikiDir, source.originalPath), "utf8")).toBe(rawBefore);
        await expect(pathExists(resolve(wikiDir, `curated/sources/${source.sourceId}.md`))).resolves.toBe(false);
        await expectAttemptTransitions(wikiDir, source.sourceId, "blocked");
      } finally {
        await chmod(indexPath, 0o600);
      }
    });
  });

  it("preflights missing default agent before mutating any queued source", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-missing-agent-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8")).replace("agent:\n  default: generic\n", ""),
        "utf8",
      );
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("missingagent"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const queueBefore = await readFile(resolve(wikiDir, source.queuePath), "utf8");
      const sourceCardBefore = await readFile(resolve(wikiDir, source.sourceCardPath), "utf8");
      const logBefore = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      // Act
      await expect(runAutoIngestBatch({
        repoRoot: wikiDir,
        now: () => new Date(TEST_NOW),
      })).rejects.toMatchObject({
        code: "AGENT_CONFIG_MISSING",
        path: ".llm-wiki/config.yml:agent.default",
      });

      // Assert
      expect(await readFile(resolve(wikiDir, source.queuePath), "utf8")).toBe(queueBefore);
      expect(await readFile(resolve(wikiDir, source.sourceCardPath), "utf8")).toBe(sourceCardBefore);
      expect(await readFile(resolve(wikiDir, "curated/log.md"), "utf8")).toBe(logBefore);
    });
  });

  it("preflights unavailable agent command before mutating any queued source", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-unavailable-command-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await configureDefaultAgent(wikiDir, resolve(workspaceDir, "missing-codex"));
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("unavailable"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const queueBefore = await readFile(resolve(wikiDir, source.queuePath), "utf8");
      const sourceCardBefore = await readFile(resolve(wikiDir, source.sourceCardPath), "utf8");
      const logBefore = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      // Act
      await expect(runAutoIngestBatch({
        repoRoot: wikiDir,
        now: () => new Date(TEST_NOW),
      })).rejects.toMatchObject({
        code: "AGENT_COMMAND_UNAVAILABLE",
      });

      // Assert
      expect(await readFile(resolve(wikiDir, source.queuePath), "utf8")).toBe(queueBefore);
      expect(await readFile(resolve(wikiDir, source.sourceCardPath), "utf8")).toBe(sourceCardBefore);
      expect(await readFile(resolve(wikiDir, "curated/log.md"), "utf8")).toBe(logBefore);
    });
  });

  it("holds the repo ingest lock while the agent runs and through the final status transition", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-lock-held-through-final-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const first = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("lock_first"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const second = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("lock_second"),
        capturedAt: "2999-06-30T09:01:00.000Z",
      });
      const executablePath = await createExecutable(
        workspaceDir,
        "codex-lock-observer",
        buildLockObservingAgentSource(first.sourceId),
      );
      await configureDefaultAgent(wikiDir, executablePath);
      const firstRawBefore = await readFile(resolve(wikiDir, first.originalPath), "utf8");
      const secondRawBefore = await readFile(resolve(wikiDir, second.originalPath), "utf8");
      const firstObservationPath = resolve(workspaceDir, "first-agent-started.json");
      const secondObservationPath = resolve(workspaceDir, "second-agent-started.json");

      // Act
      const firstResultPromise = runAutoIngestSource({
        repoRoot: wikiDir,
        sourceId: first.sourceId,
        now: () => new Date(TEST_NOW),
      });
      await waitForFile(firstObservationPath);
      const firstObservation = JSON.parse(await readFile(firstObservationPath, "utf8")) as {
        lockExists: boolean;
        firstStatus: QueueStatus;
      };
      const secondResultPromise = runAutoIngestSource({
        repoRoot: wikiDir,
        sourceId: second.sourceId,
        now: () => new Date(TEST_NOW),
        lock: { timeoutMs: 2_000, retryDelayMs: 25 },
      });
      const [firstResult, secondResult] = await Promise.all([firstResultPromise, secondResultPromise]);
      const secondObservation = JSON.parse(await readFile(secondObservationPath, "utf8")) as {
        lockExists: boolean;
        firstStatus: QueueStatus;
        secondStatus: QueueStatus;
      };

      // Assert
      expect(firstObservation).toEqual({
        lockExists: true,
        firstStatus: "ingesting",
      });
      expect(secondObservation).toEqual({
        lockExists: true,
        firstStatus: "ingested",
        secondStatus: "ingesting",
      });
      expect(firstResult).toMatchObject({
        source_id: first.sourceId,
        final_status: "ingested",
        outcome: "ingested",
        attempted: true,
      });
      expect(secondResult).toMatchObject({
        source_id: second.sourceId,
        final_status: "ingested",
        outcome: "ingested",
        attempted: true,
      });
      await expect(readQueueRecord(wikiDir, first)).resolves.toMatchObject({ status: "ingested" });
      await expect(readQueueRecord(wikiDir, second)).resolves.toMatchObject({ status: "ingested" });
      expect(await readFile(resolve(wikiDir, first.originalPath), "utf8")).toBe(firstRawBefore);
      expect(await readFile(resolve(wikiDir, second.originalPath), "utf8")).toBe(secondRawBefore);
      await expectAttemptTransitions(wikiDir, first.sourceId, "ingested");
      await expectAttemptTransitions(wikiDir, second.sourceId, "ingested");
    });
  });

  it("reloads queue and source-card state after acquiring a contended lock before mutating", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-post-lock-reload-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-stale-must-not-run", FAILING_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("stale_reload"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const rawBefore = await readFile(resolve(wikiDir, source.originalPath), "utf8");
      await mkdir(resolve(wikiDir, INGEST_LOCK_RELATIVE_PATH), { recursive: true });

      // Act
      const resultPromise = runAutoIngestBatch({
        repoRoot: wikiDir,
        limit: 1,
        now: () => new Date(TEST_NOW),
        lock: { timeoutMs: 2_000, retryDelayMs: 25 },
      });
      await sleep(75);
      const started = await transitionQueueStatus(wikiDir, source.sourceId, "ingesting", {
        now: new Date("2999-06-30T09:30:00.000Z"),
        command: "external worker",
        autoIngest: {
          enabled: true,
          result: "ingesting",
          errorCode: null,
          errorMessage: null,
        },
      });
      expect(started.ok).toBe(true);
      const completed = await transitionQueueStatus(wikiDir, source.sourceId, "ingested", {
        now: new Date("2999-06-30T09:31:00.000Z"),
        command: "external worker",
        autoIngest: {
          enabled: true,
          result: "ingested",
          errorCode: null,
          errorMessage: null,
        },
      });
      expect(completed.ok).toBe(true);
      await rm(resolve(wikiDir, INGEST_LOCK_RELATIVE_PATH), { recursive: true, force: true });
      const result = await resultPromise;

      // Assert
      const metadata = (await readQueueRecord(wikiDir, source)).auto_ingest ?? null;
      expect(result).toMatchObject({
        agent: "codex",
        counts: {
          selected: 1,
          attempted: 0,
          ingested: 0,
          blocked: 0,
          skipped: 1,
          deferred: 0,
        },
        results: [
          {
            source_id: source.sourceId,
            previous_status: "ingested",
            final_status: "ingested",
            outcome: "skipped",
            attempted: false,
            agent: "codex",
            applied_paths: [],
            auto_ingest: metadata,
          },
        ],
      });
      await expect(readSourceCardFrontmatter(wikiDir, source)).resolves.toMatchObject({
        status: "ingested",
        auto_ingest: metadata,
      });
      await expectAutoIngestMetadataSynced(wikiDir, source, metadata);
      expect(await readFile(resolve(wikiDir, source.originalPath), "utf8")).toBe(rawBefore);
      expect(await transitionBodiesForSource(wikiDir, source.sourceId)).toEqual([
        expect.stringContaining("- status: queued -> ingesting"),
        expect.stringContaining("- status: ingesting -> ingested"),
      ]);
    });
  });

  it("defers queued work when the repo ingest lock is busy", async () => {
    await withTempWorkspace("llm-wiki-auto-ingest-lock-busy-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "codex-lock", SUCCESS_AGENT_SOURCE);
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("lock"),
        capturedAt: TEST_CAPTURED_AT,
      });
      await mkdir(resolve(wikiDir, INGEST_LOCK_RELATIVE_PATH), { recursive: true });
      const queueBefore = await readFile(resolve(wikiDir, source.queuePath), "utf8");
      const sourceCardBefore = await readFile(resolve(wikiDir, source.sourceCardPath), "utf8");

      // Act
      const result = await runAutoIngestBatch({
        repoRoot: wikiDir,
        now: () => new Date(TEST_NOW),
        lock: { timeoutMs: 0, retryDelayMs: 0 },
      });

      // Assert
      expect(result.results).toEqual([
        expect.objectContaining({
          source_id: source.sourceId,
          previous_status: "queued",
          final_status: "queued",
          outcome: "deferred",
          attempted: false,
          agent: "codex",
          applied_paths: [],
          auto_ingest: null,
        }),
      ]);
      expectSafeError(result.results[0]?.error ?? null, "INGEST_LOCK_BUSY");
      expect(await readFile(resolve(wikiDir, source.queuePath), "utf8")).toBe(queueBefore);
      expect(await readFile(resolve(wikiDir, source.sourceCardPath), "utf8")).toBe(sourceCardBefore);
    });
  });
});
