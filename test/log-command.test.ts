import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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

type LogData = {
  entries: Array<{
    path: "curated/log.md";
    line: number;
    timestamp: string;
    operation: "add" | "ingest" | "query" | "lint" | "explore" | "deploy" | "upload";
    affectedId: string;
    title: string;
    body: string;
  }>;
  issues: Array<{
    severity: "error" | "warning";
    code: string;
    message: string;
    path: string;
    hint: string;
  }>;
  counts: {
    total: number;
  };
};

type SourceCaptureData = {
  status: "added" | "duplicate";
  source: {
    source_id: string;
    title: string;
  };
};

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
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

describe("log command", () => {
  it("returns no runtime entries for the seeded log template", async () => {
    await withTempWorkspace("llm-wiki-log-seeded-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["log", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"log", LogData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        ok: true,
        command: "log",
        repo: wikiDir,
        data: {
          entries: [],
          issues: [],
          counts: {
            total: 0,
          },
        },
        warnings: [],
      });
    });
  });

  it("prints parsed runtime entries in JSON and human modes and honors quiet mode", async () => {
    await withTempWorkspace("llm-wiki-log-runtime-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Runtime Note",
        "--text",
        "log me",
        "--json",
      ]);
      const added = parseJsonSuccess<"add-text", SourceCaptureData>(addResult.stdout).data.source;

      // Act
      const jsonResult = await runCliBuffered(["log", "--repo", wikiDir, "--json"]);
      const humanResult = await runCliBuffered(["log", "--repo", wikiDir]);
      const quietResult = await runCliBuffered(["log", "--repo", wikiDir, "--quiet"]);
      const payload = parseJsonSuccess<"log", LogData>(jsonResult.stdout);

      // Assert
      expect(jsonResult.exitCode).toBe(0);
      expect(payload.data.issues).toEqual([]);
      expect(payload.data.counts).toEqual({ total: 1 });
      expect(payload.data.entries).toEqual([
        expect.objectContaining({
          path: "curated/log.md",
          operation: "add",
          affectedId: added.source_id,
          title: "Runtime Note",
          body: expect.stringContaining("- actor: cli"),
        }),
      ]);
      expect(humanResult.exitCode).toBe(0);
      expect(humanResult.stdout.join("\n")).toContain("Log entries: 1");
      expect(humanResult.stdout.join("\n")).toContain(added.source_id);
      expect(humanResult.stdout.join("\n")).toContain("Runtime Note");
      expect(quietResult.exitCode).toBe(0);
      expect(quietResult.stdout).toEqual([]);
      expect(quietResult.stderr).toEqual([]);
    });
  });

  it("prints scanner issues in human mode when no runtime entries parse", async () => {
    await withTempWorkspace("llm-wiki-log-malformed-human-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, "curated/log.md"),
        "# Log\n\n## [not-a-timestamp] add | src_2026_06_17_bad_000000 | Bad entry\n",
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["log", "--repo", wikiDir]);
      const output = result.stdout.join("\n");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(output).toContain("Log entries: 0");
      expect(output).toContain("Log issues: 1");
      expect(output).toContain("error: LOG_TIMESTAMP_INVALID curated/log.md:3");
    });
  });

  it("rejects log paths that resolve through symlinked parents outside the wiki", async () => {
    await withTempWorkspace("llm-wiki-log-parent-symlink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const outsideCuratedDir = resolve(workspaceDir, "outside-curated");
      await initializeWiki(wikiDir);
      await mkdir(outsideCuratedDir);
      await writeFile(
        resolve(outsideCuratedDir, "log.md"),
        "# Log\n\n## [2026-06-17T12:00:00Z] add | src_2026_06_17_outside_000000000000 | Outside\n",
        "utf8",
      );
      await rm(resolve(wikiDir, "curated"), { force: true, recursive: true });
      await symlink(outsideCuratedDir, resolve(wikiDir, "curated"), "dir");

      // Act
      const result = await runCliBuffered(["log", "--repo", wikiDir, "--json"]);
      const payload = parseJsonFailure<"log">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("LOG_READ_FAILED");
      expect(payload.error.message).toContain("destination parent is a symlink: curated");
      expect(result.stdout.join("\n")).not.toContain("Outside");
    });
  });
});
