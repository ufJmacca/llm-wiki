import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { readWikiProfile } from "../profiles/index.js";
import { syncQuartzContent, QuartzOperationError, type QuartzSyncResult } from "./index.js";
import {
  EXPLORER_STATE_PATH,
  removeExplorerStateIfCurrent,
  removeExplorerStateIfCurrentSync,
  writeExplorerState,
  type ExplorerState,
} from "./state.js";

export const DEFAULT_EXPLORER_HOST = "127.0.0.1" as const;
export const DEFAULT_EXPLORER_PORT = 8080 as const;

export const EXPLORER_WATCH_PATHS = [
  ".llm-wiki/config.yml",
  ".llm-wiki/profiles/**/*.yaml",
  ".llm-wiki/profiles/**/*.yml",
  "curated/**/*.md",
  "quartz/quartz.config.ts",
  "quartz/quartz.layout.ts",
  "raw/inputs/**/_source.md",
  "raw/queue/*.json",
] as const;

const QUARTZ_INSTALL_HINT = "Run cd quartz && npm install." as const;
const QUARTZ_READY_PATTERN = /Started a Quartz server listening at https?:\/\/\S+/;
const LOOPBACK_LISTEN_PRELOAD = "--require=./scripts/llm-wiki-loopback-listen.cjs" as const;
const QUARTZ_READY_SETTLE_MS = 250;
const QUARTZ_READY_OUTPUT_TAIL_BYTES = 16 * 1024;
const QUARTZ_SERVE_OUTPUT_TAIL_BYTES = 64 * 1024;
const QUARTZ_BIN_CANDIDATES = [
  "quartz/node_modules/.bin/quartz",
  "quartz/node_modules/.bin/quartz.cmd",
  "quartz/node_modules/.bin/quartz.ps1",
] as const;
const QUARTZ_RUNTIME_LAYOUT_CANDIDATES = [
  "quartz/quartz/build.ts",
  "quartz/quartz/components/index.ts",
  "quartz/quartz/plugins/index.ts",
] as const;
const EXPLORER_SOURCE_WATCH_SKIP_ROOTS = [
  ".git",
  ".llm-wiki/cache",
  ".llm-wiki/templates",
  "dist",
  "node_modules",
  "quartz/.quartz-cache",
  "quartz/content",
  "quartz/node_modules",
  "quartz/public",
  "quartz/quartz",
] as const;
const QUARTZ_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const satisfies readonly NodeJS.Signals[];

export type QuartzProcessResult = {
  command: "npm";
  args: string[];
  cwd: string;
  exit_code: number;
  stdout: string;
  stderr: string;
};

export type QuartzServeResult = {
  profile: QuartzSyncResult["profile"];
  host: string;
  port: number;
  ws_port: number;
  url: string;
  state_path: typeof EXPLORER_STATE_PATH;
  watch_paths: string[];
  sync: Pick<QuartzSyncResult, "manifest_path" | "materialized_paths" | "generated_paths">;
  quartz: QuartzProcessResult;
};

export type QuartzServeReadyResult = Omit<QuartzServeResult, "quartz"> & {
  quartz: Pick<QuartzProcessResult, "command" | "args" | "cwd"> & {
    status: "running";
  };
};

