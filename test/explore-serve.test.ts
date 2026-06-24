import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { writeLocalDaemonRuntimeMetadata } from "../src/quartz/index.js";
import * as quartzState from "../src/quartz/state.js";
import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn: spawnMock,
  };
});

type ExploreServeEnvelope = {
  ok: true;
  command: "explore.serve";
  repo: string;
  data: {
    profile: "local" | "review" | "public" | "github-pages";
    host: string;
    port: number;
    ws_port: number;
    url: string;
    state_path: string;
    watch_paths: string[];
    sync: {
      manifest_path: string;
      materialized_paths: string[];
      generated_paths: string[];
    };
    quartz: {
      command: "npm";
      args: string[];
      cwd: string;
      status: "running";
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
    path: string;
    hint: string;
  }>;
};

type QuartzManifest = {
  files: Array<{
    source_path: string;
    content_path: string;
    content_hash: string;
  }>;
  generated_files: Array<{
    content_path: string;
    content_hash: string;
  }>;
};

type SourceCaptureData = {
  source: {
    queue_path: string;
    source_card_path: string;
  };
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

function parseExploreServe(stdout: string[]): ExploreServeEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreServeEnvelope;
}

function parseExploreServeFailure(stdout: string[]): ExploreServeFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreServeFailureEnvelope;
}

function parseSourceCapture(stdout: string[]): SourceCaptureData {
  expect(stdout).toHaveLength(1);
  return (JSON.parse(stdout[0]) as { data: SourceCaptureData }).data;
}

function mockSuccessfulSpawn(): { syncedBeforeServe: () => boolean } {
  let syncedBeforeServe = false;
  spawnMock.mockImplementation((_command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    const cwd = typeof options.cwd === "string" ? options.cwd : "";
    const wikiDir = resolve(cwd, "..");
    syncedBeforeServe =
      existsSync(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json")) &&
      existsSync(resolve(wikiDir, "quartz/content/curated/home.md")) &&
      existsSync(resolve(wikiDir, "quartz/content/index.md"));

    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      stdout.write(`Started a Quartz server listening at http://localhost:${servedPort(args)}\n`);
      child.emit("close", 0, null);
    });

    return child;
  });

  return { syncedBeforeServe: () => syncedBeforeServe };
}

function mockLongRunningSpawn(mockOptions: { pid?: number } = {}): {
  close: (code?: number) => void;
  killCalls: () => unknown[][];
  syncedBeforeServe: () => boolean;
  waitUntilStarted: () => Promise<void>;
} {
  let child: ChildProcessWithoutNullStreams | null = null;
  let closed = false;
  const killCalls: unknown[][] = [];
  let syncedBeforeServe = false;
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

    child = new EventEmitter() as ChildProcessWithoutNullStreams;
    if (mockOptions.pid !== undefined) {
      Object.defineProperty(child, "pid", { value: mockOptions.pid });
    }
    const stdout = new PassThrough();
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = (signal?: NodeJS.Signals | number) => {
      killCalls.push([signal]);
      closeChild();
      return true;
    };
    queueMicrotask(() => {
      stdout.write(`Started a Quartz server listening at http://localhost:${servedPort(args)}\n`);
      setImmediate(markStarted);
    });

    return child;
  });

  function closeChild(code = 0): void {
    if (child === null || closed) {
      return;
    }

    closed = true;
    child.emit("close", code, null);
  }

  return {
    close: closeChild,
    killCalls: () => killCalls,
    syncedBeforeServe: () => syncedBeforeServe,
    waitUntilStarted: () => started,
  };
}

function mockFailedStartupSpawn(): void {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stderr = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = stderr;
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      stderr.write("EADDRINUSE: address already in use\n");
      child.emit("close", 1, null);
    });

    return child;
  });
}

function mockVerboseFailedStartupSpawn(): { stderrText: string; prefix: string; suffix: string } {
  const prefix = "first diagnostic line that should be discarded";
  const suffix = "final diagnostic line that should remain";
  const stderrText = `${prefix}\n${"x".repeat(80 * 1024)}\n${suffix}\n`;

  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stderr = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = stderr;
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      stderr.write(stderrText);
      child.emit("close", 1, null);
    });

    return child;
  });

  return { stderrText, prefix, suffix };
}

