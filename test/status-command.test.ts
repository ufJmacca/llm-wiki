import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";

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

type StatusData = {
  config: {
    path: ".llm-wiki/config.yml";
    valid: boolean;
    git_enabled: boolean | null;
    errors: Array<{
      severity: "error";
      code: string;
      message: string;
      path: string;
      hint: string;
    }>;
  };
  health: {
    state: "ok" | "warning" | "error";
    ok: boolean;
    errors: number;
    warnings: number;
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
    ok: boolean;
    counts: {
      total: number;
      error: number;
      warning: number;
      fixed: number;
    };
    error_rule_ids: string[];
    warning_rule_ids: string[];
  };
  git: {
    enabled: boolean | null;
    repository: boolean;
    branch: string | null;
    head: string | null;
    dirty: boolean | null;
    errors: Array<{
      command: string;
      exit_code: number | null;
      stderr: string;
      manual_next_steps: string[];
    }>;
  };
  profiles: {
    total: number;
    valid: number;
    invalid: number;
    names: string[];
    invalid_paths: string[];
  };
  explorer: {
    ready: boolean;
    initialized: boolean;
    quartz_dir_exists: boolean;
    content_dir_exists: boolean;
    manifest_paths: string[];
  };
};

type SourceCaptureData = {
  status: "added" | "duplicate";
  source: {
    source_id: string;
  };
};

type FakeGitCall = {
  args: string[];
  cwd: string;
};

const supportsUnreadableFileTest =
  process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