export async function serveQuartzExplorer(
  repoRoot: string,
  options: {
    profile: string;
    host?: string;
    port?: number;
    onReady?: (result: QuartzServeReadyResult, warnings: string[]) => void;
    onSynced?: (result: QuartzSyncResult) => Promise<void>;
  },
): Promise<{ data: QuartzServeResult; warnings: string[] }> {
  const syncResult = await syncQuartzContent(repoRoot, options.profile);
  await assertQuartzDependenciesInstalled(repoRoot);
  await options.onSynced?.(syncResult.data);

  const host = options.host ?? DEFAULT_EXPLORER_HOST;
  const port = options.port ?? DEFAULT_EXPLORER_PORT;
  const wsPort = await selectQuartzWebSocketPort(host, port);
  const url = explorerUrl(host, port);
  const watchPaths = [...EXPLORER_WATCH_PATHS];
  const args = ["run", "serve", "--", "--port", String(port), "--wsPort", String(wsPort)];
  const env = quartzServeEnvironment(host);
  const stopWatching = await startExplorerWatchers(repoRoot, syncResult.data.profile, options.onSynced);
  let stateRecorded = false;
  let recordedState: ExplorerState | null = null;
  const exitCleanup = {
    remove: null as (() => void) | null,
  };
  let quartz: QuartzProcessResult;
  const cleanupRecordedStateSync = (): void => {
    if (!stateRecorded) {
      return;
    }

    try {
      if (recordedState !== null) {
        removeExplorerStateIfCurrentSync(repoRoot, recordedState);
      }
    } catch {
      // Best effort cleanup during process shutdown; async cleanup still runs on normal exits.
    }
  };

  try {
    quartz = await runQuartzCommand(repoRoot, args, {
      env,
      outputTailBytes: QUARTZ_SERVE_OUTPUT_TAIL_BYTES,
      requireReady: true,
      onShutdownSignal: () => {
        void stopWatching();
        cleanupRecordedStateSync();
      },
      onReady: async (signal) => {
        const state: ExplorerState = {
          version: 1,
          instance_id: randomUUID(),
          profile: syncResult.data.profile,
          host,
          port,
          ws_port: wsPort,
          url,
          updated_at: new Date().toISOString(),
          watch_paths: watchPaths,
        };
        if (signal.aborted) {
          return;
        }

        const stateWrite = await writeExplorerState(repoRoot, state);
        if (signal.aborted) {
          await removeExplorerStateIfCurrent(repoRoot, state);
          return;
        }

        if (!stateWrite.ok) {
          throw new QuartzOperationError({
            code: "EXPLORER_STATE_WRITE_FAILED",
            message: stateWrite.error.message,
            path: stateWrite.error.path,
            hint: stateWrite.error.hint,
          });
        }
        stateRecorded = true;
        recordedState = state;
        process.once("exit", cleanupRecordedStateSync);
        exitCleanup.remove = () => {
          process.off("exit", cleanupRecordedStateSync);
          exitCleanup.remove = null;
        };

        const readyResult: QuartzServeReadyResult = {
          profile: syncResult.data.profile,
          host,
          port,
          ws_port: wsPort,
          url,
          state_path: EXPLORER_STATE_PATH,
          watch_paths: watchPaths,
          sync: syncSummary(syncResult.data),
          quartz: {
            command: "npm",
            args,
            cwd: resolve(repoRoot, "quartz"),
            status: "running",
          },
        };
        options.onReady?.(readyResult, syncResult.warnings);
      },
    });
  } finally {
    await stopWatching();
    exitCleanup.remove?.();
    if (stateRecorded && recordedState !== null) {
      await removeExplorerStateIfCurrent(repoRoot, recordedState);
    }
  }

  return {
    data: {
      profile: syncResult.data.profile,
      host,
      port,
      ws_port: wsPort,
      url,
      state_path: EXPLORER_STATE_PATH,
      watch_paths: watchPaths,
      sync: syncSummary(syncResult.data),
      quartz,
    },
    warnings: syncResult.warnings,
  };
}

