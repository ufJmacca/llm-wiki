import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { writeLocalDaemonRuntimeMetadata } from "../src/quartz/index.js";
import { parseInitJson, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
const execFileMock = childProcessMocks.execFile;
const spawnMock = childProcessMocks.spawn;
const originalGitEnv = {
  GIT_DIR: process.env.GIT_DIR,
  GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
};

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    execFile: childProcessMocks.execFile,
    spawn: childProcessMocks.spawn,
  };
});

type ExploreServeWithDaemonEnvelope = {
  ok: true;
  command: "explore.serve";
  repo: string;
  data: {
    profile: "local" | "review" | "public" | "github-pages";
    host: string;
    port: number;
    url: string;
    daemon: {
      host: string;
      port: number;
      url: string;
      upload_path: "/api/raw-upload";
      upload_token: string;
      commit_uploads: boolean;
    };
  };
  warnings: string[];
};

type UploadSuccessEnvelope = {
  ok: true;
  data: {
    status: "added" | "duplicate";
    title: string;
    source_kind: "text";
    original_path: string;
    source_id: string;
    source_card_path: string;
    queue_path: string;
    commit: {
      attempted: boolean;
      ok: boolean;
      committed_paths?: string[];
    };
  };
};

type LocalDaemonRuntimeMetadata =
  | {
      enabled: true;
      url: string;
      upload_path: "/api/raw-upload";
      token_header: string;
      upload_token: string;
      commit_uploads: boolean;
      auto_ingest_available: boolean;
      updated_at: string;
    }
  | {
      enabled: false;
      updated_at: string;
    };

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function initializeQuartzRuntime(wikiDir: string): Promise<void> {
  const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);

  expect(result.exitCode).toBe(0);
}

async function markQuartzDependenciesInstalled(wikiDir: string): Promise<void> {
  await mkdir(resolve(wikiDir, "quartz/node_modules/.bin"), { recursive: true });
  await writeFile(resolve(wikiDir, "quartz/node_modules/.bin/quartz"), "#!/usr/bin/env node\n", "utf8");
  await mkdir(resolve(wikiDir, "quartz/quartz/components"), { recursive: true });
  await mkdir(resolve(wikiDir, "quartz/quartz/plugins"), { recursive: true });
  await writeFile(resolve(wikiDir, "quartz/quartz/build.ts"), "export {}\n", "utf8");
  await writeFile(resolve(wikiDir, "quartz/quartz/components/index.ts"), "export {}\n", "utf8");
  await writeFile(resolve(wikiDir, "quartz/quartz/plugins/index.ts"), "export {}\n", "utf8");
}

async function makeDefaultCuratedPagesPublic(wikiDir: string): Promise<void> {
  const pages = [
    ["curated/contradictions.md", "Contradictions"],
    ["curated/home.md", "Home"],
    ["curated/index.md", "Index"],
    ["curated/map.md", "Map"],
    ["curated/open-questions.md", "Open Questions"],
  ] as const;

  for (const [path, title] of pages) {
    await writeFile(
      resolve(wikiDir, path),
      `---\ntype: ${path === "curated/index.md" ? "index" : "page"}\ntitle: ${title}\nvisibility: public\nsource_ids: []\n---\n\n# ${title}\n`,
      "utf8",
    );
  }
}

