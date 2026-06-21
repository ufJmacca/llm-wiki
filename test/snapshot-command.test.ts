import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

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
    code?: string;
    rule_id?: string;
    message: string;
    path: string;
    hint?: string;
    fix_hint?: string;
    fixable?: boolean;
  }>;
};

type SnapshotData = {
  status: "committed";
  commit_message: "chore: snapshot llm-wiki state";
  commit_sha: string;
  lint: {
    counts: {
      error: number;
      warning: number;
    };
  };
  git: {
    enabled: true;
    repository: true;
    branch: string | null;
    head: string | null;
    dirty: boolean | null;
    errors: unknown[];
  };
};

type FakeGitCall = {
  args: string[];
  cwd: string;
  authorName: string | null;
  authorEmail: string | null;
};

const snapshotMessage = "chore: snapshot llm-wiki state";
const execFileAsync = promisify(execFile);
const supportsUnreadableFileTest =
  process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--json"]);

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

async function createFakeGit(
  behavior: "success" | "missing-identity-then-success" | "commit-failure",
): Promise<{ binDir: string; logPath: string; restore: () => void }> {
  const binDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-snapshot-fake-git-bin-"));
  const gitPath = resolve(binDir, "git");
  const logPath = resolve(binDir, "git.log");
  const oldPath = process.env.PATH;
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LLM_WIKI_FAKE_GIT_LOG, JSON.stringify({
  args,
  cwd: process.cwd(),
  authorName: process.env.GIT_AUTHOR_NAME ?? null,
  authorEmail: process.env.GIT_AUTHOR_EMAIL ?? null
}) + "\\n", "utf8");
if (args[0] === "init") {
  fs.mkdirSync(path.join(process.cwd(), ".git"), { recursive: true });
  process.exit(0);
}
if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
  process.exit(1);
}
if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
  process.stdout.write("true\\n");
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
  process.stdout.write("main\\n");
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "--short") {
  process.stdout.write("def5678\\n");
  process.exit(0);
}
if (args[0] === "status" && args[1] === "--porcelain") {
  process.exit(0);
}
if (${JSON.stringify(behavior)} === "missing-identity-then-success" && args[0] === "commit" && !process.env.GIT_AUTHOR_NAME) {
  console.error("Author identity unknown");
  process.exit(128);
}
if (${JSON.stringify(behavior)} === "commit-failure" && args[0] === "commit" && args.includes(${JSON.stringify(snapshotMessage)})) {
  console.error("fatal: cannot lock ref");
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
    restore: () => {
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
  let log: string;
  try {
    log = await readFile(logPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeGitCall);
}

function unsetGitIdentityEnv(): () => void {
  const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    delete process.env[key];
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

describe("snapshot command", () => {
  it("runs lint first and refuses to commit when critical lint errors exist", async () => {
    await withTempWorkspace("llm-wiki-snapshot-lint-blocked-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("success");
      try {
        await initializeWiki(wikiDir);
        await rm(resolve(wikiDir, "curated/log.md"));

        // Act
        const result = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
        const payload = parseJsonFailure<"snapshot">(result.stdout);
        const gitCalls = await readFakeGitLog(fakeGit.logPath);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload).toMatchObject({
          ok: false,
          command: "snapshot",
          repo: wikiDir,
          error: {
            code: "SNAPSHOT_LINT_FAILED",
          },
        });
        expect(payload.issues).toEqual([
          expect.objectContaining({
            rule_id: "runtime_log_missing",
            severity: "error",
            path: "curated/log.md",
          }),
        ]);
        expect(gitCalls.map((call) => call.args)).not.toContainEqual(["add", "--all"]);
        expect(gitCalls.map((call) => call.args)).not.toContainEqual(["commit", "-m", snapshotMessage]);
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it.skipIf(!supportsUnreadableFileTest)("wraps lint scan failures in JSON before running Git", async () => {
    await withTempWorkspace("llm-wiki-snapshot-scan-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("success");
      try {
        await initializeWiki(wikiDir);
        const gitCallsBefore = await readFakeGitLog(fakeGit.logPath);
        const unreadablePath = resolve(wikiDir, "curated/unreadable.md");
        await writeFile(
          unreadablePath,
          "---\ntype: page\ntitle: Unreadable\nvisibility: private\nsource_ids: []\n---\n\n# Unreadable\n",
          "utf8",
        );
        await chmod(unreadablePath, 0o000);

        let result;
        try {
          try {
            await readFile(unreadablePath);
            return;
          } catch {
            // Permission enforcement varies by runtime user; when enforced, assert the CLI contract below.
          }

          // Act
          result = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
        } finally {
          await chmod(unreadablePath, 0o600).catch(() => undefined);
        }

        const payload = parseJsonFailure<"snapshot">(result.stdout);
        const gitCallsAfter = await readFakeGitLog(fakeGit.logPath);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload).toMatchObject({
          ok: false,
          command: "snapshot",
          repo: wikiDir,
          error: {
            code: "SNAPSHOT_LINT_FAILED",
            message: "Snapshot refused because lint failed while scanning repository.",
          },
        });
        expect(payload.issues).toEqual([
          expect.objectContaining({
            rule_id: "lint_scan_failed",
            severity: "error",
            path: ".",
            fixable: false,
          }),
        ]);
        expect(gitCallsAfter).toEqual(gitCallsBefore);
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it("creates a standard snapshot commit and reports commit SHA plus clean Git state", async () => {
    await withTempWorkspace("llm-wiki-snapshot-success-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const restoreGitIdentity = unsetGitIdentityEnv();
      const fakeGit = await createFakeGit("missing-identity-then-success");
      try {
        await initializeWiki(wikiDir);
        await writeFile(resolve(wikiDir, "curated/home.md"), "---\ntype: page\ntitle: Home\nvisibility: private\nsource_ids: []\n---\n\n# Home\n\nSnapshot me.\n", "utf8");

        // Act
        const result = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
        const payload = parseJsonSuccess<"snapshot", SnapshotData>(result.stdout);
        const gitCalls = await readFakeGitLog(fakeGit.logPath);
        const commitCalls = gitCalls.filter((call) => call.args[0] === "commit" && call.args.includes(snapshotMessage));

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data).toEqual({
          status: "committed",
          commit_message: snapshotMessage,
          commit_sha: "def5678",
          lint: {
            counts: expect.objectContaining({
              error: 0,
            }),
          },
          git: expect.objectContaining({
            enabled: true,
            repository: true,
            branch: "main",
            head: "def5678",
            dirty: false,
            errors: [],
          }),
        });
        expect(gitCalls.map((call) => call.args)).toEqual(
          expect.arrayContaining([
            ["add", "--all"],
            ["commit", "--allow-empty", "-m", snapshotMessage],
            ["rev-parse", "--short", "HEAD"],
          ]),
        );
        expect(commitCalls).toHaveLength(2);
        expect(commitCalls[0]).toMatchObject({
          authorName: null,
          authorEmail: null,
        });
        expect(commitCalls[1]).toMatchObject({
          authorName: "llm-wiki",
          authorEmail: "llm-wiki@example.invalid",
        });
      } finally {
        fakeGit.restore();
        restoreGitIdentity();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it("creates an empty snapshot commit instead of failing on a clean worktree", async () => {
    await withTempWorkspace("llm-wiki-snapshot-clean-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      try {
        await execFileAsync("git", ["--version"]);
      } catch {
        return;
      }

      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"snapshot", SnapshotData>(result.stdout);
      const commitSubject = await execFileAsync("git", ["-C", wikiDir, "log", "--format=%s", "-1"]);
      const status = await execFileAsync("git", ["-C", wikiDir, "status", "--short"]);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        status: "committed",
        commit_message: snapshotMessage,
        git: expect.objectContaining({
          dirty: false,
          errors: [],
        }),
      });
      expect(payload.data.commit_sha).toMatch(/^[a-f0-9]+$/);
      expect(commitSubject.stdout.trim()).toBe(snapshotMessage);
      expect(status.stdout).toBe("");
    });
  });

  it("reports Git commit failures with command, exit code, stderr, and manual next steps", async () => {
    await withTempWorkspace("llm-wiki-snapshot-git-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("commit-failure");
      try {
        await initializeWiki(wikiDir);

        // Act
        const result = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
        const payload = parseJsonFailure<"snapshot">(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload).toMatchObject({
          ok: false,
          command: "snapshot",
          repo: wikiDir,
          error: {
            code: "SNAPSHOT_GIT_FAILED",
          },
        });
        expect(payload.issues).toEqual([
          expect.objectContaining({
            code: "SNAPSHOT_GIT_FAILED",
            message: expect.stringContaining("fatal: cannot lock ref"),
            path: ".git",
          }),
        ]);
        expect(payload.error).toMatchObject({
          message: expect.stringContaining("git commit --allow-empty -m"),
          hint: expect.stringContaining("Run the manual Git commands"),
        });
        expect(JSON.stringify(payload)).toContain('"exit_code":42');
        expect(JSON.stringify(payload)).toContain("git commit --allow-empty -m");
        expect(JSON.stringify(payload)).toContain("git status");
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it("reports malformed wiki config before Git disabled preflight", async () => {
    await withTempWorkspace("llm-wiki-snapshot-config-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("success");
      try {
        await initializeWiki(wikiDir);
        const gitCallsBefore = await readFakeGitLog(fakeGit.logPath);
        await writeFile(resolve(wikiDir, ".llm-wiki/config.yml"), "features:\n  git: [\n", "utf8");

        // Act
        const result = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
        const payload = parseJsonFailure<"snapshot">(result.stdout);
        const gitCallsAfter = await readFakeGitLog(fakeGit.logPath);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error).toMatchObject({
          code: "SNAPSHOT_CONFIG_FAILED",
          message: expect.stringContaining("Could not parse .llm-wiki/config.yml"),
          hint: expect.stringContaining("Fix the YAML syntax"),
        });
        expect(payload.issues).toEqual([
          expect.objectContaining({
            code: "wiki_config_invalid",
            severity: "error",
            path: ".llm-wiki/config.yml",
          }),
        ]);
        expect(JSON.stringify(payload)).not.toContain("Git is disabled");
        expect(gitCallsAfter).toEqual(gitCallsBefore);
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it("reports non-boolean Git config before lint or Git preflight", async () => {
    await withTempWorkspace("llm-wiki-snapshot-config-git-type-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("success");
      try {
        await initializeWiki(wikiDir);
        const gitCallsBefore = await readFakeGitLog(fakeGit.logPath);
        await writeFile(resolve(wikiDir, ".llm-wiki/config.yml"), "features:\n  git: tru\n", "utf8");

        // Act
        const result = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
        const payload = parseJsonFailure<"snapshot">(result.stdout);
        const gitCallsAfter = await readFakeGitLog(fakeGit.logPath);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error).toMatchObject({
          code: "SNAPSHOT_CONFIG_FAILED",
          message: expect.stringContaining("features.git must be a boolean"),
          hint: expect.stringContaining("features.git to true or false"),
        });
        expect(payload.issues).toEqual([
          expect.objectContaining({
            code: "wiki_config_invalid",
            severity: "error",
            path: ".llm-wiki/config.yml",
            message: expect.stringContaining("features.git must be a boolean"),
          }),
        ]);
        expect(JSON.stringify(payload)).not.toContain("Git is disabled");
        expect(gitCallsAfter).toEqual(gitCallsBefore);
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it.each([
    ["empty file", "", "config root must be a mapping"],
    ["array root", "[]\n", "config root must be a mapping"],
    ["array features", "features: []\n", "features must be a mapping"],
  ])("reports structurally malformed wiki config before lint or Git preflight: %s", async (_label, configSource, expectedMessage) => {
    await withTempWorkspace("llm-wiki-snapshot-config-shape-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("success");
      try {
        await initializeWiki(wikiDir);
        const gitCallsBefore = await readFakeGitLog(fakeGit.logPath);
        await writeFile(resolve(wikiDir, ".llm-wiki/config.yml"), configSource, "utf8");

        // Act
        const result = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
        const payload = parseJsonFailure<"snapshot">(result.stdout);
        const gitCallsAfter = await readFakeGitLog(fakeGit.logPath);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error).toMatchObject({
          code: "SNAPSHOT_CONFIG_FAILED",
          message: expect.stringContaining(expectedMessage),
        });
        expect(payload.issues).toEqual([
          expect.objectContaining({
            code: "wiki_config_invalid",
            severity: "error",
            path: ".llm-wiki/config.yml",
            message: expect.stringContaining(expectedMessage),
          }),
        ]);
        expect(JSON.stringify(payload)).not.toContain("Git is disabled");
        expect(gitCallsAfter).toEqual(gitCallsBefore);
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it.skipIf(!supportsUnreadableFileTest)("reports unreadable wiki config before lint scans", async () => {
    await withTempWorkspace("llm-wiki-snapshot-config-unreadable-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("success");
      try {
        await initializeWiki(wikiDir);
        const gitCallsBefore = await readFakeGitLog(fakeGit.logPath);
        const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
        await chmod(configPath, 0o000);

        let result;
        try {
          try {
            await readFile(configPath);
            return;
          } catch {
            // Permission enforcement varies by runtime user; when enforced, assert the CLI contract below.
          }

          // Act
          result = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
        } finally {
          await chmod(configPath, 0o600).catch(() => undefined);
        }

        const payload = parseJsonFailure<"snapshot">(result.stdout);
        const gitCallsAfter = await readFakeGitLog(fakeGit.logPath);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error).toMatchObject({
          code: "SNAPSHOT_CONFIG_FAILED",
          message: expect.stringContaining("Could not read .llm-wiki/config.yml"),
          hint: expect.stringContaining("Ensure .llm-wiki/config.yml is readable"),
        });
        expect(payload.issues).toEqual([
          expect.objectContaining({
            code: "wiki_config_unreadable",
            severity: "error",
            path: ".llm-wiki/config.yml",
          }),
        ]);
        expect(JSON.stringify(payload)).not.toContain("Snapshot refused because lint failed");
        expect(gitCallsAfter).toEqual(gitCallsBefore);
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it("refuses to snapshot when wiki Git is disabled even inside an enclosing worktree", async () => {
    await withTempWorkspace("llm-wiki-snapshot-disabled-git-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("success");
      try {
        await mkdir(resolve(workspaceDir, ".git"));
        const result = await runCliBuffered(["init", wikiDir, "--no-git", "--json"]);
        expect(result.exitCode).toBe(0);

        // Act
        const snapshotResult = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
        const payload = parseJsonFailure<"snapshot">(snapshotResult.stdout);
        const gitCalls = await readFakeGitLog(fakeGit.logPath);

        // Assert
        expect(snapshotResult.exitCode).toBe(1);
        expect(snapshotResult.stderr).toEqual([]);
        expect(payload.error).toMatchObject({
          code: "SNAPSHOT_GIT_FAILED",
          message: expect.stringContaining("Git is disabled for this wiki"),
        });
        expect(JSON.stringify(payload)).toContain("features.git: true");
        expect(gitCalls).toEqual([]);
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it("refuses to snapshot when Git is enabled but the wiki has no local .git", async () => {
    await withTempWorkspace("llm-wiki-snapshot-missing-local-git-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("success");
      try {
        await mkdir(resolve(workspaceDir, ".git"));
        const result = await runCliBuffered(["init", wikiDir, "--no-git", "--json"]);
        expect(result.exitCode).toBe(0);

        const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
        const config = await readFile(configPath, "utf8");
        await writeFile(configPath, config.replace("  git: false", "  git: true"), "utf8");

        // Act
        const snapshotResult = await runCliBuffered(["snapshot", "--repo", wikiDir, "--json"]);
        const payload = parseJsonFailure<"snapshot">(snapshotResult.stdout);
        const gitCalls = await readFakeGitLog(fakeGit.logPath);

        // Assert
        expect(snapshotResult.exitCode).toBe(1);
        expect(snapshotResult.stderr).toEqual([]);
        expect(payload.error).toMatchObject({
          code: "SNAPSHOT_GIT_FAILED",
          message: expect.stringContaining("no wiki-local .git repository was found"),
        });
        expect(JSON.stringify(payload)).toContain("git init");
        expect(gitCalls).toEqual([]);
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });
});