function mockReadyThenFailedStartupSpawn(): void {
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      stdout.write(`Started a Quartz server listening at http://localhost:${servedPort(args)}\n`);
      stderr.write("EADDRINUSE: websocket address already in use\n");
      child.emit("close", 1, null);
    });

    return child;
  });
}

function servedPort(args: string[]): string {
  const portIndex = args.indexOf("--port");
  return portIndex >= 0 ? args[portIndex + 1] ?? "8080" : "8080";
}

async function readManifest(wikiDir: string): Promise<QuartzManifest> {
  return JSON.parse(await readFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"), "utf8")) as QuartzManifest;
}

async function waitForFileContent(
  wikiDir: string,
  path: string,
  expectedText: string,
): Promise<string> {
  return waitFor(
    async () => readFile(resolve(wikiDir, path), "utf8"),
    (content) => content.includes(expectedText),
    `${path} to contain ${expectedText}`,
  );
}

async function waitForManifest(
  wikiDir: string,
  predicate: (manifest: QuartzManifest) => boolean,
  description: string,
): Promise<QuartzManifest> {
  return waitFor(() => readManifest(wikiDir), predicate, description);
}

async function waitForManifestMtimeAfter(wikiDir: string, previousMtimeMs: number): Promise<number> {
  return waitFor(
    async () => (await stat(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).mtimeMs,
    (mtimeMs) => mtimeMs > previousMtimeMs,
    "local Quartz manifest mtime to advance after config change",
  );
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

async function pause(ms: number): Promise<void> {
  await new Promise((resolvePause) => setTimeout(resolvePause, ms));
}

async function withProcessPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return await run();
  } finally {
    if (descriptor !== undefined) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

describe("explore serve command", () => {
  it("runs sync before serving, binds to loopback by default, records Explorer state, and tracks watched inputs", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockLongRunningSpawn();
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
        "8765",
        "--json",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await spawnObservation.waitUntilStarted();
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("\"ok\":true"),
        "serve JSON readiness envelope",
      );
      const payload = parseExploreServe(stdout);
      const state = JSON.parse(await readFile(resolve(wikiDir, payload.data.state_path), "utf8")) as {
        url: string;
        profile: string;
        host: string;
        port: number;
        ws_port: number;
        watch_paths: string[];
      };
      const expectedWsPort = String(payload.data.ws_port);

      // Assert
      expect(stderr).toEqual([]);
      expect(spawnObservation.syncedBeforeServe()).toBe(true);
      expect(spawnMock).toHaveBeenCalledWith(
        "npm",
        ["run", "serve", "--", "--port", "8765", "--wsPort", expectedWsPort],
        {
          cwd: resolve(wikiDir, "quartz"),
          env: expect.objectContaining({
            LLM_WIKI_EXPLORER_HOST: "127.0.0.1",
            NODE_OPTIONS: expect.stringContaining("--require=./scripts/llm-wiki-loopback-listen.cjs"),
          }) as NodeJS.ProcessEnv,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(payload.data).toMatchObject({
        profile: "local",
        host: "127.0.0.1",
        port: 8765,
        ws_port: payload.data.ws_port,
        url: "http://127.0.0.1:8765/",
        state_path: ".llm-wiki/cache/explorer-state.json",
        sync: {
          manifest_path: ".llm-wiki/cache/quartz-manifest.local.json",
        },
        quartz: {
          command: "npm",
          args: ["run", "serve", "--", "--port", "8765", "--wsPort", expectedWsPort],
          cwd: resolve(wikiDir, "quartz"),
          status: "running",
        },
      });
      expect(payload.data.watch_paths).toEqual([
        ".llm-wiki/config.yml",
        ".llm-wiki/profiles/**/*.yaml",
        ".llm-wiki/profiles/**/*.yml",
        "curated/**/*.md",
        "quartz/quartz.config.ts",
        "quartz/quartz.layout.ts",
        "raw/inputs/**/_source.md",
        "raw/queue/*.json",
      ]);
      expect(state).toMatchObject({
        url: "http://127.0.0.1:8765/",
        profile: "local",
        host: "127.0.0.1",
        port: 8765,
        ws_port: payload.data.ws_port,
        watch_paths: payload.data.watch_paths,
      });
      expect(payload.data.ws_port).not.toBe(8765);

      spawnObservation.close();
      await expect(serveResult).resolves.toBe(0);
      await expect(readFile(resolve(wikiDir, payload.data.state_path), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("clears stale daemon metadata during non-daemon serves", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-no-daemon-metadata-cleanup-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockLongRunningSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const metadataPath = "quartz/content/_llm-wiki/runtime/local-daemon.json";
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await writeLocalDaemonRuntimeMetadata(wikiDir, {
        enabled: true,
        url: "http://127.0.0.1:32123",
        upload_path: "/api/raw-upload",
        token_header: "x-llm-wiki-upload-token",
        upload_token: "stale-token",
        commit_uploads: false,
        auto_ingest_available: false,
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
        "8774",
        "--json",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await spawnObservation.waitUntilStarted();
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("\"ok\":true"),
        "serve JSON readiness envelope without daemon metadata",
      );

      // Assert
      expect(stderr).toEqual([]);
      await expect(readFile(resolve(wikiDir, metadataPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(parseExploreServe(stdout).data).not.toHaveProperty("daemon");

      spawnObservation.close();
      await expect(serveResult).resolves.toBe(0);
    });
  });

  it("clears Explorer state synchronously when interrupted after readiness", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-interrupt-cleanup-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnController = mockLongRunningSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const beforeSigint = new Set(process.listeners("SIGINT"));
      const beforeSigterm = new Set(process.listeners("SIGTERM"));
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      try {
        // Act
        const serveResult = runCli([
          "explore",
          "serve",
          "--repo",
          wikiDir,
          "--profile",
          "local",
          "--port",
          "8766",
          "--json",
        ], {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
          stdin: async () => "",
        });
        await spawnController.waitUntilStarted();
        await waitFor(
          async () => stdout.join("\n"),
          (content) => content.includes("\"ok\":true"),
          "serve JSON readiness envelope",
        );

        const statePath = resolve(wikiDir, ".llm-wiki/cache/explorer-state.json");
        await expect(readFile(statePath, "utf8")).resolves.toContain("http://127.0.0.1:8766/");
        const addedSigintListeners = process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener));
        expect(addedSigintListeners).toHaveLength(1);

        addedSigintListeners[0]("SIGINT");

        // Assert
        expect(stderr).toEqual([]);
        await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(serveResult).resolves.toBe(0);
        expect(process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener))).toEqual([]);
        expect(process.listeners("SIGTERM").filter((listener) => !beforeSigterm.has(listener))).toEqual([]);
      } finally {
        for (const listener of process.listeners("SIGINT")) {
          if (!beforeSigint.has(listener)) {
            process.off("SIGINT", listener);
          }
        }
        for (const listener of process.listeners("SIGTERM")) {
          if (!beforeSigterm.has(listener)) {
            process.off("SIGTERM", listener);
          }
        }
      }
    });
  });

  it("terminates the Quartz process group when interrupted after readiness", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-process-group-cleanup-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const quartzWrapperPid = 42424;
      const spawnController = mockLongRunningSpawn({ pid: quartzWrapperPid });
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const beforeSigint = new Set(process.listeners("SIGINT"));
      const beforeSigterm = new Set(process.listeners("SIGTERM"));
      const processKillSpy = vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
        if (pid === -quartzWrapperPid && signal === "SIGTERM") {
          spawnController.close();
        }

        return true;
      });
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      try {
        // Act
        const serveResult = runCli([
          "explore",
          "serve",
          "--repo",
          wikiDir,
          "--profile",
          "local",
          "--port",
          "8773",
          "--json",
        ], {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
          stdin: async () => "",
        });
        await spawnController.waitUntilStarted();
        await waitFor(
          async () => stdout.join("\n"),
          (content) => content.includes("\"ok\":true"),
          "serve JSON readiness envelope",
        );

        const addedSigtermListeners = process.listeners("SIGTERM").filter((listener) => !beforeSigterm.has(listener));
        expect(addedSigtermListeners).toHaveLength(1);
        addedSigtermListeners[0]("SIGTERM");

        // Assert
        expect(stderr).toEqual([]);
        await expect(serveResult).resolves.toBe(0);
        expect(processKillSpy).toHaveBeenCalledWith(-quartzWrapperPid, "SIGTERM");
        expect(spawnController.killCalls()).toEqual([]);
        expect(process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener))).toEqual([]);
        expect(process.listeners("SIGTERM").filter((listener) => !beforeSigterm.has(listener))).toEqual([]);
      } finally {
        processKillSpy.mockRestore();
        for (const listener of process.listeners("SIGINT")) {
          if (!beforeSigint.has(listener)) {
            process.off("SIGINT", listener);
          }
        }
        for (const listener of process.listeners("SIGTERM")) {
          if (!beforeSigterm.has(listener)) {
            process.off("SIGTERM", listener);
          }
        }
      }
    });
  });

  it("does not clear Explorer state that was replaced by a newer serve instance", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-state-owner-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockLongRunningSpawn();
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
        "8767",
        "--json",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await spawnObservation.waitUntilStarted();
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("\"ok\":true"),
        "serve JSON readiness envelope",
      );

      const statePath = resolve(wikiDir, ".llm-wiki/cache/explorer-state.json");
      const newerState = {
        version: 1,
        instance_id: "newer-serve-instance",
        profile: "local",
        host: "127.0.0.1",
        port: 8768,
        ws_port: 18768,
        url: "http://127.0.0.1:8768/",
        updated_at: "2026-06-19T00:00:00.000Z",
        watch_paths: [],
      };
      await writeFile(statePath, `${JSON.stringify(newerState, null, 2)}\n`, "utf8");
      spawnObservation.close();

      // Assert
      expect(stderr).toEqual([]);
      await expect(serveResult).resolves.toBe(0);
      await expect(readFile(statePath, "utf8")).resolves.toBe(`${JSON.stringify(newerState, null, 2)}\n`);
    });
  });

  it("launches npm through the Windows command shim when serving", async () => {
    await withProcessPlatform("win32", async () => {
      await withTempWorkspace("llm-wiki-explore-serve-windows-npm-", async (workspaceDir) => {
        // Arrange
        spawnMock.mockReset();
        mockSuccessfulSpawn();
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await initializeQuartzRuntime(wikiDir);
        await markQuartzDependenciesInstalled(wikiDir);

        // Act
        const result = await runCliBuffered([
          "explore",
          "serve",
          "--repo",
          wikiDir,
          "--profile",
          "local",
          "--port",
          "8766",
          "--json",
        ]);
        const payload = parseExploreServe(result.stdout);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(spawnMock).toHaveBeenCalledWith(
          "npm.cmd",
          ["run", "serve", "--", "--port", "8766", "--wsPort", String(payload.data.ws_port)],
          expect.objectContaining({
            cwd: resolve(wikiDir, "quartz"),
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
      });
    });
  });

  it("prints the local URL before the long-running Quartz server exits", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-startup-url-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnController = mockLongRunningSpawn();
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
        "8767",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await spawnController.waitUntilStarted();
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("URL: http://127.0.0.1:8767/"),
        "serve URL",
      );

      // Assert
      expect(stdout.join("\n")).toContain("URL: http://127.0.0.1:8767/");
      expect(stderr).toEqual([]);

      spawnController.close();
      await expect(serveResult).resolves.toBe(0);
    });
  });

  it("emits only one JSON envelope when Quartz crashes after readiness", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-json-post-ready-crash-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnController = mockLongRunningSpawn();
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
        "8771",
        "--json",
      ], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        stdin: async () => "",
      });
      await spawnController.waitUntilStarted();
      await waitFor(
        async () => stdout.join("\n"),
        (content) => content.includes("\"ok\":true"),
        "serve JSON readiness envelope",
      );
      const payload = parseExploreServe(stdout);

      spawnController.close(1);
      const exitCode = await serveResult;

      // Assert
      expect(exitCode).toBe(1);
      expect(stdout).toHaveLength(1);
      expect(stderr).toEqual([]);
      expect(payload.data.url).toBe("http://127.0.0.1:8771/");
    });
  });

  it("suppresses readiness side effects when Quartz crashes while readiness is in flight", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-json-inflight-ready-crash-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnController = mockLongRunningSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      const stdout: string[] = [];
      const stderr: string[] = [];
      let markStateWriteStarted!: () => void;
      let releaseStateWrite!: () => void;
      const stateWriteStarted = new Promise<void>((resolveStarted) => {
        markStateWriteStarted = resolveStarted;
      });
      const stateWriteReleased = new Promise<void>((resolveReleased) => {
        releaseStateWrite = resolveReleased;
      });
      const stateWriteSpy = vi.spyOn(quartzState, "writeExplorerState").mockImplementationOnce(async (repoRoot, state) => {
        await mkdir(resolve(repoRoot, ".llm-wiki/cache"), { recursive: true });
        await writeFile(resolve(repoRoot, quartzState.EXPLORER_STATE_PATH), `${JSON.stringify(state, null, 2)}\n`, "utf8");
        markStateWriteStarted();
        await stateWriteReleased;
        return { ok: true, value: undefined };
      });

      try {
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
          "8772",
          "--json",
        ], {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
          stdin: async () => "",
        });
        await stateWriteStarted;
        spawnController.close(1);
        releaseStateWrite();
        const exitCode = await serveResult;
        const payload = parseExploreServeFailure(stdout);

        // Assert
        expect(exitCode).toBe(1);
        expect(stdout).toHaveLength(1);
        expect(stdout.join("\n")).not.toContain("\"ok\":true");
        expect(stderr).toEqual([]);
        expect(payload.error.code).toBe("QUARTZ_COMMAND_FAILED");
        expect(payload.error.message).toContain("Quartz command failed: npm run serve -- --port 8772 --wsPort ");
        await expect(readFile(resolve(wikiDir, quartzState.EXPLORER_STATE_PATH), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        stateWriteSpy.mockRestore();
      }
    });
  });

  it("does not emit readiness or record Explorer state when Quartz exits before listening", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-startup-failure-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      mockFailedStartupSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      // Act
      const result = await runCliBuffered([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "local",
        "--port",
        "8768",
        "--json",
      ]);
      const payload = parseExploreServeFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(result.stdout.join("\n")).not.toContain("\"ok\":true");
      expect(payload.error).toMatchObject({
        code: "QUARTZ_COMMAND_FAILED",
        hint: "EADDRINUSE: address already in use",
      });
      expect(payload.error.message).toContain("Quartz command failed: npm run serve -- --port 8768 --wsPort ");
      await expect(readFile(resolve(wikiDir, ".llm-wiki/cache/explorer-state.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("keeps only a bounded Quartz serve output tail for failure diagnostics", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-output-tail-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const verboseOutput = mockVerboseFailedStartupSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      // Act
      const result = await runCliBuffered([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "local",
        "--port",
        "8769",
        "--json",
      ]);
      const payload = parseExploreServeFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe("QUARTZ_COMMAND_FAILED");
      expect(payload.error.hint.length).toBeLessThan(verboseOutput.stderrText.length);
      expect(payload.error.hint.length).toBeLessThanOrEqual(64 * 1024);
      expect(payload.error.hint).not.toContain(verboseOutput.prefix);
      expect(payload.error.hint).toContain(verboseOutput.suffix);
    });
  });

  it("does not emit readiness or record Explorer state when Quartz fails immediately after the startup URL", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-websocket-failure-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      mockReadyThenFailedStartupSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      // Act
      const result = await runCliBuffered([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "local",
        "--port",
        "8770",
        "--json",
      ]);
      const payload = parseExploreServeFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(result.stdout.join("\n")).not.toContain("\"ok\":true");
      expect(payload.error).toMatchObject({
        code: "QUARTZ_COMMAND_FAILED",
        hint: "EADDRINUSE: websocket address already in use",
      });
      expect(payload.error.message).toContain("Quartz command failed: npm run serve -- --port 8770 --wsPort ");
      await expect(readFile(resolve(wikiDir, ".llm-wiki/cache/explorer-state.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("reruns sync while serving when watched curated pages, source cards, queues, profiles, and config change", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-watch-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnController = mockLongRunningSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Watched Source Card",
        "--text",
        "Private source card body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await mkdir(resolve(wikiDir, "notes"), { recursive: true });
      await writeFile(
        resolve(wikiDir, "notes/profile-visible.md"),
        "---\ntype: page\ntitle: Profile Visible\nvisibility: private\nsource_ids: []\n---\n\n# Profile Visible\n\nProfile watcher marker.\n",
        "utf8",
      );

      // Act
      const serveResult = runCliBuffered([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "local",
        "--port",
        "8766",
        "--json",
      ]);
      await spawnController.waitUntilStarted();
      const contentRootBefore = await stat(resolve(wikiDir, "quartz/content"));

      const homePath = resolve(wikiDir, "curated/home.md");
      await writeFile(homePath, `${await readFile(homePath, "utf8")}\nCurated watcher marker.\n`, "utf8");
      const syncedCuratedPage = await waitForFileContent(
        wikiDir,
        "quartz/content/curated/home.md",
        "Curated watcher marker.",
      );

      const sourceCardPath = resolve(wikiDir, capture.source.source_card_path);
      await writeFile(sourceCardPath, `${await readFile(sourceCardPath, "utf8")}\nSource card watcher marker.\n`, "utf8");
      const syncedSourceCard = await waitForFileContent(
        wikiDir,
        `quartz/content/${capture.source.source_card_path}`,
        "Source card watcher marker.",
      );

      const queuePath = resolve(wikiDir, capture.source.queue_path);
      const queueRecord = JSON.parse(await readFile(queuePath, "utf8")) as Record<string, unknown>;
      await writeFile(queuePath, `${JSON.stringify({ ...queueRecord, status: "blocked" }, null, 2)}\n`, "utf8");
      const syncedQueue = await waitForFileContent(
        wikiDir,
        "quartz/content/_llm-wiki/review/source-queue.md",
        "blocked",
      );

      const localProfilePath = resolve(wikiDir, ".llm-wiki/profiles/local.yml");
      const localProfile = await readFile(localProfilePath, "utf8");
      await writeFile(localProfilePath, localProfile.replace("  - raw/queue/**\n", "  - raw/queue/**\n  - notes/**\n"), "utf8");
      const profileManifest = await waitForManifest(
        wikiDir,
        (manifest) => manifest.files.some((file) => file.source_path === "notes/profile-visible.md"),
        "local profile change to materialize notes/profile-visible.md",
      );

      await pause(300);
      const profileVisiblePath = resolve(wikiDir, "notes/profile-visible.md");
      await writeFile(
        profileVisiblePath,
        `${await readFile(profileVisiblePath, "utf8")}\nProfile-selected watcher edit marker.\n`,
        "utf8",
      );
      const syncedProfileVisiblePage = await waitForFileContent(
        wikiDir,
        "quartz/content/notes/profile-visible.md",
        "Profile-selected watcher edit marker.",
      );

      const manifestPath = resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json");
      const beforeConfigMtimeMs = (await stat(manifestPath)).mtimeMs;
      const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
      await writeFile(configPath, `${await readFile(configPath, "utf8")}\n# config watcher marker\n`, "utf8");
      const afterConfigMtimeMs = await waitForManifestMtimeAfter(wikiDir, beforeConfigMtimeMs);
      const contentRootAfter = await stat(resolve(wikiDir, "quartz/content"));

      spawnController.close();
      const result = await serveResult;
      const payload = parseExploreServe(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.url).toBe("http://127.0.0.1:8766/");
      expect(syncedCuratedPage).toContain("Curated watcher marker.");
      expect(syncedSourceCard).toContain("Source card watcher marker.");
      expect(syncedQueue).toContain("blocked");
      expect(syncedProfileVisiblePage).toContain("Profile-selected watcher edit marker.");
      expect(profileManifest.files.map((file) => file.content_path)).toContain(
        "quartz/content/notes/profile-visible.md",
      );
      expect(afterConfigMtimeMs).toBeGreaterThan(beforeConfigMtimeMs);
      expect(contentRootAfter.dev).toBe(contentRootBefore.dev);
      expect(contentRootAfter.ino).toBe(contentRootBefore.ino);
    });
  }, 15_000);

  it("keeps watching relevant subdirectories created after serve starts", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-watch-new-dirs-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnController = mockLongRunningSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      // Act
      const serveResult = runCliBuffered([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "local",
        "--port",
        "8772",
        "--json",
      ]);
      await spawnController.waitUntilStarted();

      const nestedCuratedDir = resolve(wikiDir, "curated/new");
      const nestedCuratedPath = resolve(nestedCuratedDir, "page.md");
      const initialNestedPage =
        "---\ntype: page\ntitle: New Directory Page\nvisibility: private\nsource_ids: []\n---\n\n# New Directory Page\n\nInitial nested watcher marker.\n";
      await mkdir(nestedCuratedDir, { recursive: true });
      await writeFile(nestedCuratedPath, initialNestedPage, "utf8");

      const homePath = resolve(wikiDir, "curated/home.md");
      await writeFile(homePath, `${await readFile(homePath, "utf8")}\nNew directory sync trigger.\n`, "utf8");
      await waitForFileContent(
        wikiDir,
        "quartz/content/curated/new/page.md",
        "Initial nested watcher marker.",
      );
      await pause(300);

      await writeFile(
        nestedCuratedPath,
        initialNestedPage.replace("Initial nested watcher marker.", "Updated nested watcher marker."),
        "utf8",
      );
      const syncedNestedPage = await waitForFileContent(
        wikiDir,
        "quartz/content/curated/new/page.md",
        "Updated nested watcher marker.",
      );

      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Late Watched Source Card",
        "--text",
        "Late watched source card body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      await waitForFileContent(
        wikiDir,
        `quartz/content/${capture.source.source_card_path}`,
        "Late Watched Source Card",
      );
      await pause(300);

      const sourceCardPath = resolve(wikiDir, capture.source.source_card_path);
      await writeFile(sourceCardPath, `${await readFile(sourceCardPath, "utf8")}\nLate source card edit marker.\n`, "utf8");
      const syncedSourceCard = await waitForFileContent(
        wikiDir,
        `quartz/content/${capture.source.source_card_path}`,
        "Late source card edit marker.",
      );

      spawnController.close();
      const result = await serveResult;
      const payload = parseExploreServe(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.url).toBe("http://127.0.0.1:8772/");
      expect(syncedNestedPage).toContain("Updated nested watcher marker.");
      expect(syncedSourceCard).toContain("Late source card edit marker.");
    });
  }, 15_000);

  it("does not rerun sync when generated Quartz output changes while serving", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-generated-output-watch-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnController = mockLongRunningSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);

      // Act
      const serveResult = runCliBuffered([
        "explore",
        "serve",
        "--repo",
        wikiDir,
        "--profile",
        "local",
        "--port",
        "8773",
        "--json",
      ]);
      await spawnController.waitUntilStarted();
      await pause(350);

      const manifestPath = resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json");
      const beforeGeneratedOutputMtimeMs = (await stat(manifestPath)).mtimeMs;
      await mkdir(resolve(wikiDir, "quartz/public"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html>\n", "utf8");
      await mkdir(resolve(wikiDir, "quartz/.quartz-cache"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/.quartz-cache/cache.json"), "{}\n", "utf8");
      await writeFile(resolve(wikiDir, "quartz/content/generated-output.md"), "# Generated output\n", "utf8");
      await pause(500);
      const afterGeneratedOutputMtimeMs = (await stat(manifestPath)).mtimeMs;

      spawnController.close();
      const result = await serveResult;
      const payload = parseExploreServe(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.url).toBe("http://127.0.0.1:8773/");
      expect(afterGeneratedOutputMtimeMs).toBe(beforeGeneratedOutputMtimeMs);
    });
  }, 15_000);

  it("returns exact install instructions and a stable error code when dependencies are missing", async () => {
    await withTempWorkspace("llm-wiki-explore-serve-missing-deps-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/node_modules"), { recursive: true });

      // Act
      const result = await runCliBuffered(["explore", "serve", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreServeFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(payload.error).toEqual({
        code: "QUARTZ_DEPENDENCIES_MISSING",
        message: "Quartz dependencies are not installed.",
        hint: "Run cd quartz && npm install.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "QUARTZ_DEPENDENCIES_MISSING",
          path: "quartz/package.json",
          hint: "Run cd quartz && npm install.",
        }),
      ]);
      await expect(readFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"), "utf8")).resolves.toContain(
        "\"profile\": \"local\"",
      );
    });
  });
});