export async function assertQuartzDependenciesInstalled(repoRoot: string): Promise<void> {
  const packagePath = resolve(repoRoot, "quartz/package.json");
  try {
    const packageState = await lstat(packagePath);
    if (!packageState.isFile()) {
      throw new QuartzOperationError({
        code: "QUARTZ_RUNTIME_MISSING",
        message: "Quartz runtime package file is missing.",
        path: "quartz/package.json",
        hint: "Run llm-wiki explore init before running Quartz Explorer commands.",
      });
    }
  } catch (error) {
    if (error instanceof QuartzOperationError) {
      throw error;
    }

    if (isNodeError(error) && error.code === "ENOENT") {
      throw new QuartzOperationError({
        code: "QUARTZ_RUNTIME_MISSING",
        message: "Quartz runtime package file is missing.",
        path: "quartz/package.json",
        hint: "Run llm-wiki explore init before running Quartz Explorer commands.",
      });
    }

    throw new QuartzOperationError({
      code: "QUARTZ_RUNTIME_MISSING",
      message: "Could not inspect Quartz runtime dependencies.",
      path: "quartz/package.json",
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning this command.",
    });
  }

  try {
    if ((await hasInstalledQuartzBinary(repoRoot)) && (await hasRunnableQuartzRuntimeLayout(repoRoot))) {
      return;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new QuartzOperationError({
        code: "QUARTZ_DEPENDENCIES_MISSING",
        message: "Quartz dependencies are not installed.",
        path: "quartz/package.json",
        hint: QUARTZ_INSTALL_HINT,
      });
    }
  }

  throw new QuartzOperationError({
    code: "QUARTZ_DEPENDENCIES_MISSING",
    message: "Quartz dependencies are not installed.",
    path: "quartz/package.json",
    hint: QUARTZ_INSTALL_HINT,
  });
}