function mockLongRunningQuartz(): {
  close: () => void;
  metadataBeforeServe: () => string | null;
  syncedBeforeServe: () => boolean;
  waitUntilStarted: () => Promise<void>;
} {
  let child: ChildProcessWithoutNullStreams | null = null;
  let closed = false;
  let syncedBeforeServe = false;
  let metadataBeforeServe: string | null = null;
  let markStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => {
    markStarted = resolveStarted;
  });

  spawnMock.mockImplementation((_command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    const cwd = typeof options.cwd === "string" ? options.cwd : "";
    const wikiDir = resolve(cwd, "..");
    syncedBeforeServe =
      existsSync(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json")) &&
      existsSync(resolve(wikiDir, "quartz/content/curated/home.md"));
    try {
      metadataBeforeServe = readFileSync(resolve(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"), "utf8");
    } catch {
      metadataBeforeServe = null;
    }

    child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      closeChild();
      return true;
    };
    queueMicrotask(() => {
      stdout.write(`Started a Quartz server listening at http://localhost:${servedPort(args)}\n`);
      setImmediate(markStarted);
    });

    return child;
  });

  function closeChild(): void {
    if (child === null || closed) {
      return;
    }

    closed = true;
    child.emit("close", 0, null);
  }

  return {
    close: closeChild,
    metadataBeforeServe: () => metadataBeforeServe,
    syncedBeforeServe: () => syncedBeforeServe,
    waitUntilStarted: () => started,
  };
}

function servedPort(args: string[]): string {
  const portIndex = args.indexOf("--port");

  return portIndex >= 0 ? args[portIndex + 1] ?? "8080" : "8080";
}

function parseExploreServe(stdout: string[]): ExploreServeWithDaemonEnvelope {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as ExploreServeWithDaemonEnvelope;
}

type ExecFileCallback = (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void;

function mockGitOutsideWorkTree(options: { allowUploadCommit: boolean }): void {
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback: ExecFileCallback,
    ) => {
      if (command === "git" && args[0] === "rev-parse") {
        const error = new Error("not a git repository") as Error & { code: number };
        error.code = 128;
        queueMicrotask(() => callback(error, "", "fatal: not a git repository"));
        return {};
      }

      if (command === "git" && (args[0] === "add" || args[0] === "commit")) {
        if (!options.allowUploadCommit) {
          throw new Error("Default explore serve upload path must not attempt a Git commit.");
        }

        queueMicrotask(() => callback(null, "", ""));
        return {};
      }

      queueMicrotask(() => callback(null, "", ""));
      return {};
    },
  );
}

function uploadCommitGitCalls(): unknown[][] {
  return execFileMock.mock.calls.filter(([, args]) => {
    if (!Array.isArray(args)) {
      return false;
    }

    return args[0] === "add" || args[0] === "commit";
  });
}

