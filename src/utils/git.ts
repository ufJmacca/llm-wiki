import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const INITIAL_COMMIT_MESSAGE = "chore: initialize llm-wiki";

const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "llm-wiki",
  GIT_AUTHOR_EMAIL: "llm-wiki@example.invalid",
  GIT_COMMITTER_NAME: "llm-wiki",
  GIT_COMMITTER_EMAIL: "llm-wiki@example.invalid",
} satisfies NodeJS.ProcessEnv;

const REPOSITORY_SCOPING_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
];

export type GitInitResult = {
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

export async function initializeGitRepository(
  targetDir: string,
  enabled: boolean,
  stagedPaths: readonly string[] = [],
): Promise<GitInitResult> {
  const gitAddPaths = normalizeGitAddPaths(stagedPaths);
  const result: GitInitResult = {
    enabled,
    attempted: enabled,
    ok: true,
    initialized: false,
    staged: false,
    committed: false,
    commitMessage: INITIAL_COMMIT_MESSAGE,
    manualCommands: [],
    error: null,
  };

  if (!enabled) {
    return result;
  }

  try {
    await runGit(targetDir, ["init"], "git init");
    result.initialized = true;

    await runGit(targetDir, ["add", "--", ...gitAddPaths], "git add");
    result.staged = true;

    if (!(await hasStagedScaffoldChanges(targetDir, gitAddPaths))) {
      return result;
    }

    await commitInitialScaffold(targetDir, gitAddPaths);
    result.committed = true;

    return result;
  } catch (error) {
    return {
      ...result,
      ok: false,
      manualCommands: manualGitCommands(targetDir, gitAddPaths),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function manualGitCommands(targetDir: string, stagedPaths: readonly string[]): string[] {
  return [
    formatCdCommand(targetDir),
    "git init",
    `git add -- ${stagedPaths.map(shellQuote).join(" ")}`,
    `git commit -m "${INITIAL_COMMIT_MESSAGE}" -- ${stagedPaths.map(shellQuote).join(" ")}`,
  ];
}

export function formatCdCommand(targetDir: string): string {
  return `cd ${shellQuote(targetDir)}`;
}

export async function readGitRemoteUrl(targetDir: string, remoteName = "origin"): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", remoteName], {
      cwd: targetDir,
      env: gitCommandEnv(),
    });
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

export async function readGitTopLevel(targetDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: targetDir,
      env: gitCommandEnv(),
    });
    const value = stdout.trim();
    return value === "" ? null : resolve(value);
  } catch {
    return null;
  }
}

export async function readGitCurrentBranch(targetDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: targetDir,
      env: gitCommandEnv(),
    });
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

async function hasStagedScaffoldChanges(targetDir: string, stagedPaths: readonly string[]): Promise<boolean> {
  if (stagedPaths.length === 0) {
    return false;
  }

  try {
    await execFileAsync("git", ["diff", "--cached", "--quiet", "--", ...stagedPaths], {
      cwd: targetDir,
      env: gitCommandEnv(),
    });
    return false;
  } catch (error) {
    if (isExecError(error) && error.code === 1) {
      return true;
    }

    throw new Error(`git diff failed: ${formatGitError(error)}`);
  }
}

async function commitInitialScaffold(targetDir: string, stagedPaths: readonly string[]): Promise<void> {
  const args = ["commit", "-m", INITIAL_COMMIT_MESSAGE, "--", ...stagedPaths];

  try {
    await runGit(targetDir, args, "git commit");
  } catch (error) {
    if (!isMissingGitIdentityError(error)) {
      throw error;
    }

    await runGit(targetDir, args, "git commit", FALLBACK_GIT_IDENTITY);
  }
}

async function runGit(
  targetDir: string,
  args: string[],
  label: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  try {
    await execFileAsync("git", args, {
      cwd: targetDir,
      env: gitCommandEnv(extraEnv),
    });
  } catch (error) {
    throw new Error(`${label} failed: ${formatGitError(error)}`);
  }
}

export function gitCommandEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };

  for (const key of REPOSITORY_SCOPING_GIT_ENV) {
    delete env[key];
  }

  return {
    ...env,
    ...extraEnv,
  };
}

function isMissingGitIdentityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /author identity unknown|committer identity unknown|please tell me who you are|unable to auto-detect email address/i.test(
    message,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizeGitAddPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

function formatGitError(error: unknown): string {
  if (isExecError(error)) {
    if (error.code === "ENOENT") {
      return "Git executable was not found on PATH. Install Git or make `git` available on PATH.";
    }

    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const detail = stderr || stdout || error.message;
    return detail.replace(/\s+/g, " ").trim();
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isExecError(error: unknown): error is Error & { code?: unknown; stderr?: unknown; stdout?: unknown } {
  return error instanceof Error;
}
