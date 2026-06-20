import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildQueryContext } from "../src/search/context.js";
import { validateQuerySaveReadiness } from "../src/validation/query.js";
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

const originalTimezone = process.env.TZ;
const supportsUnreadableFileTest =
  process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

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

async function captureTextSource(wikiDir: string): Promise<SourceCaptureData["source"]> {
  const result = await runCliBuffered([
    "add-text",
    "--repo",
    wikiDir,
    "--title",
    "Validation Paper",
    "--text",
    "validated evidence about saved query provenance",
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

async function writeValidQueryArtifacts(
  wikiDir: string,
  sourceId: string,
  input: { question?: string; savePath?: string } = {},
): Promise<{ question: string; savePath: string; questionId: string }> {
  const question = input.question ?? "What does validation prove?";
  const savePath = input.savePath ?? "curated/questions/validation-proof.md";
  const questionId = savePath.split("/").pop()?.replace(/\.md$/, "") ?? "validation-proof";
  const indexTarget = savePath.replace(/^curated\//, "").replace(/\.md$/, "");

  await writeCuratedPage(
    wikiDir,
    `curated/sources/${sourceId}.md`,
    {
      type: "source_summary",
      title: "Validation Paper Summary",
      visibility: "private",
      source_ids: [sourceId],
    },
    `# Validation Paper Summary\n\nThe source gives evidence about saved query provenance for: ${question}\n`,
  );
  await writeCuratedPage(
    wikiDir,
    savePath,
    {
      type: "question",
      title: question,
      visibility: "private",
      source_ids: [sourceId],
      open_questions: ["The source does not establish whether the behavior generalizes."],
    },
    `# ${question}\n\nThe answer cites [[sources/${sourceId}|Validation Paper Summary]].\n`,
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
      `- [[${indexTarget}|${question}]]`,
      "",
    ].join("\n"),
    "utf8",
  );
  await appendQueryLogEntry(wikiDir, {
    questionId,
    question,
    savePath,
  });

  return { question, savePath, questionId };
}

async function appendQueryLogEntry(
  wikiDir: string,
  input: { questionId: string; question: string; savePath: string },
): Promise<void> {
  await appendFile(
    resolve(wikiDir, "curated/log.md"),
    [
      "",
      `## [2026-06-19T12:00:00.000Z] query | ${input.questionId} | ${input.question}`,
      "",
      "- actor: test-agent",
      `- command: "llm-wiki query ${JSON.stringify(input.question)} --save ${input.savePath}"`,
      "- git_branch:",
      "- git_commit:",
      "- raw_source:",
      "- created:",
      `  - ${input.savePath}`,
      "- updated:",
      "  - curated/index.md",
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

describe("query save validation", () => {
  it.each([
    "curated/questions/foo|bar.md",
    "curated/questions/foo#bar.md",
    "curated/questions/foo?bar.md",
    "curated/questions/foo|bar/baz.md",
    "curated/questions/foo#bar/baz.md",
    "curated/questions/foo?bar/baz.md",
    "curated/questions/foo\nbar/baz.md",
    "curated/questions/ foo.md",
    "curated/questions/foo .md",
    "curated/questions/foo /bar.md",
  ])("rejects question save slugs that cannot be represented consistently: %s", async (savePath) => {
    // Act
    const validation = await validateQuerySaveReadiness(
      "/not-used",
      "What slug cannot be logged?",
      savePath,
    );

    // Assert
    expect(validation.passed).toBe(false);
    expect(validation.issues).toEqual([
      expect.objectContaining({
        rule_id: "query_save_path_invalid",
        path: savePath,
      }),
    ]);
  });

  it("reports every hard gate for an incomplete saved question", async () => {
    await withTempWorkspace("llm-wiki-query-validation-fail-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-19T11:00:00.000Z"));
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does validation prove?";
      const savePath = "curated/questions/validation-proof.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        `# Validation Paper Summary\n\nThe source gives evidence about saved query provenance for: ${question}\n`,
      );
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "topic",
          title: "",
          source_ids: [],
        },
        "# Validation Proof\n\nThis page asserts an answer but has no provenance and no open questions.\n",
      );

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);
      const cliResult = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--validate",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(cliResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toContain(source.source_id);
      expect(validation.issues.map((issue) => issue.rule_id)).toEqual(
        expect.arrayContaining([
          "query_question_type_invalid",
          "query_question_title_missing",
          "query_question_visibility_missing",
          "query_source_ids_missing",
          "query_open_questions_missing",
          "query_index_missing",
          "query_log_entry_missing",
        ]),
      );
      expect(cliResult.exitCode).toBe(1);
      expect(cliResult.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUERY_VALIDATION_FAILED");
      expect(payload.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "query_question_type_invalid",
          "query_question_title_missing",
          "query_question_visibility_missing",
          "query_source_ids_missing",
          "query_open_questions_missing",
          "query_index_missing",
          "query_log_entry_missing",
        ]),
      );
    });
  });

  it("does not treat raw-only source cards as available query evidence", async () => {
    await withTempWorkspace("llm-wiki-query-validation-raw-only-source-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What is unknown without curated evidence?";
      const savePath = "curated/questions/raw-only-open-question.md";
      await initializeWiki(wikiDir);
      await captureTextSource(wikiDir);
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [],
          open_questions: ["No curated source summary or related page is available for this question."],
        },
        "# What is unknown without curated evidence?\n\nThe answer does not cite raw-only provenance.\n",
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
          "- [[questions/raw-only-open-question|What is unknown without curated evidence?]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "raw-only-open-question",
        question,
        savePath,
      });

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation).toMatchObject({
        passed: true,
        issues: [],
        available_source_ids: [],
      });
    });
  });

  it("rejects queued raw-only source IDs inherited from related curated pages", async () => {
    await withTempWorkspace("llm-wiki-query-validation-raw-only-related-source-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does queued raw provenance prove?";
      const savePath = "curated/questions/queued-raw-provenance.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
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
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [source.source_id],
          open_questions: ["The queued raw source has no curated source summary yet."],
        },
        `# ${question}\n\nThis answer incorrectly cites a queued raw-only source as provenance.\n`,
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
          `- [[questions/queued-raw-provenance|${question}]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "queued-raw-provenance",
        question,
        savePath,
      });

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toEqual([]);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_source_ids_unavailable",
          path: savePath,
          message: expect.stringContaining(source.source_id),
        }),
      ]);
    });
  });

  it("rejects source IDs fabricated on related curated pages", async () => {
    await withTempWorkspace("llm-wiki-query-validation-fabricated-related-source-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does fabricated related provenance prove?";
      const savePath = "curated/questions/fabricated-related-provenance.md";
      const fabricatedSourceId = "src_2026_06_19_fabricated_related_deadbeef";
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/fabricated-related.md",
        {
          type: "topic",
          title: "Fabricated Related",
          visibility: "private",
          source_ids: [fabricatedSourceId],
        },
        `# Fabricated Related\n\n${question} appears here so query context can find this page.\n`,
      );
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [fabricatedSourceId],
          open_questions: ["No curated source summary exists for the cited ID."],
        },
        `# ${question}\n\nThe answer cites fabricated related-page provenance.\n`,
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
          `- [[questions/fabricated-related-provenance|${question}]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "fabricated-related-provenance",
        question,
        savePath,
      });

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toEqual([]);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_source_ids_unavailable",
          path: savePath,
          message: expect.stringContaining(fabricatedSourceId),
        }),
      ]);
    });
  });

  it("accepts cited source summaries even when keyword context misses them", async () => {
    await withTempWorkspace("llm-wiki-query-validation-cited-summary-outside-context-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "Which operational answer is supported?";
      const savePath = "curated/questions/cited-source-summary.md";
      const fabricatedSourceId = "src_2026_06_19_missing_summary_deadbeef";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Archive Note",
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Archive Note\n\nMemo: Orion-7.\n",
      );
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [source.source_id],
          open_questions: [],
        },
        `# ${question}\n\nOrion-7 is supported by [[sources/${source.source_id}|Archive Note]].\n`,
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
          `- [[questions/cited-source-summary|${question}]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "cited-source-summary",
        question,
        savePath,
      });

      // Act
      const context = await buildQueryContext(wikiDir, question, { excludePaths: [savePath] });
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [fabricatedSourceId],
          open_questions: ["No backed source summary exists for the cited source ID."],
        },
        `# ${question}\n\nThis answer cites [[sources/${fabricatedSourceId}|Missing Summary]].\n`,
      );
      const unavailableValidation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(context.source_ids).toEqual([]);
      expect(validation).toMatchObject({
        passed: true,
        issues: [],
        available_source_ids: [source.source_id],
      });
      expect(unavailableValidation.passed).toBe(false);
      expect(unavailableValidation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_source_ids_unavailable",
          path: savePath,
          message: expect.stringContaining(fabricatedSourceId),
        }),
      ]);
    });
  });

  it("requires frontmatter source_ids for source summaries cited in the saved answer body", async () => {
    await withTempWorkspace("llm-wiki-query-validation-body-citation-source-ids-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does body-cited provenance require?";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const artifacts = await writeValidQueryArtifacts(wikiDir, source.source_id, {
        question,
        savePath: "curated/questions/body-cited-provenance.md",
      });
      await writeCuratedPage(
        wikiDir,
        artifacts.savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [],
          open_questions: ["The answer still needs additional corroboration."],
        },
        `# ${question}\n\nThe answer cites [[sources/${source.source_id}|Validation Paper Summary]].\n`,
      );

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, artifacts.savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toEqual([source.source_id]);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_source_ids_missing",
          path: artifacts.savePath,
          message: expect.stringContaining(source.source_id),
        }),
      ]);
    });
  });

  it("rejects unresolved source-summary links cited in the saved answer body", async () => {
    await withTempWorkspace("llm-wiki-query-validation-unresolved-body-citation-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does unresolved body provenance require?";
      const savePath = "curated/questions/unresolved-body-provenance.md";
      const fabricatedSourceId = "src_2026_06_19_fake_deadbeef";
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [],
          open_questions: ["No available source summary backs the cited evidence."],
        },
        `# ${question}\n\nThe answer cites [[sources/${fabricatedSourceId}|Missing Summary]].\n`,
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
          `- [[questions/unresolved-body-provenance|${question}]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "unresolved-body-provenance",
        question,
        savePath,
      });

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toEqual([]);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_source_ids_unavailable",
          path: savePath,
          message: expect.stringContaining(fabricatedSourceId),
        }),
      ]);
    });
  });

  it("rejects encoded source-summary links cited in the saved answer body", async () => {
    await withTempWorkspace("llm-wiki-query-validation-encoded-body-citation-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does encoded body provenance require?";
      const savePath = "curated/questions/encoded-body-provenance.md";
      const fabricatedSourceId = "src_2026_06_19_fake_deadbeef";
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [],
          open_questions: ["No available source summary backs the encoded cited evidence."],
        },
        `# ${question}\n\nThe answer cites [fake](sources%2F${fabricatedSourceId}.md).\n`,
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
          `- [[questions/encoded-body-provenance|${question}]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "encoded-body-provenance",
        question,
        savePath,
      });

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);
      const cliResult = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--validate",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(cliResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toEqual([]);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_source_ids_unavailable",
          path: savePath,
          message: expect.stringContaining(fabricatedSourceId),
        }),
      ]);
      expect(cliResult.exitCode).toBe(1);
      expect(cliResult.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUERY_VALIDATION_FAILED");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          code: "query_source_ids_unavailable",
          path: savePath,
        }),
      ]);
    });
  });

  it.skipIf(!supportsUnreadableFileTest)("does not read raw originals during query validation", async () => {
    await withTempWorkspace("llm-wiki-query-validation-skip-raw-originals-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What is unknown without readable raw originals?";
      const savePath = "curated/questions/unreadable-raw-open-question.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [],
          open_questions: ["The captured raw source has not been converted into curated evidence."],
        },
        "# What is unknown without readable raw originals?\n\nThe answer records missing curated provenance.\n",
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
          "- [[questions/unreadable-raw-open-question|What is unknown without readable raw originals?]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "unreadable-raw-open-question",
        question,
        savePath,
      });
      const rawOriginalPath = resolve(wikiDir, source.original_path);
      await chmod(rawOriginalPath, 0o000);

      let validation: Awaited<ReturnType<typeof validateQuerySaveReadiness>> | null = null;
      try {
        // Act
        validation = await validateQuerySaveReadiness(wikiDir, question, savePath);
      } finally {
        await chmod(rawOriginalPath, 0o600);
      }

      // Assert
      expect(validation).toMatchObject({
        passed: true,
        issues: [],
        available_source_ids: [],
      });
    });
  });

  it("requires an open-question marker when no source IDs are available", async () => {
    await withTempWorkspace("llm-wiki-query-validation-no-sources-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What is unknown without sources?";
      const savePath = "curated/questions/unknown-without-sources.md";
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [],
        },
        "# What is unknown without sources?\n\nThere are no relevant sources in this wiki yet.\n",
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
          "- [[questions/unknown-without-sources|What is unknown without sources?]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "unknown-without-sources",
        question,
        savePath,
      });

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toEqual([]);
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "query_open_questions_missing",
            path: savePath,
          }),
        ]),
      );
      expect(validation.issues).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "query_source_ids_missing",
          }),
        ]),
      );
    });
  });

  it("requires the Open Questions section to contain content", async () => {
    await withTempWorkspace("llm-wiki-query-validation-empty-open-questions-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What is unknown with an empty open question section?";
      const savePath = "curated/questions/empty-open-questions.md";
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [],
        },
        "# What is unknown with an empty open question section?\n\nThere are no relevant sources in this wiki yet.\n\n## Open Questions\n\n",
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
          "- [[questions/empty-open-questions|What is unknown with an empty open question section?]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "empty-open-questions",
        question,
        savePath,
      });

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toEqual([]);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_open_questions_missing",
          path: savePath,
        }),
      ]);
    });
  });

  it("requires source_ids frontmatter even when no source IDs are available", async () => {
    await withTempWorkspace("llm-wiki-query-validation-source-ids-required-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What can be answered before sources exist?";
      const savePath = "curated/questions/no-source-ids-field.md";
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          open_questions: ["No curated evidence exists yet."],
        },
        "# What can be answered before sources exist?\n\nThe answer records the missing evidence.\n",
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
          "- [[questions/no-source-ids-field|What can be answered before sources exist?]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "no-source-ids-field",
        question,
        savePath,
      });

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toEqual([]);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_source_ids_missing",
          path: savePath,
        }),
      ]);
    });
  });

  it("rejects malformed source_ids frontmatter even when no source IDs are available", async () => {
    await withTempWorkspace("llm-wiki-query-validation-source-ids-malformed-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What can be answered with malformed provenance?";
      const savePath = "curated/questions/malformed-source-ids.md";
      await initializeWiki(wikiDir);
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: "not-an-array",
          open_questions: ["No curated evidence exists yet."],
        },
        "# What can be answered with malformed provenance?\n\nThe answer records the missing evidence.\n",
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
          "- [[questions/malformed-source-ids|What can be answered with malformed provenance?]]",
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "malformed-source-ids",
        question,
        savePath,
      });

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toEqual([]);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_source_ids_invalid",
          path: savePath,
        }),
      ]);
    });
  });

  it("rejects saved answers that cite a well-formed but unavailable source ID", async () => {
    await withTempWorkspace("llm-wiki-query-validation-unavailable-source-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does validation prove?";
      const savePath = "curated/questions/validation-proof.md";
      const fabricatedSourceId = "src_2026_06_19_fabricated_evidence_deadbeef";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Validation Paper Summary",
          visibility: "private",
          source_ids: [source.source_id],
        },
        `# Validation Paper Summary\n\nThe source gives evidence about saved query provenance for: ${question}\n`,
      );
      await writeCuratedPage(
        wikiDir,
        savePath,
        {
          type: "question",
          title: question,
          visibility: "private",
          source_ids: [fabricatedSourceId],
          open_questions: ["No available source establishes the fabricated citation."],
        },
        `# ${question}\n\nThe answer cites [[sources/${fabricatedSourceId}|Unavailable Source Summary]].\n`,
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
          `- [[questions/validation-proof|${question}]]`,
          "",
        ].join("\n"),
        "utf8",
      );
      await appendQueryLogEntry(wikiDir, {
        questionId: "validation-proof",
        question,
        savePath,
      });

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);
      const cliResult = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        savePath,
        "--validate",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(cliResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.available_source_ids).toContain(source.source_id);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_source_ids_unavailable",
          path: savePath,
          message: expect.stringContaining(fabricatedSourceId),
        }),
      ]);
      expect(cliResult.exitCode).toBe(1);
      expect(cliResult.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUERY_VALIDATION_FAILED");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          code: "query_source_ids_unavailable",
          path: savePath,
          hint: expect.stringContaining("available source"),
        }),
      ]);
    });
  });

  it("rejects saved answers whose title does not match the requested question", async () => {
    await withTempWorkspace("llm-wiki-query-validation-title-mismatch-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does validation prove?";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const artifacts = await writeValidQueryArtifacts(wikiDir, source.source_id, { question });
      await writeCuratedPage(
        wikiDir,
        artifacts.savePath,
        {
          type: "question",
          title: "What does a different question prove?",
          visibility: "private",
          source_ids: [source.source_id],
          open_questions: ["The source does not establish whether the behavior generalizes."],
        },
        `# What does a different question prove?\n\nThe answer cites [[sources/${source.source_id}|Validation Paper Summary]].\n`,
      );

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, artifacts.savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_question_title_mismatch",
          path: artifacts.savePath,
        }),
      ]);
    });
  });

  it("rejects saved answers with unsupported visibility values through query --validate", async () => {
    await withTempWorkspace("llm-wiki-query-validation-visibility-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does validation prove?";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const artifacts = await writeValidQueryArtifacts(wikiDir, source.source_id, { question });
      await writeCuratedPage(
        wikiDir,
        artifacts.savePath,
        {
          type: "question",
          title: question,
          visibility: "draft",
          source_ids: [source.source_id],
          open_questions: [],
        },
        `# ${question}\n\nThe answer cites [[sources/${source.source_id}|Validation Paper Summary]].\n`,
      );

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, artifacts.savePath);
      const cliResult = await runCliBuffered([
        "query",
        question,
        "--repo",
        wikiDir,
        "--save",
        artifacts.savePath,
        "--validate",
        "--json",
      ]);
      const payload = parseJsonFailure<"query">(cliResult.stdout);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_question_visibility_invalid",
          path: artifacts.savePath,
        }),
      ]);
      expect(cliResult.exitCode).toBe(1);
      expect(cliResult.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUERY_VALIDATION_FAILED");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          code: "query_question_visibility_invalid",
          path: artifacts.savePath,
          hint: "Use visibility: private or visibility: public.",
        }),
      ]);
    });
  });

  it("passes when a saved question has required metadata, provenance, index coverage, and a log entry", async () => {
    await withTempWorkspace("llm-wiki-query-validation-pass-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const artifacts = await writeValidQueryArtifacts(wikiDir, source.source_id);

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, artifacts.question, artifacts.savePath);

      // Assert
      expect(validation).toMatchObject({
        question: artifacts.question,
        save_path: artifacts.savePath,
        passed: true,
        issues: [],
        available_source_ids: [source.source_id],
      });
    });
  });

  it("passes a fully sourced saved question with empty open_questions", async () => {
    await withTempWorkspace("llm-wiki-query-validation-empty-open-questions-sourced-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const artifacts = await writeValidQueryArtifacts(wikiDir, source.source_id);
      await writeCuratedPage(
        wikiDir,
        artifacts.savePath,
        {
          type: "question",
          title: artifacts.question,
          visibility: "private",
          source_ids: [source.source_id],
          open_questions: [],
        },
        `# ${artifacts.question}\n\nThe answer cites [[sources/${source.source_id}|Validation Paper Summary]].\n`,
      );

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, artifacts.question, artifacts.savePath);

      // Assert
      expect(validation).toMatchObject({
        passed: true,
        issues: [],
        available_source_ids: [source.source_id],
      });
    });
  });

  it.each([
    {
      name: "frontmatter",
      frontmatterOpenQuestions: ["No available source establishes the requested answer."],
      bodySuffix: "",
    },
    {
      name: "section",
      frontmatterOpenQuestions: [],
      bodySuffix: "\n\n## Open Questions\n\n- No available source establishes the requested answer.",
    },
  ])(
    "passes an unsupported saved question with available sources when missing provenance is recorded in $name",
    async ({ name, frontmatterOpenQuestions, bodySuffix }) => {
      await withTempWorkspace(`llm-wiki-query-validation-open-question-only-${name}-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        const source = await captureTextSource(wikiDir);
        const artifacts = await writeValidQueryArtifacts(wikiDir, source.source_id, {
          question: "What remains unsupported by the available sources?",
          savePath: `curated/questions/open-question-only-${name}.md`,
        });
        await writeCuratedPage(
          wikiDir,
          artifacts.savePath,
          {
            type: "question",
            title: artifacts.question,
            visibility: "private",
            source_ids: [],
            open_questions: frontmatterOpenQuestions,
          },
          `# ${artifacts.question}\n\nThe available curated evidence does not establish an answer.${bodySuffix}\n`,
        );

        // Act
        const validation = await validateQuerySaveReadiness(wikiDir, artifacts.question, artifacts.savePath);

        // Assert
        expect(validation).toMatchObject({
          passed: true,
          issues: [],
          available_source_ids: [source.source_id],
        });
      });
    },
  );

  it.each([
    {
      name: "basename",
      question: "What does basename index coverage prove?",
      savePath: "curated/questions/foo.md",
      indexTarget: "foo",
    },
    {
      name: "title",
      question: "What does title index coverage prove?",
      savePath: "curated/questions/title-index-coverage.md",
      indexTarget: "What does title index coverage prove?",
    },
  ])("passes when the index references the saved question by $name wikilink", async ({ name, question, savePath, indexTarget }) => {
    await withTempWorkspace(`llm-wiki-query-validation-index-${name}-wikilink-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeValidQueryArtifacts(wikiDir, source.source_id, { question, savePath });
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
          `- [[${indexTarget}]]`,
          "",
        ].join("\n"),
        "utf8",
      );

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation).toMatchObject({
        passed: true,
        issues: [],
        available_source_ids: [source.source_id],
      });
    });
  });

  it("does not accept a query log entry that only mentions the saved path in command text", async () => {
    await withTempWorkspace("llm-wiki-query-validation-log-command-only-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does command-only log text prove?";
      const savePath = "curated/questions/command-only-log.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeValidQueryArtifacts(wikiDir, source.source_id, { question, savePath });
      await writeFile(
        resolve(wikiDir, "curated/log.md"),
        [
          "# Log",
          "",
          `## [2026-06-19T12:00:00.000Z] query | command-only-log | ${question}`,
          "",
          "- actor: test-agent",
          `- command: "llm-wiki query ${JSON.stringify(question)} --save ${savePath}"`,
          "- git_branch:",
          "- git_commit:",
          "- raw_source:",
          "- created:",
          "- updated:",
          "- contradictions:",
          "- follow_ups:",
          "",
        ].join("\n"),
        "utf8",
      );

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_log_entry_missing",
          path: "curated/log.md",
        }),
      ]);
    });
  });

  it("does not accept an index link whose target only prefixes the saved question path", async () => {
    await withTempWorkspace("llm-wiki-query-validation-index-prefix-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does the short prefix prove?";
      const savePath = "curated/questions/foo.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeValidQueryArtifacts(wikiDir, source.source_id, { question, savePath });
      await writeCuratedPage(
        wikiDir,
        "curated/questions/foo-bar.md",
        {
          type: "question",
          title: "Different saved question",
          visibility: "private",
          source_ids: [source.source_id],
          open_questions: [],
        },
        "# Different saved question\n\nThis page is a distinct saved answer.\n",
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
          "- [[questions/foo-bar|Different saved question]]",
          "",
        ].join("\n"),
        "utf8",
      );

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_index_missing",
          path: "curated/index.md",
        }),
      ]);
    });
  });

  it("does not accept a query log entry whose saved path only prefixes another path", async () => {
    await withTempWorkspace("llm-wiki-query-validation-log-prefix-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What does the log prefix prove?";
      const savePath = "curated/questions/foo.md";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await writeValidQueryArtifacts(wikiDir, source.source_id, { question, savePath });
      await writeFile(
        resolve(wikiDir, "curated/log.md"),
        [
          "# Log",
          "",
          `## [2026-06-19T12:00:00.000Z] query | foo | ${question}`,
          "",
          "- actor: test-agent",
          `- command: "llm-wiki query ${JSON.stringify(question)} --save curated/questions/foo-bar.md"`,
          "- git_branch:",
          "- git_commit:",
          "- raw_source:",
          "- created:",
          "  - curated/questions/foo-bar.md",
          "- updated:",
          "  - curated/index.md",
          "- contradictions:",
          "- follow_ups:",
          "",
        ].join("\n"),
        "utf8",
      );

      // Act
      const validation = await validateQuerySaveReadiness(wikiDir, question, savePath);

      // Assert
      expect(validation.passed).toBe(false);
      expect(validation.issues).toEqual([
        expect.objectContaining({
          rule_id: "query_log_entry_missing",
          path: "curated/log.md",
        }),
      ]);
    });
  });
});
