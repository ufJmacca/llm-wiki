import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

type ExploreOpenEnvelope = {
  ok: true;
  command: "explore.open";
  repo: string;
  data: {
    url: string;
    opened: boolean;
  };
  warnings: string[];
};

type ExploreOpenFailureEnvelope = {
  ok: false;
  command: "explore.open";
  repo: string;
  error: {
    code: string;
    message: string;
    hint: string;
  };
  issues: Array<{
    severity: "error";
    code: string;
    path: string;
    hint: string;
  }>;
};

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

function parseExploreOpen(stdout: string[]): ExploreOpenEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreOpenEnvelope;
}

function parseExploreOpenFailure(stdout: string[]): ExploreOpenFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreOpenFailureEnvelope;
}

async function writeExplorerState(wikiDir: string, url: string): Promise<void> {
  await mkdir(resolve(wikiDir, ".llm-wiki/cache"), { recursive: true });
  await writeFile(
    resolve(wikiDir, ".llm-wiki/cache/explorer-state.json"),
    `${JSON.stringify(
      {
        version: 1,
        profile: "local",
        host: "127.0.0.1",
        port: 8123,
        url,
        updated_at: "2026-06-19T00:00:00.000Z",
        watch_paths: ["curated/**/*.md"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("explore open command", () => {
  it("prints the current Explorer URL in stable JSON without requiring a browser opener", async () => {
    await withTempWorkspace("llm-wiki-explore-open-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeExplorerState(wikiDir, "http://127.0.0.1:8123");

      // Act
      const result = await runCliBuffered(["explore", "open", "--repo", wikiDir, "--json"]);
      const payload = parseExploreOpen(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: true,
        command: "explore.open",
        repo: wikiDir,
        data: {
          url: "http://127.0.0.1:8123",
          opened: false,
        },
        warnings: [],
      });
    });
  });

  it("prints the current Explorer URL in human mode", async () => {
    await withTempWorkspace("llm-wiki-explore-open-human-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeExplorerState(wikiDir, "http://127.0.0.1:8123");

      // Act
      const result = await runCliBuffered(["explore", "open", "--repo", wikiDir]);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(result.stdout).toEqual(["http://127.0.0.1:8123"]);
    });
  });

  it("returns an actionable stable error when no Explorer URL has been recorded", async () => {
    await withTempWorkspace("llm-wiki-explore-open-missing-state-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "open", "--repo", wikiDir, "--json"]);
      const payload = parseExploreOpenFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toEqual({
        code: "EXPLORER_STATE_MISSING",
        message: "No current Quartz Explorer URL is recorded.",
        hint: "Run llm-wiki explore serve --profile local first.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "EXPLORER_STATE_MISSING",
          path: ".llm-wiki/cache/explorer-state.json",
          hint: "Run llm-wiki explore serve --profile local first.",
        }),
      ]);
    });
  });
});
