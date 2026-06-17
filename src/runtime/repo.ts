import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { err, ok, type Result } from "../utils/result.js";

export const WIKI_CONFIG_RELATIVE_PATH = ".llm-wiki/config.yml";

export type WikiRoot = {
  rootDir: string;
  configPath: string;
};

export type WikiRootErrorCode =
  | "REPO_PATH_NOT_FOUND"
  | "REPO_PATH_NOT_DIRECTORY"
  | "WIKI_CONFIG_NOT_FILE"
  | "WIKI_ROOT_NOT_FOUND";

export type WikiRootError = {
  code: WikiRootErrorCode;
  message: string;
  startPath: string;
  hint: string;
};

export type ResolveWikiRootOptions = {
  cwd?: string;
  repoPath?: string;
};

export async function resolveWikiRoot(
  options: ResolveWikiRootOptions = {},
): Promise<Result<WikiRoot, WikiRootError>> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const startPath = resolve(cwd, options.repoPath ?? ".");

  if (options.repoPath !== undefined) {
    const repoPathStatus = await validateExplicitRepoPath(startPath);
    if (!repoPathStatus.ok) {
      return repoPathStatus;
    }
  }

  return findWikiRoot(startPath);
}

async function validateExplicitRepoPath(path: string): Promise<Result<void, WikiRootError>> {
  try {
    const pathStat = await stat(path);
    if (!pathStat.isDirectory()) {
      return err({
        code: "REPO_PATH_NOT_DIRECTORY",
        message: `Repo path is not a directory: ${path}`,
        startPath: path,
        hint: "Pass --repo <path> to an existing wiki directory or one of its descendants.",
      });
    }
  } catch (error) {
    if (isNodeError(error) && isMissingRepoPathError(error.code)) {
      return err({
        code: "REPO_PATH_NOT_FOUND",
        message: `Repo path does not exist: ${path}`,
        startPath: path,
        hint: "Pass --repo <path> to an existing wiki directory or one of its descendants.",
      });
    }

    throw error;
  }

  return ok(undefined);
}

async function findWikiRoot(startPath: string): Promise<Result<WikiRoot, WikiRootError>> {
  let currentPath = startPath;

  while (true) {
    const configPath = resolve(currentPath, WIKI_CONFIG_RELATIVE_PATH);
    const configStatus = await getConfigMarkerStatus(configPath);
    if (configStatus === "file") {
      return ok({ rootDir: currentPath, configPath });
    }
    if (configStatus === "not_file") {
      return err({
        code: "WIKI_CONFIG_NOT_FILE",
        message: `Wiki config marker is not a regular file: ${configPath}`,
        startPath: configPath,
        hint: "Replace .llm-wiki/config.yml with the YAML config file created by llm-wiki init.",
      });
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return err({
        code: "WIKI_ROOT_NOT_FOUND",
        message: `Could not find .llm-wiki/config.yml from ${startPath}`,
        startPath,
        hint: "Run llm-wiki init <dir> first, or pass --repo <path> inside an existing wiki.",
      });
    }

    currentPath = parentPath;
  }
}

async function getConfigMarkerStatus(path: string): Promise<"file" | "not_file" | "missing"> {
  try {
    const pathStat = await stat(path);
    return pathStat.isFile() ? "file" : "not_file";
  } catch (error) {
    if (isNodeError(error) && isMissingRepoPathError(error.code)) {
      return "missing";
    }

    throw error;
  }
}

function isMissingRepoPathError(code: string | undefined): boolean {
  return code === "ENOENT" || code === "ENOTDIR";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
