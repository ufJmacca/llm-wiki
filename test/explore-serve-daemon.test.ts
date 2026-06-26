import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
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
      upload_session_id: string;
      commit_uploads: boolean;
    };
  };
  warnings: string[];
};

type ExploreServeFailureEnvelope = {
  ok: false;
  command: "explore.serve";
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
      upload_session_id?: string;
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
      existsSync(resolve(wikiDir, "quartz/content/curated/home.md")) &&
      existsSync(resolve(wikiDir, "quartz/content/index.md"));
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

function parseExploreServeFailure(stdout: string[]): ExploreServeFailureEnvelope {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as ExploreServeFailureEnvelope;
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

async function writeGitHubPagesProfile(wikiDir: string): Promise<void> {
  const publicProfile = await readFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "utf8");
  await writeFile(
    resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"),
    publicProfile.replace(
      /^name: public\nmode: deploy\n/u,
      "name: github-pages\nmode: deploy\nbase_url: https://docs.example.com\n",
    ),
    "utf8",
  );
}

async function withOccupiedLoopbackPort<T>(run: (port: number) => Promise<T>): Promise<T> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    await closeServer(server);
    throw new Error("Could not reserve a loopback port for daemon profile gate assertions.");
  }

  try {
    return await run(address.port);
  } finally {
    await closeServer(server);
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) {
        rejectClose(error);
        return;
      }

      resolveClose();
    });
  });
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

