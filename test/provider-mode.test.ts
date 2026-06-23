import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseInitJson, readTreeSnapshot, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

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
    content_hash: string;
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
    frontmatter: {
      status: "queued" | "ingesting" | "ingested" | "blocked";
    };
  };
};

type IngestProviderData = {
  mode: "provider";
  provider: {
    name: string;
    model: string | null;
  };
  source: {
    source_id: string;
    status: "ingested";
  };
  proposals: {
    applied_paths: string[];
  };
  validation: {
    passed: true;
    issues: [];
  };
  queue: {
    previous_status: "queued" | "ingesting" | "ingested";
    status: "ingested";
  };
};

type QueryProviderData = {
  mode: "provider";
  provider: {
    name: string;
    model: string | null;
  };
  question: string;
  save_path: string;
  proposals: {
    applied_paths: string[];
  };
  validation: {
    passed: true;
    issues: [];
  };
};

type ProviderRequest = {
  headers: IncomingMessage["headers"];
  body: string;
};

type ProviderServer = {
  url: string;
  requests: ProviderRequest[];
  close: () => Promise<void>;
};

type ProviderFileProposal = {
  path: string;
  content: string;
};

const originalTimezone = process.env.TZ;
const originalProviderToken = process.env.LLM_WIKI_PROVIDER_TEST_TOKEN;
const originalConfiguredProviderToken = process.env.LLM_WIKI_PROVIDER_CONFIGURED_TOKEN;
const execFileAsync = promisify(execFile);

afterEach(() => {
  vi.useRealTimers();
  if (originalTimezone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
  if (originalProviderToken === undefined) {
    delete process.env.LLM_WIKI_PROVIDER_TEST_TOKEN;
  } else {
    process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = originalProviderToken;
  }
  if (originalConfiguredProviderToken === undefined) {
    delete process.env.LLM_WIKI_PROVIDER_CONFIGURED_TOKEN;
  } else {
    process.env.LLM_WIKI_PROVIDER_CONFIGURED_TOKEN = originalConfiguredProviderToken;
  }
});

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function initializeGitWorktreeWiki(workspaceDir: string): Promise<string> {
  const repoDir = resolve(workspaceDir, "repo");
  const worktreeDir = resolve(workspaceDir, "wiki-worktree");

  await initializeWiki(repoDir);
  await execFileAsync("git", ["-C", repoDir, "init"]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", "Test User"]);
  await execFileAsync("git", ["-C", repoDir, "add", "."]);
  await execFileAsync("git", ["-C", repoDir, "commit", "-m", "Initial wiki"]);
  await execFileAsync("git", ["-C", repoDir, "branch", "-M", "main"]);
  await execFileAsync("git", ["-C", repoDir, "worktree", "add", "-b", "provider-worktree", worktreeDir]);

  return worktreeDir;
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
    input.title ?? "Provider Paper",
    "--text",
    input.text ?? "provider evidence about proposal validation",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(payload.data.status).toBe("added");

  return payload.data.source;
}

async function appendProviderConfig(
  wikiDir: string,
  input: { endpoint: string; providerName?: string; envName?: string; extraYaml?: string },
): Promise<void> {
  await appendFile(
    resolve(wikiDir, ".llm-wiki/config.yml"),
    [
      "",
      "providers:",
      `  ${input.providerName ?? "local"}:`,
      "    type: http",
      `    endpoint: ${JSON.stringify(input.endpoint)}`,
      `    api_key_env: ${input.envName ?? "LLM_WIKI_PROVIDER_TEST_TOKEN"}`,
      "    model: provider-test-model",
      ...(input.extraYaml === undefined ? [] : input.extraYaml.split("\n").map((line) => `    ${line}`)),
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

async function waitForFilesystemTimestamp(): Promise<void> {
  await new Promise((resolveWait) => {
    setTimeout(resolveWait, 20);
  });
}

async function startProviderServer(
  handler: (request: ProviderRequest) => { status?: number; body: string; contentType?: string },
): Promise<ProviderServer> {
  const requests: ProviderRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    const providerRequest = {
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(providerRequest);
    const providerResponse = handler(providerRequest);
    response.statusCode = providerResponse.status ?? 200;
    response.setHeader("content-type", providerResponse.contentType ?? "application/json");
    response.end(providerResponse.body);
  });
  await listen(server);
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Provider test server did not bind to a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => close(server),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }

      resolveClose();
    });
  });
}

