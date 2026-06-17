import { execFile } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const initialCommitMessage = "chore: initialize llm-wiki";
const gitIdentityEnvKeys = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

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

type FakeGitCall = {
  args: string[];
  cwd: string;
  agentsExists: boolean;
  gitDir: string | null;
  gitWorkTree: string | null;
  gitIndexFile: string | null;
  authorName: string | null;
  authorEmail: string | null;
  committerName: string | null;
  committerEmail: string | null;
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

async function createFakeGit(
  behavior: "record-success" | "fail-commit" | "missing-identity-then-success",
): Promise<{ binDir: string; logPath: string; restorePath: () => void }> {
  const binDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-fake-git-bin-"));
  const logPath = resolve(binDir, "git.log");
  const gitPath = resolve(binDir, "git");
  const oldPath = process.env.PATH;
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const logPath = process.env.LLM_WIKI_FAKE_GIT_LOG;
const record = (event) => fs.appendFileSync(logPath, JSON.stringify(event) + "\\n", "utf8");
record({
  args,
  cwd: process.cwd(),
  agentsExists: fs.existsSync(path.join(process.cwd(), "AGENTS.md")),
  gitDir: process.env.GIT_DIR ?? null,
  gitWorkTree: process.env.GIT_WORK_TREE ?? null,
  gitIndexFile: process.env.GIT_INDEX_FILE ?? null,
  authorName: process.env.GIT_AUTHOR_NAME ?? null,
  authorEmail: process.env.GIT_AUTHOR_EMAIL ?? null,
  committerName: process.env.GIT_COMMITTER_NAME ?? null,
  committerEmail: process.env.GIT_COMMITTER_EMAIL ?? null
});
if (args[0] === "init") {
  fs.mkdirSync(path.join(process.cwd(), ".git"), { recursive: true });
  process.exit(0);
}
if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
  process.exit(1);
}
if (${JSON.stringify(behavior)} === "missing-identity-then-success" && args[0] === "commit" && !process.env.GIT_AUTHOR_NAME) {
  console.error("Author identity unknown");
  console.error("fatal: unable to auto-detect email address");
  process.exit(128);
}
if (${JSON.stringify(behavior)} === "fail-commit" && args[0] === "commit") {
  console.error("commit rejected by fake git");
  process.exit(42);
}
process.exit(0);
`;

  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;
  process.env.LLM_WIKI_FAKE_GIT_LOG = logPath;

  return {
    binDir,
    logPath,
    restorePath: () => {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      delete process.env.LLM_WIKI_FAKE_GIT_LOG;
    },
  };
}

async function readFakeGitLog(logPath: string): Promise<FakeGitCall[]> {
  const log = await readFile(logPath, "utf8");
  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeGitCall);
}

async function createUnavailableGitPath(): Promise<{ binDir: string; restorePath: () => void }> {
  const binDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-no-git-bin-"));
  const oldPath = process.env.PATH;

  process.env.PATH = binDir;

  return {
    binDir,
    restorePath: () => {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    },
  };
}

function overrideEnv(overrides: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function unsetGitIdentityEnv(): () => void {
  return overrideEnv(Object.fromEntries(gitIdentityEnvKeys.map((key) => [key, undefined])));
}

function quotedCdCommand(targetDir: string): string {
  return `cd ${shellQuote(targetDir)}`;
}

function manualGitAddCommand(paths: readonly string[]): string {
  return `git add -- ${paths.map(shellQuote).join(" ")}`;
}

function manualGitCommitCommand(paths: readonly string[]): string {
  return `git commit -m "${initialCommitMessage}" -- ${paths.map(shellQuote).join(" ")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stagedPaths(payload: InitJson): string[] {
  return [...payload.createdPaths, ...payload.overwrittenPaths, ...payload.skippedPaths].sort();
}

describe("init Git lifecycle", () => {
  it("runs git init, git add, and initial commit after scaffold files are written", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-git-sequence-"));
    const targetDir = resolve(parent, "wiki");
    const restoreGitIdentity = unsetGitIdentityEnv();
    const fakeGit = await createFakeGit("record-success");

    try {
      // Act
      const result = await runCliBuffered(["init", targetDir, "--json"]);
      const payload = parseInitJson(result.stdout);
      const gitCalls = await readFakeGitLog(fakeGit.logPath);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.git).toMatchObject({
        enabled: true,
        attempted: true,
        ok: true,
        initialized: true,
        staged: true,
        committed: true,
        commitMessage: initialCommitMessage,
        error: null,
      });
      expect(gitCalls.map((call) => call.args)).toEqual([
        ["init"],
        ["add", "--", ...stagedPaths(payload)],
        ["diff", "--cached", "--quiet", "--", ...stagedPaths(payload)],
        ["commit", "-m", initialCommitMessage, "--", ...stagedPaths(payload)],
      ]);
      expect(gitCalls.every((call) => call.cwd === targetDir)).toBe(true);
      expect(gitCalls.every((call) => call.agentsExists)).toBe(true);
      expect(gitCalls.every((call) => call.authorName === null)).toBe(true);
      expect(gitCalls.every((call) => call.authorEmail === null)).toBe(true);
      expect(gitCalls.every((call) => call.committerName === null)).toBe(true);
      expect(gitCalls.every((call) => call.committerEmail === null)).toBe(true);
    } finally {
      fakeGit.restorePath();
      restoreGitIdentity();
      await rm(parent, { force: true, recursive: true });
      await rm(fakeGit.binDir, { force: true, recursive: true });
    }
  });

  it("clears inherited repository-scoping Git environment before running Git", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-git-env-"));
    const targetDir = resolve(parent, "wiki");
    const restoreGitEnv = overrideEnv({
      GIT_DIR: resolve(parent, "inherited.git"),
      GIT_WORK_TREE: resolve(parent, "inherited-work-tree"),
      GIT_INDEX_FILE: resolve(parent, "inherited.index"),
    });
    const fakeGit = await createFakeGit("record-success");

    try {
      // Act
      const result = await runCliBuffered(["init", targetDir, "--json"]);
      const payload = parseInitJson(result.stdout);
      const gitCalls = await readFakeGitLog(fakeGit.logPath);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.git.ok).toBe(true);
      expect(gitCalls.every((call) => call.cwd === targetDir)).toBe(true);
      expect(gitCalls.every((call) => call.gitDir === null)).toBe(true);
      expect(gitCalls.every((call) => call.gitWorkTree === null)).toBe(true);
      expect(gitCalls.every((call) => call.gitIndexFile === null)).toBe(true);
    } finally {
      fakeGit.restorePath();
      restoreGitEnv();
      await rm(parent, { force: true, recursive: true });
      await rm(fakeGit.binDir, { force: true, recursive: true });
    }
  });

  it("retries commit with fallback identity only when Git reports missing identity", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-git-identity-"));
    const targetDir = resolve(parent, "wiki");
    const restoreGitIdentity = unsetGitIdentityEnv();
    const fakeGit = await createFakeGit("missing-identity-then-success");

    try {
      // Act
      const result = await runCliBuffered(["init", targetDir, "--json"]);
      const payload = parseInitJson(result.stdout);
      const commitCalls = (await readFakeGitLog(fakeGit.logPath)).filter((call) => call.args[0] === "commit");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.git).toMatchObject({
        ok: true,
        committed: true,
        error: null,
      });
      expect(commitCalls).toHaveLength(2);
      expect(commitCalls[0]).toMatchObject({
        authorName: null,
        authorEmail: null,
        committerName: null,
        committerEmail: null,
      });
      expect(commitCalls[1]).toMatchObject({
        authorName: "llm-wiki",
        authorEmail: "llm-wiki@example.invalid",
        committerName: "llm-wiki",
        committerEmail: "llm-wiki@example.invalid",
      });
    } finally {
      fakeGit.restorePath();
      restoreGitIdentity();
      await rm(parent, { force: true, recursive: true });
      await rm(fakeGit.binDir, { force: true, recursive: true });
    }
  });

  it("creates a real Git repository with an initial commit when Git is available", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-real-git-"));
    const targetDir = resolve(parent, "wiki");

    try {
      await execFileAsync("git", ["--version"]);

      // Act
      const result = await runCliBuffered(["init", targetDir, "--json"]);
      const commit = await execFileAsync("git", ["-C", targetDir, "log", "--format=%s", "-1"]);
      const status = await execFileAsync("git", ["-C", targetDir, "status", "--short"]);
      const payload = parseInitJson(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.git.ok).toBe(true);
      expect(await pathExists(resolve(targetDir, ".git"))).toBe(true);
      expect(commit.stdout.trim()).toBe(initialCommitMessage);
      expect(status.stdout).toBe("");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("does not commit unrelated pre-staged files when --force initializes an existing repository", async () => {
    // Arrange
    const targetDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-force-existing-git-"));
    const unrelatedPath = resolve(targetDir, "private-notes.md");

    try {
      await execFileAsync("git", ["--version"]);
      await execFileAsync("git", ["-C", targetDir, "init"]);
      await execFileAsync("git", ["-C", targetDir, "config", "user.email", "test@example.invalid"]);
      await execFileAsync("git", ["-C", targetDir, "config", "user.name", "Test User"]);
      await writeFile(unrelatedPath, "private notes stay outside the scaffold commit\n", "utf8");
      await execFileAsync("git", ["-C", targetDir, "add", "private-notes.md"]);

      // Act
      const result = await runCliBuffered(["init", targetDir, "--force", "--json"]);
      const payload = parseInitJson(result.stdout);
      const committedFiles = await execFileAsync("git", ["-C", targetDir, "ls-tree", "--name-only", "-r", "HEAD"]);
      const status = await execFileAsync("git", ["-C", targetDir, "status", "--short", "--", "private-notes.md"]);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.git.ok).toBe(true);
      expect(payload.createdPaths).toContain("AGENTS.md");
      expect(committedFiles.stdout.split("\n")).not.toContain("private-notes.md");
      expect(status.stdout.trim()).toBe("A  private-notes.md");
      expect(await readFile(unrelatedPath, "utf8")).toBe("private notes stay outside the scaffold commit\n");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    } finally {
      await rm(targetDir, { force: true, recursive: true });
    }
  });

  it("treats clean --force reruns as successful Git no-ops", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-force-clean-rerun-"));
    const targetDir = resolve(parent, "wiki");

    try {
      await execFileAsync("git", ["--version"]);
      const firstResult = await runCliBuffered(["init", targetDir, "--json"]);
      const firstPayload = parseInitJson(firstResult.stdout);

      // Act
      const result = await runCliBuffered(["init", targetDir, "--force", "--json"]);
      const payload = parseInitJson(result.stdout);
      const commitSubjects = await execFileAsync("git", ["-C", targetDir, "log", "--format=%s"]);
      const status = await execFileAsync("git", ["-C", targetDir, "status", "--short"]);

      // Assert
      expect(firstResult.exitCode).toBe(0);
      expect(firstPayload.git.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.status).toBe("initialized");
      expect(payload.git).toMatchObject({
        enabled: true,
        attempted: true,
        ok: true,
        initialized: true,
        staged: true,
        committed: false,
        error: null,
        manualCommands: [],
      });
      expect(payload.warnings).toEqual([]);
      expect(commitSubjects.stdout.trim().split("\n")).toEqual([initialCommitMessage]);
      expect(status.stdout).toBe("");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("stages unchanged scaffold files when --force enables Git on an existing --no-git scaffold", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-force-existing-no-git-"));
    const targetDir = resolve(parent, "wiki");

    try {
      await execFileAsync("git", ["--version"]);
      const noGitResult = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);
      const noGitPayload = parseInitJson(noGitResult.stdout);

      // Act
      const result = await runCliBuffered(["init", targetDir, "--force", "--json"]);
      const payload = parseInitJson(result.stdout);
      const committedFiles = await execFileAsync("git", ["-C", targetDir, "ls-tree", "--name-only", "-r", "HEAD"]);
      const status = await execFileAsync("git", ["-C", targetDir, "status", "--short"]);

      // Assert
      expect(noGitResult.exitCode).toBe(0);
      expect(noGitPayload.git.enabled).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.git.ok).toBe(true);
      expect(payload.createdPaths).toEqual([]);
      expect(payload.overwrittenPaths).toEqual([".llm-wiki/config.yml"]);
      expect(payload.skippedPaths).toContain("AGENTS.md");
      expect(payload.skippedPaths).toContain("curated/index.md");
      expect(committedFiles.stdout.split("\n")).toEqual(expect.arrayContaining(stagedPaths(payload)));
      expect(status.stdout).toBe("");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("skips every Git operation when --no-git is passed", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-no-git-"));
    const targetDir = resolve(parent, "wiki");
    const fakeGit = await createFakeGit("record-success");

    try {
      // Act
      const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);
      const payload = parseInitJson(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.noOp.git).toBe(true);
      expect(payload.git).toMatchObject({
        enabled: false,
        attempted: false,
        ok: true,
        initialized: false,
        staged: false,
        committed: false,
        error: null,
      });
      expect(await pathExists(resolve(targetDir, ".git"))).toBe(false);
      expect(await pathExists(fakeGit.logPath)).toBe(false);
    } finally {
      fakeGit.restorePath();
      await rm(parent, { force: true, recursive: true });
      await rm(fakeGit.binDir, { force: true, recursive: true });
    }
  });

  it("keeps scaffold files and reports manual Git next steps when commit fails", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-git-failure-"));
    const targetDir = resolve(parent, "wiki");
    const fakeGit = await createFakeGit("fail-commit");

    try {
      // Act
      const result = await runCliBuffered(["init", targetDir, "--json"]);
      const payload = parseInitJson(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(await pathExists(resolve(targetDir, "AGENTS.md"))).toBe(true);
      expect(await pathExists(resolve(targetDir, "curated/index.md"))).toBe(true);
      expect(payload.status).toBe("initialized_with_warnings");
      expect(payload.git).toMatchObject({
        enabled: true,
        attempted: true,
        ok: false,
        initialized: true,
        staged: true,
        committed: false,
        commitMessage: initialCommitMessage,
      });
      expect(payload.git.error).toContain("git commit");
      expect(payload.warnings.join("\n")).toContain("Git setup did not complete");
      expect(payload.git.manualCommands).toEqual([
        quotedCdCommand(targetDir),
        "git init",
        manualGitAddCommand(stagedPaths(payload)),
        manualGitCommitCommand(stagedPaths(payload)),
      ]);
    } finally {
      fakeGit.restorePath();
      await rm(parent, { force: true, recursive: true });
      await rm(fakeGit.binDir, { force: true, recursive: true });
    }
  });

  it("keeps scaffold files and reports JSON recovery details when git is unavailable", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-git-unavailable-json-"));
    const targetDir = resolve(parent, "wiki with 'quotes' && spaces");
    const unavailableGit = await createUnavailableGitPath();

    try {
      // Act
      const result = await runCliBuffered(["init", targetDir, "--json"]);
      const payload = parseInitJson(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(await pathExists(resolve(targetDir, "AGENTS.md"))).toBe(true);
      expect(await pathExists(resolve(targetDir, "curated/index.md"))).toBe(true);
      expect(await pathExists(resolve(targetDir, ".git"))).toBe(false);
      expect(payload.status).toBe("initialized_with_warnings");
      expect(payload.git).toMatchObject({
        enabled: true,
        attempted: true,
        ok: false,
        initialized: false,
        staged: false,
        committed: false,
        commitMessage: initialCommitMessage,
      });
      expect(payload.git.error).toContain("git init");
      expect(payload.git.error).toContain("Git executable was not found on PATH");
      expect(payload.warnings.join("\n")).toContain("Git setup did not complete");
      expect(payload.git.manualCommands).toEqual([
        quotedCdCommand(targetDir),
        "git init",
        manualGitAddCommand(stagedPaths(payload)),
        manualGitCommitCommand(stagedPaths(payload)),
      ]);
    } finally {
      unavailableGit.restorePath();
      await rm(parent, { force: true, recursive: true });
      await rm(unavailableGit.binDir, { force: true, recursive: true });
    }
  });

  it("prints human-readable recovery commands when git is unavailable", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-git-unavailable-human-"));
    const targetDir = resolve(parent, "wiki");
    const unavailableGit = await createUnavailableGitPath();

    try {
      // Act
      const result = await runCliBuffered(["init", targetDir]);
      const output = result.stdout.join("\n");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(await pathExists(resolve(targetDir, "AGENTS.md"))).toBe(true);
      expect(await pathExists(resolve(targetDir, "curated/log.md"))).toBe(true);
      expect(await pathExists(resolve(targetDir, ".git"))).toBe(false);
      expect(output).toContain("Git: manual action required");
      expect(output).toContain("Warnings:");
      expect(output).toContain("Git setup did not complete");
      expect(output).toContain("Git executable was not found on PATH");
      expect(output).toContain("Manual Git next steps:");
      expect(output).toContain(`- ${quotedCdCommand(targetDir)}`);
      expect(output).toContain("- git init");
      expect(output).toContain("- git add -- ");
      expect(output).not.toContain("- git add .");
      expect(output).toContain(`- git commit -m "${initialCommitMessage}" -- `);
      expect(output).toContain("Next commands:");
    } finally {
      unavailableGit.restorePath();
      await rm(parent, { force: true, recursive: true });
      await rm(unavailableGit.binDir, { force: true, recursive: true });
    }
  });
});
