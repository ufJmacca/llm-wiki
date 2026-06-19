import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseLogEntries } from "../src/scanner/index.js";
import {
  parseInitJson,
  readGeneratedFile,
  readTreeSnapshot,
  runCliBuffered,
  withTempWorkspace,
} from "./helpers/init.js";

type RuntimeEnvelope<Data> = {
  ok: true;
  command: "add-url";
  repo: string;
  data: Data;
  warnings: string[];
};

type RuntimeFailureEnvelope = {
  ok: false;
  command: "add-url";
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
    source_kind: "url";
    origin: string;
    origin_url: string;
    captured_at: string;
    content_hash: string;
    visibility: "private";
    queue_status: "queued";
    original_path: string;
    source_card_path: string;
    queue_path: string;
  };
  created_paths: string[];
};

const capturedAt = "2026-06-17T11:28:42.778Z";
const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function expectedSourceId(title: string, content: string | Buffer): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  return `src_2026_06_17_${slug}_${sha256Hex(content).slice(0, 12)}`;
}

function parseJsonEnvelope<Data>(stdout: string[]): RuntimeEnvelope<Data> {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as RuntimeEnvelope<Data>;
}

function parseJsonFailureEnvelope(stdout: string[]): RuntimeFailureEnvelope {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as RuntimeFailureEnvelope;
}

function parseSourceCardFrontmatter<T>(content: string): T {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(frontmatter).not.toBeNull();

  return parse(frontmatter?.[1] ?? "") as T;
}

function mockFetchResponse(body: string, init: ResponseInit = {}, responseUrl?: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    const response = new Response(body, init);
    if (responseUrl !== undefined) {
      Object.defineProperty(response, "url", { value: responseUrl });
    }

    return response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  return fetchMock;
}

function mockFetchFailure(error: Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    throw error;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  return fetchMock;
}