function providerOutput(files: ProviderFileProposal[]): string {
  return JSON.stringify({ files });
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
    "The source supports provider proposal validation.",
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
    `## [2026-06-19T12:00:00.000Z] ingest | ${source.source_id} | Provider ingest completed`,
    "",
    "- actor: provider-test",
    `- command: "llm-wiki ingest ${source.source_id} --provider local"`,
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

function queryAnswerContent(question: string, sourceId: string): string {
  return [
    "---",
    "type: question",
    `title: ${JSON.stringify(question)}`,
    "visibility: private",
    "source_ids:",
    `  - ${sourceId}`,
    "open_questions:",
    "  - The source does not establish long-term production behavior.",
    "---",
    "",
    `# ${question}`,
    "",
    `The answer cites [[sources/${sourceId}|the source summary]].`,
    "",
  ].join("\n");
}

function queryIndexContent(question: string): string {
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
    `- [[questions/provider-answer|${question}]]`,
    "",
  ].join("\n");
}

function queryLogContent(question: string): string {
  return [
    "# Log",
    "",
    `## [2026-06-19T13:00:00.000Z] query | provider-answer | ${question}`,
    "",
    "- actor: provider-test",
    `- command: "llm-wiki query ${JSON.stringify(question)} --save curated/questions/provider-answer.md --provider local"`,
    "- git_branch:",
    "- git_commit:",
    "- raw_source:",
    "- created:",
    "  - curated/questions/provider-answer.md",
    "- updated:",
    "  - curated/index.md",
    "- contradictions:",
    "- follow_ups:",
    "",
  ].join("\n");
}