export async function runQuartzCommand(
  repoRoot: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    onReady?: (signal: AbortSignal) => Promise<void>;
    onShutdownSignal?: (signal: NodeJS.Signals) => void;
    outputTailBytes?: number;
    requireReady?: boolean;
  } = {},
): Promise<QuartzProcessResult> {
  const cwd = resolve(repoRoot, "quartz");

  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(npmCommand(), args, {
      cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(usesShutdownHandlers(options) && process.platform !== "win32" ? { detached: true } : {}),
    });
    const stdout = new OutputTail(options.outputTailBytes);
    const stderr = new OutputTail(options.outputTailBytes);
    const observedOutput = new OutputTail(QUARTZ_READY_OUTPUT_TAIL_BYTES);
    let ready = false;
    let settled = false;
    let readyPromise: Promise<void> | null = null;
    let readyTimer: NodeJS.Timeout | null = null;
    const readyAbort = new AbortController();
    let interruptedSignal: NodeJS.Signals | null = null;
    let shutdownSideEffectsRan = false;
    let terminationRequested = false;

    const clearReadyTimer = (): void => {
      if (readyTimer !== null) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
    };

    const stopReadiness = (): void => {
      readyAbort.abort();
      clearReadyTimer();
    };

    const runShutdownSideEffects = (signal: NodeJS.Signals): void => {
      if (shutdownSideEffectsRan) {
        return;
      }

      shutdownSideEffectsRan = true;
      options.onShutdownSignal?.(signal);
    };

    const terminateChildTree = (signal: NodeJS.Signals): void => {
      if (terminationRequested) {
        return;
      }

      terminationRequested = true;
      terminateQuartzProcessTree(child, signal);
    };

    const handleShutdownSignal = (signal: NodeJS.Signals): void => {
      if (settled) {
        return;
      }

      interruptedSignal = signal;
      stopReadiness();

      runShutdownSideEffects(signal);
      terminateChildTree(signal);
    };
    const handleProcessExit = (): void => {
      if (settled) {
        return;
      }

      stopReadiness();
      runShutdownSideEffects("SIGTERM");
      terminateChildTree("SIGTERM");
    };

    const signalHandlers: Record<(typeof QUARTZ_SHUTDOWN_SIGNALS)[number], () => void> = {
      SIGINT: () => handleShutdownSignal("SIGINT"),
      SIGTERM: () => handleShutdownSignal("SIGTERM"),
    };
    const cleanupProcessHandlers = (): void => {
      if (!usesShutdownHandlers(options)) {
        return;
      }

      for (const signal of QUARTZ_SHUTDOWN_SIGNALS) {
        process.off(signal, signalHandlers[signal]);
      }
      process.off("exit", handleProcessExit);
    };
    const fail = (error: QuartzOperationError): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupProcessHandlers();
      stopReadiness();
      rejectCommand(error);
    };

    if (usesShutdownHandlers(options)) {
      for (const signal of QUARTZ_SHUTDOWN_SIGNALS) {
        process.once(signal, signalHandlers[signal]);
      }
      process.once("exit", handleProcessExit);
    }

    const startReadyCallback = (): void => {
      if (!ready || options.onReady === undefined || readyPromise !== null || settled) {
        return;
      }

      readyTimer = null;
      readyPromise = options.onReady(readyAbort.signal).catch((error: unknown) => {
        if (readyAbort.signal.aborted) {
          return;
        }

        terminateChildTree("SIGTERM");

        fail(
          error instanceof QuartzOperationError
            ? error
            : new QuartzOperationError({
                code: "EXPLORER_STATE_WRITE_FAILED",
                message: "Failed to record current Quartz Explorer state.",
                path: EXPLORER_STATE_PATH,
                hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning serve.",
              }),
        );
      });
    };

    const observeOutput = (chunk: Buffer | string): void => {
      if (options.onReady === undefined || ready) {
        return;
      }

      observedOutput.append(chunk);
      if (QUARTZ_READY_PATTERN.test(observedOutput.toString())) {
        ready = true;
        readyTimer = setTimeout(startReadyCallback, QUARTZ_READY_SETTLE_MS);
        readyTimer.unref();
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.append(chunk);
      observeOutput(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.append(chunk);
      observeOutput(chunk);
    });

    child.on("error", (error) => {
      fail(
        new QuartzOperationError({
          code: "QUARTZ_COMMAND_FAILED",
          message: `Quartz command failed to start: npm ${args.join(" ")}.`,
          path: "quartz/package.json",
          hint: error.message,
        }),
      );
    });

    child.on("close", (code) => {
      const complete = async (): Promise<void> => {
        cleanupProcessHandlers();
        const stdoutText = stdout.toString();
        const stderrText = stderr.toString();
        const exitCode = interruptedSignal === null ? code ?? 1 : 0;
        clearReadyTimer();

        if (exitCode !== 0) {
          readyAbort.abort();
          if (readyPromise !== null) {
            await readyPromise;
          }

          fail(
            new QuartzOperationError({
              code: "QUARTZ_COMMAND_FAILED",
              message: `Quartz command failed: npm ${args.join(" ")}.`,
              path: "quartz/package.json",
              hint: stderrText.trim() || QUARTZ_INSTALL_HINT,
            }),
          );
          return;
        }

        if (options.requireReady === true && !ready) {
          fail(
            new QuartzOperationError({
              code: "QUARTZ_COMMAND_FAILED",
              message: "Quartz serve exited before reporting a startup URL.",
              path: "quartz/package.json",
              hint:
                stderrText.trim() ||
                stdoutText.trim() ||
                "Check the Quartz serve script and rerun llm-wiki explore serve.",
            }),
          );
          return;
        }

        startReadyCallback();
        if (readyPromise !== null) {
          await readyPromise;
        }

        if (settled) {
          return;
        }

        settled = true;
        cleanupProcessHandlers();
        resolveCommand({
          command: "npm",
          args,
          cwd,
          exit_code: exitCode,
          stdout: stdoutText,
          stderr: stderrText,
        });
      };

      complete().catch((error: unknown) => {
        fail(
          error instanceof QuartzOperationError
            ? error
            : new QuartzOperationError({
                code: "QUARTZ_COMMAND_FAILED",
                message: `Quartz command failed: npm ${args.join(" ")}.`,
                path: "quartz/package.json",
                hint: error instanceof Error ? error.message : QUARTZ_INSTALL_HINT,
              }),
        );
      });
    });
  });
}