function setInheritedGitEnv(workspaceDir: string): void {
  process.env.GIT_DIR = resolve(workspaceDir, "inherited.git");
  process.env.GIT_WORK_TREE = resolve(workspaceDir, "inherited-work-tree");
  process.env.GIT_INDEX_FILE = resolve(workspaceDir, "inherited.index");
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function expectScrubbedGitOptions(options: unknown, cwd: string): void {
  expect(options).toMatchObject({
    cwd,
    env: expect.any(Object),
  });

  const env = (options as { env: NodeJS.ProcessEnv }).env;
  expect(env).not.toHaveProperty("GIT_DIR");
  expect(env).not.toHaveProperty("GIT_WORK_TREE");
  expect(env).not.toHaveProperty("GIT_INDEX_FILE");
}

async function waitFor<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  description: string,
): Promise<T> {
  const startedAt = Date.now();
  let lastObserved: unknown;

  while (Date.now() - startedAt < 8_000) {
    try {
      const value = await read();
      lastObserved = value;
      if (matches(value)) {
        return value;
      }
    } catch (error) {
      lastObserved = error;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  throw new Error(`Timed out waiting for ${description}. Last observed: ${String(lastObserved)}`);
}

describe("explore serve local upload daemon integration", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
  });

  afterEach(() => {
    restoreEnvValue("GIT_DIR", originalGitEnv.GIT_DIR);
    restoreEnvValue("GIT_WORK_TREE", originalGitEnv.GIT_WORK_TREE);
    restoreEnvValue("GIT_INDEX_FILE", originalGitEnv.GIT_INDEX_FILE);
  });

  it("starts a localhost upload daemon when requested and closes it with the Explorer process", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-daemon-", async (workspaceDir) => {
      // Arrange
      mockGitOutsideWorkTree({ allowUploadCommit: false });
      const quartz = mockLongRunningQuartz();
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      // Act
      const serveResult = runCli([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "local",
        "--port",
        "8788",
        "--with-daemon",
        "--daemon-port",
        "0",
        "--json",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await Promise.race([
        quartz.waitUntilStarted(),
        serveResult.then((exitCode) => {
          throw new Error(`explore serve exited before Quartz started: ${exitCode}; stderr=${stderr.join("\n")}`);
        }),
      ]);
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("\"ok\":true"),
        "serve JSON readiness envelope with daemon metadata",
      );
      const payload = parseExploreServe(stdout);
      const metadata = JSON.parse(
        await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
      ) as LocalDaemonRuntimeMetadata;
      const form = new FormData();
      form.set("title", "Explorer Upload");
      form.set("text", "Explorer daemon upload body.\n");
      const uploadResponse = await fetch(`${payload.data.daemon.url}/api/raw-upload`, {
        method: "POST",
        headers: {
          "x-llm-wiki-upload-token": payload.data.daemon.upload_token,
        },
        body: form,
      });
      const upload = await uploadResponse.json() as UploadSuccessEnvelope;

      // Assert
      expect(stderr).toEqual([]);
      expect(quartz.syncedBeforeServe()).toBe(true);
      expect(payload.data).toMatchObject({
        profile: "local",
        host: "127.0.0.1",
        port: 8788,
        url: "http://127.0.0.1:8788/curated/",
        daemon: {
          host: "127.0.0.1",
          upload_path: "/api/raw-upload",
          commit_uploads: false,
        },
      });
      expect(payload.data.daemon.port).toBeGreaterThan(0);
      expect(payload.data.daemon.url).toBe(`http://127.0.0.1:${payload.data.daemon.port}`);
      expect(payload.data.daemon.upload_token).toMatch(/^[a-f0-9]{64}$/);
      expect(metadata).toMatchObject({
        enabled: true,
        url: payload.data.daemon.url,
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: payload.data.daemon.upload_token,
        commit_uploads: false,
        auto_ingest_available: false,
      });
      expect(metadata.updated_at).toEqual(expect.any(String));
      expect(uploadResponse.status).toBe(201);
      expect(upload).toMatchObject({
        ok: true,
        data: {
          status: "added",
          title: "Explorer Upload",
          source_kind: "text",
          commit: {
            attempted: false,
            ok: true,
          },
        },
      });
      expect(uploadCommitGitCalls()).toEqual([]);
      expect((await readGeneratedFile(wikiDir, upload.data.original_path)).replaceAll("\r\n", "\n")).toBe(
        "Explorer daemon upload body.\n",
      );

      quartz.close();
      await expect(serveResult).resolves.toBe(0);
      const disabledMetadata = JSON.parse(
        await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
      ) as LocalDaemonRuntimeMetadata;
      expect(disabledMetadata).toMatchObject({
        enabled: false,
        updated_at: expect.any(String),
      });
      expect(disabledMetadata).not.toHaveProperty("upload_token");
      await expect(fetch(`${payload.data.daemon.url}/api/raw-upload`)).rejects.toThrow();
    });
  });

  it("does not disable daemon metadata that was replaced by a newer serve before shutdown", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-daemon-stale-shutdown-", async (workspaceDir) => {
      // Arrange
      mockGitOutsideWorkTree({ allowUploadCommit: false });
      const quartz = mockLongRunningQuartz();
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const metadataPath = "quartz/content/_llm-wiki/runtime/local-daemon.json";
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      // Act
      const serveResult = runCli([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "local",
        "--port",
        "8793",
        "--with-daemon",
        "--daemon-port",
        "0",
        "--json",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await Promise.race([
        quartz.waitUntilStarted(),
        serveResult.then((exitCode) => {
          throw new Error(`explore serve exited before Quartz started: ${exitCode}; stderr=${stderr.join("\n")}`);
        }),
      ]);
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("\"ok\":true"),
        "serve JSON readiness envelope with daemon metadata before stale shutdown",
      );
      const payload = parseExploreServe(stdout);
      const newerMetadata = {
        enabled: true,
        url: payload.data.daemon.url,
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: "newer-upload-token",
        commit_uploads: true,
        auto_ingest_available: true,
        updated_at: "2026-06-24T00:00:00.000Z",
      } satisfies Extract<LocalDaemonRuntimeMetadata, { enabled: true }>;
      await writeLocalDaemonRuntimeMetadata(wikiDir, newerMetadata);
      quartz.close();

      // Assert
      expect(stderr).toEqual([]);
      await expect(serveResult).resolves.toBe(0);
      const metadataAfterShutdown = JSON.parse(
        await readGeneratedFile(wikiDir, metadataPath),
      ) as LocalDaemonRuntimeMetadata;
      expect(metadataAfterShutdown).toEqual(newerMetadata);
    });
  });

  it("replaces stale daemon metadata after sync clears content and before Quartz starts", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-daemon-stale-metadata-", async (workspaceDir) => {
      // Arrange
      mockGitOutsideWorkTree({ allowUploadCommit: false });
      const quartz = mockLongRunningQuartz();
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await writeLocalDaemonRuntimeMetadata(wikiDir, {
        enabled: true,
        url: "http://127.0.0.1:9",
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: "stale-token",
        commit_uploads: true,
        auto_ingest_available: true,
        updated_at: "2026-06-23T00:00:00.000Z",
      });

      // Act
      const serveResult = runCli([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "local",
        "--port",
        "8790",
        "--with-daemon",
        "--daemon-port",
        "0",
        "--json",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await Promise.race([
        quartz.waitUntilStarted(),
        serveResult.then((exitCode) => {
          throw new Error(`explore serve exited before Quartz started: ${exitCode}; stderr=${stderr.join("\n")}`);
        }),
      ]);
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("\"ok\":true"),
        "serve JSON readiness envelope with fresh daemon metadata",
      );
      const payload = parseExploreServe(stdout);
      const metadataAtSpawn = JSON.parse(quartz.metadataBeforeServe() ?? "null") as LocalDaemonRuntimeMetadata | null;

      // Assert
      expect(stderr).toEqual([]);
      expect(metadataAtSpawn).toMatchObject({
        enabled: true,
        url: payload.data.daemon.url,
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: payload.data.daemon.upload_token,
        commit_uploads: false,
        auto_ingest_available: false,
      });
      expect(metadataAtSpawn).not.toMatchObject({
        upload_token: "stale-token",
        commit_uploads: true,
        auto_ingest_available: true,
      });

      quartz.close();
      await expect(serveResult).resolves.toBe(0);
    });
  });

  it("writes enabled daemon metadata for review profile serves after sync and before Quartz starts", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-daemon-review-metadata-", async (workspaceDir) => {
      // Arrange
      mockGitOutsideWorkTree({ allowUploadCommit: false });
      const quartz = mockLongRunningQuartz();
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      // Act
      const serveResult = runCli([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "review",
        "--port",
        "8791",
        "--with-daemon",
        "--daemon-port",
        "0",
        "--json",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await Promise.race([
        quartz.waitUntilStarted(),
        serveResult.then((exitCode) => {
          throw new Error(`explore serve exited before Quartz started: ${exitCode}; stderr=${stderr.join("\n")}`);
        }),
      ]);
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("\"ok\":true"),
        "review serve JSON readiness envelope with daemon metadata",
      );
      const payload = parseExploreServe(stdout);
      const metadataAtSpawn = JSON.parse(quartz.metadataBeforeServe() ?? "null") as LocalDaemonRuntimeMetadata | null;

      // Assert
      expect(stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        profile: "review",
        host: "127.0.0.1",
        port: 8791,
        daemon: {
          host: "127.0.0.1",
          upload_path: "/api/raw-upload",
          commit_uploads: false,
        },
      });
      expect(payload.data.daemon.port).toBeGreaterThan(0);
      expect(payload.data.daemon.upload_token).toMatch(/^[a-f0-9]{64}$/);
      expect(metadataAtSpawn).toMatchObject({
        enabled: true,
        url: payload.data.daemon.url,
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: payload.data.daemon.upload_token,
        commit_uploads: false,
        auto_ingest_available: false,
      });
      expect(metadataAtSpawn?.updated_at).toEqual(expect.any(String));

      quartz.close();
      await expect(serveResult).resolves.toBe(0);
      const disabledMetadata = JSON.parse(
        await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
      ) as LocalDaemonRuntimeMetadata;
      expect(disabledMetadata).toEqual({
        enabled: false,
        updated_at: expect.any(String),
      });
    });
  });

  it("does not write token-bearing daemon metadata for public profile serves after sync", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-daemon-public-no-metadata-", async (workspaceDir) => {
      // Arrange
      mockGitOutsideWorkTree({ allowUploadCommit: false });
      const quartz = mockLongRunningQuartz();
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const metadataPath = "quartz/content/_llm-wiki/runtime/local-daemon.json";
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeLocalDaemonRuntimeMetadata(wikiDir, {
        enabled: true,
        url: "http://127.0.0.1:9",
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: "stale-public-token",
        commit_uploads: true,
        auto_ingest_available: true,
        updated_at: "2026-06-23T00:00:00.000Z",
      });

      // Act
      const serveResult = runCli([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "public",
        "--port",
        "8792",
        "--with-daemon",
        "--daemon-port",
        "0",
        "--json",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await Promise.race([
        quartz.waitUntilStarted(),
        serveResult.then((exitCode) => {
          throw new Error(`explore serve exited before Quartz started: ${exitCode}; stderr=${stderr.join("\n")}`);
        }),
      ]);
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("\"ok\":true"),
        "public serve JSON readiness envelope without daemon runtime metadata",
      );
      const payload = parseExploreServe(stdout);

      // Assert
      expect(stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        profile: "public",
        host: "127.0.0.1",
        port: 8792,
        daemon: {
          host: "127.0.0.1",
          upload_path: "/api/raw-upload",
          commit_uploads: false,
        },
      });
      expect(payload.data.daemon.upload_token).toMatch(/^[a-f0-9]{64}$/);
      expect(quartz.metadataBeforeServe()).toBeNull();
      expect(existsSync(resolve(wikiDir, metadataPath))).toBe(false);

      quartz.close();
      await expect(serveResult).resolves.toBe(0);
      expect(existsSync(resolve(wikiDir, metadataPath))).toBe(false);
    });
  });

  it("sanitizes disabled daemon metadata so stale token fields cannot be persisted", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-daemon-disabled-metadata-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      await writeLocalDaemonRuntimeMetadata(wikiDir, {
        enabled: false,
        upload_token: "must-not-persist",
        token_header: "x-llm-wiki-upload-token",
        url: "http://127.0.0.1:32123",
      } as unknown as LocalDaemonRuntimeMetadata);
      const metadata = JSON.parse(
        await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
      ) as Record<string, unknown>;

      // Assert
      expect(metadata).toEqual({
        enabled: false,
        updated_at: expect.any(String),
      });
    });
  });

  it("wires --commit-uploads through explore serve and commits successful daemon uploads", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-daemon-commit-", async (workspaceDir) => {
      // Arrange
      mockGitOutsideWorkTree({ allowUploadCommit: true });
      const quartz = mockLongRunningQuartz();
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      setInheritedGitEnv(workspaceDir);

      // Act
      const serveResult = runCli([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "local",
        "--port",
        "8789",
        "--with-daemon",
        "--daemon-port",
        "0",
        "--commit-uploads",
        "--json",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await Promise.race([
        quartz.waitUntilStarted(),
        serveResult.then((exitCode) => {
          throw new Error(`explore serve exited before Quartz started: ${exitCode}; stderr=${stderr.join("\n")}`);
        }),
      ]);
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("\"ok\":true"),
        "serve JSON readiness envelope with commit-enabled daemon metadata",
      );
      const payload = parseExploreServe(stdout);
      const form = new FormData();
      form.set("title", "Committed Explorer Upload");
      form.set("text", "Committed Explorer daemon upload body.\n");
      const uploadResponse = await fetch(`${payload.data.daemon.url}/api/raw-upload`, {
        method: "POST",
        headers: {
          "x-llm-wiki-upload-token": payload.data.daemon.upload_token,
        },
        body: form,
      });
      const upload = await uploadResponse.json() as UploadSuccessEnvelope;

      // Assert
      expect(stderr).toEqual([]);
      expect(payload.data.daemon).toMatchObject({
        host: "127.0.0.1",
        upload_path: "/api/raw-upload",
        commit_uploads: true,
      });
      expect(uploadResponse.status).toBe(201);
      expect(upload).toMatchObject({
        ok: true,
        data: {
          status: "added",
          title: "Committed Explorer Upload",
          source_kind: "text",
          commit: {
            attempted: true,
            ok: true,
          },
        },
      });
      expect(upload.data.commit.committed_paths).toEqual(expect.arrayContaining([
        upload.data.original_path,
        upload.data.source_card_path,
        upload.data.queue_path,
        "curated/log.md",
      ]));
      const commitCalls = uploadCommitGitCalls();
      expect(commitCalls).toHaveLength(2);
      expect(commitCalls[0]).toEqual([
        "git",
        expect.arrayContaining([
          "add",
          "--",
          upload.data.original_path,
          upload.data.source_card_path,
          upload.data.queue_path,
        ]),
        expect.any(Object),
        expect.any(Function),
      ]);
      expect(commitCalls[1]).toEqual([
        "git",
        expect.arrayContaining([
          "commit",
          "-m",
          `chore: upload raw source ${upload.data.source_id}`,
          "--",
          upload.data.original_path,
          upload.data.source_card_path,
          upload.data.queue_path,
        ]),
        expect.any(Object),
        expect.any(Function),
      ]);
      expectScrubbedGitOptions(commitCalls[0]?.[2], wikiDir);
      expectScrubbedGitOptions(commitCalls[1]?.[2], wikiDir);

      quartz.close();
      await expect(serveResult).resolves.toBe(0);
    });
  });
});