async function initializeWiki(targetDir: string, git = false): Promise<void> {
  const args = git ? ["init", targetDir, "--json"] : ["init", targetDir, "--no-git", "--json"];
  const result = await runCliBuffered(args);

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

async function captureTextSource(wikiDir: string): Promise<string> {
  const result = await runCliBuffered([
    "add-text",
    "--repo",
    wikiDir,
    "--title",
    "Queue Health Note",
    "--text",
    "queued source for status",
    "--json",
  ]);
  const payload = parseJsonSuccess<"add-text", SourceCaptureData>(result.stdout);

  expect(result.exitCode).toBe(0);
  return payload.data.source.source_id;
}

async function createFakeGit(
  behavior: "status-success" | "status-failure",
): Promise<{ binDir: string; logPath: string; restore: () => void }> {
  const binDir = await mkdtemp(resolve(tmpdir(), "llm-wiki-status-fake-git-bin-"));
  const gitPath = resolve(binDir, "git");
  const logPath = resolve(binDir, "git.log");
  const oldPath = process.env.PATH;
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LLM_WIKI_FAKE_GIT_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n", "utf8");
if (args[0] === "init") {
  fs.mkdirSync(path.join(process.cwd(), ".git"), { recursive: true });
  process.exit(0);
}
if (${JSON.stringify(behavior)} === "status-failure" && args[0] === "status") {
  console.error("fatal: repository ownership check failed");
  process.exit(128);
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
  process.stdout.write("abc1234\\n");
  process.exit(0);
}
if (args[0] === "status" && args[1] === "--porcelain") {
  process.stdout.write(" M curated/home.md\\n");
  process.exit(0);
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
  const log = await readFile(logPath, "utf8");

  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeGitCall);
}

describe("status command", () => {
  it("reports health, queue, lint, optional Git, profiles, and Explorer readiness in stable JSON", async () => {
    await withTempWorkspace("llm-wiki-status-json-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const sourceId = await captureTextSource(wikiDir);

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toEqual({
        state: "warning",
        ok: true,
        errors: 0,
        warnings: 1,
      });
      expect(payload.data.queue.counts).toEqual({
        total: 1,
        queued: 1,
        ingesting: 0,
        ingested: 0,
        blocked: 0,
      });
      expect(payload.data.lint).toMatchObject({
        ok: true,
        counts: {
          total: 1,
          error: 0,
          warning: 1,
          fixed: 0,
        },
        error_rule_ids: [],
        warning_rule_ids: ["index_stale"],
      });
      expect(payload.data.git).toMatchObject({
        enabled: false,
        repository: false,
        branch: null,
        head: null,
        dirty: null,
        errors: [],
      });
      expect(payload.data.profiles).toMatchObject({
        total: 3,
        valid: 3,
        invalid: 0,
        names: ["local", "public", "review"],
        invalid_paths: [],
      });
      expect(payload.data.explorer).toEqual({
        ready: false,
        initialized: false,
        quartz_dir_exists: false,
        content_dir_exists: false,
        manifest_paths: [],
      });
      expect(JSON.stringify(payload.data)).toContain(sourceId);
    });
  });

  it("surfaces malformed wiki config as a health error instead of treating Git as disabled", async () => {
    await withTempWorkspace("llm-wiki-status-config-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/config.yml"), "features:\n  git: [\n", "utf8");

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
        errors: 1,
      });
      expect(payload.data.config).toMatchObject({
        path: ".llm-wiki/config.yml",
        valid: false,
        git_enabled: null,
        errors: [
          expect.objectContaining({
            code: "wiki_config_invalid",
            path: ".llm-wiki/config.yml",
            message: expect.stringContaining("Could not parse .llm-wiki/config.yml"),
          }),
        ],
      });
      expect(payload.data.git).toMatchObject({
        enabled: null,
        repository: false,
        branch: null,
        head: null,
        dirty: null,
      });
    });
  });

  it("surfaces non-boolean Git config as invalid instead of treating Git as disabled", async () => {
    await withTempWorkspace("llm-wiki-status-config-git-type-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/config.yml"), 'features:\n  git: "true"\n', "utf8");

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
        errors: 1,
      });
      expect(payload.data.config).toMatchObject({
        path: ".llm-wiki/config.yml",
        valid: false,
        git_enabled: null,
        errors: [
          expect.objectContaining({
            code: "wiki_config_invalid",
            path: ".llm-wiki/config.yml",
            message: expect.stringContaining("features.git must be a boolean"),
            hint: expect.stringContaining("features.git to true or false"),
          }),
        ],
      });
      expect(payload.data.git).toMatchObject({
        enabled: null,
        repository: false,
        branch: null,
        head: null,
        dirty: null,
      });
    });
  });

  it.each([
    ["empty file", "", "config root must be a mapping"],
    ["array root", "[]\n", "config root must be a mapping"],
    ["array features", "features: []\n", "features must be a mapping"],
  ])("surfaces structurally malformed wiki config as invalid: %s", async (_label, configSource, expectedMessage) => {
    await withTempWorkspace("llm-wiki-status-config-shape-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/config.yml"), configSource, "utf8");

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
        errors: 1,
      });
      expect(payload.data.config).toMatchObject({
        path: ".llm-wiki/config.yml",
        valid: false,
        git_enabled: null,
        errors: [
          expect.objectContaining({
            code: "wiki_config_invalid",
            path: ".llm-wiki/config.yml",
            message: expect.stringContaining(expectedMessage),
          }),
        ],
      });
      expect(payload.data.git).toMatchObject({
        enabled: null,
        repository: false,
        branch: null,
        head: null,
        dirty: null,
      });
    });
  });

  it.skipIf(!supportsUnreadableFileTest)("surfaces unreadable wiki config as a health error instead of a scan failure", async () => {
    await withTempWorkspace("llm-wiki-status-config-unreadable-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
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
        result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      } finally {
        await chmod(configPath, 0o600).catch(() => undefined);
      }

      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
        errors: 1,
      });
      expect(payload.data.config).toMatchObject({
        path: ".llm-wiki/config.yml",
        valid: false,
        git_enabled: null,
        errors: [
          expect.objectContaining({
            code: "wiki_config_unreadable",
            path: ".llm-wiki/config.yml",
            message: expect.stringContaining("Could not read .llm-wiki/config.yml"),
          }),
        ],
      });
      expect(payload.data.git).toMatchObject({
        enabled: null,
        repository: false,
        branch: null,
        head: null,
        dirty: null,
      });
    });
  });

  it("reports Explorer as ready when Quartz content and a profile manifest are present", async () => {
    await withTempWorkspace("llm-wiki-status-explorer-ready-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/content"), { recursive: true });
      await mkdir(resolve(wikiDir, ".llm-wiki/cache"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/package.json"), "{\"name\":\"llm-wiki-quartz\"}\n", "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"), "{\"profile\":\"local\"}\n", "utf8");

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.explorer).toEqual({
        ready: true,
        initialized: true,
        quartz_dir_exists: true,
        content_dir_exists: true,
        manifest_paths: [".llm-wiki/cache/quartz-manifest.local.json"],
      });
    });
  });

  it("does not report Explorer as ready when Quartz paths have the wrong file type", async () => {
    await withTempWorkspace("llm-wiki-status-explorer-file-types-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await mkdir(resolve(wikiDir, ".llm-wiki/cache"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/content"), "not a directory\n", "utf8");
      await writeFile(resolve(wikiDir, "quartz/package.json"), "{\"name\":\"llm-wiki-quartz\"}\n", "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"), "{\"profile\":\"local\"}\n", "utf8");
      await mkdir(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.review.json"));

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.explorer).toEqual({
        ready: false,
        initialized: true,
        quartz_dir_exists: true,
        content_dir_exists: false,
        manifest_paths: [".llm-wiki/cache/quartz-manifest.local.json"],
      });
    });
  });

  it("keeps status usable for malformed profiles and reports profile validity through lint health", async () => {
    await withTempWorkspace("llm-wiki-status-profile-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "name: public\ninclude: curated/**\n", "utf8");

      // Act
      const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.health).toMatchObject({
        state: "error",
        ok: false,
      });
      expect(payload.data.profiles).toMatchObject({
        total: 3,
        valid: 2,
        invalid: 1,
        invalid_paths: [".llm-wiki/profiles/public.yml"],
      });
      expect(payload.data.lint.error_rule_ids).toContain("profile_malformed");
    });
  });

  it.skipIf(!supportsUnreadableFileTest)("returns a JSON failure envelope when status scanning fails", async () => {
    await withTempWorkspace("llm-wiki-status-scan-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
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
        result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
      } finally {
        await chmod(unreadablePath, 0o600).catch(() => undefined);
      }

      const payload = parseJsonFailure<"status">(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "status",
        repo: wikiDir,
        error: {
          code: "status_failed",
          message: "Status failed while scanning repository.",
          hint: expect.any(String),
        },
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          code: "status_scan_failed",
          severity: "error",
          path: ".",
        }),
      ]);
    });
  });

  it("reports branch, head, dirty state, and command-level Git errors when Git is enabled", async () => {
    await withTempWorkspace("llm-wiki-status-git-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("status-success");
      try {
        await initializeWiki(wikiDir, true);

        // Act
        const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
        const payload = parseJsonSuccess<"status", StatusData>(result.stdout);
        const gitCalls = await readFakeGitLog(fakeGit.logPath);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(payload.data.git).toMatchObject({
          enabled: true,
          repository: true,
          branch: "main",
          head: "abc1234",
          dirty: true,
          errors: [],
        });
        expect(gitCalls.map((call) => call.args)).toEqual(
          expect.arrayContaining([
            ["rev-parse", "--is-inside-work-tree"],
            ["rev-parse", "--abbrev-ref", "HEAD"],
            ["rev-parse", "--short", "HEAD"],
            ["status", "--porcelain"],
          ]),
        );
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });

  it("keeps status usable when a Git command fails and includes manual next steps", async () => {
    await withTempWorkspace("llm-wiki-status-git-failure-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fakeGit = await createFakeGit("status-failure");
      try {
        await initializeWiki(wikiDir, true);

        // Act
        const result = await runCliBuffered(["status", "--repo", wikiDir, "--json"]);
        const payload = parseJsonSuccess<"status", StatusData>(result.stdout);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(payload.data.health).toMatchObject({
          state: "warning",
          ok: true,
        });
        expect(payload.data.git.errors).toEqual([
          expect.objectContaining({
            command: "git status --porcelain",
            exit_code: 128,
            stderr: "fatal: repository ownership check failed",
            manual_next_steps: expect.arrayContaining([expect.stringContaining("git status --porcelain")]),
          }),
        ]);
      } finally {
        fakeGit.restore();
        await rm(fakeGit.binDir, { force: true, recursive: true });
      }
    });
  });
});