function npmCommand(): "npm" | "npm.cmd" {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function usesShutdownHandlers(options: { onShutdownSignal?: (signal: NodeJS.Signals) => void }): boolean {
  return options.onShutdownSignal !== undefined;
}

function terminateQuartzProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    child.kill(signal);
    return;
  }

  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) {
      child.kill(signal);
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

class OutputTail {
  private chunks: Buffer[] = [];
  private byteLength = 0;

  constructor(private readonly maxBytes?: number) {}

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.maxBytes !== undefined && this.maxBytes <= 0) {
      return;
    }

    if (this.maxBytes !== undefined && buffer.length >= this.maxBytes) {
      this.chunks = [Buffer.from(buffer.subarray(buffer.length - this.maxBytes))];
      this.byteLength = this.maxBytes;
      return;
    }

    this.chunks.push(buffer);
    this.byteLength += buffer.length;
    this.trim();
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.byteLength).toString("utf8");
  }

  private trim(): void {
    if (this.maxBytes === undefined) {
      return;
    }

    while (this.byteLength > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.byteLength - this.maxBytes;
      const first = this.chunks[0];
      if (first.length <= overflow) {
        this.chunks.shift();
        this.byteLength -= first.length;
        continue;
      }

      this.chunks[0] = first.subarray(overflow);
      this.byteLength -= overflow;
    }
  }
}

async function selectQuartzWebSocketPort(host: string, httpPort: number): Promise<number> {
  const preferredPort = httpPort < 65535 ? httpPort + 1 : httpPort - 1;
  if (preferredPort !== httpPort && (await canListenOnPort(host, preferredPort))) {
    return preferredPort;
  }

  return await allocateEphemeralPort(host);
}

async function canListenOnPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const server = createServer();
    server.once("error", () => {
      resolveCheck(false);
    });
    server.listen(port, host, () => {
      server.close(() => resolveCheck(true));
    });
  });
}

async function allocateEphemeralPort(host: string): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", (error) => {
      rejectPort(
        new QuartzOperationError({
          code: "QUARTZ_COMMAND_FAILED",
          message: "Could not reserve a Quartz WebSocket port.",
          path: "quartz/package.json",
          hint: error.message,
        }),
      );
    });
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => {
        if (port === null) {
          rejectPort(
            new QuartzOperationError({
              code: "QUARTZ_COMMAND_FAILED",
              message: "Could not determine a Quartz WebSocket port.",
              path: "quartz/package.json",
              hint: "Choose a different Explorer host or port and rerun llm-wiki explore serve.",
            }),
          );
          return;
        }

        resolvePort(port);
      });
    });
  });
}