async function waitForGeneratedFileContent(
  wikiDir: string,
  path: string,
  expectedText: string,
): Promise<string> {
  return waitFor(
    async () => readGeneratedFile(wikiDir, path),
    (content) => content.includes(expectedText),
    `${path} to contain ${expectedText}`,
  );
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
      const metadataAtSpawn = JSON.parse(quartz.metadataBeforeServe() ?? "null") as LocalDaemonRuntimeMetadata | null;
      const metadata = JSON.parse(
        await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
      ) as LocalDaemonRuntimeMetadata;
      const sourceQueue = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/source-queue.md");
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
        url: "http://127.0.0.1:8788/",
        daemon: {
          host: "127.0.0.1",
          upload_path: "/api/raw-upload",
          commit_uploads: false,
        },
      });
      expect(payload.data.daemon.port).toBeGreaterThan(0);
      expect(payload.data.daemon.url).toBe(`http://127.0.0.1:${payload.data.daemon.port}`);
      expect(payload.data.daemon.upload_token).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.data.daemon.upload_session_id).toMatch(/^upl_[a-f0-9]{16}$/);
      expect(payload.data.daemon.upload_session_id).not.toBe(payload.data.daemon.upload_token);
      expect(metadataAtSpawn).toMatchObject({
        enabled: true,
        url: payload.data.daemon.url,
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: payload.data.daemon.upload_token,
        upload_session_id: payload.data.daemon.upload_session_id,
        commit_uploads: false,
        auto_ingest_available: false,
      });
      expect(metadataAtSpawn?.updated_at).toEqual(expect.any(String));
      expect(metadata).toMatchObject({
        enabled: true,
        url: payload.data.daemon.url,
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: payload.data.daemon.upload_token,
        upload_session_id: payload.data.daemon.upload_session_id,
        commit_uploads: false,
        auto_ingest_available: false,
      });
      expect(metadata.updated_at).toEqual(expect.any(String));
      expect(sourceQueue).toContain("llm_wiki_upload_page_enabled: true");
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

  it("regenerates upload, review, status, and root pages after daemon upload watcher syncs and preserves the active token", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-daemon-watch-sync-", async (workspaceDir) => {
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
        "8795",
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
        "serve JSON readiness envelope with daemon watcher metadata",
      );
      const payload = parseExploreServe(stdout);
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        "---\ntype: index\ntitle: Watcher Root\nvisibility: private\nsource_ids: []\n---\n\n# Watcher Root\n\nRoot watcher marker.\n",
        "utf8",
      );
      const rootPage = await waitForGeneratedFileContent(
        wikiDir,
        "quartz/content/index.md",
        "Root watcher marker.",
      );

      await writeLocalDaemonRuntimeMetadata(wikiDir, {
        enabled: true,
        url: payload.data.daemon.url,
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: "stale-token",
        commit_uploads: true,
        auto_ingest_available: true,
        updated_at: "2026-06-23T00:00:00.000Z",
      });
      await writeFile(
        resolve(wikiDir, "quartz/content/_llm-wiki/upload.md"),
        "# Stale upload page\n\nstale upload sentinel\n",
        "utf8",
      );

      const form = new FormData();
      form.set("title", "Watcher Upload");
      form.set("text", "Watcher daemon upload body.\n");
      const uploadResponse = await fetch(`${payload.data.daemon.url}/api/raw-upload`, {
        method: "POST",
        headers: {
          "x-llm-wiki-upload-token": payload.data.daemon.upload_token,
        },
        body: form,
      });
      const upload = await uploadResponse.json() as UploadSuccessEnvelope;
      const sourceQueue = await waitForGeneratedFileContent(
        wikiDir,
        "quartz/content/_llm-wiki/review/source-queue.md",
        upload.data.source_id,
      );
      const statusPage = await waitForGeneratedFileContent(
        wikiDir,
        "quartz/content/_llm-wiki/review/status.md",
        "| Queued | 1 |",
      );
      const uploadPage = await waitForGeneratedFileContent(
        wikiDir,
        "quartz/content/_llm-wiki/upload.md",
        "component: LlmWikiUploadForm",
      );
      await writeLocalDaemonRuntimeMetadata(wikiDir, {
        enabled: true,
        url: payload.data.daemon.url,
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: "stale-before-log-sync",
        commit_uploads: true,
        auto_ingest_available: true,
        updated_at: "2026-06-23T00:00:00.000Z",
      });
      await writeFile(
        resolve(wikiDir, "curated/log.md"),
        `${await readFile(resolve(wikiDir, "curated/log.md"), "utf8")}\n## [2026-06-24T00:00:00.000Z] ingest | ${upload.data.source_id} | Watcher Upload\n\n- actor: test\n- command: llm-wiki ingest ${upload.data.source_id}\n- updated:\n  - curated/index.md\n- contradictions: none\n- follow_ups: none\n`,
        "utf8",
      );
      const recentIngests = await waitForGeneratedFileContent(
        wikiDir,
        "quartz/content/_llm-wiki/review/recent-ingests.md",
        upload.data.source_id,
      );
      const metadata = await waitFor(
        async () => JSON.parse(await readGeneratedFile(wikiDir, metadataPath)) as LocalDaemonRuntimeMetadata,
        (value) => value.enabled && value.upload_token === payload.data.daemon.upload_token,
        "daemon metadata to be rewritten with active token after watcher sync",
      );

      // Assert
      expect(stderr).toEqual([]);
      expect(uploadResponse.status).toBe(201);
      expect(upload).toMatchObject({
        ok: true,
        data: {
          status: "added",
          title: "Watcher Upload",
          source_kind: "text",
          queue_status: "queued",
          commit: {
            attempted: false,
            ok: true,
          },
        },
      });
      expect(sourceQueue).toContain("Watcher Upload");
      expect(sourceQueue).toContain(upload.data.source_card_path);
      expect(sourceQueue).toContain(upload.data.queue_path);
      expect(statusPage).toContain("| Queued | 1 |");
      expect(uploadPage).not.toContain("stale upload sentinel");
      expect(rootPage).toContain("# Watcher Root");
      expect(recentIngests).toContain("Watcher Upload");
      expect(recentIngests).toContain("curated/log.md");
      expect(metadata).toMatchObject({
        enabled: true,
        url: payload.data.daemon.url,
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: payload.data.daemon.upload_token,
        commit_uploads: false,
        auto_ingest_available: false,
      });
      expect(metadata).not.toMatchObject({
        upload_token: "stale-token",
        commit_uploads: true,
        auto_ingest_available: true,
        updated_at: "2026-06-23T00:00:00.000Z",
      });

      quartz.close();
      await expect(serveResult).resolves.toBe(0);
    });
  }, 15_000);

  it("keeps daemon upload success state when a later watcher sync fails best-effort", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-daemon-watch-failure-", async (workspaceDir) => {
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
        "8796",
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
      const form = new FormData();
      form.set("title", "Best Effort Upload");
      form.set("text", "Best effort watcher failure body.\n");
      const uploadResponse = await fetch(`${payload.data.daemon.url}/api/raw-upload`, {
        method: "POST",
        headers: {
          "x-llm-wiki-upload-token": payload.data.daemon.upload_token,
        },
        body: form,
      });
      const upload = await uploadResponse.json() as UploadSuccessEnvelope;
      const sourceQueueBeforeFailure = await waitForGeneratedFileContent(
        wikiDir,
        "quartz/content/_llm-wiki/review/source-queue.md",
        upload.data.source_id,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));

      const localProfilePath = resolve(wikiDir, ".llm-wiki/profiles/local.yml");
      const validLocalProfile = await readFile(localProfilePath, "utf8");
      await writeFile(
        resolve(wikiDir, "quartz/content/_llm-wiki/upload.md"),
        "# Upload sentinel\n\nbest effort upload success sentinel\n",
        "utf8",
      );
      await writeFile(localProfilePath, "name: local\ninclude:\n  - [invalid\n", "utf8");
      const invalidSync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      await writeFile(
        resolve(wikiDir, "curated/log.md"),
        `${await readFile(resolve(wikiDir, "curated/log.md"), "utf8")}\n## [2026-06-24T00:01:00.000Z] ingest | ${upload.data.source_id} | Best Effort Upload\n\n- actor: test\n- command: llm-wiki ingest ${upload.data.source_id}\n- updated:\n  - curated/home.md\n- contradictions: none\n- follow_ups: none\n`,
        "utf8",
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      const sourceQueueAfterFailure = await readGeneratedFile(
        wikiDir,
        "quartz/content/_llm-wiki/review/source-queue.md",
      );
      const uploadPageAfterFailure = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/upload.md");
      await writeFile(localProfilePath, validLocalProfile, "utf8");
      await writeFile(
        resolve(wikiDir, "curated/home.md"),
        `${await readFile(resolve(wikiDir, "curated/home.md"), "utf8")}\nWatcher recovery marker.\n`,
        "utf8",
      );
      const recoveredHome = await waitForGeneratedFileContent(
        wikiDir,
        "quartz/content/curated/home.md",
        "Watcher recovery marker.",
      );

      // Assert
      expect(stderr).toEqual([]);
      expect(uploadResponse.status).toBe(201);
      expect(upload).toMatchObject({
        ok: true,
        data: {
          status: "added",
          title: "Best Effort Upload",
          source_kind: "text",
          queue_status: "queued",
          commit: {
            attempted: false,
            ok: true,
          },
        },
      });
      expect(sourceQueueBeforeFailure).toContain("Best Effort Upload");
      expect(invalidSync.exitCode).toBe(1);
      expect(invalidSync.stdout.join("\n")).toContain("PROFILE_INVALID");
      expect(sourceQueueAfterFailure).toContain(upload.data.source_id);
      expect(sourceQueueAfterFailure).toContain("Best Effort Upload");
      expect(uploadPageAfterFailure).toContain("best effort upload success sentinel");
      expect((await readGeneratedFile(wikiDir, upload.data.original_path)).replaceAll("\r\n", "\n")).toBe(
        "Best effort watcher failure body.\n",
      );
      await expect(readGeneratedFile(wikiDir, upload.data.source_card_path)).resolves.toContain("Best Effort Upload");
      await expect(readGeneratedFile(wikiDir, upload.data.queue_path)).resolves.toContain(upload.data.source_id);
      expect(recoveredHome).toContain("Watcher recovery marker.");

      quartz.close();
      await expect(serveResult).resolves.toBe(0);
    });
  }, 15_000);

  it("prints root readiness and daemon upload details in human mode", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-daemon-human-ready-", async (workspaceDir) => {
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
        "8794",
        "--with-daemon",
        "--daemon-port",
        "0",
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
      const output = await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("URL: http://127.0.0.1:8794/"),
        "human serve readiness output with root Explorer URL",
      );
      const metadata = JSON.parse(
        await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
      ) as LocalDaemonRuntimeMetadata;
      if (!metadata.enabled) {
        throw new Error("Expected enabled local daemon metadata before human readiness assertions.");
      }

      // Assert
      expect(stderr).toEqual([]);
      expect(output).toContain("Quartz Explorer serving");
      expect(output).toContain("Profile: local");
      expect(output).toContain("URL: http://127.0.0.1:8794/");
      expect(output).toContain(`Upload endpoint: ${metadata.url}${metadata.upload_path}`);
      expect(output).toContain(`Upload token header: ${metadata.token_header}: ${metadata.upload_token}`);
      expect(output).toContain("Commit uploads: disabled");
      expect(metadata.upload_token).toMatch(/^[a-f0-9]{64}$/);

      quartz.close();
      await expect(serveResult).resolves.toBe(0);
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
      expect(payload.data.daemon.upload_session_id).toMatch(/^upl_[a-f0-9]{16}$/);
      expect(metadataAtSpawn).toMatchObject({
        enabled: true,
        url: payload.data.daemon.url,
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: payload.data.daemon.upload_token,
        upload_session_id: payload.data.daemon.upload_session_id,
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

  it.each(["public", "github-pages"] as const)(
    "rejects %s --with-daemon before daemon bind, Quartz readiness, or runtime metadata writes",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-serve-daemon-${profile}-forbidden-`, async (workspaceDir) => {
        // Arrange
        mockGitOutsideWorkTree({ allowUploadCommit: false });
        const wikiDir = resolve(workspaceDir, "wiki");
        const metadataPath = "quartz/content/_llm-wiki/runtime/local-daemon.json";
        await initializeWiki(wikiDir);
        await initializeQuartzRuntime(wikiDir);
        await makeDefaultCuratedPagesPublic(wikiDir);
        if (profile === "github-pages") {
          await writeGitHubPagesProfile(wikiDir);
        }
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
        await withOccupiedLoopbackPort(async (daemonPort) => {
          const result = await runCliBuffered([
            "explore",
            "serve",
            "--repo",
            wikiDir,
            "--profile",
            profile,
            "--port",
            "8792",
            "--with-daemon",
            "--daemon-port",
            String(daemonPort),
            "--json",
          ]);
          const payload = parseExploreServeFailure(result.stdout);

          // Assert
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toEqual([]);
          expect(payload.error.code).toBe("UPLOAD_DAEMON_PROFILE_FORBIDDEN");
          expect(payload.error.message).toContain("--with-daemon");
          expect(payload.error.message).toContain(profile);
          expect(payload.error.hint).toContain("--profile local");
          expect(payload.issues).toContainEqual(expect.objectContaining({
            code: "UPLOAD_DAEMON_PROFILE_FORBIDDEN",
            path: "--with-daemon",
          }));
          expect(result.stdout.join("\n")).not.toMatch(/[a-f0-9]{64}/u);
          expect(result.stdout.join("\n")).not.toContain("upload_token");
          expect(spawnMock).not.toHaveBeenCalled();
          expect(existsSync(resolve(wikiDir, metadataPath))).toBe(false);
        });
      });
    },
  );

  it.each(["local", "review"] as const)(
    "serves %s without daemon metadata or an upload page when --with-daemon is omitted",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-serve-${profile}-no-daemon-upload-`, async (workspaceDir) => {
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
          profile,
          "--port",
          "8792",
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
          `${profile} serve JSON readiness envelope without daemon metadata`,
        );
        const payload = JSON.parse(stdout[0] ?? "{}") as {
          data: {
            profile: "local" | "review";
            sync: { generated_paths: string[] };
            daemon?: unknown;
          };
        };

        // Assert
        expect(stderr).toEqual([]);
        expect(payload.data.profile).toBe(profile);
        expect(payload.data).not.toHaveProperty("daemon");
        expect(payload.data.sync.generated_paths).not.toContain("quartz/content/_llm-wiki/upload.md");
        expect(quartz.metadataBeforeServe()).toBeNull();
        expect(existsSync(resolve(wikiDir, "quartz/content/_llm-wiki/upload.md"))).toBe(false);
        expect(existsSync(resolve(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"))).toBe(false);
        const sourceQueue = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/source-queue.md");
        expect(sourceQueue).toContain("llm_wiki_upload_page_enabled: false");
        expect(sourceQueue).not.toContain("_llm-wiki/upload");

        quartz.close();
        await expect(serveResult).resolves.toBe(0);
      });
    },
  );

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
