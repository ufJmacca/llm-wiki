import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

type InitJson = {
  command: "init";
  targetDir: string;
  options: {
    agent: "codex" | "claude" | "generic";
    obsidian: boolean;
    dataview: boolean;
    git: boolean;
    quartzReady: boolean;
    force: boolean;
    json: boolean;
  };
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

  it("parses default init options without scaffold side effects", async () => {
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
        targetDir,
        options: {
          agent: "generic",
          obsidian: false,
          dataview: false,
          git: true,
          quartzReady: false,
          force: false,
          json: true,
        },
      });
      expect(await pathExists(targetDir)).toBe(false);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("parses supported agent and feature options", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-init-options-"));
    const targetDir = resolve(parent, "wiki");

    try {
      // Act
      const codex = await runCliBuffered([
        "init",
        targetDir,
        "--agent",
        "codex",
        "--obsidian",
        "--dataview",
        "--git",
        "--quartz-ready",
        "--force",
        "--json",
      ]);
      const claude = await runCliBuffered(["init", targetDir, "--agent", "claude", "--no-git", "--json"]);
      const generic = await runCliBuffered(["init", targetDir, "--agent", "generic", "--json"]);

      // Assert
      expect(codex.exitCode).toBe(0);
      expect(parseInitJson(codex.stdout).options).toEqual({
        agent: "codex",
        obsidian: true,
        dataview: true,
        git: true,
        quartzReady: true,
        force: true,
        json: true,
      });
      expect(claude.exitCode).toBe(0);
      expect(parseInitJson(claude.stdout).options).toMatchObject({
        agent: "claude",
        git: false,
        quartzReady: false,
      });
      expect(generic.exitCode).toBe(0);
      expect(parseInitJson(generic.stdout).options).toMatchObject({
        agent: "generic",
      });
      expect(await pathExists(targetDir)).toBe(false);
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