describe("explicit provider proposal mode", () => {
  it("keeps ingest task-first unless --provider is explicitly requested", async () => {
    await withTempWorkspace("llm-wiki-provider-default-ingest-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);

      // Act
      const result = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"ingest", { mode: "task" }>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.mode).toBe("task");
    });
  });

  it("keeps ingest task-first when a provider is configured but --provider is omitted", async () => {
    await withTempWorkspace("llm-wiki-provider-configured-ingest-task-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "configured-provider-token";
      const server = await startProviderServer(() => ({
        status: 500,
        body: JSON.stringify({ error: "provider should not be called without --provider" }),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });

      try {
        // Act
        const result = await runCliBuffered(["ingest", source.source_id, "--repo", wikiDir, "--json"]);
        const payload = parseJsonSuccess<"ingest", { mode: "task" }>(result.stdout);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.mode).toBe("task");
        expect(server.requests).toHaveLength(0);
      } finally {
        await server.close();
      }
    });
  });

  it("keeps query --save task-first when a provider is configured but --provider is omitted", async () => {
    await withTempWorkspace("llm-wiki-provider-configured-query-task-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "Does configured provider mode stay explicit?";
      await initializeWiki(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "configured-provider-token";
      const server = await startProviderServer(() => ({
        status: 500,
        body: JSON.stringify({ error: "provider should not be called without --provider" }),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });

      try {
        // Act
        const result = await runCliBuffered([
          "query",
          question,
          "--repo",
          wikiDir,
          "--save",
          "curated/questions/configured-provider-explicit.md",
          "--json",
        ]);
        const payload = parseJsonSuccess<"query", { mode: "task"; save_path: string | null }>(result.stdout);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.mode).toBe("task");
        expect(payload.data.save_path).toBe("curated/questions/configured-provider-explicit.md");
        expect(server.requests).toHaveLength(0);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects provider mode when the requested provider is not configured", async () => {
    await withTempWorkspace("llm-wiki-provider-unconfigured-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--provider",
        "local",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROVIDER_CONFIG_MISSING");
      expect(after).toEqual(before);
    });
  });

  it("keeps the default-agent provider hint on supported workflows", async () => {
    await withTempWorkspace("llm-wiki-provider-agent-confusion-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
      const config = await readFile(configPath, "utf8");
      await writeFile(configPath, config.replace("default: generic", "default: codex"), "utf8");
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--provider",
        "codex",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toMatchObject({
        code: "PROVIDER_CONFIG_MISSING",
        hint: expect.stringContaining("--provider only runs HTTP providers"),
      });
      expect(payload.error.hint).toContain("omit --provider");
      expect(payload.error.hint).not.toContain("--agent");
      expect(after).toEqual(before);
    });
  });

  it("rejects provider configs that contain literal secret material", async () => {
    await withTempWorkspace("llm-wiki-provider-literal-secret-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await appendProviderConfig(wikiDir, {
        endpoint: "http://127.0.0.1:1",
        extraYaml: "api_key: sk-test-secret-must-not-live-in-config",
      });
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--provider",
        "local",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROVIDER_CONFIG_INVALID");
      expect(JSON.stringify(payload)).not.toContain("sk-test-secret-must-not-live-in-config");
      expect(after).toEqual(before);
    });
  });

  it.each(["access_token", "client_secret", "password"])(
    "rejects provider configs with literal %s fields",
    async (secretKey) => {
      await withTempWorkspace(`llm-wiki-provider-literal-${secretKey.replaceAll("_", "-")}-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        const source = await captureTextSource(wikiDir);
        await appendProviderConfig(wikiDir, {
          endpoint: "http://127.0.0.1:1",
          extraYaml: `${secretKey}: sk-test-secret-must-not-live-in-config`,
        });
        process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
        const before = await readTreeSnapshot(wikiDir);

        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonFailure<"ingest">(result.stdout);
        const after = await readTreeSnapshot(wikiDir);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PROVIDER_CONFIG_INVALID");
        expect(payload.issues[0]?.message).toContain("environment variable name only");
        expect(JSON.stringify(payload)).not.toContain("sk-test-secret-must-not-live-in-config");
        expect(after).toEqual(before);
      });
    },
  );

  it.each([
    {
      name: "authorization headers",
      extraYaml: "headers:\n  authorization: sk-test-secret-must-not-live-in-config",
      expectedPath: ".llm-wiki/config.yml:providers.local.headers.authorization",
    },
    {
      name: "oauth client secrets",
      extraYaml: "oauth:\n  client_secret: sk-test-secret-must-not-live-in-config",
      expectedPath: ".llm-wiki/config.yml:providers.local.oauth.client_secret",
    },
    {
      name: "array access tokens",
      extraYaml: "fallbacks:\n  - access_token: sk-test-secret-must-not-live-in-config",
      expectedPath: ".llm-wiki/config.yml:providers.local.fallbacks[0].access_token",
    },
  ])("rejects provider configs with nested literal $name", async ({ extraYaml, expectedPath }) => {
    await withTempWorkspace("llm-wiki-provider-nested-literal-secret-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await appendProviderConfig(wikiDir, {
        endpoint: "http://127.0.0.1:1",
        extraYaml,
      });
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--provider",
        "local",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROVIDER_CONFIG_INVALID");
      expect(payload.issues[0]?.path).toBe(expectedPath);
      expect(payload.issues[0]?.message).toContain("environment variable name only");
      expect(JSON.stringify(payload)).not.toContain("sk-test-secret-must-not-live-in-config");
      expect(after).toEqual(before);
    });
  });

  it("requires provider secrets to be present in the configured environment variable", async () => {
    await withTempWorkspace("llm-wiki-provider-missing-env-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await appendProviderConfig(wikiDir, { endpoint: "http://127.0.0.1:1" });
      delete process.env.LLM_WIKI_PROVIDER_TEST_TOKEN;
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--provider",
        "local",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROVIDER_ENV_MISSING");
      expect(payload.issues[0]).toMatchObject({
        path: "LLM_WIKI_PROVIDER_TEST_TOKEN",
      });
      expect(after).toEqual(before);
    });
  });

  it("fails when the configured non-default provider secret env var is missing despite a decoy token", async () => {
    await withTempWorkspace("llm-wiki-provider-missing-configured-env-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await appendProviderConfig(wikiDir, {
        endpoint: "http://127.0.0.1:1",
        envName: "LLM_WIKI_PROVIDER_CONFIGURED_TOKEN",
      });
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "decoy-default-token";
      delete process.env.LLM_WIKI_PROVIDER_CONFIGURED_TOKEN;
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--provider",
        "local",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROVIDER_ENV_MISSING");
      expect(payload.issues[0]).toMatchObject({
        path: "LLM_WIKI_PROVIDER_CONFIGURED_TOKEN",
      });
      expect(JSON.stringify(payload)).not.toContain("decoy-default-token");
      expect(after).toEqual(before);
    });
  });

  it("sends only the configured non-default environment secret to the provider and applies valid ingest proposals", async () => {
    await withTempWorkspace("llm-wiki-provider-ingest-success-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "decoy-default-token";
      process.env.LLM_WIKI_PROVIDER_CONFIGURED_TOKEN = "configured-secret-token";
      const server = await startProviderServer(() => ({
        body: providerOutput([
          { path: `curated/sources/${source.source_id}.md`, content: ingestSummaryContent(source) },
          { path: "curated/index.md", content: ingestIndexContent(source) },
          { path: "curated/log.md", content: ingestLogContent(source) },
        ]),
      }));
      await appendProviderConfig(wikiDir, {
        endpoint: server.url,
        envName: "LLM_WIKI_PROVIDER_CONFIGURED_TOKEN",
      });
      const rawOriginalBefore = await readFile(resolve(wikiDir, source.original_path), "utf8");
      const logBefore = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

      try {
        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonSuccess<"ingest", IngestProviderData>(result.stdout);
        const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
        const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
        const logAfter = await readFile(resolve(wikiDir, "curated/log.md"), "utf8");

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]?.headers.authorization).toBe("Bearer configured-secret-token");
        expect(server.requests[0]?.body).not.toContain("configured-secret-token");
        expect(server.requests[0]?.body).not.toContain("decoy-default-token");
        expect(payload.data).toMatchObject({
          mode: "provider",
          provider: {
            name: "local",
            model: "provider-test-model",
          },
          source: {
            source_id: source.source_id,
            status: "ingested",
          },
          validation: {
            passed: true,
            issues: [],
          },
        });
        expect(payload.data.proposals.applied_paths).toEqual([
          "curated/index.md",
          "curated/log.md",
          `curated/sources/${source.source_id}.md`,
        ]);
        expect(JSON.stringify(payload)).not.toContain("configured-secret-token");
        expect(JSON.stringify(payload)).not.toContain("decoy-default-token");
        expect(queuePayload.data.queue_record.status).toBe("ingested");
        expect(queuePayload.data.source_card.frontmatter.status).toBe("ingested");
        expect(logAfter.startsWith(logBefore)).toBe(true);
        expect(logAfter).toContain(`ingest | ${source.source_id} | Provider ingest completed`);
        expect(await readFile(resolve(wikiDir, source.original_path), "utf8")).toBe(rawOriginalBefore);
      } finally {
        await server.close();
      }
    });
  });

  it("does not write provider proposals when the provider request fails", async () => {
    await withTempWorkspace("llm-wiki-provider-request-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const server = await startProviderServer(() => ({
        status: 503,
        body: JSON.stringify({ error: "try later" }),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });
      const before = await readTreeSnapshot(wikiDir);

      try {
        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonFailure<"ingest">(result.stdout);
        const after = await readTreeSnapshot(wikiDir);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PROVIDER_REQUEST_FAILED");
        expect(after).toEqual(before);
      } finally {
        await server.close();
      }
    });
  });

  it.each([
    {
      name: "invalid authorization header",
      endpoint: "http://127.0.0.1:1",
      token: "top-secret-token\r\nx-leak: yes",
      leakedValues: ["Bearer", "top-secret-token", "x-leak"],
    },
    {
      name: "credentialed endpoint",
      endpoint: "http://leaky-user:leaky-pass@127.0.0.1:1",
      token: "safe-token",
      leakedValues: ["Bearer", "safe-token", "leaky-user", "leaky-pass"],
    },
  ])("sanitizes provider request failures for $name", async ({ endpoint, token, leakedValues }) => {
    await withTempWorkspace("llm-wiki-provider-request-sanitized-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      await appendProviderConfig(wikiDir, { endpoint });
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = token;
      const before = await readTreeSnapshot(wikiDir);

      // Act
      const result = await runCliBuffered([
        "ingest",
        source.source_id,
        "--repo",
        wikiDir,
        "--provider",
        "local",
        "--json",
      ]);
      const payload = parseJsonFailure<"ingest">(result.stdout);
      const after = await readTreeSnapshot(wikiDir);
      const serializedPayload = JSON.stringify(payload);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toMatchObject({
        code: "PROVIDER_REQUEST_FAILED",
        message: "Provider request failed before a structured response was received.",
      });
      for (const leakedValue of leakedValues) {
        expect(serializedPayload).not.toContain(leakedValue);
      }
      expect(after).toEqual(before);
    });
  });

  it("does not write provider proposals when provider output is malformed", async () => {
    await withTempWorkspace("llm-wiki-provider-malformed-output-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const server = await startProviderServer(() => ({
        body: JSON.stringify({ files: [{ path: "curated/index.md" }] }),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });
      const before = await readTreeSnapshot(wikiDir);

      try {
        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonFailure<"ingest">(result.stdout);
        const after = await readTreeSnapshot(wikiDir);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PROVIDER_OUTPUT_INVALID");
        expect(after).toEqual(before);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects provider proposals that try to modify raw originals without changing queue status", async () => {
    await withTempWorkspace("llm-wiki-provider-raw-original-reject-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const server = await startProviderServer(() => ({
        body: providerOutput([{ path: source.original_path, content: "provider tried to rewrite raw evidence" }]),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });
      const before = await readTreeSnapshot(wikiDir);

      try {
        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonFailure<"ingest">(result.stdout);
        const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
        const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
        const after = await readTreeSnapshot(wikiDir);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error).toEqual({
          code: "PROVIDER_PROPOSAL_REJECTED",
          message: `Provider proposal path is not allowed: ${source.original_path}.`,
          hint: "Provider proposals may only write Markdown files under curated/.",
        });
        expect(payload.issues[0]).toEqual({
          severity: "error",
          code: "PROVIDER_PROPOSAL_REJECTED",
          message: `Provider proposal path is not allowed: ${source.original_path}.`,
          path: source.original_path,
          hint: "Provider proposals may only write Markdown files under curated/.",
        });
        expect(queuePayload.data.queue_record.status).toBe("queued");
        expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
        expect(after).toEqual(before);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects ingest provider proposals that fail validation without applying curated writes", async () => {
    await withTempWorkspace("llm-wiki-provider-ingest-validation-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const server = await startProviderServer(() => ({
        body: providerOutput([
          {
            path: `curated/sources/${source.source_id}.md`,
            content: [
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
              "This proposed summary intentionally omits source_ids provenance.",
              "",
            ].join("\n"),
          },
          {
            path: "curated/topics/provider-claim.md",
            content: [
              "---",
              "type: topic",
              "title: Provider Claim",
              "visibility: private",
              "source_ids: []",
              "---",
              "",
              "# Provider Claim",
              "",
              `This proposal mentions ${source.source_id} but omits required provenance.`,
              "",
            ].join("\n"),
          },
        ]),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });
      const before = await readTreeSnapshot(wikiDir);

      try {
        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonFailure<"ingest">(result.stdout);
        const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
        const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
        const after = await readTreeSnapshot(wikiDir);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(server.requests).toHaveLength(1);
        expect(payload.error.code).toBe("INGEST_VALIDATION_FAILED");
        expect(payload.issues.map((issue) => issue.code)).toEqual(
          expect.arrayContaining([
            "ingest_index_missing",
            "ingest_log_entry_missing",
            "ingest_source_ids_missing",
          ]),
        );
        expect(queuePayload.data.queue_record.status).toBe("queued");
        expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
        expect(after).toEqual(before);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects invalid ingest proposals in Git worktrees before applying real writes", async () => {
    await withTempWorkspace("llm-wiki-provider-ingest-worktree-validation-", async (workspaceDir) => {
      // Arrange
      const wikiDir = await initializeGitWorktreeWiki(workspaceDir);
      const source = await captureTextSource(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const server = await startProviderServer(() => ({
        body: providerOutput([
          { path: `curated/sources/${source.source_id}.md`, content: ingestSummaryContent(source) },
          { path: "curated/index.md", content: ingestIndexContent(source) },
          { path: "curated/log.md", content: ingestLogContent(source) },
          {
            path: "curated/topics/uncited-provider-page.md",
            content: [
              "---",
              "type: topic",
              "title: Uncited Provider Page",
              "visibility: private",
              "source_ids: []",
              "---",
              "",
              "# Uncited Provider Page",
              "",
              "This provider-created page has no provenance and no source reference.",
              "",
            ].join("\n"),
          },
        ]),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });
      const before = await readTreeSnapshot(wikiDir);

      try {
        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonFailure<"ingest">(result.stdout);
        const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
        const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
        const after = await readTreeSnapshot(wikiDir);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("INGEST_VALIDATION_FAILED");
        expect(payload.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "ingest_source_ids_missing",
              path: "curated/topics/uncited-provider-page.md",
            }),
          ]),
        );
        expect(queuePayload.data.queue_record.status).toBe("queued");
        expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
        expect(after).toEqual(before);
      } finally {
        await server.close();
      }
    });
  });

  it("rolls back ingest provider proposals when final Git validation fails", async () => {
    await withTempWorkspace("llm-wiki-provider-ingest-final-validation-rollback-", async (workspaceDir) => {
      // Arrange
      const wikiDir = await initializeGitWorktreeWiki(workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/preexisting-dirty-page.md",
        {
          type: "topic",
          title: "Preexisting Dirty Page",
          visibility: "private",
          source_ids: [],
        },
        "# Preexisting Dirty Page\n\nThis page was dirty before source capture and has no new source provenance.\n",
      );
      await waitForFilesystemTimestamp();
      const source = await captureTextSource(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const server = await startProviderServer(() => ({
        body: providerOutput([
          { path: `curated/sources/${source.source_id}.md`, content: ingestSummaryContent(source) },
          { path: "curated/index.md", content: ingestIndexContent(source) },
          { path: "curated/log.md", content: ingestLogContent(source) },
        ]),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });
      const before = await readTreeSnapshot(wikiDir);

      try {
        // Act
        const result = await runCliBuffered([
          "ingest",
          source.source_id,
          "--repo",
          wikiDir,
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonFailure<"ingest">(result.stdout);
        const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
        const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
        const after = await readTreeSnapshot(wikiDir);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("INGEST_VALIDATION_FAILED");
        expect(payload.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "ingest_source_ids_missing",
              path: "curated/topics/preexisting-dirty-page.md",
            }),
          ]),
        );
        expect(queuePayload.data.queue_record.status).toBe("queued");
        expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
        expect(after).toEqual(before);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects query provider proposals with invented provenance and leaves files unchanged", async () => {
    await withTempWorkspace("llm-wiki-provider-query-invalid-provenance-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What did the provider invent?";
      const inventedSourceId = "src_2026_06_19_invented_deadbeef";
      await initializeWiki(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const server = await startProviderServer(() => ({
        body: providerOutput([
          {
            path: "curated/questions/provider-answer.md",
            content: queryAnswerContent(question, inventedSourceId),
          },
          { path: "curated/index.md", content: queryIndexContent(question) },
          { path: "curated/log.md", content: queryLogContent(question) },
        ]),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });
      const before = await readTreeSnapshot(wikiDir);

      try {
        // Act
        const result = await runCliBuffered([
          "query",
          question,
          "--repo",
          wikiDir,
          "--save",
          "curated/questions/provider-answer.md",
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonFailure<"query">(result.stdout);
        const after = await readTreeSnapshot(wikiDir);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("QUERY_VALIDATION_FAILED");
        expect(payload.issues.map((issue) => issue.code)).toContain("query_source_ids_unavailable");
        expect(after).toEqual(before);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects query provider proposals that create cited source summaries", async () => {
    await withTempWorkspace("llm-wiki-provider-query-created-evidence-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What evidence did the provider create?";
      const inventedSourceId = "src_2026_06_19_invented_deadbeef";
      await initializeWiki(wikiDir);
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const server = await startProviderServer(() => ({
        body: providerOutput([
          {
            path: `curated/sources/${inventedSourceId}.md`,
            content: [
              "---",
              "type: source_summary",
              "title: Invented Provider Evidence",
              "visibility: private",
              "source_ids:",
              `  - ${inventedSourceId}`,
              `source_id: ${inventedSourceId}`,
              "---",
              "",
              "# Invented Provider Evidence",
              "",
              "This source summary did not exist before the provider proposal.",
              "",
            ].join("\n"),
          },
          {
            path: "curated/questions/provider-answer.md",
            content: queryAnswerContent(question, inventedSourceId),
          },
          { path: "curated/index.md", content: queryIndexContent(question) },
          { path: "curated/log.md", content: queryLogContent(question) },
        ]),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });
      const before = await readTreeSnapshot(wikiDir);

      try {
        // Act
        const result = await runCliBuffered([
          "query",
          question,
          "--repo",
          wikiDir,
          "--save",
          "curated/questions/provider-answer.md",
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonFailure<"query">(result.stdout);
        const after = await readTreeSnapshot(wikiDir);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error).toEqual({
          code: "PROVIDER_PROPOSAL_REJECTED",
          message: `Query provider proposals cannot create or modify source summaries: curated/sources/${inventedSourceId}.md.`,
          hint: "Query provider mode may cite only source summaries that existed before the provider proposal.",
        });
        expect(payload.issues[0]).toEqual({
          severity: "error",
          code: "PROVIDER_PROPOSAL_REJECTED",
          message: `Query provider proposals cannot create or modify source summaries: curated/sources/${inventedSourceId}.md.`,
          path: `curated/sources/${inventedSourceId}.md`,
          hint: "Query provider mode may cite only source summaries that existed before the provider proposal.",
        });
        expect(after).toEqual(before);
      } finally {
        await server.close();
      }
    });
  });

  it.each([
    {
      name: "an unrelated curated topic page",
      extraPath: "curated/topics/unrelated-provider-page.md",
      extraContent: (sourceId: string) => [
        "---",
        "type: topic",
        "title: Unrelated Provider Page",
        "visibility: private",
        "source_ids:",
        `  - ${sourceId}`,
        "---",
        "",
        "# Unrelated Provider Page",
        "",
        "This page is outside the saved-query output contract.",
        "",
      ].join("\n"),
    },
    {
      name: "an extra question page",
      extraPath: "curated/questions/other-provider-answer.md",
      extraContent: (sourceId: string) => queryAnswerContent("What else did the provider answer?", sourceId),
    },
  ])("rejects query provider proposals that include $name", async ({ extraPath, extraContent }) => {
    await withTempWorkspace("llm-wiki-provider-query-extra-output-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What output paths may query providers write?";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, {
        title: "Provider Query Evidence",
        text: "validated evidence about provider query path boundaries",
      });
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Provider Query Evidence Summary",
          visibility: "private",
          source_ids: [source.source_id],
          source_id: source.source_id,
        },
        "# Provider Query Evidence Summary\n\nThe source supports provider query path boundaries.\n",
      );
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const server = await startProviderServer(() => ({
        body: providerOutput([
          {
            path: "curated/questions/provider-answer.md",
            content: queryAnswerContent(question, source.source_id),
          },
          { path: "curated/index.md", content: queryIndexContent(question) },
          { path: "curated/log.md", content: queryLogContent(question) },
          { path: extraPath, content: extraContent(source.source_id) },
        ]),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });
      const rawOriginalBefore = await readFile(resolve(wikiDir, source.original_path), "utf8");
      const before = await readTreeSnapshot(wikiDir);

      try {
        // Act
        const result = await runCliBuffered([
          "query",
          question,
          "--repo",
          wikiDir,
          "--save",
          "curated/questions/provider-answer.md",
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonFailure<"query">(result.stdout);
        const queueResult = await runCliBuffered(["queue", "show", source.source_id, "--repo", wikiDir, "--json"]);
        const queuePayload = parseJsonSuccess<"queue show", QueueShowData>(queueResult.stdout);
        const rawOriginalAfter = await readFile(resolve(wikiDir, source.original_path), "utf8");
        const after = await readTreeSnapshot(wikiDir);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error).toEqual({
          code: "PROVIDER_PROPOSAL_REJECTED",
          message: `Query provider proposal path is not an expected saved-query output: ${extraPath}.`,
          hint: "Query provider mode may only write curated/questions/provider-answer.md, curated/index.md, and curated/log.md.",
        });
        expect(payload.issues[0]).toEqual({
          severity: "error",
          code: "PROVIDER_PROPOSAL_REJECTED",
          message: `Query provider proposal path is not an expected saved-query output: ${extraPath}.`,
          path: extraPath,
          hint: "Query provider mode may only write curated/questions/provider-answer.md, curated/index.md, and curated/log.md.",
        });
        expect(queuePayload.data.queue_record.status).toBe("queued");
        expect(queuePayload.data.source_card.frontmatter.status).toBe("queued");
        expect(rawOriginalAfter).toBe(rawOriginalBefore);
        expect(after).toEqual(before);
      } finally {
        await server.close();
      }
    });
  });

  it("applies valid saved-query provider proposals only after validation passes", async () => {
    await withTempWorkspace("llm-wiki-provider-query-success-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const question = "What can provider proposals answer?";
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir, {
        title: "Provider Evidence",
        text: "validated evidence about provider-written saved answers",
      });
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        {
          type: "source_summary",
          title: "Provider Evidence Summary",
          visibility: "private",
          source_ids: [source.source_id],
          source_id: source.source_id,
        },
        "# Provider Evidence Summary\n\nThe source supports provider-written saved answers.\n",
      );
      process.env.LLM_WIKI_PROVIDER_TEST_TOKEN = "top-secret-token";
      const server = await startProviderServer(() => ({
        body: providerOutput([
          {
            path: "curated/questions/provider-answer.md",
            content: queryAnswerContent(question, source.source_id),
          },
          { path: "curated/index.md", content: queryIndexContent(question) },
          { path: "curated/log.md", content: queryLogContent(question) },
        ]),
      }));
      await appendProviderConfig(wikiDir, { endpoint: server.url });

      try {
        // Act
        const result = await runCliBuffered([
          "query",
          question,
          "--repo",
          wikiDir,
          "--save",
          "curated/questions/provider-answer.md",
          "--provider",
          "local",
          "--json",
        ]);
        const payload = parseJsonSuccess<"query", QueryProviderData>(result.stdout);
        const savedQuestion = await readFile(resolve(wikiDir, "curated/questions/provider-answer.md"), "utf8");

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data).toMatchObject({
          mode: "provider",
          provider: {
            name: "local",
            model: "provider-test-model",
          },
          question,
          save_path: "curated/questions/provider-answer.md",
          validation: {
            passed: true,
            issues: [],
          },
        });
        expect(payload.data.proposals.applied_paths).toEqual([
          "curated/index.md",
          "curated/log.md",
          "curated/questions/provider-answer.md",
        ]);
        expect(savedQuestion).toContain(`- ${source.source_id}`);
        expect(JSON.stringify(payload)).not.toContain("top-secret-token");
      } finally {
        await server.close();
      }
    });
  });
});
