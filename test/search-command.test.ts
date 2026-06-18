import { mkdir, writeFile } from "node:fs/promises";
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
    source_kind: "file" | "text" | "url";
    visibility: "private";
    queue_status: "queued";
    original_path: string;
    source_card_path: string;
    queue_path: string;
  };
};

type SearchData = {
  query: string;
  scope: "raw" | "curated" | "all";
  results: Array<{
    path: string;
    page_type: string;
    title: string;
    snippet: string;
    score: number;
    source_ids: string[];
    visibility: string | null;
    match_fields: Array<"title" | "alias" | "tag" | "heading" | "body" | "source_id">;
  }>;
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

async function captureTextSource(wikiDir: string): Promise<SourceCaptureData["source"]> {
  const result = await runCliBuffered([
    "add-text",
    "--repo",
    wikiDir,
    "--title",
    "Transformer Paper",
    "--text",
    "raw evidence about retrieval memory",
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

async function arrangeSearchWiki(workspaceDir: string): Promise<{
  wikiDir: string;
  sourceId: string;
  sourceCardPath: string;
}> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-17T11:28:42.778Z"));
  const wikiDir = resolve(workspaceDir, "wiki");
  await initializeWiki(wikiDir);
  const source = await captureTextSource(wikiDir);
  await writeCuratedPage(
    wikiDir,
    `curated/sources/${source.source_id}.md`,
    {
      type: "source_summary",
      title: "Transformer Paper Summary",
      visibility: "private",
      aliases: ["Attention Notes"],
      tags: ["paper"],
      source_ids: [source.source_id],
    },
    "# Transformer Paper Summary\n\n## Capture Signals\n\nCurated summary mentions reciprocal rank fusion.\n",
  );
  await writeCuratedPage(
    wikiDir,
    "curated/topics/memory-retrieval.md",
    {
      type: "topic",
      title: "Memory Retrieval",
      visibility: "private",
      aliases: ["Recall System"],
      tags: ["rag", "retrieval"],
      source_ids: [source.source_id],
    },
    "# Memory Retrieval\n\nHybrid lexical search keeps local notes discoverable.\n\n## Ranking Signals\n\nSee [[sources/" +
      source.source_id +
      "|primary source summary]].\n",
  );

  return {
    wikiDir,
    sourceId: source.source_id,
    sourceCardPath: source.source_card_path,
  };
}

describe("search command", () => {
  it("returns deterministic offline matches for title, alias, tag, heading, body, and source IDs", async () => {
    await withTempWorkspace("llm-wiki-search-fields-", async (workspaceDir) => {
      // Arrange
      const { wikiDir, sourceId, sourceCardPath } = await arrangeSearchWiki(workspaceDir);

      // Act
      const titleResult = await runCliBuffered(["search", "Memory Retrieval", "--repo", wikiDir, "--json"]);
      const aliasResult = await runCliBuffered(["search", "Recall System", "--repo", wikiDir, "--json"]);
      const tagResult = await runCliBuffered(["search", "rag", "--repo", wikiDir, "--json"]);
      const headingResult = await runCliBuffered(["search", "Ranking Signals", "--repo", wikiDir, "--json"]);
      const bodyResult = await runCliBuffered(["search", "reciprocal rank", "--repo", wikiDir, "--json"]);
      const sourceIdResult = await runCliBuffered(["search", sourceId, "--repo", wikiDir, "--scope", "all", "--json"]);
      const titlePayload = parseJsonSuccess<"search", SearchData>(titleResult.stdout);
      const aliasPayload = parseJsonSuccess<"search", SearchData>(aliasResult.stdout);
      const tagPayload = parseJsonSuccess<"search", SearchData>(tagResult.stdout);
      const headingPayload = parseJsonSuccess<"search", SearchData>(headingResult.stdout);
      const bodyPayload = parseJsonSuccess<"search", SearchData>(bodyResult.stdout);
      const sourceIdPayload = parseJsonSuccess<"search", SearchData>(sourceIdResult.stdout);

      // Assert
      for (const result of [titleResult, aliasResult, tagResult, headingResult, bodyResult, sourceIdResult]) {
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
      }
      expect(titlePayload.data.results[0]).toMatchObject({
        path: "curated/topics/memory-retrieval.md",
        page_type: "topic",
        title: "Memory Retrieval",
        snippet: "Memory Retrieval",
        score: 150,
        source_ids: [sourceId],
        visibility: "private",
        match_fields: ["title", "heading"],
      });
      expect(aliasPayload.data.results[0]).toMatchObject({
        path: "curated/topics/memory-retrieval.md",
        match_fields: ["alias"],
        score: 80,
      });
      expect(tagPayload.data.results[0]).toMatchObject({
        path: "curated/topics/memory-retrieval.md",
        match_fields: ["tag"],
        score: 60,
      });
      expect(headingPayload.data.results[0]).toMatchObject({
        path: "curated/topics/memory-retrieval.md",
        match_fields: ["heading"],
        score: 50,
      });
      expect(bodyPayload.data.results[0]).toMatchObject({
        path: `curated/sources/${sourceId}.md`,
        page_type: "source_summary",
        title: "Transformer Paper Summary",
        snippet: "Curated summary mentions reciprocal rank fusion.",
        score: 10,
        source_ids: [sourceId],
        visibility: "private",
        match_fields: ["body"],
      });
      expect(sourceIdPayload.data.results.map((result) => result.path)).toEqual([
        sourceCardPath,
        `curated/sources/${sourceId}.md`,
        "curated/topics/memory-retrieval.md",
      ]);
      expect(sourceIdPayload.data.results[0]).toMatchObject({
        path: sourceCardPath,
        page_type: "raw_source",
        title: "Transformer Paper",
        source_ids: [sourceId],
        visibility: "private",
        match_fields: ["source_id"],
      });
    });
  });

  it("limits search scope to curated pages or raw source cards without reading Quartz output", async () => {
    await withTempWorkspace("llm-wiki-search-scope-", async (workspaceDir) => {
      // Arrange
      const { wikiDir, sourceId, sourceCardPath } = await arrangeSearchWiki(workspaceDir);
      await mkdir(resolve(wikiDir, "quartz/content"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/content/leak.md"), "# Transformer Paper\n\nDo not scan generated output.\n", "utf8");

      // Act
      const rawResult = await runCliBuffered(["search", sourceId, "--repo", wikiDir, "--scope", "raw", "--json"]);
      const curatedResult = await runCliBuffered(["search", sourceId, "--repo", wikiDir, "--scope", "curated", "--json"]);
      const rawPayload = parseJsonSuccess<"search", SearchData>(rawResult.stdout);
      const curatedPayload = parseJsonSuccess<"search", SearchData>(curatedResult.stdout);

      // Assert
      expect(rawResult.exitCode).toBe(0);
      expect(curatedResult.exitCode).toBe(0);
      expect(rawPayload.data).toMatchObject({ query: sourceId, scope: "raw" });
      expect(rawPayload.data.results.map((result) => result.path)).toEqual([sourceCardPath]);
      expect(curatedPayload.data).toMatchObject({ query: sourceId, scope: "curated" });
      expect(curatedPayload.data.results.map((result) => result.path)).toEqual([
        `curated/sources/${sourceId}.md`,
        "curated/topics/memory-retrieval.md",
      ]);
      expect([...rawPayload.data.results, ...curatedPayload.data.results].map((result) => result.path)).not.toContain(
        "quartz/content/leak.md",
      );
    });
  });

  it("excludes raw scaffold Markdown from raw and all search inputs", async () => {
    await withTempWorkspace("llm-wiki-search-raw-scaffold-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const rawResult = await runCliBuffered(["search", "Raw Sources", "--repo", wikiDir, "--scope", "raw", "--json"]);
      const allResult = await runCliBuffered(["search", "Raw Sources", "--repo", wikiDir, "--scope", "all", "--json"]);
      const rawPayload = parseJsonSuccess<"search", SearchData>(rawResult.stdout);
      const allPayload = parseJsonSuccess<"search", SearchData>(allResult.stdout);

      // Assert
      expect(rawResult.exitCode).toBe(0);
      expect(allResult.exitCode).toBe(0);
      expect(rawPayload.data.results).toEqual([]);
      expect(allPayload.data.results.map((result) => result.path)).not.toContain("raw/README.md");
      expect(allPayload.data.results).toEqual([]);
    });
  });

  it("rejects invalid search scopes without widening results", async () => {
    await withTempWorkspace("llm-wiki-search-invalid-scope-", async (workspaceDir) => {
      // Arrange
      const { wikiDir } = await arrangeSearchWiki(workspaceDir);

      // Act
      const result = await runCliBuffered(["search", "paper", "--repo", wikiDir, "--scope", "curted", "--json"]);
      const payload = parseJsonFailure<"search">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: false,
        command: "search",
        repo: wikiDir,
        error: {
          code: "INVALID_SEARCH_SCOPE",
          message: "Invalid search scope: curted",
          hint: "Use --scope raw, --scope curated, or --scope all.",
        },
        issues: [
          {
            severity: "error",
            code: "INVALID_SEARCH_SCOPE",
            message: "Invalid search scope: curted",
            path: "--scope",
            hint: "Use --scope raw, --scope curated, or --scope all.",
          },
        ],
      });
    });
  });
});