function explorerUrl(host: string, port: number): string {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}/`;
}

function quartzServeEnvironment(host: string): NodeJS.ProcessEnv {
  const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
  const nodeOptions =
    existingNodeOptions && existingNodeOptions.length > 0
      ? `${existingNodeOptions} ${LOOPBACK_LISTEN_PRELOAD}`
      : LOOPBACK_LISTEN_PRELOAD;

  return {
    ...process.env,
    LLM_WIKI_EXPLORER_HOST: host,
    NODE_OPTIONS: nodeOptions,
  };
}

async function hasInstalledQuartzBinary(repoRoot: string): Promise<boolean> {
  for (const path of QUARTZ_BIN_CANDIDATES) {
    try {
      const state = await lstat(resolve(repoRoot, path));
      if (state.isFile() || state.isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return false;
}

async function hasRunnableQuartzRuntimeLayout(repoRoot: string): Promise<boolean> {
  for (const path of QUARTZ_RUNTIME_LAYOUT_CANDIDATES) {
    try {
      const state = await lstat(resolve(repoRoot, path));
      if (!state.isFile()) {
        return false;
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  return true;
}

export function syncSummary(
  sync: QuartzSyncResult,
): Pick<QuartzSyncResult, "manifest_path" | "materialized_paths" | "generated_paths"> {
  return {
    manifest_path: sync.manifest_path,
    materialized_paths: sync.materialized_paths,
    generated_paths: sync.generated_paths,
  };
}

async function startExplorerWatchers(
  repoRoot: string,
  profile: QuartzSyncResult["profile"],
  onSynced?: (result: QuartzSyncResult) => Promise<void>,
): Promise<() => Promise<void>> {
  const watchers = new Map<string, FSWatcher>();
  let timeout: NodeJS.Timeout | null = null;
  let syncInFlight = false;
  let closed = false;
  let syncPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const refreshWatchTargets = async (): Promise<void> => {
    for (const path of await existingWatchTargets(repoRoot, profile)) {
      addWatchTarget(path);
    }
  };

  const handleWatchEvent = (watchPath: string, filename: string | Buffer | null): void => {
    const eventPath = watchEventPath(watchPath, filename);
    if (eventPath !== null && shouldSkipExplorerSourceWatchPath(eventPath)) {
      return;
    }

    void refreshWatchTargets().catch(() => undefined);
    scheduleSync();
  };

  const addWatchTarget = (path: string): void => {
    if (closed || watchers.has(path)) {
      return;
    }

    try {
      const watcher = watch(resolve(repoRoot, path), { persistent: false }, (_eventType, filename) => {
        handleWatchEvent(path, filename);
      });
      watcher.on("error", () => {
        watchers.delete(path);
      });
      watchers.set(path, watcher);
    } catch {
      // Watch support varies by filesystem. The initial sync and state still remain valid.
    }
  };

  const scheduleSync = (): void => {
    if (closed) {
      return;
    }

    if (timeout !== null) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      timeout = null;
      if (closed) {
        return;
      }

      if (syncInFlight) {
        scheduleSync();
        return;
      }

      syncInFlight = true;
      syncPromise = syncQuartzContent(repoRoot, profile, { preserveContentRoot: true })
        .then(async (syncResult) => {
          if (closed) {
            return;
          }

          await onSynced?.(syncResult.data);
          await refreshWatchTargets();
        })
        .catch(() => undefined)
        .finally(() => {
          syncInFlight = false;
          syncPromise = null;
        });
    }, 100);
    timeout.unref();
  };

  await refreshWatchTargets();

  return async () => {
    stopPromise ??= (async () => {
      closed = true;
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }

      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
      await syncPromise;
    })();
    await stopPromise;
  };
}

async function existingWatchTargets(repoRoot: string, profile: QuartzSyncResult["profile"]): Promise<string[]> {
  const targets = new Set<string>();
  for (const path of ["curated", "raw/inputs", "raw/queue", ".llm-wiki/profiles"]) {
    for (const directory of await existingDirectories(repoRoot, path)) {
      targets.add(directory);
    }
  }

  for (const directory of await existingProfileMarkdownWatchTargets(repoRoot, profile)) {
    targets.add(directory);
  }

  if (await isExistingDirectory(repoRoot, ".llm-wiki")) {
    targets.add(".llm-wiki");
  }

  for (const path of [".llm-wiki/config.yml", "quartz/quartz.config.ts", "quartz/quartz.layout.ts"]) {
    if (await isExistingFile(repoRoot, path)) {
      targets.add(path);
    }
  }

  return [...targets].sort();
}

async function existingProfileMarkdownWatchTargets(
  repoRoot: string,
  profileName: QuartzSyncResult["profile"],
): Promise<string[]> {
  const profile = await readWikiProfile(repoRoot, profileName);
  if (!profile.ok) {
    return [];
  }

  const targets = new Set<string>();
  for (const includePattern of profile.value.include) {
    const root = sourceWatchRootForIncludePattern(includePattern);
    if (root === null || shouldSkipExplorerSourceWatchPath(root)) {
      continue;
    }

    if (await isExistingDirectory(repoRoot, root)) {
      for (const directory of await existingDirectories(repoRoot, root, { skipGenerated: true })) {
        targets.add(directory);
      }
      continue;
    }

    const ancestor = await nearestExistingDirectory(repoRoot, root);
    if (ancestor !== null && !shouldSkipExplorerSourceWatchPath(ancestor)) {
      targets.add(ancestor);
    }
  }

  return [...targets].sort();
}

type ExistingDirectoriesOptions = {
  skipGenerated?: boolean;
};

async function existingDirectories(
  repoRoot: string,
  path: string,
  options: ExistingDirectoriesOptions = {},
): Promise<string[]> {
  const normalizedPath = normalizeWatchPath(path);
  if (options.skipGenerated && shouldSkipExplorerSourceWatchPath(normalizedPath)) {
    return [];
  }

  try {
    const state = await lstat(resolve(repoRoot, normalizedPath));
    if (!state.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const paths = [normalizedPath];
  const entries = await readdir(resolve(repoRoot, normalizedPath), { withFileTypes: true });
  for (const entry of entries) {
    const childPath = normalizedPath === "." ? entry.name : `${normalizedPath}/${entry.name}`;
    if (options.skipGenerated && shouldSkipExplorerSourceWatchPath(childPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      paths.push(...await existingDirectories(repoRoot, childPath, options));
    }
  }

  return paths;
}

async function nearestExistingDirectory(repoRoot: string, path: string): Promise<string | null> {
  let candidate = normalizeWatchPath(path);
  while (candidate !== ".") {
    const parent = parentWatchPath(candidate);
    if (await isExistingDirectory(repoRoot, parent)) {
      return parent;
    }
    candidate = parent;
  }

  return await isExistingDirectory(repoRoot, ".") ? "." : null;
}

async function isExistingDirectory(repoRoot: string, path: string): Promise<boolean> {
  try {
    const state = await lstat(resolve(repoRoot, path));
    return state.isDirectory();
  } catch {
    return false;
  }
}

async function isExistingFile(repoRoot: string, path: string): Promise<boolean> {
  try {
    const state = await lstat(resolve(repoRoot, path));
    return state.isFile();
  } catch {
    return false;
  }
}

function sourceWatchRootForIncludePattern(pattern: string): string | null {
  const normalized = normalizeWatchPath(pattern);
  if (isUnsafeWatchPath(normalized)) {
    return null;
  }

  const globIndex = normalized.indexOf("*");
  if (globIndex === -1) {
    return normalized.endsWith(".md") ? parentWatchPath(normalized) : normalized;
  }

  const literalPrefix = normalized.slice(0, globIndex);
  const slashIndex = literalPrefix.lastIndexOf("/");
  return slashIndex === -1 ? "." : normalizeWatchPath(literalPrefix.slice(0, slashIndex));
}

function watchEventPath(watchPath: string, filename: string | Buffer | null): string | null {
  if (filename === null) {
    return null;
  }

  const name = filename.toString();
  if (name === "") {
    return null;
  }

  return normalizeWatchPath(watchPath === "." ? name : `${watchPath}/${name}`);
}

function normalizeWatchPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/u, "");
  return normalized === "" ? "." : normalized;
}

function parentWatchPath(path: string): string {
  const normalized = normalizeWatchPath(path);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex === -1 ? "." : normalizeWatchPath(normalized.slice(0, slashIndex));
}

function shouldSkipExplorerSourceWatchPath(path: string): boolean {
  const normalized = normalizeWatchPath(path);
  return EXPLORER_SOURCE_WATCH_SKIP_ROOTS.some(
    (skippedRoot) => normalized === skippedRoot || normalized.startsWith(`${skippedRoot}/`),
  );
}

function isUnsafeWatchPath(path: string): boolean {
  return path.startsWith("/") || path.includes("\0") || path.split("/").includes("..");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
