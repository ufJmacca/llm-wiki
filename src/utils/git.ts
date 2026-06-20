import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const INITIAL_COMMIT_MESSAGE = "chore: initialize llm-wiki";
export const SNAPSHOT_COMMIT_MESSAGE = "chore: snapshot llm-wiki state";

export const FALLBACK_GIT_IDENTITY = {
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

const DEFAULT_GIT_BRANCH_BASE_CANDIDATES = [
  "main",
  "master",
  "trunk",
  "develop",
  "origin/main",
  "origin/master",
  "origin/trunk",
  "origin/develop",
  "upstream/main",
  "upstream/master",
];

const GIT_INGEST_BASE_CONFIG_KEYS = ["llm-wiki.ingestBase", "llm-wiki.ingestBaseBranch"];

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

export type GitBranchResult = {
  enabled: boolean;
  branchName: string;
  recommendedCommand: string | null;
  created: boolean;
  error: string | null;
};

export type GitChangedFilesResult = {
  enabled: boolean;
  paths: string[];
  error: string | null;
  committedPathsIncomplete: boolean;
};

export type GitCommandError = {
  command: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  message: string;
  manual_next_steps: string[];
};

export type GitState = {
  enabled: boolean | null;
  repository: boolean;
  branch: string | null;
  head: string | null;
  dirty: boolean | null;
  errors: GitCommandError[];
};

export type GitSnapshotResult = {
  commit_sha: string;
  git: GitState;
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

export async function readGitState(repoRoot: string, enabled: boolean): Promise<GitState> {
  const repository = await hasGitRepositoryMetadata(repoRoot);
  const baseState: GitState = {
    enabled,
    repository,
    branch: null,
    head: null,
    dirty: null,
    errors: [],
  };

  if (!enabled && !repository) {
    return baseState;
  }

  if (!repository) {
    return {
      ...baseState,
      errors: [
        gitConfigurationError(repoRoot, "Git is enabled for this wiki, but no .git repository was found."),
      ],
    };
  }

  const insideWorkTree = await runGitForStatus(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree.ok) {
    return {
      ...baseState,
      errors: [insideWorkTree.error],
    };
  }

  const branch = await runGitForStatus(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await runGitForStatus(repoRoot, ["rev-parse", "--short", "HEAD"]);
  const dirty = await runGitForStatus(repoRoot, ["status", "--porcelain"]);
  const errors = [branch, head, dirty].flatMap((result) => (result.ok ? [] : [result.error]));

  return {
    enabled,
    repository,
    branch: branch.ok ? emptyToNull(branch.value.stdout.trim()) : null,
    head: head.ok ? emptyToNull(head.value.stdout.trim()) : null,
    dirty: dirty.ok ? dirty.value.stdout.trim().length > 0 : null,
    errors,
  };
}

export async function createGitSnapshotCommit(repoRoot: string, enabled: boolean): Promise<GitSnapshotResult> {
  await assertSnapshotGitReady(repoRoot, enabled);
  await runGitOrThrow(repoRoot, ["add", "--all"]);

  try {
    await runGitOrThrow(repoRoot, ["commit", "--allow-empty", "-m", SNAPSHOT_COMMIT_MESSAGE]);
  } catch (error) {
    if (!isMissingGitIdentityError(error)) {
      throw error;
    }

    await runGitOrThrow(repoRoot, ["commit", "--allow-empty", "-m", SNAPSHOT_COMMIT_MESSAGE], FALLBACK_GIT_IDENTITY);
  }

  const commitSha = await runGitOrThrow(repoRoot, ["rev-parse", "--short", "HEAD"]);
  const git = await readGitState(repoRoot, true);

  return {
    commit_sha: commitSha.stdout.trim(),
    git,
  };
}

async function assertSnapshotGitReady(repoRoot: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    throw snapshotGitConfigurationError(
      repoRoot,
      "Git is disabled for this wiki because .llm-wiki/config.yml does not enable features.git.",
      [
        formatCdCommand(repoRoot),
        "Edit .llm-wiki/config.yml and set features.git: true.",
        "git init",
      ],
    );
  }

  if (!(await hasGitRepositoryMetadata(repoRoot))) {
    throw snapshotGitConfigurationError(
      repoRoot,
      "Git is enabled for this wiki, but no wiki-local .git repository was found.",
      [
        formatCdCommand(repoRoot),
        "git init",
      ],
    );
  }
}

function snapshotGitConfigurationError(
  repoRoot: string,
  message: string,
  manualNextSteps: string[],
): GitCommandError {
  return {
    command: "snapshot git preflight",
    exit_code: null,
    stdout: "",
    stderr: message,
    message,
    manual_next_steps: manualNextSteps.length > 0 ? manualNextSteps : manualGitRecoverySteps(repoRoot),
  };
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

export async function isGitRepositoryEnabled(targetDir: string): Promise<boolean> {
  try {
    await lstat(resolve(targetDir, ".git"));
    return true;
  } catch {
    return false;
  }
}

export function ingestBranchName(sourceId: string): string {
  return `ingest/${sourceId}`;
}

export function recommendBranchCommand(branchName: string): string {
  return `git switch -c ${branchName}`;
}

export async function prepareIngestBranch(
  targetDir: string,
  sourceId: string,
  options: { create: boolean },
): Promise<GitBranchResult> {
  const enabled = await isGitRepositoryEnabled(targetDir);
  const branchName = ingestBranchName(sourceId);

  if (!enabled) {
    return {
      enabled: false,
      branchName,
      recommendedCommand: null,
      created: false,
      error: null,
    };
  }

  if (!options.create) {
    return {
      enabled: true,
      branchName,
      recommendedCommand: recommendBranchCommand(branchName),
      created: false,
      error: null,
    };
  }

  try {
    await runGit(targetDir, ["switch", "-c", branchName], "git switch");
    return {
      enabled: true,
      branchName,
      recommendedCommand: null,
      created: true,
      error: null,
    };
  } catch (error) {
    if (await gitBranchExists(targetDir, branchName)) {
      try {
        await runGit(targetDir, ["switch", branchName], "git switch");
        return {
          enabled: true,
          branchName,
          recommendedCommand: null,
          created: false,
          error: null,
        };
      } catch (switchError) {
        return {
          enabled: true,
          branchName,
          recommendedCommand: null,
          created: false,
          error: switchError instanceof Error ? switchError.message : String(switchError),
        };
      }
    }

    return {
      enabled: true,
      branchName,
      recommendedCommand: recommendBranchCommand(branchName),
      created: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function gitBranchExists(targetDir: string, branchName: string): Promise<boolean> {
  try {
    await runGit(targetDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], "git show-ref");
    return true;
  } catch {
    return false;
  }
}

export async function listGitChangedFiles(
  targetDir: string,
  pathspecs: readonly string[] = [],
): Promise<GitChangedFilesResult> {
  const enabled = await isGitRepositoryEnabled(targetDir);
  if (!enabled) {
    return {
      enabled: false,
      paths: [],
      error: null,
      committedPathsIncomplete: false,
    };
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...pathspecs],
      {
        cwd: targetDir,
        env: gitCommandEnv(),
      },
    );
    const statusPaths = parseGitStatusChangedPaths(stdout);
    const baseChanges = await listGitBranchBaseChangedFiles(targetDir, pathspecs);

    return {
      enabled: true,
      paths: [...new Set([...statusPaths, ...baseChanges.paths])].sort(),
      error: statusPaths.length === 0 ? baseChanges.error : null,
      committedPathsIncomplete: baseChanges.error !== null,
    };
  } catch (error) {
    return {
      enabled: true,
      paths: [],
      error: `git status failed: ${formatGitError(error)}`,
      committedPathsIncomplete: true,
    };
  }
}

async function listGitBranchBaseChangedFiles(
  targetDir: string,
  pathspecs: readonly string[],
): Promise<{ paths: string[]; error: string | null }> {
  try {
    const branchBase = await findGitBranchBase(targetDir);
    if (branchBase === null) {
      return {
        paths: [],
        error:
          "Git branch base could not be identified; validate from an ingest branch based on a repository base branch or configure llm-wiki.ingestBaseBranch.",
      };
    }

    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--name-only", `${branchBase}...HEAD`, "--", ...pathspecs],
      {
        cwd: targetDir,
        env: gitCommandEnv(),
      },
    );

    return { paths: parseGitNameOnlyPaths(stdout), error: null };
  } catch (error) {
    return {
      paths: [],
      error: `git diff against branch base failed: ${formatGitError(error)}`,
    };
  }
}

async function findGitBranchBase(targetDir: string): Promise<string | null> {
  const head = await gitStdout(targetDir, ["rev-parse", "--verify", "HEAD"]);
  if (head === null) {
    return null;
  }

  const currentBranch = await gitStdout(targetDir, ["branch", "--show-current"]);
  for (const ref of await gitBranchBaseCandidates(targetDir, currentBranch)) {
    const refCommit = await gitStdout(targetDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (refCommit === null) {
      continue;
    }

    const mergeBase = await gitStdout(targetDir, ["merge-base", "HEAD", ref]);
    if (mergeBase !== null) {
      return mergeBase;
    }
  }

  return null;
}

async function gitBranchBaseCandidates(targetDir: string, currentBranch: string | null): Promise<string[]> {
  const remotes = await gitRemoteNames(targetDir);
  const configuredBases = await gitConfiguredIngestBases(targetDir);
  const remoteDefaults = await gitRemoteDefaultBranchRefs(targetDir, remotes);
  const currentUpstream = await gitCurrentUpstreamBase(targetDir);
  const configuredDefaultBranches = await gitConfiguredDefaultBranchRefs(targetDir, remotes);
  const branchRefs = await gitBranchRefs(targetDir);
  const candidates: string[] = [];

  for (const ref of configuredBases) {
    if (!isCurrentGitBranchRef(ref, currentBranch, remotes)) {
      candidates.push(ref);
    }
  }

  for (const ref of [
    ...remoteDefaults,
    ...currentUpstream,
    ...configuredDefaultBranches,
    ...DEFAULT_GIT_BRANCH_BASE_CANDIDATES,
    ...branchRefs,
  ]) {
    if (isCurrentGitBranchRef(ref, currentBranch, remotes) || isIngestBranchRef(ref, remotes)) {
      continue;
    }

    candidates.push(ref);
  }

  return [...new Set(candidates)];
}

async function gitConfiguredIngestBases(targetDir: string): Promise<string[]> {
  const refs: string[] = [];

  for (const key of GIT_INGEST_BASE_CONFIG_KEYS) {
    const value = await gitStdout(targetDir, ["config", "--get", key]);
    if (value !== null) {
      refs.push(...value.split(",").map((ref) => ref.trim()));
    }
  }

  return refs.filter((ref) => ref !== "");
}

async function gitRemoteNames(targetDir: string): Promise<string[]> {
  const stdout = await gitStdout(targetDir, ["remote"]);
  return parseGitLines(stdout);
}

async function gitRemoteDefaultBranchRefs(targetDir: string, remotes: readonly string[]): Promise<string[]> {
  const refs: string[] = [];

  for (const remote of remotes) {
    const ref = await gitStdout(targetDir, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
    if (ref !== null) {
      refs.push(ref);
    }
  }

  return refs;
}

async function gitCurrentUpstreamBase(targetDir: string): Promise<string[]> {
  const upstream = await gitStdout(targetDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  return upstream === null ? [] : [upstream];
}

async function gitConfiguredDefaultBranchRefs(targetDir: string, remotes: readonly string[]): Promise<string[]> {
  const defaultBranch = await gitStdout(targetDir, ["config", "--get", "init.defaultBranch"]);
  if (defaultBranch === null) {
    return [];
  }

  return [defaultBranch, ...remotes.map((remote) => `${remote}/${defaultBranch}`)];
}

async function gitBranchRefs(targetDir: string): Promise<string[]> {
  const stdout = await gitStdout(targetDir, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  return parseGitLines(stdout).filter((ref) => !ref.endsWith("/HEAD"));
}

function parseGitLines(stdout: string | null): string[] {
  return stdout === null
    ? []
    : stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
}

function isCurrentGitBranchRef(ref: string, currentBranch: string | null, remotes: readonly string[]): boolean {
  if (currentBranch === null) {
    return false;
  }

  return ref === currentBranch || gitBranchNameFromRef(ref, remotes) === currentBranch;
}

function isIngestBranchRef(ref: string, remotes: readonly string[]): boolean {
  return gitBranchNameFromRef(ref, remotes).startsWith("ingest/");
}

function gitBranchNameFromRef(ref: string, remotes: readonly string[]): string {
  if (ref.startsWith("refs/heads/")) {
    return ref.slice("refs/heads/".length);
  }

  if (ref.startsWith("refs/remotes/")) {
    const remoteRef = ref.slice("refs/remotes/".length);
    const separator = remoteRef.indexOf("/");
    return separator === -1 ? remoteRef : remoteRef.slice(separator + 1);
  }

  for (const remote of remotes) {
    const remotePrefix = `${remote}/`;
    if (ref.startsWith(remotePrefix)) {
      return ref.slice(remotePrefix.length);
    }
  }

  return ref;
}

async function gitStdout(targetDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: targetDir,
      env: gitCommandEnv(),
    });
    const trimmed = stdout.trim();
    return trimmed === "" ? null : trimmed;
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

async function runGitOrThrow(
  targetDir: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await runGitDetailed(targetDir, args, extraEnv);
  if (!result.ok) {
    throw result.error;
  }

  return result.value;
}

async function runGitForStatus(
  targetDir: string,
  args: string[],
): Promise<{ ok: true; value: { stdout: string; stderr: string } } | { ok: false; error: GitCommandError }> {
  return runGitDetailed(targetDir, args);
}

async function runGitDetailed(
  targetDir: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ ok: true; value: { stdout: string; stderr: string } } | { ok: false; error: GitCommandError }> {
  try {
    const output = await execFileAsync("git", args, {
      cwd: targetDir,
      env: gitCommandEnv(extraEnv),
    });

    return {
      ok: true,
      value: {
        stdout: output.stdout,
        stderr: output.stderr,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: toGitCommandError(targetDir, args, error),
    };
  }
}

function gitCommandEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
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
  const message = isGitCommandError(error) ? error.message : error instanceof Error ? error.message : String(error);
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

function parseGitStatusChangedPaths(stdout: string): string[] {
  const paths = new Set<string>();
  const entries = stdout.split("\0");

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) {
      continue;
    }

    const status = entry.slice(0, 2);
    if (status === "!!") {
      continue;
    }

    const path = entry.slice(3);
    if (path !== "") {
      paths.add(path);
    }

    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }

  return [...paths].sort();
}

function parseGitNameOnlyPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path !== "")
    .sort();
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

async function hasGitRepositoryMetadata(repoRoot: string): Promise<boolean> {
  try {
    const gitPath = await lstat(`${repoRoot}/.git`);
    return gitPath.isDirectory() || gitPath.isFile();
  } catch (error) {
    if (isExecMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

function gitConfigurationError(repoRoot: string, message: string): GitCommandError {
  return {
    command: "git status --porcelain",
    exit_code: null,
    stdout: "",
    stderr: message,
    message,
    manual_next_steps: manualGitRecoverySteps(repoRoot),
  };
}

function toGitCommandError(targetDir: string, args: string[], error: unknown): GitCommandError {
  const stderr = execOutputToString(isExecError(error) ? error.stderr : undefined).trim();
  const stdout = execOutputToString(isExecError(error) ? error.stdout : undefined).trim();
  const message = (stderr || stdout || (error instanceof Error ? error.message : String(error))).replace(/\s+/g, " ").trim();

  return {
    command: formatGitCommand(args),
    exit_code: execExitCode(error),
    stdout,
    stderr,
    message,
    manual_next_steps: manualGitRecoverySteps(targetDir, args),
  };
}

function execExitCode(error: unknown): number | null {
  if (isExecError(error) && typeof error.code === "number") {
    return error.code;
  }

  return null;
}

function execOutputToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  return "";
}

function manualGitRecoverySteps(targetDir: string, args: readonly string[] = ["status"]): string[] {
  return [formatCdCommand(targetDir), formatGitCommand(args)];
}

function formatGitCommand(args: readonly string[]): string {
  return `git ${args.map(shellQuoteIfNeeded).join(" ")}`;
}

function shellQuoteIfNeeded(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : shellQuote(value);
}

function emptyToNull(value: string): string | null {
  return value === "" ? null : value;
}

function isGitCommandError(error: unknown): error is GitCommandError {
  return typeof error === "object" && error !== null && "command" in error && "manual_next_steps" in error;
}

function isExecMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
