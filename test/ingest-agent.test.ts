import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseInitJson,
  pathExists,
  readTreeSnapshot,
  runCliBuffered,
  withTempWorkspace,
} from "./helpers/init.js";

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

type SourceCaptureData = {
  status: "added" | "duplicate";
  source: {
    source_id: string;
    title: string;
    source_kind: "file" | "text" | "url";
    visibility: "private";
    queue_status: "queued";
    original_path: string;
    source_card_path: string;
    queue_path: string;
  };
};

type QueueShowData = {
  queue_record: {
    source_id: string;
    status: "queued" | "ingesting" | "ingested" | "blocked";
  };
  source_card: {
    frontmatter: {
      status: "queued" | "ingesting" | "ingested" | "blocked";
    };
  };
};

type IngestAgentData = {
  mode: "agent";
  agent: string;
  source: {
    source_id: string;
    status: "ingested";
  };
  applied_paths: string[];
  validation: {
    passed: true;
    issues: [];
  };
  queue: {
    previous_status: "ingesting";
    status: "ingested";
  };
};

const originalAgentPromptLog = process.env.LLM_WIKI_AGENT_PROMPT_LOG;

afterEach(() => {
  if (originalAgentPromptLog === undefined) {
    delete process.env.LLM_WIKI_AGENT_PROMPT_LOG;
  } else {
    process.env.LLM_WIKI_AGENT_PROMPT_LOG = originalAgentPromptLog;
  }
});

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function captureTextSource(wikiDir: string): Promise<SourceCaptureData["source"]> {
  const result = await runCliBuffered([
    "add-text",
    "--repo",
    wikiDir,
    "--title",
    "Agent Research Note",
    "--text",
    "agent evidence about validated ingest automation",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(payload.data.status).toBe("added");

  return payload.data.source;
}

async function configureCodexAgent(
  wikiDir: string,
  input: { command: string; defaultAgent?: "generic" | "codex"; timeoutSeconds?: number },
): Promise<void> {
  const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
  const config = await readFile(configPath, "utf8");
  const baseConfig = input.defaultAgent === "codex"
    ? config.replace("default: generic", "default: codex")
    : config;
  await writeFile(
    configPath,
    [
      baseConfig.trimEnd(),
      "agents:",
      "  codex:",
      "    type: local-exec",
      `    command: ${JSON.stringify(input.command)}`,
      "    args:",
      "      - exec",
      `    timeout_seconds: ${input.timeoutSeconds ?? 900}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function createFakeCodex(workspaceDir: string, source: string): Promise<string> {
  const binDir = resolve(workspaceDir, "fake-codex-bin");
  const executablePath = resolve(binDir, "codex");
  await mkdir(binDir, { recursive: true });
  await writeFile(executablePath, source, "utf8");
  await chmod(executablePath, 0o755);

  return executablePath;
}

async function createFakeCodexInBin(binDir: string, source: string): Promise<string> {
  await mkdir(binDir, { recursive: true });

  if (process.platform === "win32") {
    const scriptPath = resolve(binDir, "codex.js");
    const executablePath = resolve(binDir, "codex.cmd");
    await writeFile(scriptPath, source, "utf8");
    await writeFile(executablePath, `@echo off\r\n"${process.execPath}" "%~dp0codex.js" %*\r\n`, "utf8");
    await chmod(executablePath, 0o755);

    return executablePath;
  }

  const executablePath = resolve(binDir, "codex");
  await writeFile(executablePath, source, "utf8");
  await chmod(executablePath, 0o755);

  return executablePath;
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

function ingestSummaryContent(source: SourceCaptureData["source"]): string {
  return [
    "---",
    "type: source_summary",
    `title: ${JSON.stringify(`${source.title} Summary`)}`,
    "visibility: private",
    "source_ids:",
    `  - ${source.source_id}`,
    `source_id: ${source.source_id}`,
    "---",
    "",
    `# ${source.title} Summary`,
    "",
    "The source supports local agent ingest automation.",
    "",
  ].join("\n");
}

function ingestIndexContent(source: SourceCaptureData["source"]): string {
  return [
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
    "",
  ].join("\n");
}

function ingestLogContent(source: SourceCaptureData["source"]): string {
  return [
    "# Log",
    "",
    `## [2026-06-23T08:00:00.000Z] ingest | ${source.source_id} | Codex ingest completed`,
    "",
    "- actor: codex",
    `- command: "llm-wiki ingest ${source.source_id} --agent codex"`,
    "- git_branch:",
    "- git_commit:",
    `- raw_source: ${source.source_card_path}`,
    "- created:",
    `  - curated/sources/${source.source_id}.md`,
    "- updated:",
    "  - curated/index.md",
    "- contradictions:",
    "- follow_ups:",
    "",
  ].join("\n");
}

function successfulCodexSource(source: SourceCaptureData["source"]): string {
  return [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const cwd = process.cwd();",
    "const prompt = fs.readFileSync(0, 'utf8');",
    "fs.writeFileSync(process.env.LLM_WIKI_AGENT_PROMPT_LOG, prompt, 'utf8');",
    `if (!prompt.includes(${JSON.stringify(`Source ID: ${source.source_id}`)})) {`,
    "  console.error('missing source id in prompt');",
    "  process.exit(2);",
    "}",
    "if (!prompt.includes('Queue status: ingesting')) {",
    "  console.error('agent prompt was not rebuilt after queue start');",
    "  process.exit(3);",
    "}",
    `if (prompt.includes(${JSON.stringify(`llm-wiki ingest ${source.source_id} --validate`)})) {`,
    "  console.error('agent prompt includes self-rejecting validation command');",
    "  process.exit(4);",
    "}",
    "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true });",
    `fs.writeFileSync(path.join(cwd, ${JSON.stringify(`curated/sources/${source.source_id}.md`)}), ${JSON.stringify(ingestSummaryContent(source))}, 'utf8');`,
    `fs.writeFileSync(path.join(cwd, 'curated/index.md'), ${JSON.stringify(ingestIndexContent(source))}, 'utf8');`,
    `fs.writeFileSync(path.join(cwd, 'curated/log.md'), ${JSON.stringify(ingestLogContent(source))}, 'utf8');`,
    "process.exit(0);",
    "",
  ].join("\n");
}

describe("ingest local agent automation", () => {
  it("keeps the extracted local agent core independent from queue and runtime log ownership", async () => {
    // Arrange
    const corePath = resolve(process.cwd(), "src/ingest/localAgentCore.ts");
    const forbiddenCalls = [
      "setQueueStatus",
      "ensureIngesting",
      "markBlockedIfIngesting",
      "validateAndCompleteIngest",
    ];

    // Act
    const coreSource = await readFile(corePath, "utf8");

    // Assert
    expect(coreSource).toContain("runLocalAgentIngestCore");
    expect(coreSource).not.toMatch(/from ["']\.\.\/runtime\/(?:queue|log)\.js["']/);
    for (const forbiddenCall of forbiddenCalls) {
      expect(coreSource).not.toMatch(new RegExp(`\\b${forbiddenCall}\\b`));
    }
  });

  it("rejects --create-branch with local agent ingest before queue changes", async () => {
    await withTempWorkspace("llm-wiki-ingest-agent-create-branch-conflict-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await mkdir(resolve(wikiDir, ".git"));

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--agent",
        "codex",
        "--create-branch",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error).toMatchObject({
        code: "INGEST_MODE_CONFLICT",
        message: "Local agent ingest cannot be combined with --create-branch.",
      });
      expect(payload.issues[0]).toMatchObject({
        code: "INGEST_MODE_CONFLICT",
        path: "--create-branch",
      });
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("runs Codex in a temp workspace, validates proposals, applies curated Markdown, and marks the source ingested", async () => {
    await withTempWorkspace("llm-wiki-ingest-agent-success-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const promptLogPath = resolve(workspaceDir, "agent-prompt.md");
      process.env.LLM_WIKI_AGENT_PROMPT_LOG = promptLogPath;
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const executablePath = await createFakeCodex(workspaceDir, successfulCodexSource(source));
      await configureCodexAgent(wikiDir, { command: executablePath });
      const rawOriginalBefore = await readFile(resolve(wikiDir, source.original_path), "utf8");
      const runtimeLogBefore = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonSuccess<"ingest", IngestAgentData>(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
      const prompt = await readFile(promptLogPath, "utf8");
      const runtimeLogAfter = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        mode: "agent",
        agent: "codex",
        source: {
          source_id: source.source_id,
          status: "ingested",
        },
        validation: {
          passed: true,
          issues: [],
        },
        queue: {
          previous_status: "ingesting",
          status: "ingested",
        },
      });
      expect(payload.data.applied_paths).toEqual([
        "curated/index.md",
        "curated/log.md",
        `curated/sources/${source.source_id}.md`,
      ]);
      expect(prompt).toContain(`Source ID: ${source.source_id}`);
      expect(prompt).toContain("Queue status: ingesting");
      expect(prompt).toContain("Do not run llm-wiki validation or queue commands");
      expect(prompt).not.toContain(`llm-wiki ingest ${source.source_id} --validate`);
      expect(await readFile(resolve(wikiDir, `curated/sources/${source.source_id}.md`), "utf8")).toBe(
        ingestSummaryContent(source),
      );
      expect(await readFile(resolve(wikiDir, "curated/index.md"), "utf8")).toBe(ingestIndexContent(source));
      expect(runtimeLogAfter.startsWith(runtimeLogBefore)).toBe(true);
      expect(runtimeLogAfter).toContain(`ingest | ${source.source_id} | Codex ingest completed`);
      expect(queuePayload.data.queue_record.status).toBe("ingested");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("ingested");
      expect(await readFile(resolve(wikiDir, source.original_path), "utf8")).toBe(rawOriginalBefore);
    });
  });

  it("--auto uses agent.default and --quiet suppresses human success output", async () => {
    await withTempWorkspace("llm-wiki-ingest-agent-auto-quiet-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const promptLogPath = resolve(workspaceDir, "auto-prompt.md");
      process.env.LLM_WIKI_AGENT_PROMPT_LOG = promptLogPath;
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const executablePath = await createFakeCodex(workspaceDir, successfulCodexSource(source));
      await configureCodexAgent(wikiDir, {
        command: executablePath,
        defaultAgent: "codex",
      });

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--auto",
        "--quiet",
      ]);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toEqual([]);
      expect(queuePayload.data.queue_record.status).toBe("ingested");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("ingested");
    });
  });

  it("runs after preflight when PATH contains a repo-relative entry excluded from the temp workspace", async () => {
    await withTempWorkspace("llm-wiki-ingest-agent-relative-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const runDir = resolve(workspaceDir, "outside");
      const promptLogPath = resolve(workspaceDir, "relative-path-prompt.md");
      process.env.LLM_WIKI_AGENT_PROMPT_LOG = promptLogPath;
      await initializeWiki(wikiDir);
      await mkdir(runDir);
      const source = await captureTextSource(wikiDir);
      await createFakeCodexInBin(resolve(wikiDir, "node_modules/.bin"), successfulCodexSource(source));
      await configureCodexAgent(wikiDir, { command: "codex" });

      const oldCwd = process.cwd();
      const oldPath = process.env.PATH;
      try {
        process.chdir(runDir);
        process.env.PATH = "node_modules/.bin";

        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--agent",
          "codex",
          "--json",
        ]);
        const payload = parseJsonSuccess<"ingest", IngestAgentData>(result.stdout);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.source.status).toBe("ingested");
      } finally {
        process.chdir(oldCwd);
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
      }
    });
  });

  it("blocks the queue and leaves curated proposals unapplied when Codex exits non-zero", async () => {
    await withTempWorkspace("llm-wiki-ingest-agent-nonzero-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const executablePath = await createFakeCodex(
        workspaceDir,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const cwd = process.cwd();",
          "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true });",
          `fs.writeFileSync(path.join(cwd, ${JSON.stringify(`curated/sources/${source.source_id}.md`)}), ${JSON.stringify(ingestSummaryContent(source))}, 'utf8');`,
          "console.error('codex failed after editing the temp workspace');",
          "process.exit(7);",
          "",
        ].join("\n"),
      );
      await configureCodexAgent(wikiDir, { command: executablePath });

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("AGENT_COMMAND_FAILED");
      expect(payload.error.message).toContain("exit code 7");
      expect(payload.error.message).toContain("changes observed: true");
      expect(queuePayload.data.queue_record.status).toBe("blocked");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("blocked");
      await expect(pathExists(resolve(wikiDir, `curated/sources/${source.source_id}.md`))).resolves.toBe(false);
    });
  });

  it("blocks the queue and leaves proposals unapplied when Codex times out", async () => {
    await withTempWorkspace("llm-wiki-ingest-agent-timeout-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const executablePath = await createFakeCodex(
        workspaceDir,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const cwd = process.cwd();",
          "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true });",
          `fs.writeFileSync(path.join(cwd, ${JSON.stringify(`curated/sources/${source.source_id}.md`)}), ${JSON.stringify(ingestSummaryContent(source))}, 'utf8');`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      await configureCodexAgent(wikiDir, {
        command: executablePath,
        timeoutSeconds: 1,
      });

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("AGENT_COMMAND_TIMEOUT");
      expect(payload.error.message).toContain("timed out");
      expect(queuePayload.data.queue_record.status).toBe("blocked");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("blocked");
      await expect(pathExists(resolve(wikiDir, `curated/sources/${source.source_id}.md`))).resolves.toBe(false);
    });
  });

  it.each([
    {
      name: "raw original edits",
      expectedCode: "AGENT_PROPOSAL_REJECTED",
      buildScript: (source: SourceCaptureData["source"]) => [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        `fs.writeFileSync(path.join(process.cwd(), ${JSON.stringify(source.original_path)}), 'rewritten raw evidence\\n', 'utf8');`,
        "",
      ].join("\n"),
      expectedPath: (source: SourceCaptureData["source"]) => source.original_path,
      expectedMessage: "Agent proposal path is not allowed",
    },
    {
      name: "non-Markdown curated files",
      expectedCode: "AGENT_PROPOSAL_REJECTED",
      buildScript: () => [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "fs.mkdirSync(path.join(process.cwd(), 'curated/assets'), { recursive: true });",
        "fs.writeFileSync(path.join(process.cwd(), 'curated/assets/agent.txt'), 'not markdown\\n', 'utf8');",
        "",
      ].join("\n"),
      expectedPath: () => "curated/assets/agent.txt",
      expectedMessage: "Agent proposal path is not allowed",
    },
    {
      name: "deletions",
      expectedCode: "AGENT_PROPOSAL_REJECTED",
      buildScript: () => [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "fs.rmSync(path.join(process.cwd(), 'curated/home.md'));",
        "",
      ].join("\n"),
      expectedPath: () => "curated/home.md",
      expectedMessage: "deleted a file",
    },
  ])("rejects disallowed temp workspace diffs for $name and blocks the source", async (caseInput) => {
    await withTempWorkspace("llm-wiki-ingest-agent-disallowed-diff-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const rawOriginalBefore = await readFile(resolve(wikiDir, source.original_path), "utf8");
      const executablePath = await createFakeCodex(workspaceDir, caseInput.buildScript(source));
      await configureCodexAgent(wikiDir, { command: executablePath });
      const before = await readTreeSnapshot(wikiDir, {
        exclude: (path) => path === "curated/log.md" || path === source.queue_path || path === source.source_card_path,
      });

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
      const after = await readTreeSnapshot(wikiDir, {
        exclude: (path) => path === "curated/log.md" || path === source.queue_path || path === source.source_card_path,
      });

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe(caseInput.expectedCode);
      expect(payload.error.message).toContain(caseInput.expectedMessage);
      expect(payload.issues[0]?.path).toBe(caseInput.expectedPath(source));
      expect(queuePayload.data.queue_record.status).toBe("blocked");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("blocked");
      expect(after).toEqual(before);
      expect(await readFile(resolve(wikiDir, source.original_path), "utf8")).toBe(rawOriginalBefore);
    });
  });

  it("blocks the queue and skips real writes when temp validation fails", async () => {
    await withTempWorkspace("llm-wiki-ingest-agent-validation-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const indexBefore = await readFile(resolve(wikiDir, "curated/index.md"), "utf8");
      const executablePath = await createFakeCodex(
        workspaceDir,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const cwd = process.cwd();",
          "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true });",
          `fs.writeFileSync(path.join(cwd, ${JSON.stringify(`curated/sources/${source.source_id}.md`)}), ${JSON.stringify([
            "---",
            "type: source_summary",
            `title: ${JSON.stringify(`${source.title} Summary`)}`,
            "visibility: private",
            "source_ids: []",
            `source_id: ${source.source_id}`,
            "---",
            "",
            `# ${source.title} Summary`,
            "",
            "This summary omits required source_ids provenance.",
            "",
          ].join("\n"))}, 'utf8');`,
          "",
        ].join("\n"),
      );
      await configureCodexAgent(wikiDir, { command: executablePath });

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("INGEST_VALIDATION_FAILED");
      expect(payload.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "ingest_index_missing",
          "ingest_log_entry_missing",
          "ingest_source_ids_missing",
        ]),
      );
      expect(queuePayload.data.queue_record.status).toBe("blocked");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("blocked");
      await expect(pathExists(resolve(wikiDir, `curated/sources/${source.source_id}.md`))).resolves.toBe(false);
      expect(await readFile(resolve(wikiDir, "curated/index.md"), "utf8")).toBe(indexBefore);
    });
  });
});
