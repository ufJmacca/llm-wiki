import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalAgentConfig } from "../src/runtime/config.js";
import { IngestValidationFailedError, runLocalAgentIngestCore } from "../src/ingest/localAgentCore.js";
import { parseInitJson, pathExists, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const runLocalAgentInTemporaryWorkspaceMock = vi.hoisted(() => vi.fn());

vi.mock("../src/agents/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/index.js")>();

  return {
    ...actual,
    runLocalAgentInTemporaryWorkspace: runLocalAgentInTemporaryWorkspaceMock,
  };
});

type RuntimeSuccessEnvelope<Command extends string, Data> = {
  ok: true;
  command: Command;
  repo: string;
  data: Data;
  warnings: string[];
};

type SourceCaptureData = {
  status: "added" | "duplicate";
  source: {
    source_id: string;
    title: string;
  };
};

const localAgent: LocalAgentConfig = {
  name: "codex",
  type: "local-exec",
  command: "codex",
  args: [],
  approvalPolicy: null,
  sandboxMode: null,
  outputMode: null,
  timeoutSeconds: null,
};

beforeEach(() => {
  runLocalAgentInTemporaryWorkspaceMock.mockReset();
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
    "Normalized Path Evidence",
    "--text",
    "evidence for normalized proposal path validation",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(payload.data.status).toBe("added");

  return payload.data.source;
}

function parseJsonSuccess<Command extends string, Data>(
  stdout: string[],
): RuntimeSuccessEnvelope<Command, Data> {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as RuntimeSuccessEnvelope<Command, Data>;
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
    "The source supports normalized proposal path validation.",
    "",
  ].join("\n");
}

function indexContent(source: SourceCaptureData["source"]): string {
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

function logContent(source: SourceCaptureData["source"]): string {
  return [
    "# Log",
    "",
    `## [2026-06-23T08:00:00.000Z] ingest | ${source.source_id} | Codex ingest completed`,
    "",
    "- actor: codex",
    `- command: "llm-wiki ingest ${source.source_id} --agent codex"`,
    "- git_branch:",
    "- git_commit:",
    `- raw_source: raw/inputs/2026/06/${source.source_id}/_source.md`,
    "- created:",
    `  - curated/sources/${source.source_id}.md`,
    "- updated:",
    "  - curated/index.md",
    "- contradictions:",
    "- follow_ups:",
    "",
  ].join("\n");
}

function uncitedTopicContent(): string {
  return [
    "---",
    "type: topic",
    "title: Uncited Normalized Path",
    "visibility: private",
    "source_ids: []",
    "---",
    "",
    "# Uncited Normalized Path",
    "",
    "This page was part of the current agent attempt but has no source provenance.",
    "",
  ].join("\n");
}

describe("local agent ingest core", () => {
  it("validates normalized proposal paths from the current attempt", async () => {
    await withTempWorkspace("llm-wiki-local-agent-normalized-proposal-paths-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureTextSource(wikiDir);
      runLocalAgentInTemporaryWorkspaceMock.mockResolvedValue({
        execution: {
          agentName: "codex",
          executablePath: "codex",
          args: [],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: { text: "", truncated: false, maxBytes: 65_536 },
          stderr: { text: "", truncated: false, maxBytes: 65_536 },
        },
        proposals: {
          files: [
            { path: `curated/sources/${source.source_id}.md`, content: sourceSummaryContent(source) },
            { path: "curated/index.md", content: indexContent(source) },
            { path: "curated/log.md", content: logContent(source) },
            { path: "curated//topics/uncited-normalized-path.md", content: uncitedTopicContent() },
          ],
        },
      });

      // Act
      let failure: unknown;
      try {
        await runLocalAgentIngestCore({
          repoRoot: wikiDir,
          sourceId: source.source_id,
          agent: localAgent,
        });
      } catch (error) {
        failure = error;
      }

      // Assert
      expect(failure).toBeInstanceOf(IngestValidationFailedError);
      expect((failure as IngestValidationFailedError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "ingest_source_ids_missing",
            path: "curated/topics/uncited-normalized-path.md",
          }),
        ]),
      );
      await expect(pathExists(resolve(wikiDir, "curated/topics/uncited-normalized-path.md"))).resolves.toBe(false);
    });
  });
});
