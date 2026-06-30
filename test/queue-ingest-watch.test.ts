import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  runAutoIngestWatch,
  type AutoIngestWatchEvent,
} from "../src/autoIngest/index.js";
import { runCli } from "../src/cli.js";
import { INGEST_LOCK_RELATIVE_PATH } from "../src/runtime/ingestLock.js";
import { createWiki } from "../src/scaffold/createWiki.js";
import { pathExists, withTempWorkspace } from "./helpers/init.js";

type QueueStatus = "queued" | "ingesting" | "ingested" | "blocked";

type SourceFixture = {
  sourceId: string;
  queuePath: string;
  sourceCardPath: string;
  originalPath: string;
};

type QueueRecord = {
  source_id: string;
  status: QueueStatus;
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
    capturedAt: string;
    status?: QueueStatus;
  },
): Promise<SourceFixture> {
  const status = input.status ?? "queued";
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
      `title: ${JSON.stringify(input.sourceId)}`,
      "source_kind: text",
      "origin: test",
      "origin_url:",
      `captured_at: ${input.capturedAt}`,
      `content_hash: ${contentHash}`,
      `status: ${status}`,
      "visibility: private",
      "---",
      "",
      `# ${input.sourceId}`,
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
        title: input.sourceId,
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
    queuePath,
    sourceCardPath,
    originalPath,
  };
}

