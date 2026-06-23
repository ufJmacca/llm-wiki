import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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

describe("llm-wiki init command surface", () => {
  it("registers init with Commander help and supported options", async () => {
    // Arrange
    const expectedOptions = [
      "--agent <agent>",
      "--obsidian",
      "--dataview",
      "--git",
      "--no-git",
      "--quartz-ready",
      "--force",
      "--json",
    ];

    // Act
    const result = await runCliBuffered(["init", "--help"]);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout.join("\n")).toContain("Usage: llm-wiki init [options] <dir>");
    for (const option of expectedOptions) {
      expect(result.stdout.join("\n")).toContain(option);
    }
  });

  it("creates the default scaffold and reports deterministic JSON path activity", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-init-default-"));
    const targetDir = resolve(parent, "wiki");

    try {
      // Act
      const result = await runCliBuffered(["init", targetDir, "--json"]);
      const payload = parseInitJson(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload).toEqual({
        command: "init",
        status: payload.status,
        targetDir,
        createdPaths: payload.createdPaths,
        overwrittenPaths: [],
        skippedPaths: [],
        optionalGroups: {
          agent: "generic",
          obsidian: false,
          dataview: false,
          git: true,
          quartzReady: false,
        },
        noOp: {
          git: false,
        },
        git: payload.git,
        warnings: payload.warnings,
        errors: [],
      });
      expect(payload.createdPaths).toEqual([...payload.createdPaths].sort());
      expect(payload.createdPaths).toContain("AGENTS.md");
      expect(payload.createdPaths).toContain(".llm-wiki/config.yml");
      expect(payload.createdPaths).toContain("curated/index.md");
      expect(payload.createdPaths).toContain("curated/log.md");
      expect(payload.git.commitMessage).toBe("chore: initialize llm-wiki");
      expect(await readFile(resolve(targetDir, "AGENTS.md"), "utf8")).toContain(
        "Maintain this repo as a persistent, compounding LLM Wiki.",
      );
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("parses supported agent and feature options", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-init-options-"));
    const codexTargetDir = resolve(parent, "codex-wiki");
    const claudeTargetDir = resolve(parent, "claude-wiki");
    const genericTargetDir = resolve(parent, "generic-wiki");

    try {
      // Act
      const codex = await runCliBuffered([
        "init",
        codexTargetDir,
        "--agent",
        "codex",
        "--obsidian",
        "--dataview",
        "--git",
        "--quartz-ready",
        "--force",
        "--json",
      ]);
      const claude = await runCliBuffered([
        "init",
        claudeTargetDir,
        "--agent",
        "claude",
        "--no-git",
        "--json",
      ]);
      const generic = await runCliBuffered(["init", genericTargetDir, "--agent", "generic", "--json"]);
      const codexConfigSource = await readFile(resolve(codexTargetDir, ".llm-wiki/config.yml"), "utf8");
      const codexConfig = parse(codexConfigSource) as {
        agent: { default: string };
        agents?: Record<string, unknown>;
      };
      const claudeConfig = parse(await readFile(resolve(claudeTargetDir, ".llm-wiki/config.yml"), "utf8")) as {
        agent: { default: string };
        agents?: Record<string, unknown>;
      };
      const genericConfig = parse(await readFile(resolve(genericTargetDir, ".llm-wiki/config.yml"), "utf8")) as {
        agent: { default: string };
        agents?: Record<string, unknown>;
      };

      // Assert
      expect(codex.exitCode).toBe(0);
      expect(parseInitJson(codex.stdout).optionalGroups).toEqual({
        agent: "codex",
        obsidian: true,
        dataview: true,
        git: true,
        quartzReady: true,
      });
      expect(claude.exitCode).toBe(0);
      expect(parseInitJson(claude.stdout).optionalGroups).toMatchObject({
        agent: "claude",
        git: false,
        quartzReady: false,
      });
      expect(generic.exitCode).toBe(0);
      expect(parseInitJson(generic.stdout).optionalGroups).toMatchObject({
        agent: "generic",
      });
      expect(parseInitJson(codex.stdout).createdPaths).toContain("CODEX.md");
      expect(parseInitJson(claude.stdout).createdPaths).toContain("CLAUDE.md");
      expect(codexConfig).toMatchObject({
        agent: { default: "codex" },
        agents: {
          codex: {
            type: "local-exec",
            command: "codex",
            args: ["exec"],
            approval_policy: "never",
            sandbox_mode: "workspace-write",
            output_mode: "git-diff",
            timeout_seconds: 900,
          },
        },
      });
      expect(codexConfigSource).not.toMatch(/api[_-]?key|secret|token|password|sk-/i);
      expect(claudeConfig).toMatchObject({ agent: { default: "claude" } });
      expect(claudeConfig.agents).toBeUndefined();
      expect(genericConfig).toMatchObject({ agent: { default: "generic" } });
      expect(genericConfig.agents).toBeUndefined();
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("rejects unsupported agents before touching the target path", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-init-invalid-agent-"));
    const targetDir = resolve(parent, "wiki");

    try {
      // Act
      const result = await runCliBuffered(["init", targetDir, "--agent", "gpt", "--json"]);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toEqual([]);
      expect(result.stderr.join("\n")).toContain("unsupported agent");
      expect(await pathExists(targetDir)).toBe(false);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});
