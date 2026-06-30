import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { RuntimeCommandError } from "../src/runtime/errors.js";
import { withIngestLock } from "../src/runtime/ingestLock.js";
import { pathExists, withTempWorkspace } from "./helpers/init.js";

type LockMetadata = {
  pid: number;
  started_at: string;
  label: string;
};

const LOCK_RELATIVE_PATH = ".llm-wiki/cache/locks/ingest.lock";
const LOCK_METADATA_RELATIVE_PATH = `${LOCK_RELATIVE_PATH}/metadata.json`;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readLockMetadata(repoRoot: string): Promise<LockMetadata> {
  return JSON.parse(await readFile(resolve(repoRoot, LOCK_METADATA_RELATIVE_PATH), "utf8")) as LockMetadata;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}

type LockHolderProcess = {
  child: ChildProcess;
  stderr: () => string;
  stdout: () => string;
};

function spawnLockHolderProcess(repoRoot: string, readyPath: string, releasePath: string): LockHolderProcess {
  const lockModuleUrl = pathToFileURL(resolve(PROJECT_ROOT, "dist/src/runtime/ingestLock.js")).href;
  const script = `
import { access, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { withIngestLock } from ${JSON.stringify(lockModuleUrl)};

await withIngestLock(${JSON.stringify(repoRoot)}, { label: "child holder" }, async () => {
  await writeFile(${JSON.stringify(readyPath)}, "ready", "utf8");

  while (true) {
    try {
      await access(${JSON.stringify(releasePath)});
      break;
    } catch {
      await sleep(10);
    }
  }
});
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

async function waitForLockHolderReady(holder: LockHolderProcess, readyPath: string): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    if (await pathExists(readyPath)) {
      return;
    }

    if (holder.child.exitCode !== null) {
      throw new Error(`Lock holder exited before acquiring the lock: ${holder.stderr()}`);
    }

    await sleep(10);
  }

  throw new Error(`Lock holder did not report readiness. stdout: ${holder.stdout()} stderr: ${holder.stderr()}`);
}

async function releaseLockHolder(holder: LockHolderProcess, releasePath: string): Promise<void> {
  await writeFile(releasePath, "release", "utf8");

  if (holder.child.exitCode === null) {
    const closeResult = await Promise.race([
      new Promise<"closed">((resolveClose) => {
        holder.child.once("close", () => resolveClose("closed"));
      }),
      sleep(1_000).then(() => "timeout" as const),
    ]);

    if (closeResult === "timeout") {
      holder.child.kill("SIGKILL");
      await new Promise<void>((resolveClose) => {
        holder.child.once("close", () => resolveClose());
      });
      throw new Error(`Lock holder did not exit after release. stdout: ${holder.stdout()} stderr: ${holder.stderr()}`);
    }
  }

  if (holder.child.exitCode !== 0) {
    throw new Error(`Lock holder exited with ${holder.child.exitCode}. stdout: ${holder.stdout()} stderr: ${holder.stderr()}`);
  }
}

async function spawnExitedProcess(): Promise<number> {
  const child = spawn(process.execPath, ["--eval", ""], {
    stdio: "ignore",
  });
  if (child.pid === undefined) {
    throw new Error("Expected exited process fixture to have a pid.");
  }

  const pid = child.pid;
  const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
  if (exitResult.code !== 0 || exitResult.signal !== null) {
    throw new Error(`Expected exited process fixture to exit cleanly: ${JSON.stringify(exitResult)}`);
  }

  return pid;
}

async function ageLockPath(path: string): Promise<void> {
  const staleTime = new Date(Date.now() - 5_000);

  await utimes(path, staleTime, staleTime);
}

describe("ingest repository lock", () => {
  it("creates lock metadata while the callback runs and cleans up after success", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-success-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      await mkdir(repoRoot, { recursive: true });
      const observedMetadata: LockMetadata[] = [];

      // Act
      const result = await withIngestLock(repoRoot, { label: "queue ingest" }, async () => {
        observedMetadata.push(await readLockMetadata(repoRoot));

        return "ingested";
      });

      // Assert
      expect(result).toBe("ingested");
      expect(observedMetadata).toHaveLength(1);
      expect(observedMetadata[0]).toMatchObject({
        pid: process.pid,
        label: "queue ingest",
      });
      expect(new Date(observedMetadata[0].started_at).toISOString()).toBe(observedMetadata[0].started_at);
      await expect(pathExists(resolve(repoRoot, LOCK_RELATIVE_PATH))).resolves.toBe(false);
    });
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked lock directory before creating the lock", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-symlinked-parent-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      const outsideLocksDir = resolve(workspaceDir, "outside-locks");
      await mkdir(resolve(repoRoot, ".llm-wiki/cache"), { recursive: true });
      await mkdir(outsideLocksDir, { recursive: true });
      await symlink(outsideLocksDir, resolve(repoRoot, ".llm-wiki/cache/locks"), "dir");
      let callbackRan = false;

      // Act
      const result = withIngestLock(repoRoot, { label: "symlinked lock" }, async () => {
        callbackRan = true;
      });

      // Assert
      await expect(result).rejects.toMatchObject({
        code: "INGEST_LOCK_PATH_UNSAFE",
        path: ".llm-wiki/cache/locks",
      });
      await expect(result).rejects.toBeInstanceOf(RuntimeCommandError);
      expect(callbackRan).toBe(false);
      await expect(pathExists(resolve(outsideLocksDir, "ingest.lock"))).resolves.toBe(false);
    });
  });

  it("returns INGEST_LOCK_BUSY without invoking work when the same repo lock is already held", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-busy-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      await mkdir(repoRoot, { recursive: true });
      await writeFile(resolve(repoRoot, "mutation-sentinel.txt"), "unchanged", "utf8");
      const releaseFirstLock = createDeferred();
      const firstLockStarted = createDeferred();
      const firstLock = withIngestLock(repoRoot, { label: "first holder" }, async () => {
        firstLockStarted.resolve();
        await releaseFirstLock.promise;
      });
      await firstLockStarted.promise;
      let secondCallbackRan = false;

      // Act
      const secondLock = withIngestLock(
        repoRoot,
        { label: "second holder", retryDelayMs: 5, timeoutMs: 20 },
        async () => {
          secondCallbackRan = true;
          await writeFile(resolve(repoRoot, "mutation-sentinel.txt"), "changed", "utf8");
        },
      );

      // Assert
      await expect(secondLock).rejects.toMatchObject({
        code: "INGEST_LOCK_BUSY",
        path: LOCK_RELATIVE_PATH,
      });
      await expect(secondLock).rejects.toBeInstanceOf(RuntimeCommandError);
      expect(secondCallbackRan).toBe(false);
      await expect(readFile(resolve(repoRoot, "mutation-sentinel.txt"), "utf8")).resolves.toBe("unchanged");
      releaseFirstLock.resolve();
      await expect(firstLock).resolves.toBeUndefined();
      await expect(pathExists(resolve(repoRoot, LOCK_RELATIVE_PATH))).resolves.toBe(false);
    });
  });

  it("waits with default timing and runs work when the same repo lock is released before timeout", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-wait-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      const mutationSentinelPath = resolve(repoRoot, "mutation-sentinel.txt");
      await mkdir(repoRoot, { recursive: true });
      await writeFile(mutationSentinelPath, "unchanged", "utf8");
      const releaseFirstLock = createDeferred();
      const firstLockStarted = createDeferred();
      const firstLock = withIngestLock(repoRoot, { label: "first holder" }, async () => {
        firstLockStarted.resolve();
        await releaseFirstLock.promise;
      });
      await firstLockStarted.promise;
      let secondCallbackRan = false;

      // Act
      const secondLock = withIngestLock(repoRoot, { label: "second holder" }, async () => {
        secondCallbackRan = true;
        await writeFile(mutationSentinelPath, "changed", "utf8");

        return "second acquired";
      });
      const resultWhileFirstLockHeld = await Promise.race([
        secondLock.then(
          () => "settled",
          () => "rejected",
        ),
        sleep(50).then(() => "waiting" as const),
      ]);

      // Assert
      expect(resultWhileFirstLockHeld).toBe("waiting");
      expect(secondCallbackRan).toBe(false);
      await expect(readFile(mutationSentinelPath, "utf8")).resolves.toBe("unchanged");
      releaseFirstLock.resolve();
      await expect(firstLock).resolves.toBeUndefined();
      await expect(secondLock).resolves.toBe("second acquired");
      expect(secondCallbackRan).toBe(true);
      await expect(readFile(mutationSentinelPath, "utf8")).resolves.toBe("changed");
      await expect(pathExists(resolve(repoRoot, LOCK_RELATIVE_PATH))).resolves.toBe(false);
    });
  });

  it("returns INGEST_LOCK_BUSY without invoking work when another process holds the filesystem lock", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-cross-process-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      const readyPath = resolve(workspaceDir, "child-ready");
      const releasePath = resolve(workspaceDir, "release-child");
      const mutationSentinelPath = resolve(repoRoot, "mutation-sentinel.txt");
      await mkdir(repoRoot, { recursive: true });
      await writeFile(mutationSentinelPath, "unchanged", "utf8");
      const holder = spawnLockHolderProcess(repoRoot, readyPath, releasePath);
      await waitForLockHolderReady(holder, readyPath);
      let parentCallbackRan = false;

      try {
        // Act
        const parentLock = withIngestLock(
          repoRoot,
          { label: "parent contender", retryDelayMs: 5, timeoutMs: 20 },
          async () => {
            parentCallbackRan = true;
            await writeFile(mutationSentinelPath, "changed", "utf8");
          },
        );

        // Assert
        await expect(parentLock).rejects.toMatchObject({
          code: "INGEST_LOCK_BUSY",
          path: LOCK_RELATIVE_PATH,
        });
        await expect(parentLock).rejects.toBeInstanceOf(RuntimeCommandError);
        expect(parentCallbackRan).toBe(false);
        await expect(readFile(mutationSentinelPath, "utf8")).resolves.toBe("unchanged");
        const metadata = await readLockMetadata(repoRoot);
        expect(metadata).toMatchObject({ label: "child holder" });
        expect(metadata.pid).not.toBe(process.pid);
      } finally {
        await releaseLockHolder(holder, releasePath);
      }

      await expect(pathExists(resolve(repoRoot, LOCK_RELATIVE_PATH))).resolves.toBe(false);
    });
  });

  it("reclaims a stale lock when the metadata process is no longer running", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-stale-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      const mutationSentinelPath = resolve(repoRoot, "mutation-sentinel.txt");
      const stalePid = await spawnExitedProcess();
      await mkdir(resolve(repoRoot, LOCK_RELATIVE_PATH), { recursive: true });
      await writeFile(mutationSentinelPath, "unchanged", "utf8");
      await writeFile(
        resolve(repoRoot, LOCK_METADATA_RELATIVE_PATH),
        `${JSON.stringify(
          {
            pid: stalePid,
            started_at: new Date(Date.now() - 60_000).toISOString(),
            label: "crashed holder",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      let callbackRan = false;

      // Act
      const observedMetadata = await withIngestLock(
        repoRoot,
        { label: "recovered holder", retryDelayMs: 5, timeoutMs: 20 },
        async () => {
          callbackRan = true;
          await writeFile(mutationSentinelPath, "changed", "utf8");

          return readLockMetadata(repoRoot);
        },
      );

      // Assert
      expect(callbackRan).toBe(true);
      expect(observedMetadata).toMatchObject({
        pid: process.pid,
        label: "recovered holder",
      });
      await expect(readFile(mutationSentinelPath, "utf8")).resolves.toBe("changed");
      await expect(pathExists(resolve(repoRoot, LOCK_RELATIVE_PATH))).resolves.toBe(false);
    });
  });

  it("keeps a fresh metadata-less lock busy during the creation grace period", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-fresh-unowned-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      const mutationSentinelPath = resolve(repoRoot, "mutation-sentinel.txt");
      await mkdir(resolve(repoRoot, LOCK_RELATIVE_PATH), { recursive: true });
      await writeFile(mutationSentinelPath, "unchanged", "utf8");
      let callbackRan = false;

      // Act
      const result = withIngestLock(
        repoRoot,
        { label: "fresh contender", retryDelayMs: 5, timeoutMs: 20 },
        async () => {
          callbackRan = true;
          await writeFile(mutationSentinelPath, "changed", "utf8");
        },
      );

      // Assert
      await expect(result).rejects.toMatchObject({
        code: "INGEST_LOCK_BUSY",
        path: LOCK_RELATIVE_PATH,
      });
      await expect(result).rejects.toBeInstanceOf(RuntimeCommandError);
      expect(callbackRan).toBe(false);
      await expect(readFile(mutationSentinelPath, "utf8")).resolves.toBe("unchanged");
      await expect(pathExists(resolve(repoRoot, LOCK_RELATIVE_PATH))).resolves.toBe(true);
    });
  });

  it("reclaims a stale metadata-less lock after the creation grace period", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-stale-unowned-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      const lockPath = resolve(repoRoot, LOCK_RELATIVE_PATH);
      const mutationSentinelPath = resolve(repoRoot, "mutation-sentinel.txt");
      await mkdir(lockPath, { recursive: true });
      await ageLockPath(lockPath);
      await writeFile(mutationSentinelPath, "unchanged", "utf8");
      let callbackRan = false;

      // Act
      const observedMetadata = await withIngestLock(
        repoRoot,
        { label: "recovered unowned holder", retryDelayMs: 5, timeoutMs: 20 },
        async () => {
          callbackRan = true;
          await writeFile(mutationSentinelPath, "changed", "utf8");

          return readLockMetadata(repoRoot);
        },
      );

      // Assert
      expect(callbackRan).toBe(true);
      expect(observedMetadata).toMatchObject({
        pid: process.pid,
        label: "recovered unowned holder",
      });
      await expect(readFile(mutationSentinelPath, "utf8")).resolves.toBe("changed");
      await expect(pathExists(lockPath)).resolves.toBe(false);
    });
  });

  it("reclaims a stale lock with invalid metadata after the creation grace period", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-stale-invalid-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      const lockPath = resolve(repoRoot, LOCK_RELATIVE_PATH);
      const metadataPath = resolve(repoRoot, LOCK_METADATA_RELATIVE_PATH);
      const mutationSentinelPath = resolve(repoRoot, "mutation-sentinel.txt");
      await mkdir(lockPath, { recursive: true });
      await writeFile(metadataPath, "{", "utf8");
      await ageLockPath(metadataPath);
      await ageLockPath(lockPath);
      await writeFile(mutationSentinelPath, "unchanged", "utf8");
      let callbackRan = false;

      // Act
      const observedMetadata = await withIngestLock(
        repoRoot,
        { label: "recovered invalid holder", retryDelayMs: 5, timeoutMs: 20 },
        async () => {
          callbackRan = true;
          await writeFile(mutationSentinelPath, "changed", "utf8");

          return readLockMetadata(repoRoot);
        },
      );

      // Assert
      expect(callbackRan).toBe(true);
      expect(observedMetadata).toMatchObject({
        pid: process.pid,
        label: "recovered invalid holder",
      });
      await expect(readFile(mutationSentinelPath, "utf8")).resolves.toBe("changed");
      await expect(pathExists(lockPath)).resolves.toBe(false);
    });
  });

  it("releases the lock when the callback throws", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-throw-", async (workspaceDir) => {
      // Arrange
      const repoRoot = resolve(workspaceDir, "wiki");
      await mkdir(repoRoot, { recursive: true });
      const failure = new Error("agent proposal failed");

      // Act
      const result = withIngestLock(repoRoot, { label: "failing ingest" }, async () => {
        throw failure;
      });

      // Assert
      await expect(result).rejects.toBe(failure);
      await expect(pathExists(resolve(repoRoot, LOCK_RELATIVE_PATH))).resolves.toBe(false);
      await expect(withIngestLock(repoRoot, { label: "retry" }, async () => "retry ok")).resolves.toBe("retry ok");
    });
  });

  it("allows different repository roots to hold independent ingest locks", async () => {
    await withTempWorkspace("llm-wiki-ingest-lock-independent-", async (workspaceDir) => {
      // Arrange
      const firstRepoRoot = resolve(workspaceDir, "first-wiki");
      const secondRepoRoot = resolve(workspaceDir, "second-wiki");
      await mkdir(firstRepoRoot, { recursive: true });
      await mkdir(secondRepoRoot, { recursive: true });
      const releaseFirstLock = createDeferred();
      const firstLockStarted = createDeferred();
      const firstLock = withIngestLock(firstRepoRoot, { label: "first repo" }, async () => {
        firstLockStarted.resolve();
        await releaseFirstLock.promise;
      });
      await firstLockStarted.promise;

      // Act
      const secondResult = await withIngestLock(secondRepoRoot, { label: "second repo" }, async () =>
        readLockMetadata(secondRepoRoot),
      );

      // Assert
      expect(secondResult).toMatchObject({
        pid: process.pid,
        label: "second repo",
      });
      await expect(pathExists(resolve(firstRepoRoot, LOCK_RELATIVE_PATH))).resolves.toBe(true);
      await expect(pathExists(resolve(secondRepoRoot, LOCK_RELATIVE_PATH))).resolves.toBe(false);
      releaseFirstLock.resolve();
      await expect(firstLock).resolves.toBeUndefined();
    });
  });
});
