import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
    captured_at: string;
    source_kind: "file" | "text" | "url";
    visibility: "private";
    queue_status: "queued";
    original_path: string;
    source_card_path: string;
    queue_path: string;
  };
};

type QueryTaskData = {
  mode: "task";
  question: string;
  save_path: string | null;
  context: {
    paths: string[];
    source_ids: string[];
    related_pages: Array<{
      path: string;
      title: string;
      reason: "search" | "nav" | "source";
      source_ids: string[];
    }>;
  };
  task: {
    artifact_path: string | null;
    required_outputs: string[];
    provenance_rules: string[];
    prompt: string;
  };
};

type QueryValidationData = {
  mode: "validate";
  question: string;
  save_path: string;
  validation: {
    passed: true;
    issues: [];
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
    input.title ?? "Transformer Paper",
    "--text",
    input.text ?? "raw evidence about retrieval memory and graph search",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(payload.data.status).toBe("added");

  return payload.data.source;
}

async function configureCodexLocalAgent(
  wikiDir: string,
  input: { defaultAgent: "generic" | "codex"; command?: string },
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
      `    command: ${input.command ?? "codex"}`,
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

async function appendQueryLogEntry(
  wikiDir: string,
  input: { questionId: string; title: string; savePath: string; updatedPaths?: string[] },
): Promise<void> {
  await appendFile(
    resolve(wikiDir, "curated/log.md"),
    [
      "",
      `## [2026-06-19T10:30:00.000Z] query | ${input.questionId} | ${input.title}`,
      "",
      "- actor: test-agent",
      `- command: "llm-wiki query ${JSON.stringify(input.title)} --save ${input.savePath}"`,
      "- git_branch:",
      "- git_commit:",
      "- raw_source:",
      "- created:",
      `  - ${input.savePath}`,
      "- updated:",
      "  - curated/index.md",
      ...(input.updatedPaths ?? []).map((path) => `  - ${path}`),
      "- contradictions:",
      "- follow_ups:",
      "",
    ].join("\n"),
    "utf8",
  );
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

describe("query command task scaffolding", () => {
  it.each([
    {
      name: "agent and provider",
      args: ["--agent", "codex", "--provider", "local"],
      message: "Choose only one query execution mode.",
    },
    {
      name: "auto and provider",
      args: ["--auto", "--provider", "local"],
      message: "Choose only one query execution mode.",
    },
    {
      name: "auto and agent",
      args: ["--auto", "--agent", "codex"],
      message: "Choose only one query execution mode.",
    },
    {
      name: "provider and validate",
      args: ["--provider", "local", "--validate"],
      message: "Query validation cannot be combined with execution mode.",
    },
    {
      name: "agent and validate",
      args: ["--agent", "codex", "--validate"],
      message: "Query validation cannot be combined with execution mode.",
    },
    {
      name: "auto and validate",
      args: ["--auto", "--validate"],
      message: "Query validation cannot be combined with execution mode.",
    },
  ])("rejects conflicting query mode flags: $name", async ({ args, message }) => {
    await withTempWorkspace("llm-wiki-query-mode-conflict-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "query",
        "Can conflicting query modes run together?",
        "--repo",
        wikiDir,
        "--save",
        "curated/questions/query-mode-conflict.md",
        ...args,
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toMatchObject({
        code: "QUERY_MODE_CONFLICT",
        message,
      });
      expect(payload.error.hint).toContain("--agent");
      expect(payload.error.hint).toContain("--auto");
      expect(payload.error.hint).toContain("--provider");
    });
  });

  it.each(["--agent", "--auto"])("requires --save before resolving query %s mode", async (modeFlag) => {
    await withTempWorkspace("llm-wiki-query-agent-save-required-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
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
        "query",
        "Does query agent mode require a durable output path?",
        "--repo",
        wikiDir,
        modeFlag,
        ...(modeFlag === "--agent" ? ["codex"] : []),
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toMatchObject({
        code: "QUERY_SAVE_REQUIRED",
        message: "Query agent mode requires --save <path>.",
      });
      expect(payload.error.hint).toContain("--save curated/questions/<slug>.md");
      expect(JSON.stringify(payload)).not.toContain("Agent type must be local-exec");
    });
  });

  it("fails query --auto early when the default agent has no local agent config", async () => {
    await withTempWorkspace("llm-wiki-query-auto-missing-agent-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "query",
        "Can auto query run without a configured local agent?",
        "--repo",
        wikiDir,
        "--save",
        "curated/questions/auto-missing-agent.md",
        "--auto",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);

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

  it("fails query --auto early when the configured default agent is not local-exec", async () => {
    await withTempWorkspace("llm-wiki-query-auto-unsupported-agent-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
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
        "query",
        "Can auto query use an HTTP-shaped agent?",
        "--repo",
        wikiDir,
        "--save",
        "curated/questions/auto-unsupported-agent.md",
        "--auto",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);

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
  ])("resolves a valid local agent config before launching query execution: $name", async ({ args, defaultAgent }) => {
    await withTempWorkspace("llm-wiki-query-agent-handoff-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const missingCommand = "llm-wiki-definitely-missing-codex";
      await initializeWiki(wikiDir);
      await configureCodexLocalAgent(wikiDir, { defaultAgent, command: missingCommand });

      // Act
      const result = await runCliBuffered([
        "query",
        "Can query select a configured local agent?",
        "--repo",
        wikiDir,
        "--save",
        "curated/questions/local-agent-handoff.md",
        ...args,
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toMatchObject({
        code: "AGENT_COMMAND_UNAVAILABLE",
        message: `Agent command is not available: ${missingCommand}.`,
      });
      expect(payload.error.hint).toContain("PATH");
      expect(payload.issues[0]).toMatchObject({
        path: missingCommand,
      });
    });
  });

  it("keeps query prompt generation manual when execution flags are omitted", async () => {
    await withTempWorkspace("llm-wiki-query-manual-task-default-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "query",
        "What can the wiki answer manually?",
        "--repo",
        wikiDir,
        "--json",
      ]);
      const payload = parseJsonSuccess<"query", QueryTaskData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.mode).toBe("task");
      expect(payload.data.save_path).toBeNull();
      expect(payload.data.task.prompt).toContain("What can the wiki answer manually?");
    });
  });

  it("builds an agent prompt from curated Markdown, source summaries, index, source IDs, and relevant links", async () => {
    await withTempWorkspace("llm-wiki-query-task-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-19T10:00:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const navSource = await captureTextSource(wikiDir, {
        title: "Route Atelier Memo",
        text: "raw evidence about route atelier planning",
      });
      const agentsSentinel = "REM-S10 AGENTS sentinel: answer with provenance or open questions.";
      const indexSentinel = "REM-S10 index sentinel: current wiki map is loaded.";
      const summarySentinel = "REM-S10 source summary sentinel: retrieval evidence is loaded.";
      const navSummarySentinel = "REM-S10 source summary sentinel: markdown-linked route evidence is loaded.";
      const searchPageSentinel = "REM-S10 searched page sentinel: direct query context is loaded.";
      const navOnlyPageSentinel = "REM-S10 nav-only sentinel: braided context is loaded by Markdown link.";
      await appendFile(resolve(wikiDir, "AGENTS.md"), `\n\n${agentsSentinel}\n`, "utf8");
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Transformer Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        [
          "# Transformer Paper Summary",
          "",
          "The paper gives evidence about retrieval memory and graph search.",
          summarySentinel,
          "",
        ].join("\n"),
      );
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${navSource.source_id}.md`,
        {
          type: "source_summary",
          title: "Route Atelier Memo Summary",
          visibility: "private",
          source_ids: [navSource.source_id],
        },
        [
          "# Route Atelier Memo Summary",
          "",
          "The memo gives evidence about route atelier planning.",
          navSummarySentinel,
          "",
        ].join("\n"),
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/memory-retrieval.md",
        {
          type: "topic",
          title: "Memory Retrieval",
          visibility: "private",
          aliases: ["Recall System"],
          source_ids: [source.source_id],
        },
        [
          "# Memory Retrieval",
          "",
          `Retrieval memory connects to [[sources/${source.source_id}|the source summary]] and [Route Atelier](../concepts/route-atelier.md).`,
          searchPageSentinel,
          "",
        ].join("\n"),
      );
      await writeCuratedPage(
        wikiDir,
        "curated/concepts/route-atelier.md",
        {
          type: "concept",
          title: "Route Atelier",
          visibility: "private",
          source_ids: [navSource.source_id],
        },
        [
          "# Route Atelier",
          "",
          "This adjacent note is reachable only through the parent note link.",
          navOnlyPageSentinel,
          "",
        ].join("\n"),
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
          indexSentinel,
          `- [[sources/${source.source_id}|Transformer Paper Summary]]`,
          "- [[topics/memory-retrieval|Memory Retrieval]]",
          "",
        ].join("\n"),
        "utf8",
      );

      // Act
      const result = await runCliBuffered([
        "query",
        "How does retrieval memory use graph search?",
        "--repo",
        wikiDir,
        "--save",
        "curated/questions/retrieval-memory.md",
        "--json",
      ]);
      const payload = parseJsonSuccess<"query", QueryTaskData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.mode).toBe("task");
      expect(payload.data.question).toBe("How does retrieval memory use graph search?");
      expect(payload.data.save_path).toBe("curated/questions/retrieval-memory.md");
      expect(payload.data.context.paths).toEqual(
        expect.arrayContaining([
          "AGENTS.md",
          "curated/index.md",
          `curated/sources/${source.source_id}.md`,
          `curated/sources/${navSource.source_id}.md`,
          "curated/concepts/route-atelier.md",
          "curated/topics/memory-retrieval.md",
        ]),
      );
      expect(payload.data.context.source_ids).toEqual([navSource.source_id, source.source_id].sort());
      expect(payload.data.context.related_pages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: `curated/sources/${source.source_id}.md`,
            reason: "source",
            source_ids: [source.source_id],
          }),
          expect.objectContaining({
            path: `curated/sources/${navSource.source_id}.md`,
            reason: "source",
            source_ids: [navSource.source_id],
          }),
          expect.objectContaining({
            path: "curated/topics/memory-retrieval.md",
            reason: "search",
            source_ids: [source.source_id],
          }),
          expect.objectContaining({
            path: "curated/concepts/route-atelier.md",
            reason: "nav",
            source_ids: [navSource.source_id],
          }),
        ]),
      );
      expect(payload.data.task.required_outputs).toEqual(
        expect.arrayContaining([
          "curated/questions/retrieval-memory.md",
          "curated/index.md",
          "curated/log.md",
        ]),
      );
      expect(payload.data.task.provenance_rules.join("\n")).toContain("source_ids");
      expect(payload.data.task.provenance_rules.join("\n")).toContain("open_questions");
      expect(payload.data.task.prompt).toContain("How does retrieval memory use graph search?");
      expect(payload.data.task.prompt).toContain(agentsSentinel);
      expect(payload.data.task.prompt).toContain(indexSentinel);
      expect(payload.data.task.prompt).toContain(summarySentinel);
      expect(payload.data.task.prompt).toContain(navSummarySentinel);
      expect(payload.data.task.prompt).toContain(searchPageSentinel);
      expect(payload.data.task.prompt).toContain(navOnlyPageSentinel);
      expect(payload.data.task.prompt).toContain(source.source_id);
      expect(payload.data.task.prompt).toContain(navSource.source_id);
      expect(payload.data.task.prompt).toContain("type: question");
      expect(payload.data.task.prompt).toContain("visibility:");
      expect(payload.data.task.prompt).toContain("source_ids:");
      expect(payload.data.task.prompt).toContain("open_questions:");
      expect(payload.data.task.prompt).toContain("Update curated/index.md");
      expect(payload.data.task.prompt).toContain("Append a query entry to curated/log.md");
      expect(payload.data.task.prompt).toContain(
        "Run llm-wiki query 'How does retrieval memory use graph search?' --save 'curated/questions/retrieval-memory.md' --validate",
      );
    });
  });

  it("shell-quotes generated validation command arguments", async () => {
    await withTempWorkspace("llm-wiki-query-task-shell-quote-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "Can $(touch tmp-query-question) keep Bob's note?";
      const savePath = "curated/questions/answer; touch tmp-query-save Bob's.md";
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["query", question, "--repo", wikiDir, "--save", savePath, "--json"]);
      const payload = parseJsonSuccess<"query", QueryTaskData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.task.prompt).toContain(
        "Run llm-wiki query 'Can $(touch tmp-query-question) keep Bob'\\''s note?' --save 'curated/questions/answer; touch tmp-query-save Bob'\\''s.md' --validate",
      );
    });
  });

  it("excludes an existing save target from rerun task context", async () => {
    await withTempWorkspace("llm-wiki-query-task-exclude-save-target-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "How should Atlas retrieval memory be refreshed?";
      const savePath = "curated/questions/atlas-retrieval-memory.md";
      const staleAnswerSentinel = "REM-S10 stale saved answer sentinel must not be reused as evidence.";
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [],
          open_questions: ["Previous run lacked durable provenance."],
        },
        [
          "# How should Atlas retrieval memory be refreshed?",
          "",
          "Atlas retrieval memory was answered in a previous saved query.",
          staleAnswerSentinel,
          "",
        ].join("\n"),
      );

      // Act
      const result = await runCliBuffered(["query", question, "--repo", wikiDir, "--save", savePath, "--json"]);
      const payload = parseJsonSuccess<"query", QueryTaskData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.save_path).toBe(savePath);
      expect(payload.data.context.paths).not.toContain(savePath);
      expect(payload.data.context.related_pages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: savePath,
          }),
        ]),
      );
      expect(payload.data.task.prompt).not.toContain(`### ${savePath} (`);
      expect(payload.data.task.prompt).not.toContain(staleAnswerSentinel);
    });
  });

  it("omits stale curated source IDs from advertised query citations", async () => {
    await withTempWorkspace("llm-wiki-query-task-stale-source-id-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does stale query provenance show?";
      const staleSourceId = "src_2026_06_19_stale_query_deadbeef";
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/stale-provenance.md",
        {
          type: "topic",
          title: "Stale Provenance",
          visibility: "private",
          source_ids: [staleSourceId],
        },
        "# Stale Provenance\n\nWhat does stale query provenance show when no backing source card or source summary exists?\n",
      );

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        "curated/questions/stale-provenance.md",
        "--json",
      ]);
      const payload = parseJsonSuccess<"query", QueryTaskData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.context.source_ids).toEqual([]);
      expect(payload.data.context.related_pages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "curated/topics/stale-provenance.md",
            source_ids: [],
          }),
        ]),
      );
      expect(payload.data.task.prompt).toContain("## Available source IDs\n- None available");
      expect(payload.data.task.prompt).toContain("source_ids: []");
      expect(payload.data.task.prompt).not.toContain(staleSourceId);
    });
  });

  it("omits queued raw-only source IDs from related-page query citations", async () => {
    await withTempWorkspace("llm-wiki-query-task-raw-only-related-source-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does queued raw provenance prove?";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, {
        title: "Queued Raw Evidence",
        text: "raw queued source text that has not been ingested into a curated source summary",
      });
      await writeCuratedPage(
        wikiDir,
        "curated/topics/queued-raw-provenance.md",
        {
          type: "topic",
          title: "Queued Raw Provenance",
          visibility: "private",
          source_ids: [source.source_id],
        },
        `# Queued Raw Provenance\n\n${question} This related page references a queued source card only.\n`,
      );

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        "curated/questions/queued-raw-provenance.md",
        "--json",
      ]);
      const payload = parseJsonSuccess<"query", QueryTaskData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.context.source_ids).toEqual([]);
      expect(payload.data.context.related_pages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "curated/topics/queued-raw-provenance.md",
            source_ids: [],
          }),
        ]),
      );
      expect(payload.data.task.prompt).toContain("## Available source IDs\n- None available");
      expect(payload.data.task.prompt).toContain("source_ids: []");
      expect(payload.data.task.prompt).not.toContain(source.source_id);
    });
  });

  it.each([
    "../outside.md",
    "curated/questions/foo#bar.md",
    "curated/questions/foo?bar.md",
    "curated/questions/foo#bar/baz.md",
    "curated/questions/foo?bar/baz.md",
    "curated/questions/foo\nbar/baz.md",
    "curated/questions/ foo.md",
    "curated/questions/foo .md",
  ])("rejects invalid save path before building a task: %s", async (savePath) => {
    await withTempWorkspace("llm-wiki-query-invalid-save-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "query",
        "Can this write outside curated questions?",
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUERY_SAVE_PATH_INVALID");
      expect(payload.issues[0]).toMatchObject({
        code: "QUERY_SAVE_PATH_INVALID",
        path: savePath,
      });
    });
  });

  it("validates a completed saved question and reports success without rewriting the answer", async () => {
    await withTempWorkspace("llm-wiki-query-validate-success-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-19T10:20:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const savePath = "curated/questions/retrieval-memory.md";
      const question = "How does retrieval memory use graph search?";
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Transformer Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Transformer Paper Summary\n\nThe source gives evidence about retrieval memory.\n",
      );
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [source.source_id],
          open_questions: ["No source in this wiki directly evaluates production latency."],
        },
        [
          "# How does retrieval memory use graph search?",
          "",
          `Retrieval memory is supported by [[sources/${source.source_id}|the source summary]].`,
          "",
        ].join("\n"),
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
          "- [[questions/retrieval-memory|How does retrieval memory use graph search?]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "retrieval-memory",
        title: question,
        savePath,
      });
      const answerBefore = await readFile(resolve(wikiDir, savePath), "utf8");

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--validate",
        "--json",
      ]);
      const payload = parseJsonSuccess<"query", QueryValidationData>(result.stdout);
      const answerAfter = await readFile(resolve(wikiDir, savePath), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        mode: "validate",
        question,
        save_path: savePath,
        validation: {
          passed: true,
          issues: [],
        },
      });
      expect(answerAfter).toBe(answerBefore);
    });
  });
});
