import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";
import { runRuntimeCommand } from "../src/runtime/command.js";

type RuntimeSuccessEnvelope = {
  ok: true;
  command: "status";
  repo: string;
  data: {
    configPath: ".llm-wiki/config.yml";
    config: {
      path: ".llm-wiki/config.yml";
      valid: boolean;
      git_enabled: boolean | null;
      errors: unknown[];
    };
    health: {
      state: "ok" | "warning" | "error";
      ok: boolean;
    };
    queue: {
      counts: {
        total: number;
        queued: number;
        ingesting: number;
        ingested: number;
        blocked: number;
      };
    };
    lint: {
      counts: {
        total: number;
        error: number;
        warning: number;
        fixed: number;
      };
    };
    git: {
      enabled: boolean | null;
      branch: string | null;
      head: string | null;
      dirty: boolean | null;
      errors: unknown[];
    };
    profiles: {
      total: number;
      valid: number;
      invalid: number;
    };
    explorer: {
      ready: boolean;
      initialized: boolean;
    };
  };
  warnings: string[];
};

type RuntimeFailureEnvelope = {
  ok: false;
  command: string;
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

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

function parseStatusSuccess(stdout: string[]): RuntimeSuccessEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as RuntimeSuccessEnvelope;
}

function parseStatusFailure(stdout: string[]): RuntimeFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as RuntimeFailureEnvelope;
}

