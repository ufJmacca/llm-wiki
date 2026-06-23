import { appendFile, chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

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
    captured_at: string;
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
    path: string;
    frontmatter: {
      status: "queued" | "ingesting" | "ingested" | "blocked";
    };
  };
};

type IngestTaskData = {
  mode: "task";
  source: {
    source_id: string;
    title: string;
    status: "queued" | "ingesting" | "ingested" | "blocked";
    source_card_path: string;
    original_path: string;
    queue_path: string;
  };
  queue: {
    status: "queued" | "ingesting" | "ingested" | "blocked";
    previous_status: "queued" | "ingesting" | "ingested" | "blocked" | null;
  };
  context: {
    paths: string[];
    related_pages: Array<{
      path: string;
      title: string;
      reason: "search" | "nav";
    }>;
  };
  git: {
    enabled: boolean;
    branch_name: string;
    recommended_command: string | null;
    created: boolean;
  };
  task: {
    artifact_path: string | null;
    required_outputs: string[];
    raw_immutability_rules: string[];
    prompt: string;
  };
};

const originalTimezone = process.env.TZ;
const originalPath = process.env.PATH;
const originalFakeGitLog = process.env.LLM_WIKI_FAKE_GIT_LOG;

afterEach(() => {
  vi.useRealTimers();
  if (originalTimezone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalFakeGitLog === undefined) {
    delete process.env.LLM_WIKI_FAKE_GIT_LOG;
  } else {
    process.env.LLM_WIKI_FAKE_GIT_LOG = originalFakeGitLog;
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
    "Transformer Paper",
    "--text",
    "raw evidence about retrieval memory and graph search",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(payload.data.status).toBe("added");

  return payload.data.source;
}

async function configureCodexLocalAgent(
  wikiDir: string,
  input: { defaultAgent: "generic" | "codex" },
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
      "    command: codex",
      "    args:",
      "      - exec",
      "    timeout_seconds: 900",
      "",
    ].join("\n"),
    "utf8",
  );
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

async function installFakeGit(
  workspaceDir: string,
  options: {
    existingBranches?: string[];
    checkoutFiles?: Record<string, string>;
    checkoutDirectories?: string[];
  } = {},
): Promise<{ binDir: string; logPath: string }> {
  const binDir = resolve(workspaceDir, "fake-git-bin");
  const logPath = resolve(workspaceDir, "fake-git.log");
  const gitPath = resolve(binDir, "git");
  const existingBranches = options.existingBranches ?? [];
  const checkoutFiles = options.checkoutFiles ?? {};
  const checkoutDirectories = options.checkoutDirectories ?? [];
  await mkdir(binDir, { recursive: true });
  await writeFile(
    gitPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const logPath = process.env.LLM_WIKI_FAKE_GIT_LOG;",
      `const existingBranches = new Set(${JSON.stringify(existingBranches)});`,
      `const checkoutFiles = new Map(Object.entries(${JSON.stringify(checkoutFiles)}));`,
      `const checkoutDirectories = ${JSON.stringify(checkoutDirectories)};`,
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(logPath, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');",
      "function applyCheckoutFiles() {",
      "  for (const [relativePath, content] of checkoutFiles) {",
      "    const absolutePath = path.resolve(process.cwd(), relativePath);",
      "    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });",
      "    fs.writeFileSync(absolutePath, content, 'utf8');",
      "  }",
      "  for (const relativePath of checkoutDirectories) {",
      "    const absolutePath = path.resolve(process.cwd(), relativePath);",
      "    fs.rmSync(absolutePath, { recursive: true, force: true });",
      "    fs.mkdirSync(absolutePath, { recursive: true });",
      "  }",
      "}",
      "if (args[0] === 'switch' && args[1] === '-c' && existingBranches.has(args[2])) {",
      "  console.error(`fatal: a branch named '${args[2]}' already exists`);",
      "  process.exit(128);",
      "}",
      "if (args[0] === 'switch' && existingBranches.has(args[1])) {",
      "  applyCheckoutFiles();",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'show-ref' && args[1] === '--verify' && args[2] === '--quiet') {",
      "  const branchName = args[3]?.replace(/^refs\\/heads\\//, '');",
      "  process.exit(existingBranches.has(branchName) ? 0 : 1);",
      "}",
    ].join("\n"),
    "utf8",
  );
  await chmod(gitPath, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.LLM_WIKI_FAKE_GIT_LOG = logPath;

  return { binDir, logPath };
}

describe("ingest command task scaffolding", () => {
  it.each([
    {
      name: "agent and provider",
      args: ["--agent", "codex", "--provider", "local"],
      message: "Choose only one ingest execution mode.",
    },
    {
      name: "auto and provider",
      args: ["--auto", "--provider", "local"],
      message: "Choose only one ingest execution mode.",
    },
    {
      name: "auto and agent",
      args: ["--auto", "--agent", "codex"],
      message: "Choose only one ingest execution mode.",
    },
    {
      name: "provider and validate",
      args: ["--provider", "local", "--validate"],
      message: "Ingest validation cannot be combined with execution mode.",
    },
    {
      name: "agent and validate",
      args: ["--agent", "codex", "--validate"],
      message: "Ingest validation cannot be combined with execution mode.",
    },
    {
      name: "auto and validate",
      args: ["--auto", "--validate"],
      message: "Ingest validation cannot be combined with execution mode.",
    },
  ])("rejects conflicting ingest mode flags: $name", async ({ args, message }) => {
    await withTempWorkspace("llm-wiki-ingest-mode-conflict-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        ...args,
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toMatchObject({
        code: "INGEST_MODE_CONFLICT",
        message,
      });
      expect(payload.error.hint).toContain("--agent");
      expect(payload.error.hint).toContain("--auto");
      expect(payload.error.hint).toContain("--provider");
    });
  });

  it("fails --auto early when the default agent has no local agent config", async () => {
    await withTempWorkspace("llm-wiki-ingest-auto-missing-agent-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--auto",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toMatchObject({
        code: "AGENT_CONFIG_MISSING",
        message: "Local agent is not configured: generic.",
        hint: expect.stringContaining("local agent mode"),
      });
      expect(payload.issues[0]).toMatchObject({
        path: ".llm-wiki/config.yml:agents.generic",
      });
    });
  });

  it("fails --auto early when the configured default agent is not local-exec", async () => {
    await withTempWorkspace("llm-wiki-ingest-auto-unsupported-agent-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        [
          config.replace("default: generic", "default: codex").trimEnd(),
          "agents:",
          "  codex:",
          "    type: http",
          "    command: codex",
          "",
        ].join("\n"),
        "utf8",
      );

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--auto",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toMatchObject({
        code: "AGENT_CONFIG_INVALID",
        message: "Agent type must be local-exec.",
      });
      expect(payload.issues[0]).toMatchObject({
        path: ".llm-wiki/config.yml:agents.codex.type",
      });
    });
  });

  it.each([
    {
      name: "explicit --agent codex",
      args: ["--agent", "codex"],
      defaultAgent: "generic" as const,
    },
    {
      name: "--auto with agent.default",
      args: ["--auto"],
      defaultAgent: "codex" as const,
    },
  ])("resolves a valid local agent config before deferred ingest handoff: $name", async ({ args, defaultAgent }) => {
    await withTempWorkspace("llm-wiki-ingest-agent-handoff-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await configureCodexLocalAgent(wikiDir, { defaultAgent });

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        ...args,
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toMatchObject({
        code: "AGENT_EXECUTION_UNAVAILABLE",
        message: "Local agent execution is not implemented for ingest yet: codex.",
      });
      expect(payload.error.hint).toContain(".llm-wiki/config.yml:agents.codex");
      expect(payload.issues[0]).toMatchObject({
        path: ".llm-wiki/config.yml:agents.codex",
      });
    });
  });

  it("builds an agent prompt from source, raw content, queue, agents, index, and related pages", async () => {
    await withTempWorkspace("llm-wiki-ingest-task-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T09:00:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const agentsSentinel = "REM-S09 AGENTS sentinel: keep curated edits provenance-bound.";
      const indexSentinel = "REM-S09 index sentinel: existing overview context is loaded.";
      const sourceCardSentinel = "REM-S09 source-card sentinel: source metadata body is loaded.";
      const relatedPageBodySentinel = "REM-S09 related page body sentinel: existing page content is loaded.";
      await appendFile(resolve(wikiDir, "AGENTS.md"), `\n\n${agentsSentinel}\n`, "utf8");
      await appendFile(resolve(wikiDir, "curated/index.md"), `\n\n${indexSentinel}\n`, "utf8");
      await appendFile(resolve(wikiDir, source.source_card_path), `\n${sourceCardSentinel}\n`, "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/memory-retrieval.md",
        {
          type: "topic",
          title: "Memory Retrieval",
          visibility: "private",
          source_ids: [source.source_id],
        },
        [
          "# Memory Retrieval",
          "",
          "Transformer Paper evidence is relevant to retrieval memory.",
          `This existing page already cites ${source.source_id}.`,
          relatedPageBodySentinel,
          "",
        ].join("\n"),
      );

      // Act
      const result = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"ingest", IngestTaskData>(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.mode).toBe("task");
      expect(payload.data.source).toMatchObject({
        source_id: source.source_id,
        title: "Transformer Paper",
        source_card_path: source.source_card_path,
        original_path: source.original_path,
        queue_path: source.queue_path,
      });
      expect(payload.data.queue).toMatchObject({
        previous_status: "queued",
        status: "ingesting",
      });
      expect(payload.data.context.paths).toEqual(
        expect.arrayContaining([
          source.source_card_path,
          source.original_path,
          source.queue_path,
          "AGENTS.md",
          "curated/index.md",
          "curated/topics/memory-retrieval.md",
        ]),
      );
      expect(payload.data.context.related_pages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "curated/topics/memory-retrieval.md",
          }),
        ]),
      );
      expect(payload.data.task.required_outputs).toEqual(
        expect.arrayContaining([
          `curated/sources/${source.source_id}.md`,
          "curated/index.md",
          "curated/log.md",
        ]),
      );
      expect(payload.data.task.raw_immutability_rules.join("\n")).toContain("raw/inputs/**/original.*");
      expect(payload.data.task.prompt).toContain(source.source_id);
      expect(payload.data.task.prompt).toContain(agentsSentinel);
      expect(payload.data.task.prompt).toContain(indexSentinel);
      expect(payload.data.task.prompt).toContain(sourceCardSentinel);
      expect(payload.data.task.prompt).toContain(relatedPageBodySentinel);
      expect(payload.data.task.prompt).toContain("raw evidence about retrieval memory and graph search");
      expect(payload.data.task.prompt).toContain(`Create or update curated/sources/${source.source_id}.md`);
      expect(payload.data.task.prompt).toContain("Do not edit raw/inputs/**/original.*");
      expect(payload.data.task.prompt).toContain("Add source_ids to every curated page you edit");
      expect(payload.data.task.prompt).toContain("Update curated/index.md");
      expect(payload.data.task.prompt).toContain("Append an ingest entry to curated/log.md");
      expect(queuePayload.data.queue_record.status).toBe("ingesting");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("ingesting");
    });
  });

  it("keeps binary file originals out of generated ingest prompts", async () => {
    await withTempWorkspace("llm-wiki-ingest-binary-task-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T09:30:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      const binaryPath = resolve(workspaceDir, "scan.pdf");
      const binarySentinel = "BINARY_ORIGINAL_SHOULD_NOT_BE_INLINED";
      await initializeWiki(wikiDir);
      await writeFile(binaryPath, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, ...Buffer.from(binarySentinel), 0xff]));
      const addResult = await runCliBuffered([
        "add",
        binaryPath,
        "--repo",
        wikiDir,
        "--title",
        "Binary Scan",
        "--json",
      ]);
      const addPayload = parseJsonSuccess<"add", SourceCaptureData>(addResult.stdout);

      // Act
      const result = await runCliBuffered(["ingest", addPayload.data.source.source_id, "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"ingest", IngestTaskData>(result.stdout);

      // Assert
      expect(addResult.exitCode).toBe(0);
      expect(result.exitCode).toBe(0);
      expect(payload.data.context.paths).toContain(addPayload.data.source.original_path);
      expect(payload.data.task.prompt).toContain(`Raw original path: ${addPayload.data.source.original_path}`);
      expect(payload.data.task.prompt).toContain("Content not inlined");
      expect(payload.data.task.prompt).toContain("extraction or OCR");
      expect(payload.data.task.prompt).not.toContain(binarySentinel);
    });
  });

  it("rejects symlinked ingest context files before adding them to prompts", async () => {
    await withTempWorkspace("llm-wiki-ingest-context-symlink-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T09:45:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      const outsidePath = resolve(workspaceDir, "outside-agents.md");
      const outsideSentinel = "OUTSIDE_AGENTS_SHOULD_NOT_BE_INLINED";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeFile(outsidePath, outsideSentinel, "utf8");
      await rm(resolve(wikiDir, "AGENTS.md"));
      await symlink(outsidePath, resolve(wikiDir, "AGENTS.md"));

      // Act
      const result = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--json"]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe("INGEST_CONTEXT_READ_FAILED");
      expect(payload.issues[0]).toMatchObject({
        code: "INGEST_CONTEXT_READ_FAILED",
        path: "AGENTS.md",
      });
      expect(JSON.stringify(payload)).not.toContain(outsideSentinel);
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
    });
  });

  it("leaves queue state unchanged when task artifact writing fails", async () => {
    await withTempWorkspace("llm-wiki-ingest-task-write-fail-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T09:50:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--task-out",
        "../outside-task.md",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
      const log = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe("INGEST_TASK_WRITE_FAILED");
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
      expect(log).not.toContain(`ingest | ${source.source_id} | Status changed to ingesting`);
    });
  });

  it("rolls back queue state when final task artifact write fails after preflight", async () => {
    await withTempWorkspace("llm-wiki-ingest-task-write-permission-fail-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T09:51:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      const taskOutPath = "tasks/existing-ingest-task.md";
      const taskOutAbsolutePath = resolve(wikiDir, taskOutPath);
      const taskOutBefore = "existing task artifact must remain unchanged\n";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await mkdir(resolve(taskOutAbsolutePath, ".."), { recursive: true });
      await writeFile(taskOutAbsolutePath, taskOutBefore, "utf8");
      await chmod(taskOutAbsolutePath, 0o444);

      try {
        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--task-out",
          taskOutPath,
          "--json",
        ]);
        const payload = parseJsonFailure<"ingest">(result.stdout);
        const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
        const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
        const log = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

        // Assert
        expect(result.exitCode).toBe(1);
        expect(payload.error.code).toBe("INGEST_TASK_WRITE_FAILED");
        expect(queuePayload.data.queue_record.status).toBe("queued");
        expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
        expect(log).not.toContain(`ingest | ${source.source_id} | Status changed to ingesting`);
        expect(await readFile(taskOutAbsolutePath, "utf8")).toBe(taskOutBefore);
      } finally {
        await chmod(taskOutAbsolutePath, 0o644).catch(() => undefined);
      }
    });
  });

  it("rejects task artifacts in raw runtime paths without mutating source state", async () => {
    await withTempWorkspace("llm-wiki-ingest-task-out-raw-paths-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T09:52:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const protectedPaths = [source.original_path, source.source_card_path, source.queue_path];
      const sourceStateBefore = new Map(
        await Promise.all(
          protectedPaths.map(async (protectedPath) => [
            protectedPath,
            await readFile(resolve(wikiDir, protectedPath), "utf8"),
          ] as const),
        ),
      );

      for (const protectedPath of protectedPaths) {
        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--task-out",
          protectedPath,
          "--json",
        ]);
        const payload = parseJsonFailure<"ingest">(result.stdout);
        const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
        const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
        const log = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

        // Assert
        expect(result.exitCode).toBe(1);
        expect(payload.error.code).toBe("INGEST_TASK_WRITE_FAILED");
        expect(payload.error.message).toContain("raw runtime state");
        expect(payload.issues[0]).toMatchObject({
          code: "INGEST_TASK_WRITE_FAILED",
          path: protectedPath,
        });
        expect(queuePayload.data.queue_record.status).toBe("queued");
        expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
        expect(log).not.toContain(`ingest | ${source.source_id} | Status changed to ingesting`);
        for (const [path, content] of sourceStateBefore) {
          expect(await readFile(resolve(wikiDir, path), "utf8")).toBe(content);
        }
      }
    });
  });

  it("rejects task artifacts in Git metadata without mutating source state", async () => {
    await withTempWorkspace("llm-wiki-ingest-task-out-git-paths-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T09:52:30.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const gitConfigPath = ".git/config";
      await mkdir(resolve(wikiDir, ".git"), { recursive: true });
      await writeFile(resolve(wikiDir, gitConfigPath), "[core]\n\trepositoryformatversion = 0\n", "utf8");
      const gitConfigBefore = await readFile(resolve(wikiDir, gitConfigPath), "utf8");

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--task-out",
        gitConfigPath,
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
      const log = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe("INGEST_TASK_WRITE_FAILED");
      expect(payload.error.message).toContain("Git metadata");
      expect(payload.issues[0]).toMatchObject({
        code: "INGEST_TASK_WRITE_FAILED",
        path: gitConfigPath,
      });
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
      expect(log).not.toContain(`ingest | ${source.source_id} | Status changed to ingesting`);
      expect(await readFile(resolve(wikiDir, gitConfigPath), "utf8")).toBe(gitConfigBefore);
    });
  });

  it("rejects task artifacts in curated and control paths without mutating source state", async () => {
    await withTempWorkspace("llm-wiki-ingest-task-out-curated-paths-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T09:53:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const curatedPagePath = "curated/topics/existing-task-target.md";
      const protectedPaths = ["curated/log.md", "curated/index.md", curatedPagePath, ".llm-wiki/config.yml"];
      await writeCuratedPage(
        wikiDir,
        curatedPagePath,
        {
          type: "topic",
          title: "Existing Task Target",
          visibility: "private",
          source_ids: [],
        },
        "# Existing Task Target\n\nThis curated page must not be overwritten by a task prompt.\n",
      );
      const protectedStateBefore = new Map(
        await Promise.all(
          protectedPaths.map(async (protectedPath) => [
            protectedPath,
            await readFile(resolve(wikiDir, protectedPath), "utf8"),
          ] as const),
        ),
      );

      for (const protectedPath of protectedPaths) {
        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--task-out",
          protectedPath,
          "--json",
        ]);
        const payload = parseJsonFailure<"ingest">(result.stdout);
        const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
        const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
        const log = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

        // Assert
        expect(result.exitCode).toBe(1);
        expect(payload.error.code).toBe("INGEST_TASK_WRITE_FAILED");
        expect(payload.error.message).toContain("curated or control state");
        expect(payload.issues[0]).toMatchObject({
          code: "INGEST_TASK_WRITE_FAILED",
          path: protectedPath,
        });
        expect(queuePayload.data.queue_record.status).toBe("queued");
        expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
        expect(log).not.toContain(`ingest | ${source.source_id} | Status changed to ingesting`);
        for (const [path, content] of protectedStateBefore) {
          expect(await readFile(resolve(wikiDir, path), "utf8")).toBe(content);
        }
      }
    });
  });

  it("writes task artifacts from the final prompt after queue transition", async () => {
    await withTempWorkspace("llm-wiki-ingest-task-out-final-state-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T09:55:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      const taskOutPath = "ingest-task.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--task-out",
        taskOutPath,
        "--json",
      ]);
      const payload = parseJsonSuccess<"ingest", IngestTaskData>(result.stdout);
      const artifact = await readFile(resolve(wikiDir, taskOutPath), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.task.artifact_path).toBe(taskOutPath);
      expect(payload.data.queue).toMatchObject({
        previous_status: "queued",
        status: "ingesting",
      });
      expect(artifact).toBe(payload.data.task.prompt);
      expect(artifact).toContain("Queue status: ingesting");
      expect(artifact).not.toContain("Queue status: queued");
    });
  });

  it("rejects task generation for already ingested sources", async () => {
    await withTempWorkspace("llm-wiki-ingest-reject-ingested-task-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T12:30:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);

      const ingestingResult = await runCliBuffered([
        "queue",
        "set-status",
        source.source_id,
        "ingesting",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const ingestedResult = await runCliBuffered([
        "queue",
        "set-status",
        source.source_id,
        "ingested",
        "--repo",
        wikiDir,
        "--json",
      ]);

      // Act
      const result = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--json"]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);

      // Assert
      expect(ingestingResult.exitCode).toBe(0);
      expect(ingestedResult.exitCode).toBe(0);
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe("INGEST_STATUS_INVALID");
      expect(payload.error.message).toContain("ingested");
      expect(payload.error.hint).toContain("Already ingested sources cannot generate a new task");
      expect(queuePayload.data.queue_record.status).toBe("ingested");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("ingested");
    });
  });

  it("recommends an ingest branch for Git repos and creates it only when explicitly requested", async () => {
    await withTempWorkspace("llm-wiki-ingest-git-branch-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T10:00:00.000Z"));
      const recommendWikiDir = resolve(workspaceDir, "recommend-wiki");
      await initializeWiki(recommendWikiDir);
      const recommendSource = await captureTextSource(recommendWikiDir);
      await mkdir(resolve(recommendWikiDir, ".git"));

      const createWikiDir = resolve(workspaceDir, "create-wiki");
      await initializeWiki(createWikiDir);
      const createSource = await captureTextSource(createWikiDir);
      await mkdir(resolve(createWikiDir, ".git"));
      const fakeGit = await installFakeGit(workspaceDir);

      // Act
      const recommendResult = await runCliBuffered([
        "ingest",
        recommendSource.source_id,
        "--repo",
        recommendWikiDir,
        "--json",
      ]);
      const createResult = await runCliBuffered([
        "ingest",
        createSource.source_id,
        "--repo",
        createWikiDir,
        "--create-branch",
        "--json",
      ]);
      const recommendPayload = parseJsonSuccess<"ingest", IngestTaskData>(recommendResult.stdout);
      const createPayload = parseJsonSuccess<"ingest", IngestTaskData>(createResult.stdout);
      const gitCalls = (await readFile(fakeGit.logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { cwd: string; args: string[] });

      // Assert
      expect(recommendResult.exitCode).toBe(0);
      expect(recommendPayload.data.git).toMatchObject({
        enabled: true,
        branch_name: `ingest/${recommendSource.source_id}`,
        recommended_command: `git switch -c ingest/${recommendSource.source_id}`,
        created: false,
      });
      expect(createResult.exitCode).toBe(0);
      expect(createPayload.data.git).toMatchObject({
        enabled: true,
        branch_name: `ingest/${createSource.source_id}`,
        recommended_command: null,
        created: true,
      });
      expect(gitCalls).toEqual([
        {
          cwd: createWikiDir,
          args: ["switch", "-c", `ingest/${createSource.source_id}`],
        },
      ]);
    });
  });

  it("checks out an existing ingest branch when --create-branch is requested", async () => {
    await withTempWorkspace("llm-wiki-ingest-existing-git-branch-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T10:30:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await mkdir(resolve(wikiDir, ".git"));
      const branchName = `ingest/${source.source_id}`;
      const fakeGit = await installFakeGit(workspaceDir, { existingBranches: [branchName] });

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--create-branch",
        "--json",
      ]);
      const payload = parseJsonSuccess<"ingest", IngestTaskData>(result.stdout);
      const gitCalls = (await readFile(fakeGit.logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { cwd: string; args: string[] });

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.git).toMatchObject({
        enabled: true,
        branch_name: branchName,
        recommended_command: null,
        created: false,
      });
      expect(gitCalls).toEqual([
        {
          cwd: wikiDir,
          args: ["switch", "-c", branchName],
        },
        {
          cwd: wikiDir,
          args: ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
        },
        {
          cwd: wikiDir,
          args: ["switch", branchName],
        },
      ]);
    });
  });

  it("rolls back branch-local ingest state when reused branch prompt generation fails", async () => {
    await withTempWorkspace("llm-wiki-ingest-existing-branch-prompt-rollback-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T10:40:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await mkdir(resolve(wikiDir, ".git"));
      const branchName = `ingest/${source.source_id}`;
      const queueContentBefore = await readFile(resolve(wikiDir, source.queue_path), "utf8");
      const sourceCardContentBefore = await readFile(resolve(wikiDir, source.source_card_path), "utf8");
      const logContentBefore = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");
      const branchQueueContent = `${JSON.stringify(
        {
          ...(JSON.parse(queueContentBefore) as Record<string, unknown>),
          branch_local_marker: "existing-branch-queue",
        },
        null,
        2,
      )}\n`;
      const branchSourceCardContent = sourceCardContentBefore.replace(
        "status: queued",
        "status: queued\nbranch_local_marker: existing-branch-source",
      );
      const branchLogContent = `${logContentBefore.trimEnd()}\n\n<!-- existing-branch-log-sentinel -->\n`;
      await installFakeGit(workspaceDir, {
        existingBranches: [branchName],
        checkoutFiles: {
          [source.queue_path]: branchQueueContent,
          [source.source_card_path]: branchSourceCardContent,
          "curated/log.md": branchLogContent,
        },
        checkoutDirectories: ["AGENTS.md"],
      });

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--create-branch",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
      const queueContentAfter = await readFile(resolve(wikiDir, source.queue_path), "utf8");
      const sourceCardContentAfter = await readFile(resolve(wikiDir, source.source_card_path), "utf8");
      const logContentAfter = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe("INGEST_CONTEXT_READ_FAILED");
      expect(payload.issues[0]).toMatchObject({
        code: "INGEST_CONTEXT_READ_FAILED",
        path: "AGENTS.md",
      });
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
      expect(queueContentAfter).toBe(branchQueueContent);
      expect(sourceCardContentAfter).toBe(branchSourceCardContent);
      expect(logContentAfter).toBe(branchLogContent);
      expect(logContentAfter).not.toContain(`ingest | ${source.source_id} | Status changed to ingesting`);
    });
  });

  it("rolls back branch-local ingest state when reused branch task writing fails", async () => {
    await withTempWorkspace("llm-wiki-ingest-existing-branch-rollback-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-18T10:45:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      const taskOutPath = "tasks/reused-branch-task.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await mkdir(resolve(wikiDir, ".git"));
      const branchName = `ingest/${source.source_id}`;
      const queueContentBefore = await readFile(resolve(wikiDir, source.queue_path), "utf8");
      const sourceCardContentBefore = await readFile(resolve(wikiDir, source.source_card_path), "utf8");
      const logContentBefore = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");
      const branchQueueContent = `${JSON.stringify(
        {
          ...(JSON.parse(queueContentBefore) as Record<string, unknown>),
          branch_local_marker: "existing-branch-queue",
        },
        null,
        2,
      )}\n`;
      const branchSourceCardContent = sourceCardContentBefore.replace(
        "status: queued",
        "status: queued\nbranch_local_marker: existing-branch-source",
      );
      const branchLogContent = `${logContentBefore.trimEnd()}\n\n<!-- existing-branch-log-sentinel -->\n`;
      await installFakeGit(workspaceDir, {
        existingBranches: [branchName],
        checkoutFiles: {
          [source.queue_path]: branchQueueContent,
          [source.source_card_path]: branchSourceCardContent,
          "curated/log.md": branchLogContent,
        },
        checkoutDirectories: [taskOutPath],
      });

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--create-branch",
        "--task-out",
        taskOutPath,
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
      const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
      const queueContentAfter = await readFile(resolve(wikiDir, source.queue_path), "utf8");
      const sourceCardContentAfter = await readFile(resolve(wikiDir, source.source_card_path), "utf8");
      const logContentAfter = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe("INGEST_TASK_WRITE_FAILED");
      expect(payload.issues[0]).toMatchObject({
        code: "INGEST_TASK_WRITE_FAILED",
        path: taskOutPath,
      });
      expect(queuePayload.data.queue_record.status).toBe("queued");
      expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
      expect(queueContentAfter).toBe(branchQueueContent);
      expect(sourceCardContentAfter).toBe(branchSourceCardContent);
      expect(logContentAfter).toBe(branchLogContent);
      expect(logContentAfter).not.toContain(`ingest | ${source.source_id} | Status changed to ingesting`);
    });
  });
});
