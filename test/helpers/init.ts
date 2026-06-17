import { access, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

import { expect } from "vitest";
import { parse } from "yaml";

import { runCli } from "../../src/cli.js";
import type { CreateWikiOptions } from "../../src/scaffold/createWiki.js";

export const defaultCreateWikiOptions: CreateWikiOptions = {
  agent: "generic",
  obsidian: false,
  dataview: false,
  git: true,
  quartzReady: false,
  force: false,
};

export type InitJson = {
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

export type CliResult = {
  exitCode: number;
  stderr: string[];
  stdout: string[];
};

export type RunCliBufferedOptions = {
  stdin?: string | (() => Promise<string>);
};

export async function withTempWorkspace<T>(
  prefix: string,
  run: (workspaceDir: string) => Promise<T>,
): Promise<T> {
  const workspaceDir = await mkdtemp(resolve(tmpdir(), prefix));

  try {
    return await run(workspaceDir);
  } finally {
    await rm(workspaceDir, { force: true, recursive: true });
  }
}

export async function runCliBuffered(args: string[], options: RunCliBufferedOptions = {}): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdinOption = options.stdin;
  const stdin =
    stdinOption === undefined ? undefined : typeof stdinOption === "function" ? stdinOption : async () => stdinOption;

  const exitCode = await runCli(args, {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    stdin,
  });

  return { exitCode, stderr, stdout };
}

export function parseInitJson(stdout: string[]): InitJson {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as InitJson;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readGeneratedFile(targetDir: string, path: string): Promise<string> {
  return readFile(resolve(targetDir, path), "utf8");
}

export async function readGeneratedYaml<T>(targetDir: string, path: string): Promise<T> {
  return parse(await readGeneratedFile(targetDir, path)) as T;
}

export async function readTreeSnapshot(
  rootDir: string,
  options: { exclude?: (relativePath: string) => boolean } = {},
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir);
    for (const entry of entries.sort()) {
      const absolutePath = resolve(dir, entry);
      const pathStat = await stat(absolutePath);
      const relativePath = relative(rootDir, absolutePath).replaceAll("\\", "/");

      if (options.exclude?.(relativePath)) {
        continue;
      }

      if (pathStat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      snapshot.set(relativePath, await readFile(absolutePath, "utf8"));
    }
  }

  await visit(rootDir);
  return snapshot;
}

export async function expectPathInsideSystemTemp(path: string): Promise<void> {
  const [realPath, realTempDir] = await Promise.all([realpath(path), realpath(tmpdir())]);
  const relativeToTemp = relative(realTempDir, realPath);

  expect(relativeToTemp).not.toBe("");
  expect(relativeToTemp.startsWith("..")).toBe(false);
}