describe("non-init CLI runtime contracts", () => {
  it("prints a stable success envelope for JSON output", async () => {
    await withTempWorkspace("llm-wiki-runtime-json-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseStatusSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(Object.keys(payload)).toEqual(["ok", "command", "repo", "data", "warnings"]);
      expect(payload).toEqual({
        ok: true,
        command: "status",
        repo: wikiDir,
        data: {
          configPath: ".llm-wiki/config.yml",
          config: {
            path: ".llm-wiki/config.yml",
            valid: true,
            git_enabled: false,
            errors: [],
          },
          health: expect.objectContaining({
            state: "ok",
            ok: true,
          }),
          queue: expect.objectContaining({
            counts: {
              total: 0,
              queued: 0,
              ingesting: 0,
              ingested: 0,
              blocked: 0,
            },
          }),
          lint: expect.objectContaining({
            counts: {
              total: 0,
              error: 0,
              warning: 0,
              fixed: 0,
            },
          }),
          git: expect.objectContaining({
            enabled: false,
            branch: null,
            head: null,
            dirty: null,
            errors: [],
          }),
          profiles: expect.objectContaining({
            total: 3,
            valid: 3,
            invalid: 0,
          }),
          explorer: expect.objectContaining({
            ready: false,
            initialized: false,
          }),
        },
        warnings: [],
      });
    });
  });

  it("accepts --repo paths inside a wiki and reports the resolved root", async () => {
    await withTempWorkspace("llm-wiki-runtime-descendant-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const descendantDir = resolve(wikiDir, "curated", "questions");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["status", "--repo", descendantDir, "--json"]);
      const payload = parseStatusSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.repo).toBe(wikiDir);
    });
  });

  it("resolves the wiki root from a descendant current working directory without --repo", async () => {
    await withTempWorkspace("llm-wiki-runtime-cwd-descendant-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const descendantDir = resolve(wikiDir, "curated", "questions");
      const originalCwd = process.cwd();
      await initializeWiki(wikiDir);

      try {
        process.chdir(descendantDir);

        // Act
        const result = await runCliBuffered(["status", "--json"]);
        const payload = parseStatusSuccess(result.stdout);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.repo).toBe(wikiDir);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  it("suppresses human success output in quiet mode", async () => {
    await withTempWorkspace("llm-wiki-runtime-quiet-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--quiet"]);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toEqual([]);
    });
  });

  it("does not suppress JSON success output in quiet mode", async () => {
    await withTempWorkspace("llm-wiki-runtime-quiet-json-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--quiet", "--json"]);
      const payload = parseStatusSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.repo).toBe(wikiDir);
    });
  });

  it("prints a stable failure envelope when JSON output cannot resolve a wiki root", async () => {
    await withTempWorkspace("llm-wiki-runtime-json-failure-", async (workspaceDir) => {
      // Arrange
      const nonWikiDir = resolve(workspaceDir, "notes");
      await mkdir(nonWikiDir);

      // Act
      const result = await runCliBuffered(["status", "--repo", nonWikiDir, "--json"]);
      const payload = parseStatusFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(Object.keys(payload)).toEqual(["ok", "command", "repo", "error", "issues"]);
      expect(payload).toEqual({
        ok: false,
        command: "status",
        repo: null,
        error: {
          code: "WIKI_ROOT_NOT_FOUND",
          message: `Could not find .llm-wiki/config.yml from ${nonWikiDir}`,
          hint: "Run llm-wiki init <dir> first, or pass --repo <path> inside an existing wiki.",
        },
        issues: [
          {
            severity: "error",
            code: "WIKI_ROOT_NOT_FOUND",
            message: `Could not find .llm-wiki/config.yml from ${nonWikiDir}`,
            path: nonWikiDir,
            hint: "Run llm-wiki init <dir> first, or pass --repo <path> inside an existing wiki.",
          },
        ],
      });
    });
  });

  it("prints a stable failure envelope when --repo points at a malformed path", async () => {
    await withTempWorkspace("llm-wiki-runtime-json-bad-repo-", async (workspaceDir) => {
      // Arrange
      const missingRepoPath = resolve(workspaceDir, "missing");

      // Act
      const result = await runCliBuffered(["status", "--repo", missingRepoPath, "--json"]);
      const payload = parseStatusFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("REPO_PATH_NOT_FOUND");
      expect(payload.error.message).toBe(`Repo path does not exist: ${missingRepoPath}`);
      expect(payload.issues).toEqual([
        {
          severity: "error",
          code: "REPO_PATH_NOT_FOUND",
          message: `Repo path does not exist: ${missingRepoPath}`,
          path: missingRepoPath,
          hint: "Pass --repo <path> to an existing wiki directory or one of its descendants.",
        },
      ]);
    });
  });

  it("prints a stable JSON failure envelope when --repo has a file as an intermediate path segment", async () => {
    await withTempWorkspace("llm-wiki-runtime-json-enotdir-repo-", async (workspaceDir) => {
      // Arrange
      const notesFilePath = resolve(workspaceDir, "notes.md");
      const malformedRepoPath = resolve(notesFilePath, "wiki");
      await writeFile(notesFilePath, "# Notes\n");

      // Act
      const result = await runCliBuffered(["status", "--repo", malformedRepoPath, "--json"]);
      const payload = parseStatusFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: false,
        command: "status",
        repo: null,
        error: {
          code: "REPO_PATH_NOT_FOUND",
          message: `Repo path does not exist: ${malformedRepoPath}`,
          hint: "Pass --repo <path> to an existing wiki directory or one of its descendants.",
        },
        issues: [
          {
            severity: "error",
            code: "REPO_PATH_NOT_FOUND",
            message: `Repo path does not exist: ${malformedRepoPath}`,
            path: malformedRepoPath,
            hint: "Pass --repo <path> to an existing wiki directory or one of its descendants.",
          },
        ],
      });
    });
  });

  it("prints a stable JSON failure envelope when a searched directory contains a plain .llm-wiki file", async () => {
    await withTempWorkspace("llm-wiki-runtime-json-file-marker-", async (workspaceDir) => {
      // Arrange
      const nonWikiDir = resolve(workspaceDir, "notes");
      await mkdir(nonWikiDir);
      await writeFile(resolve(nonWikiDir, ".llm-wiki"), "not a wiki config directory\n");

      // Act
      const result = await runCliBuffered(["status", "--repo", nonWikiDir, "--json"]);
      const payload = parseStatusFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: false,
        command: "status",
        repo: null,
        error: {
          code: "WIKI_ROOT_NOT_FOUND",
          message: `Could not find .llm-wiki/config.yml from ${nonWikiDir}`,
          hint: "Run llm-wiki init <dir> first, or pass --repo <path> inside an existing wiki.",
        },
        issues: [
          {
            severity: "error",
            code: "WIKI_ROOT_NOT_FOUND",
            message: `Could not find .llm-wiki/config.yml from ${nonWikiDir}`,
            path: nonWikiDir,
            hint: "Run llm-wiki init <dir> first, or pass --repo <path> inside an existing wiki.",
          },
        ],
      });
    });
  });

  it("prints a stable JSON failure envelope when the wiki config marker is not a file", async () => {
    await withTempWorkspace("llm-wiki-runtime-json-config-not-file-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const configPath = resolve(wikiDir, ".llm-wiki", "config.yml");
      await mkdir(configPath, { recursive: true });

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseStatusFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: false,
        command: "status",
        repo: null,
        error: {
          code: "WIKI_CONFIG_NOT_FILE",
          message: `Wiki config marker is not a regular file: ${configPath}`,
          hint: "Replace .llm-wiki/config.yml with the YAML config file created by llm-wiki init.",
        },
        issues: [
          {
            severity: "error",
            code: "WIKI_CONFIG_NOT_FILE",
            message: `Wiki config marker is not a regular file: ${configPath}`,
            path: configPath,
            hint: "Replace .llm-wiki/config.yml with the YAML config file created by llm-wiki init.",
          },
        ],
      });
    });
  });

  it("keeps human failure output visible in quiet mode", async () => {
    await withTempWorkspace("llm-wiki-runtime-human-failure-", async (workspaceDir) => {
      // Arrange
      const nonWikiDir = resolve(workspaceDir, "notes");
      await mkdir(nonWikiDir);

      // Act
      const result = await runCliBuffered(["status", "--repo", nonWikiDir, "--quiet"]);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toEqual([`Error: Could not find .llm-wiki/config.yml from ${nonWikiDir}`]);
    });
  });

  it("wraps post-resolution search and nav runtime errors in JSON failure envelopes", async () => {
    await withTempWorkspace("llm-wiki-runtime-json-run-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const cases = [
        { command: "search" as const, code: "SEARCH_FAILED" },
        { command: "nav graph" as const, code: "NAV_GRAPH_FAILED" },
      ];

      for (const testCase of cases) {
        const stdout: string[] = [];
        const stderr: string[] = [];

        // Act
        await expect(
          runRuntimeCommand({
            command: testCase.command,
            rawOptions: { repo: wikiDir, json: true },
            io: {
              stdout: (message) => stdout.push(message),
              stderr: (message) => stderr.push(message),
            },
            run: async () => {
              throw new Error("scanner exploded");
            },
            formatHuman: () => "unused",
          }),
        ).rejects.toMatchObject({ exitCode: 1 });
        const payload = JSON.parse(stdout[0]) as RuntimeFailureEnvelope;

        // Assert
        expect(stderr).toEqual([]);
        expect(stdout).toHaveLength(1);
        expect(payload).toEqual({
          ok: false,
          command: testCase.command,
          repo: wikiDir,
          error: {
            code: testCase.code,
            message: "scanner exploded",
            hint: `Fix the repository data or permissions, then rerun llm-wiki ${testCase.command}.`,
          },
          issues: [
            {
              severity: "error",
              code: testCase.code,
              message: "scanner exploded",
              path: ".",
              hint: `Fix the repository data or permissions, then rerun llm-wiki ${testCase.command}.`,
            },
          ],
        });
      }
    });
  });
});