describe("URL source capture", () => {
  it("adds a fetchable URL as private original.md with URL metadata, queue JSON, and a log entry", async () => {
    await withTempWorkspace("llm-wiki-add-url-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const url = "https://example.com/research/url-note";
      const title = "Fetched URL Note";
      const content = "# Fetched URL Note\n\nCaptured from the web.\n";
      const hash = sha256Hex(content);
      const sourceId = expectedSourceId(title, content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      const fetchMock = mockFetchResponse(content, {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["add-url", url, "--repo", wikiDir, "--title", title, "--json"]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(fetchMock).toHaveBeenCalledWith(url);
      expect(payload).toEqual({
        ok: true,
        command: "add-url",
        repo: wikiDir,
        data: {
          status: "added",
          source: {
            source_id: sourceId,
            title,
            source_kind: "url",
            origin: "url",
            origin_url: url,
            captured_at: capturedAt,
            content_hash: `sha256:${hash}`,
            visibility: "private",
            queue_status: "queued",
            original_path: `${sourceDir}/original.md`,
            source_card_path: `${sourceDir}/_source.md`,
            queue_path: `raw/queue/${sourceId}.json`,
          },
          created_paths: [`${sourceDir}/original.md`, `${sourceDir}/_source.md`, `raw/queue/${sourceId}.json`],
        },
        warnings: [],
      });
      expect(await readGeneratedFile(wikiDir, `${sourceDir}/original.md`)).toBe(content);
      const sourceCard = parseSourceCardFrontmatter<{
        type: string;
        source_id: string;
        title: string;
        source_kind: string;
        origin: string;
        origin_url: string;
        captured_at: string;
        content_hash: string;
        status: string;
        visibility: string;
      }>(await readGeneratedFile(wikiDir, `${sourceDir}/_source.md`));
      expect(sourceCard).toMatchObject({
        type: "raw_source",
        source_id: sourceId,
        title,
        source_kind: "url",
        origin: "url",
        origin_url: url,
        captured_at: capturedAt,
        content_hash: `sha256:${hash}`,
        status: "queued",
        visibility: "private",
      });
      const queueItem = JSON.parse(await readGeneratedFile(wikiDir, `raw/queue/${sourceId}.json`)) as {
        kind: string;
        source_id: string;
        title: string;
        source_kind: string;
        origin: string;
        origin_url: string;
        status: string;
        path: string;
        original_path: string;
        content_hash: string;
      };
      expect(queueItem).toMatchObject({
        kind: "url",
        source_id: sourceId,
        title,
        source_kind: "url",
        origin: "url",
        origin_url: url,
        status: "queued",
        path: `${sourceDir}/_source.md`,
        original_path: `${sourceDir}/original.md`,
        content_hash: `sha256:${hash}`,
      });
      const parsedLog = parseLogEntries({
        path: "curated/log.md",
        content: await readGeneratedFile(wikiDir, "curated/log.md"),
      });
      expect(parsedLog.issues).toEqual([]);
      expect(parsedLog.entries).toEqual([
        expect.objectContaining({
          timestamp: capturedAt,
          operation: "add",
          affectedId: sourceId,
          title,
        }),
      ]);
      expect(parsedLog.entries[0]?.body).toContain(`- command: ${JSON.stringify(`llm-wiki add-url ${url} --title ${title}`)}`);
    });
  });

  it("derives a stable title from the URL when no title is provided", async () => {
    await withTempWorkspace("llm-wiki-add-url-title-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const url = "https://docs.example.test/guides/capture-patterns?ref=queue";
      const content = "Capture patterns from a URL.\n";
      const sourceId = expectedSourceId("capture-patterns", content);
      mockFetchResponse(content, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["add-url", url, "--repo", wikiDir, "--json"]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.source).toMatchObject({
        source_id: sourceId,
        title: "capture-patterns",
        source_kind: "url",
        origin: "url",
        origin_url: url,
      });
    });
  });

  it("derives fallback metadata from the final fetched URL after redirects", async () => {
    await withTempWorkspace("llm-wiki-add-url-redirect-title-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const url = "https://short.example.test/x";
      const finalUrl = "https://docs.example.test/articles/final-article.md";
      const content = "Redirected article body.\n";
      const sourceId = expectedSourceId("final-article", content);
      const fetchMock = mockFetchResponse(
        content,
        {
          status: 200,
          headers: { "content-type": "text/markdown" },
        },
        finalUrl,
      );
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["add-url", url, "--repo", wikiDir, "--json"]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);
      const queueItem = JSON.parse(await readGeneratedFile(wikiDir, payload.data.source.queue_path)) as {
        origin_url: string;
      };

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(fetchMock).toHaveBeenCalledWith(url);
      expect(payload.data.source).toMatchObject({
        source_id: sourceId,
        title: "final-article",
        origin_url: finalUrl,
      });
      expect(queueItem.origin_url).toBe(finalUrl);
    });
  });

  it.each([
    {
      name: "invalid URL",
      url: "notaurl",
      setupFetch: () => vi.fn(),
      expected: {
        code: "URL_INVALID",
        message: "URL capture requires a valid http(s) URL.",
        path: "url",
        hint: "Pass an absolute http:// or https:// URL to llm-wiki add-url.",
      },
      expectFetchCalls: false,
    },
    {
      name: "network failure",
      url: "https://example.com/unreachable",
      setupFetch: () => mockFetchFailure(new Error("socket hang up")),
      expected: {
        code: "URL_FETCH_FAILED",
        message: "Could not fetch URL: https://example.com/unreachable",
        path: "https://example.com/unreachable",
        hint: "Check the URL and network connection, then try again.",
      },
      expectFetchCalls: true,
    },
    {
      name: "non-2xx status",
      url: "https://example.com/missing",
      setupFetch: () => mockFetchResponse("not found", { status: 404, headers: { "content-type": "text/plain" } }),
      expected: {
        code: "URL_FETCH_FAILED",
        message: "URL fetch returned HTTP 404 for https://example.com/missing",
        path: "https://example.com/missing",
        hint: "Fetchable URLs must return a successful HTTP status.",
      },
      expectFetchCalls: true,
    },
    {
      name: "empty response",
      url: "https://example.com/empty",
      setupFetch: () => mockFetchResponse("", { status: 200, headers: { "content-type": "text/plain" } }),
      expected: {
        code: "URL_EMPTY_RESPONSE",
        message: "URL response was empty: https://example.com/empty",
        path: "https://example.com/empty",
        hint: "Capture a URL that returns non-empty text content.",
      },
      expectFetchCalls: true,
    },
    {
      name: "unsupported response body",
      url: "https://example.com/report.pdf",
      setupFetch: () => mockFetchResponse("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }),
      expected: {
        code: "URL_UNSUPPORTED_RESPONSE",
        message: "URL response content type is not supported: application/pdf",
        path: "https://example.com/report.pdf",
        hint: "Capture URLs that return text, Markdown, HTML, XML, or JSON content.",
      },
      expectFetchCalls: true,
    },
  ])("fails without partial writes for $name", async ({ url, setupFetch, expected, expectFetchCalls }) => {
    await withTempWorkspace("llm-wiki-add-url-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fetchMock = setupFetch();
      await initializeWiki(wikiDir);
      const beforeFailure = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered(["add-url", url, "--repo", wikiDir, "--title", "Failure", "--json"]);
      const payload = parseJsonFailureEnvelope(result.stdout);
      const afterFailure = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(expectFetchCalls ? 1 : 0);
      expect(payload).toEqual({
        ok: false,
        command: "add-url",
        repo: wikiDir,
        error: {
          code: expected.code,
          message: expected.message,
          hint: expected.hint,
        },
        issues: [
          {
            severity: "error",
            code: expected.code,
            message: expected.message,
            path: expected.path,
            hint: expected.hint,
          },
        ],
      });
      expect(afterFailure).toEqual(beforeFailure);
    });
  });

  it("returns existing source metadata for duplicate fetched content without writing new files", async () => {
    await withTempWorkspace("llm-wiki-add-url-duplicate-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const firstUrl = "https://example.com/first";
      const secondUrl = "https://example.com/second";
      const content = "The same fetched body.\n";
      const sourceId = expectedSourceId("First URL", content);
      await initializeWiki(wikiDir);
      mockFetchResponse(content, { status: 200, headers: { "content-type": "text/plain" } });
      const firstAdd = await runCliBuffered([
        "add-url",
        firstUrl,
        "--repo",
        wikiDir,
        "--title",
        "First URL",
        "--json",
      ]);
      expect(firstAdd.exitCode).toBe(0);
      const beforeDuplicate = await readTreeSnapshot(wikiDir);
      mockFetchResponse(content, { status: 200, headers: { "content-type": "text/plain" } });

      // Act
      const result = await runCliBuffered([
        "add-url",
        secondUrl,
        "--repo",
        wikiDir,
        "--title",
        "Second URL",
        "--json",
      ]);
      const payload = parseJsonEnvelope<SourceCaptureData>(result.stdout);
      const afterDuplicate = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        status: "duplicate",
        source: {
          source_id: sourceId,
          title: "First URL",
          source_kind: "url",
          origin: "url",
          origin_url: firstUrl,
          queue_status: "queued",
        },
        created_paths: [],
      });
      expect(afterDuplicate).toEqual(beforeDuplicate);
    });
  });

  it("prints add-family human output for URL captures", async () => {
    await withTempWorkspace("llm-wiki-add-url-human-", async (workspaceDir) => {
      // Arrange
      vi.useFakeTimers();
      vi.setSystemTime(new Date(capturedAt));
      const wikiDir = resolve(workspaceDir, "wiki");
      const url = "https://example.com/human-output";
      const title = "Human URL";
      const content = "Human-readable URL output.\n";
      const sourceId = expectedSourceId(title, content);
      const sourceDir = `raw/inputs/2026/06/${sourceId}`;
      mockFetchResponse(content, { status: 200, headers: { "content-type": "text/plain" } });
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["add-url", url, "--repo", wikiDir, "--title", title]);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(result.stdout).toEqual([
        [
          "URL source captured",
          `Source ID: ${sourceId}`,
          `Title: ${title}`,
          `Original: ${sourceDir}/original.md`,
          `Queue: raw/queue/${sourceId}.json`,
        ].join("\n"),
      ]);
      expect(await readFile(resolve(wikiDir, `${sourceDir}/original.md`), "utf8")).toBe(content);
    });
  });
});
