import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseInitJson, pathExists, readTreeSnapshot, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

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

type QueryAgentData = {
  mode: "agent";
  agent: string;
  question: string;
  save_path: string;
  saved_path: string;
  applied_paths: string[];
  validation: {
    passed: true;
    issues: [];
  };
};

const originalTimezone = process.env.TZ;
const originalPath = process.env.PATH;

afterEach(() => {
  vi.useRealTimers();
  process.env.PATH = originalPath;
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

async function initializeCodexWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--agent", "codex", "--no-git", "--json"]);

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
    input.title ?? "Agent Query Evidence",
    "--text",
    input.text ?? "validated evidence about local agent query automation",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(payload.data.status).toBe("added");

  return payload.data.source;
}

async function configureCodexLocalAgent(
  wikiDir: string,
  input: { command: string; defaultAgent?: "generic" | "codex" },
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
      "    timeout_seconds: 30",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function createFakeCodex(
  workspaceDir: string,
  input: {
    requiredPromptFragments?: string[];
    writes?: Array<{ path: string; content: string }>;
    stderr?: string;
    exitCode?: number;
  },
): Promise<string> {
  const binDir = resolve(workspaceDir, "bin");
  const executablePath = resolve(binDir, "codex");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    executablePath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const prompt = fs.readFileSync(0, 'utf8');",
      `const required = ${JSON.stringify(input.requiredPromptFragments ?? [])};`,
      "for (const fragment of required) {",
      "  if (!prompt.includes(fragment)) {",
      "    process.stderr.write(`missing prompt fragment: ${fragment}\\n`);",
      "    process.exit(86);",
      "  }",
      "}",
      `const writes = ${JSON.stringify(input.writes ?? [])};`,
      "for (const write of writes) {",
      "  const target = path.join(process.cwd(), write.path);",
      "  fs.mkdirSync(path.dirname(target), { recursive: true });",
      "  fs.writeFileSync(target, write.content, 'utf8');",
      "}",
      `process.stderr.write(${JSON.stringify(input.stderr ?? "")});`,
      `process.exit(${input.exitCode ?? 0});`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(executablePath, 0o755);

  return executablePath;
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

function queryAnswerContent(question: string, sourceId: string): string {
  return [
    "---",
    "type: question",
    `title: ${JSON.stringify(question)}`,
    "visibility: private",
    "source_ids:",
    `  - ${sourceId}`,
    "open_questions:",
    "  - The source does not establish whether every deployment behaves identically.",
    "---",
    "",
    `# ${question}`,
    "",
    `The answer cites [[sources/${sourceId}|the source summary]].`,
    "",
  ].join("\n");
}

function queryAnswerWithoutEvidenceContent(question: string): string {
  return [
    "---",
    "type: question",
    `title: ${JSON.stringify(question)}`,
    "visibility: private",
    "source_ids: []",
    "open_questions:",
    "  - No curated source summaries are available for this question yet.",
    "---",
    "",
    `# ${question}`,
    "",
    "No evidence-backed answer is available in the curated wiki yet.",
    "",
  ].join("\n");
}

function sourceSummaryContent(source: SourceCaptureData["source"]): string {
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
    "The source supports local agent query automation.",
    "",
  ].join("\n");
}

function queryIndexContent(question: string, savePath: string): string {
  const indexTarget = savePath.replace(/^curated\//, "").replace(/\.md$/, "");

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
    `- [[${indexTarget}|${question}]]`,
    "",
  ].join("\n");
}

function queryLogContent(question: string, savePath: string): string {
  const questionId = savePath.split("/").pop()?.replace(/\.md$/, "") ?? "agent-answer";

  return [
    "# Log",
    "",
    `## [2026-06-23T09:00:00.000Z] query | ${questionId} | ${question}`,
    "",
    "- actor: codex",
    `- command: "llm-wiki query ${JSON.stringify(question)} --save ${savePath} --agent codex"`,
    "- git_branch:",
    "- git_commit:",
    "- raw_source:",
    "- created:",
    `  - ${savePath}`,
    "- updated:",
    "  - curated/index.md",
    "- contradictions:",
    "- follow_ups:",
    "",
  ].join("\n");
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

describe("query local agent automation", () => {
  it("runs Codex in a temp workspace, validates proposals, applies them, and reports JSON output", async () => {
    await withTempWorkspace("llm-wiki-query-agent-success-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What can local agent query automation answer?";
      const savePath = "curated/questions/agent-answer.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: `${source.title} Summary`,
          visibility: "private",
          source_ids: [source.source_id],
          source_id: source.source_id,
        },
        "# Agent Query Evidence Summary\n\nThe source supports local agent query automation.\n",
      );
      const fakeCodex = await createFakeCodex(workspaceDir, {
        requiredPromptFragments: [
          `# Query task: ${question}`,
          savePath,
          "Update curated/index.md",
          "Append a query entry to curated/log.md",
          "Run llm-wiki query",
          source.source_id,
        ],
        writes: [
          { path: savePath, content: queryAnswerContent(question, source.source_id) },
          { path: "curated/index.md", content: queryIndexContent(question, savePath) },
          { path: "curated/log.md", content: queryLogContent(question, savePath) },
        ],
      });
      await configureCodexLocalAgent(wikiDir, { command: fakeCodex });
      const rawOriginalBefore = await readFile(resolve(wikiDir, source.original_path), "utf8");

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonSuccess<"query", QueryAgentData>(result.stdout);
      const savedQuestion = await readFile(resolve(wikiDir, savePath), "utf8");
      const logAfter = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toEqual({
        mode: "agent",
        agent: "codex",
        question,
        save_path: savePath,
        saved_path: savePath,
        applied_paths: [
          "curated/index.md",
          "curated/log.md",
          savePath,
        ],
        validation: {
          passed: true,
          issues: [],
        },
      });
      expect(savedQuestion).toContain(`- ${source.source_id}`);
      expect(logAfter).toContain(`query | agent-answer | ${question}`);
      expect(await readFile(resolve(wikiDir, source.original_path), "utf8")).toBe(rawOriginalBefore);
    });
  });

  it("runs the configured default Codex agent with --auto", async () => {
    await withTempWorkspace("llm-wiki-query-agent-auto-success-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What is unknown before curated evidence exists?";
      const savePath = "curated/questions/no-evidence-agent-answer.md";
      await initializeWiki(wikiDir);
      const fakeCodex = await createFakeCodex(workspaceDir, {
        requiredPromptFragments: [
          `# Query task: ${question}`,
          "## Available source IDs\n- None available",
          "source_ids: []",
        ],
        writes: [
          { path: savePath, content: queryAnswerWithoutEvidenceContent(question) },
          { path: "curated/index.md", content: queryIndexContent(question, savePath) },
          { path: "curated/log.md", content: queryLogContent(question, savePath) },
        ],
      });
      await configureCodexLocalAgent(wikiDir, { command: fakeCodex, defaultAgent: "codex" });

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--auto",
        "--json",
      ]);
      const payload = parseJsonSuccess<"query", QueryAgentData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        mode: "agent",
        agent: "codex",
        save_path: savePath,
        saved_path: savePath,
        validation: {
          passed: true,
          issues: [],
        },
      });
      expect(payload.data.applied_paths).toEqual([
        "curated/index.md",
        "curated/log.md",
        savePath,
      ]);
    });
  });

  it("runs --auto from a fresh Codex scaffold", async () => {
    await withTempWorkspace("llm-wiki-query-agent-auto-scaffold-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does a fresh Codex scaffold know?";
      const savePath = "curated/questions/fresh-codex-auto.md";
      const fakeCodex = await createFakeCodex(workspaceDir, {
        requiredPromptFragments: [
          `# Query task: ${question}`,
          "## Available source IDs\n- None available",
          "source_ids: []",
        ],
        writes: [
          { path: savePath, content: queryAnswerWithoutEvidenceContent(question) },
          { path: "curated/index.md", content: queryIndexContent(question, savePath) },
          { path: "curated/log.md", content: queryLogContent(question, savePath) },
        ],
      });
      process.env.PATH = `${dirname(fakeCodex)}:${originalPath ?? ""}`;
      await initializeCodexWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--auto",
        "--json",
      ]);
      const payload = parseJsonSuccess<"query", QueryAgentData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        mode: "agent",
        agent: "codex",
        save_path: savePath,
        saved_path: savePath,
        validation: {
          passed: true,
          issues: [],
        },
      });
      expect(payload.data.applied_paths).toEqual([
        "curated/index.md",
        "curated/log.md",
        savePath,
      ]);
    });
  });

  it("rejects non-zero Codex exits and leaves queue and real repo files unchanged", async () => {
    await withTempWorkspace("llm-wiki-query-agent-command-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What happens when Codex fails?";
      const savePath = "curated/questions/codex-failure.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const fakeCodex = await createFakeCodex(workspaceDir, {
        writes: [
          { path: savePath, content: queryAnswerWithoutEvidenceContent(question) },
          { path: "curated/index.md", content: queryIndexContent(question, savePath) },
        ],
        stderr: "codex failed after writing temp files\n",
        exitCode: 19,
      });
      await configureCodexLocalAgent(wikiDir, { command: fakeCodex });
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("AGENT_COMMAND_FAILED");
      expect(payload.error.message).toContain(fakeCodex);
      expect(payload.error.message).toContain("exit code 19");
      expect(payload.error.message).toContain("changes observed: yes");
      expect(payload.error.hint).toContain("codex failed after writing temp files");
      expect(after).toEqual(before);
      expect(after.get(source.queue_path)).toBe(before.get(source.queue_path));
    });
  });

  it("rejects query agents that create source summaries before applying real writes", async () => {
    await withTempWorkspace("llm-wiki-query-agent-source-summary-reject-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "Can query agents create their own evidence?";
      const savePath = "curated/questions/created-evidence.md";
      const inventedSourceId = "src_2026_06_23_query_agent_deadbeef";
      await initializeWiki(wikiDir);
      const fakeCodex = await createFakeCodex(workspaceDir, {
        writes: [
          { path: `curated/sources/${inventedSourceId}.md`, content: sourceSummaryContent({
            source_id: inventedSourceId,
            title: "Invented Agent Evidence",
            captured_at: "2026-06-23T09:00:00.000Z",
            source_kind: "text",
            visibility: "private",
            queue_status: "queued",
            original_path: "raw/inputs/invented.md",
            source_card_path: "raw/queue/invented/_source.md",
            queue_path: "raw/queue/invented/queue.yml",
          }) },
          { path: savePath, content: queryAnswerContent(question, inventedSourceId) },
          { path: "curated/index.md", content: queryIndexContent(question, savePath) },
          { path: "curated/log.md", content: queryLogContent(question, savePath) },
        ],
      });
      await configureCodexLocalAgent(wikiDir, { command: fakeCodex });
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toEqual({
        code: "AGENT_PROPOSAL_REJECTED",
        message: `Query agent proposals cannot create or modify source summaries: curated/sources/${inventedSourceId}.md.`,
        hint: "Query agent mode may cite only source summaries that existed before the agent proposal.",
      });
      expect(payload.issues[0]).toMatchObject({
        code: "AGENT_PROPOSAL_REJECTED",
        path: `curated/sources/${inventedSourceId}.md`,
      });
      expect(after).toEqual(before);
    });
  });

  it("rejects query agents that write outside the saved-query output set", async () => {
    await withTempWorkspace("llm-wiki-query-agent-extra-output-reject-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What extra files may query agents write?";
      const savePath = "curated/questions/extra-output.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: `${source.title} Summary`,
          visibility: "private",
          source_ids: [source.source_id],
          source_id: source.source_id,
        },
        "# Agent Query Evidence Summary\n\nThe source supports local agent query path boundaries.\n",
      );
      const fakeCodex = await createFakeCodex(workspaceDir, {
        writes: [
          { path: savePath, content: queryAnswerContent(question, source.source_id) },
          { path: "curated/index.md", content: queryIndexContent(question, savePath) },
          { path: "curated/log.md", content: queryLogContent(question, savePath) },
          { path: "curated/questions/extra-answer.md", content: queryAnswerContent("What else?", source.source_id) },
        ],
      });
      await configureCodexLocalAgent(wikiDir, { command: fakeCodex });
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toEqual({
        code: "AGENT_PROPOSAL_REJECTED",
        message: "Query agent proposal path is not an expected saved-query output: curated/questions/extra-answer.md.",
        hint: "Query agent mode may only write curated/questions/extra-output.md, curated/index.md, and curated/log.md.",
      });
      expect(after).toEqual(before);
    });
  });

  it("rejects query agents that modify large non-proposal raw files", async () => {
    await withTempWorkspace("llm-wiki-query-agent-large-raw-reject-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "Can query agents rewrite raw captures?";
      const savePath = "curated/questions/raw-rewrite.md";
      const rawPath = "raw/inputs/large-capture.txt";
      const largeRawContent = "large raw capture that should not become a proposal\n".repeat(200_000);
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "raw/inputs"), { recursive: true });
      await writeFile(resolve(wikiDir, rawPath), largeRawContent, "utf8");
      const fakeCodex = await createFakeCodex(workspaceDir, {
        writes: [
          { path: savePath, content: queryAnswerWithoutEvidenceContent(question) },
          { path: "curated/index.md", content: queryIndexContent(question, savePath) },
          { path: "curated/log.md", content: queryLogContent(question, savePath) },
          { path: rawPath, content: "agent tried to rewrite raw capture\n" },
        ],
      });
      await configureCodexLocalAgent(wikiDir, { command: fakeCodex });

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toEqual({
        code: "AGENT_PROPOSAL_REJECTED",
        message: `Agent proposal path is not allowed: ${rawPath}.`,
        hint: "Agent proposals may only write Markdown files under curated/.",
      });
      await expect(readFile(resolve(wikiDir, rawPath), "utf8")).resolves.toBe(largeRawContent);
      await expect(pathExists(resolve(wikiDir, savePath))).resolves.toBe(false);
    });
  });

  it("rejects invented source IDs during validation and rolls back partial real writes", async () => {
    await withTempWorkspace("llm-wiki-query-agent-validation-rollback-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What provenance did the agent invent?";
      const savePath = "curated/questions/invented-source-id.md";
      const inventedSourceId = "src_2026_06_23_invented_deadbeef";
      await initializeWiki(wikiDir);
      const fakeCodex = await createFakeCodex(workspaceDir, {
        writes: [
          { path: savePath, content: queryAnswerContent(question, inventedSourceId) },
          { path: "curated/index.md", content: queryIndexContent(question, savePath) },
          { path: "curated/log.md", content: queryLogContent(question, savePath) },
        ],
      });
      await configureCodexLocalAgent(wikiDir, { command: fakeCodex });
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--agent",
        "codex",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUERY_VALIDATION_FAILED");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          code: "query_source_ids_unavailable",
          path: savePath,
          message: expect.stringContaining(inventedSourceId),
        }),
      ]);
      expect(after).toEqual(before);
    });
  });
});
