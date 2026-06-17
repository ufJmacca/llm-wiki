import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

type InitJson = {
  command: "init";
  status: "initialized" | "initialized_with_warnings";
  targetDir: string;
  createdPaths: string[];
  overwrittenPaths: string[];
  skippedPaths: string[];
  optionalGroups: {
    agent: "codex" | "claude" | "generic";
    obsidian: boolean;
    dataview: boolean;
    git: boolean;
    quartzReady: boolean;
  };
  noOp: {
    git: boolean;
  };
  git: {
    enabled: boolean;
    attempted: boolean;
    ok: boolean;
    initialized: boolean;
    staged: boolean;
    committed: boolean;
    commitMessage: string;
    manualCommands: string[];
    error: string | null;
  };
  warnings: string[];
  errors: string[];
};

async function runCliBuffered(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCli(args, {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });

  return { exitCode, stderr, stdout };
}

function parseInitJson(stdout: string[]): InitJson {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as InitJson;
}

function quotedCdCommand(targetDir: string): string {
  return `cd '${targetDir.replaceAll("'", "'\\''")}'`;
}

describe("init output contracts", () => {
  it("prints a stable machine-readable JSON status for agents", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-json-output-"));
    const targetDir = resolve(parent, "wiki");

    try {
      // Act
      const result = await runCliBuffered([
        "init",
        targetDir,
        "--agent",
        "codex",
        "--obsidian",
        "--dataview",
        "--quartz-ready",
        "--no-git",
        "--json",
      ]);
      const payload = parseInitJson(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(Object.keys(payload)).toEqual([
        "command",
        "status",
        "targetDir",
        "createdPaths",
        "overwrittenPaths",
        "skippedPaths",
        "optionalGroups",
        "noOp",
        "git",
        "warnings",
        "errors",
      ]);
      expect(payload).toMatchObject({
        command: "init",
        status: "initialized",
        targetDir,
        optionalGroups: {
          agent: "codex",
          obsidian: true,
          dataview: true,
          git: false,
          quartzReady: true,
        },
        noOp: {
          git: true,
        },
        git: {
          enabled: false,
          attempted: false,
          ok: true,
          initialized: false,
          staged: false,
          committed: false,
          commitMessage: "chore: initialize llm-wiki",
          manualCommands: [],
          error: null,
        },
        warnings: [],
        errors: [],
      });
      expect(payload.createdPaths).toEqual([...payload.createdPaths].sort());
      expect(payload.createdPaths).toContain("AGENTS.md");
      expect(payload.createdPaths).toContain("CODEX.md");
      expect(payload.createdPaths).toContain(".obsidian/app.json");
      expect(payload.createdPaths).toContain("curated/dashboards/ingestion-queue.md");
      expect(payload.overwrittenPaths).toEqual([]);
      expect(payload.skippedPaths).toEqual([]);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("prints human-readable init output with path, optional groups, Git result, warnings, and next commands", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-human-output-"));
    const targetDir = resolve(parent, "wiki");

    try {
      // Act
      const result = await runCliBuffered(["init", targetDir, "--agent", "claude", "--dataview", "--no-git"]);
      const output = result.stdout.join("\n");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(output).toContain("LLM Wiki initialized");
      expect(output).toContain(`Path: ${targetDir}`);
      expect(output).toContain("Optional groups: agent=claude, obsidian=off, dataview=on, quartz-ready=off");
      expect(output).toContain("Git: skipped (--no-git)");
      expect(output).toContain("Warnings: none");
      expect(output).toContain("Next commands:");
      expect(output).toContain(quotedCdCommand(targetDir));
      expect(output).toContain("llm-wiki add <source> --title <title>");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});