async function readQueueRecord(wikiDir: string, source: SourceFixture): Promise<QueueRecord> {
  return JSON.parse(await readFile(resolve(wikiDir, source.queuePath), "utf8")) as QueueRecord;
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

function successAgentSource(): string {
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
    "const title = 'Queue Watch ' + sourceId;",
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
    "  'The source supports queue watch auto-ingest orchestration.',",
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
    "  '## [2999-06-30T09:00:00.000Z] ingest | ' + sourceId + ' | Agent ingest completed',",
    "  '',",
    "  '- actor: codex',",
    "  '- command: \"llm-wiki queue ingest --auto --watch\"',",
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

function failingAgentSource(): string {
  return [
    `#!${process.execPath}`,
    "console.error('intentional watch failure');",
    "process.exit(7);",
    "",
  ].join("\n");
}

function blockingAgentSource(workspaceDir: string): string {
  return [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const workspaceDir = ${JSON.stringify(workspaceDir)};`,
    "const startedPath = path.join(workspaceDir, 'agent-started');",
    "const releasePath = path.join(workspaceDir, 'agent-release');",
    "fs.writeFileSync(startedPath, 'started\\n', 'utf8');",
    "while (!fs.existsSync(releasePath)) {",
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);",
    "}",
    ...successAgentSource().split("\n").slice(3),
  ].join("\n");
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
): Promise<T> {
  let latest: T;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    latest = await read();
    if (predicate(latest)) {
      return latest;
    }

    await sleep(25);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function parseJsonLines(stdout: string[]): Array<Record<string, unknown>> {
  return stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("queue ingest watch mode", () => {
  it("discovers queued sources added after an initially empty poll and processes them oldest first", async () => {
    await withTempWorkspace("llm-wiki-queue-watch-discovery-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const controller = new AbortController();
      const events: AutoIngestWatchEvent[] = [];
      let preflightCount = 0;
      let releasePreflight: (() => void) | undefined;
      const preflightCompleted = new Promise<void>((resolvePreflight) => {
        releasePreflight = resolvePreflight;
      });
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-watch-discovery", successAgentSource());
      await configureDefaultAgent(wikiDir, executablePath);

      // Act
      const watch = runAutoIngestWatch({
        repoRoot: wikiDir,
        pollIntervalMs: 250,
        signal: controller.signal,
        onPreflightComplete: async () => {
          preflightCount += 1;
          await removeDefaultAgent(wikiDir);
          releasePreflight?.();
        },
        onEvent: async (event) => {
          events.push(event);
          if (event.event === "result" && event.result.source_id === sourceIdForSlug("watch_newer")) {
            controller.abort();
          }
        },
      });
      await preflightCompleted;
      await sleep(75);
      const older = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("watch_older"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const newer = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("watch_newer"),
        capturedAt: TEST_LATER_CAPTURED_AT,
      });
      const summary = await watch;

      // Assert
      const resultEvents = events.filter((event): event is Extract<AutoIngestWatchEvent, { event: "result" }> =>
        event.event === "result"
      );
      expect(summary.exit_code).toBe(0);
      expect(preflightCount).toBe(1);
      expect(resultEvents.map((event) => event.result.source_id)).toEqual([
        older.sourceId,
        newer.sourceId,
      ]);
      expect(summary.counts).toMatchObject({
        selected: 2,
        attempted: 2,
        ingested: 2,
        blocked: 0,
        deferred: 0,
      });
      await expect(readQueueRecord(wikiDir, older)).resolves.toMatchObject({ status: "ingested" });
      await expect(readQueueRecord(wikiDir, newer)).resolves.toMatchObject({ status: "ingested" });
    });
  });

  it("handles SIGTERM by finishing the current ingest and stopping further discovery", async () => {
    await withTempWorkspace("llm-wiki-queue-watch-sigterm-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const beforeSigint = new Set(process.listeners("SIGINT"));
      const beforeSigterm = new Set(process.listeners("SIGTERM"));
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-watch-sigterm", blockingAgentSource(workspaceDir));
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("watch_sigterm"),
        capturedAt: TEST_CAPTURED_AT,
      });
      const nextSource = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("watch_sigterm_next"),
        capturedAt: TEST_LATER_CAPTURED_AT,
      });

      try {
        // Act
        const run = runCli(["queue", "ingest", "--auto", "--watch", "--repo", wikiDir], {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
          stdin: async () => "",
        });
        await waitFor(
          () => pathExists(resolve(workspaceDir, "agent-started")),
          (exists) => exists,
          "blocking agent to start",
        );
        const sigtermListeners = process.listeners("SIGTERM").filter((listener) => !beforeSigterm.has(listener));
        expect(sigtermListeners).toHaveLength(1);
        sigtermListeners[0]("SIGTERM");
        await sleep(75);
        const preReleaseState = await Promise.race([
          run.then(() => "resolved" as const),
          sleep(50).then(() => "pending" as const),
        ]);
        await writeFile(resolve(workspaceDir, "agent-release"), "release\n", "utf8");
        const exitCode = await run;
        const output = stdout.join("\n");

        // Assert
        expect(preReleaseState).toBe("pending");
        expect(exitCode).toBe(0);
        expect(stderr).toEqual([]);
        expect(output).toContain("Queue auto-ingest watch result");
        expect(output).toContain(`${source.sourceId} | ingested | attempted`);
        expect(output).not.toContain(nextSource.sourceId);
        expect(output).toContain("Queue auto-ingest watch summary");
        expect(output).toContain("Counts: ingested 1, blocked 0, skipped 0, deferred 0");
        expect(output).toContain("Interrupted: yes");
        await expect(readQueueRecord(wikiDir, source)).resolves.toMatchObject({ status: "ingested" });
        await expect(readQueueRecord(wikiDir, nextSource)).resolves.toMatchObject({ status: "queued" });
        expect(process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener))).toEqual([]);
        expect(process.listeners("SIGTERM").filter((listener) => !beforeSigterm.has(listener))).toEqual([]);
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

  it("emits NDJSON result and summary events for JSON watch mode", async () => {
    await withTempWorkspace("llm-wiki-queue-watch-json-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const beforeSigint = new Set(process.listeners("SIGINT"));
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-watch-json", successAgentSource());
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("watch_json"),
        capturedAt: TEST_CAPTURED_AT,
      });

      try {
        // Act
        const exitCode = await runCli(["queue", "ingest", "--auto", "--watch", "--repo", wikiDir, "--json"], {
          stdout: (message) => {
            stdout.push(message);
            const payload = JSON.parse(message) as { event?: string };
            if (payload.event === "result") {
              const sigintListeners = process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener));
              expect(sigintListeners).toHaveLength(1);
              sigintListeners[0]("SIGINT");
            }
          },
          stderr: (message) => stderr.push(message),
          stdin: async () => "",
        });
        const events = parseJsonLines(stdout);

        // Assert
        expect(exitCode).toBe(0);
        expect(stderr).toEqual([]);
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
          event: "result",
          command: "queue ingest",
          repo: wikiDir,
          result: {
            source_id: source.sourceId,
            outcome: "ingested",
          },
        });
        expect(events[1]).toMatchObject({
          event: "summary",
          ok: true,
          command: "queue ingest",
          repo: wikiDir,
          summary: {
            exit_code: 0,
            counts: {
              ingested: 1,
              blocked: 0,
              deferred: 0,
            },
          },
        });
      } finally {
        for (const listener of process.listeners("SIGINT")) {
          if (!beforeSigint.has(listener)) {
            process.off("SIGINT", listener);
          }
        }
      }
    });
  });

  it("emits a blocked JSON result and exits 1 when a watched source fails ingest", async () => {
    await withTempWorkspace("llm-wiki-queue-watch-json-blocked-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const beforeSigint = new Set(process.listeners("SIGINT"));
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-watch-json-blocked", failingAgentSource());
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("watch_json_blocked"),
        capturedAt: TEST_CAPTURED_AT,
      });

      try {
        // Act
        const exitCode = await runCli(["queue", "ingest", "--auto", "--watch", "--repo", wikiDir, "--json"], {
          stdout: (message) => {
            stdout.push(message);
            const payload = JSON.parse(message) as { event?: string };
            if (payload.event === "result") {
              const sigintListeners = process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener));
              expect(sigintListeners).toHaveLength(1);
              sigintListeners[0]("SIGINT");
            }
          },
          stderr: (message) => stderr.push(message),
          stdin: async () => "",
        });
        const events = parseJsonLines(stdout);

        // Assert
        expect(exitCode).toBe(1);
        expect(stderr).toEqual([]);
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
          event: "result",
          command: "queue ingest",
          repo: wikiDir,
          result: {
            source_id: source.sourceId,
            outcome: "blocked",
            attempted: true,
            final_status: "blocked",
            error: {
              code: "AGENT_COMMAND_FAILED",
            },
          },
          counts: {
            selected: 1,
            attempted: 1,
            ingested: 0,
            blocked: 1,
            deferred: 0,
          },
        });
        expect(events[1]).toMatchObject({
          event: "summary",
          ok: false,
          command: "queue ingest",
          repo: wikiDir,
          summary: {
            exit_code: 1,
            failure_count: 1,
            counts: {
              selected: 1,
              attempted: 1,
              ingested: 0,
              blocked: 1,
              deferred: 0,
            },
          },
        });
        await expect(readQueueRecord(wikiDir, source)).resolves.toMatchObject({ status: "blocked" });
      } finally {
        for (const listener of process.listeners("SIGINT")) {
          if (!beforeSigint.has(listener)) {
            process.off("SIGINT", listener);
          }
        }
      }
    });
  });

  it("exits 1 on a watch preflight error before mutating queued work", async () => {
    await withTempWorkspace("llm-wiki-queue-watch-preflight-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      await initializeWiki(wikiDir);
      await removeDefaultAgent(wikiDir);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("watch_preflight"),
        capturedAt: TEST_CAPTURED_AT,
      });

      // Act
      const exitCode = await runCli(["queue", "ingest", "--auto", "--watch", "--repo", wikiDir, "--json"], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      const events = parseJsonLines(stdout);

      // Assert
      expect(exitCode).toBe(1);
      expect(stderr).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: "summary",
        ok: false,
        command: "queue ingest",
        repo: wikiDir,
        error: {
          code: "AGENT_CONFIG_MISSING",
        },
        summary: {
          agent: null,
          exit_code: 1,
          failure_count: 1,
          counts: {
            selected: 0,
            attempted: 0,
          },
        },
      });
      await expect(readQueueRecord(wikiDir, source)).resolves.toMatchObject({ status: "queued" });
    });
  });

  it("exits 1 when a watched source is deferred by the ingest lock", async () => {
    await withTempWorkspace("llm-wiki-queue-watch-lock-deferred-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const beforeSigint = new Set(process.listeners("SIGINT"));
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "agent-watch-lock", successAgentSource());
      await configureDefaultAgent(wikiDir, executablePath);
      const source = await writeSourceFixture(wikiDir, {
        sourceId: sourceIdForSlug("watch_lock"),
        capturedAt: TEST_CAPTURED_AT,
      });
      await mkdir(resolve(wikiDir, INGEST_LOCK_RELATIVE_PATH), { recursive: true });

      try {
        // Act
        const exitCode = await runCli(["queue", "ingest", "--auto", "--watch", "--repo", wikiDir, "--json"], {
          stdout: (message) => {
            stdout.push(message);
            const payload = JSON.parse(message) as { event?: string };
            if (payload.event === "result") {
              const sigintListeners = process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener));
              expect(sigintListeners).toHaveLength(1);
              sigintListeners[0]("SIGINT");
            }
          },
          stderr: (message) => stderr.push(message),
          stdin: async () => "",
        });
        const events = parseJsonLines(stdout);

        // Assert
        expect(exitCode).toBe(1);
        expect(stderr).toEqual([]);
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
          event: "result",
          result: {
            source_id: source.sourceId,
            outcome: "deferred",
            error: {
              code: "INGEST_LOCK_BUSY",
            },
          },
        });
        expect(events[1]).toMatchObject({
          event: "summary",
          ok: false,
          summary: {
            exit_code: 1,
            failure_count: 1,
            counts: {
              selected: 1,
              attempted: 0,
              deferred: 1,
            },
          },
        });
        await expect(readQueueRecord(wikiDir, source)).resolves.toMatchObject({ status: "queued" });
      } finally {
        for (const listener of process.listeners("SIGINT")) {
          if (!beforeSigint.has(listener)) {
            process.off("SIGINT", listener);
          }
        }
      }
    });
  });
});
