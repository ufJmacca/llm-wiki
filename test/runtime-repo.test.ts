import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveWikiRoot } from "../src/runtime/repo.js";
import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

describe("wiki root discovery", () => {
  it("resolves a wiki root from a descendant working directory containing config", async () => {
    await withTempWorkspace("llm-wiki-runtime-cwd-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const descendantDir = resolve(wikiDir, "curated", "questions");
      await initializeWiki(wikiDir);

      // Act
      const resolved = await resolveWikiRoot({ cwd: descendantDir });

      // Assert
      expect(resolved).toEqual({
        ok: true,
        value: {
          rootDir: wikiDir,
          configPath: resolve(wikiDir, ".llm-wiki", "config.yml"),
        },
      });
    });
  });

  it("resolves a wiki root from an explicit repo path pointing at a descendant", async () => {
    await withTempWorkspace("llm-wiki-runtime-repo-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const descendantDir = resolve(wikiDir, "curated", "topics");
      await initializeWiki(wikiDir);

      // Act
      const resolved = await resolveWikiRoot({ cwd: workspaceDir, repoPath: descendantDir });

      // Assert
      expect(resolved).toEqual({
        ok: true,
        value: {
          rootDir: wikiDir,
          configPath: resolve(wikiDir, ".llm-wiki", "config.yml"),
        },
      });
    });
  });

  it("returns an actionable error when no wiki config exists above the search path", async () => {
    await withTempWorkspace("llm-wiki-runtime-missing-root-", async (workspaceDir) => {
      // Arrange
      const nonWikiDir = resolve(workspaceDir, "notes");
      await mkdir(nonWikiDir);

      // Act
      const resolved = await resolveWikiRoot({ cwd: nonWikiDir });

      // Assert
      expect(resolved).toEqual({
        ok: false,
        error: {
          code: "WIKI_ROOT_NOT_FOUND",
          message: `Could not find .llm-wiki/config.yml from ${nonWikiDir}`,
          startPath: nonWikiDir,
          hint: "Run llm-wiki init <dir> first, or pass --repo <path> inside an existing wiki.",
        },
      });
    });
  });

  it("returns an actionable error when the wiki config marker is not a file", async () => {
    await withTempWorkspace("llm-wiki-runtime-config-not-file-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const configPath = resolve(wikiDir, ".llm-wiki", "config.yml");
      await mkdir(configPath, { recursive: true });

      // Act
      const resolved = await resolveWikiRoot({ cwd: wikiDir });

      // Assert
      expect(resolved).toEqual({
        ok: false,
        error: {
          code: "WIKI_CONFIG_NOT_FILE",
          message: `Wiki config marker is not a regular file: ${configPath}`,
          startPath: configPath,
          hint: "Replace .llm-wiki/config.yml with the YAML config file created by llm-wiki init.",
        },
      });
    });
  });

  it("returns an actionable error when an explicit repo path does not exist", async () => {
    await withTempWorkspace("llm-wiki-runtime-bad-repo-", async (workspaceDir) => {
      // Arrange
      const missingRepoPath = resolve(workspaceDir, "missing");

      // Act
      const resolved = await resolveWikiRoot({ cwd: workspaceDir, repoPath: missingRepoPath });

      // Assert
      expect(resolved).toEqual({
        ok: false,
        error: {
          code: "REPO_PATH_NOT_FOUND",
          message: `Repo path does not exist: ${missingRepoPath}`,
          startPath: missingRepoPath,
          hint: "Pass --repo <path> to an existing wiki directory or one of its descendants.",
        },
      });
    });
  });

  it("returns an actionable error when an explicit repo path has a file as an intermediate segment", async () => {
    await withTempWorkspace("llm-wiki-runtime-enotdir-repo-", async (workspaceDir) => {
      // Arrange
      const notesFilePath = resolve(workspaceDir, "notes.md");
      const malformedRepoPath = resolve(notesFilePath, "wiki");
      await writeFile(notesFilePath, "# Notes\n");

      // Act
      const resolved = await resolveWikiRoot({ cwd: workspaceDir, repoPath: malformedRepoPath });

      // Assert
      expect(resolved).toEqual({
        ok: false,
        error: {
          code: "REPO_PATH_NOT_FOUND",
          message: `Repo path does not exist: ${malformedRepoPath}`,
          startPath: malformedRepoPath,
          hint: "Pass --repo <path> to an existing wiki directory or one of its descendants.",
        },
      });
    });
  });
});
