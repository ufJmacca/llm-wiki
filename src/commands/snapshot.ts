import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import { lintWiki, type LintIssue, type LintResult } from "../lint/index.js";
import { addRuntimeOptions, type RawRuntimeCommandOptions, type RuntimeCommandOptions } from "../runtime/command.js";
import { readWikiGitConfig, type WikiConfigIssue } from "../runtime/config.js";
import { buildRuntimeFailureEnvelope, buildRuntimeSuccessEnvelope } from "../runtime/envelope.js";
import { resolveWikiRoot } from "../runtime/repo.js";
import {
  createGitSnapshotCommit,
  SNAPSHOT_COMMIT_MESSAGE,
  type GitCommandError,
  type GitSnapshotResult,
} from "../utils/git.js";

type SnapshotData = {
  status: "committed";
  commit_message: typeof SNAPSHOT_COMMIT_MESSAGE;
  commit_sha: string;
  lint: {
    counts: LintResult["counts"];
  };
  git: GitSnapshotResult["git"];
};

export function registerSnapshotCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("snapshot")
      .description("Commit the current wiki state after lint passes"),
  ).action(async (rawOptions: RawRuntimeCommandOptions) => {
    await runSnapshotCommand(rawOptions, io);
  });
}

async function runSnapshotCommand(rawOptions: RawRuntimeCommandOptions, io: CliIo): Promise<void> {
  const options = normalizeOptions(rawOptions);
  const resolvedRepo = await resolveWikiRoot({ repoPath: options.repo });

  if (!resolvedRepo.ok) {
    const envelope = buildRuntimeFailureEnvelope("snapshot", resolvedRepo.error);
    if (options.json) {
      io.stdout(JSON.stringify(envelope));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.snapshot", envelope.error.message);
  }

  const repoRoot = resolvedRepo.value.rootDir;
  const gitConfig = await readWikiGitConfig(repoRoot);
  if (!gitConfig.ok) {
    throwSnapshotConfigFailure(io, repoRoot, gitConfig.error, options);
  }

  let lint: LintResult;
  try {
    lint = await lintWiki(repoRoot);
  } catch (error) {
    throwSnapshotLintScanFailure(io, repoRoot, error, options);
  }

  if (lint.counts.error > 0) {
    throwSnapshotLintFailure(io, repoRoot, lint, options);
  }

  let snapshot: GitSnapshotResult;
  try {
    snapshot = await createGitSnapshotCommit(repoRoot, gitConfig.value.gitEnabled);
  } catch (error) {
    throwSnapshotGitFailure(io, repoRoot, error, options);
  }

  const data: SnapshotData = {
    status: "committed",
    commit_message: SNAPSHOT_COMMIT_MESSAGE,
    commit_sha: snapshot.commit_sha,
    lint: {
      counts: lint.counts,
    },
    git: snapshot.git,
  };
  const envelope = buildRuntimeSuccessEnvelope("snapshot", repoRoot, data, []);

  if (options.json) {
    io.stdout(JSON.stringify(envelope));
    return;
  }

  if (!options.quiet) {
    io.stdout(formatHumanSnapshot(data));
  }
}

function normalizeOptions(rawOptions: RawRuntimeCommandOptions): RuntimeCommandOptions {
  return {
    repo: typeof rawOptions.repo === "string" ? rawOptions.repo : undefined,
    json: rawOptions.json === true,
    quiet: rawOptions.quiet === true,
  };
}

function throwSnapshotLintFailure(
  io: CliIo,
  repoRoot: string,
  lint: LintResult,
  options: RuntimeCommandOptions,
): never {
  const envelope = {
    ok: false,
    command: "snapshot" as const,
    repo: repoRoot,
    error: {
      code: "SNAPSHOT_LINT_FAILED",
      message: `Snapshot refused because lint found ${lint.counts.error} error${lint.counts.error === 1 ? "" : "s"}.`,
      hint: "Fix critical lint errors before committing a snapshot.",
    },
    issues: lint.issues.filter((issue) => issue.severity === "error"),
  };

  if (options.json) {
    io.stdout(JSON.stringify(envelope));
  } else {
    io.stderr(`Error: ${envelope.error.message}`);
    if (!options.quiet) {
      io.stdout(formatLintIssues(envelope.issues));
    }
  }

  throw new CommanderError(1, "llm-wiki.snapshot", envelope.error.message);
}

function throwSnapshotConfigFailure(
  io: CliIo,
  repoRoot: string,
  issue: WikiConfigIssue,
  options: RuntimeCommandOptions,
): never {
  const message = `Snapshot refused because ${issue.message}`;
  const envelope = {
    ok: false,
    command: "snapshot" as const,
    repo: repoRoot,
    error: {
      code: "SNAPSHOT_CONFIG_FAILED",
      message,
      hint: issue.hint,
    },
    issues: [
      {
        ...issue,
        message,
      },
    ],
  };

  if (options.json) {
    io.stdout(JSON.stringify(envelope));
  } else {
    io.stderr(`Error: ${envelope.error.message}`);
    if (!options.quiet) {
      io.stderr(issue.hint);
    }
  }

  throw new CommanderError(1, "llm-wiki.snapshot", envelope.error.message);
}

function throwSnapshotLintScanFailure(
  io: CliIo,
  repoRoot: string,
  error: unknown,
  options: RuntimeCommandOptions,
): never {
  const detail = error instanceof Error ? error.message : String(error);
  const message = "Snapshot refused because lint failed while scanning repository.";
  const envelope = {
    ok: false,
    command: "snapshot" as const,
    repo: repoRoot,
    error: {
      code: "SNAPSHOT_LINT_FAILED",
      message,
      hint: "Fix unreadable or invalid wiki files before committing a snapshot.",
    },
    issues: [
      {
        rule_id: "lint_scan_failed",
        severity: "error" as const,
        path: ".",
        message: `${message} ${detail}`,
        fix_hint: "Fix unreadable Markdown, JSON, or profile files before rerunning snapshot.",
        fixable: false,
      },
    ],
  };

  if (options.json) {
    io.stdout(JSON.stringify(envelope));
  } else {
    io.stderr(`Error: ${envelope.error.message}`);
    if (!options.quiet) {
      io.stderr(envelope.issues[0]?.message ?? message);
    }
  }

  throw new CommanderError(1, "llm-wiki.snapshot", envelope.error.message);
}

function throwSnapshotGitFailure(
  io: CliIo,
  repoRoot: string,
  error: unknown,
  options: RuntimeCommandOptions,
): never {
  const gitError = normalizeGitError(repoRoot, error);
  const message = `${gitError.command} failed: ${gitError.message}`;
  const envelope = {
    ok: false,
    command: "snapshot" as const,
    repo: repoRoot,
    error: {
      code: "SNAPSHOT_GIT_FAILED",
      message,
      hint: "Run the manual Git commands after resolving the reported Git error.",
      git: gitError,
    },
    issues: [
      {
        severity: "error" as const,
        code: "SNAPSHOT_GIT_FAILED",
        message,
        path: ".git",
        hint: "Inspect the Git repository state, then rerun llm-wiki snapshot.",
        command: gitError.command,
        exit_code: gitError.exit_code,
        stderr: gitError.stderr,
        manual_next_steps: [
          ...gitError.manual_next_steps,
          "git status",
          "git add --all",
          `git commit --allow-empty -m ${JSON.stringify(SNAPSHOT_COMMIT_MESSAGE)}`,
        ],
      },
    ],
  };

  if (options.json) {
    io.stdout(JSON.stringify(envelope));
  } else {
    io.stderr(`Error: ${message}`);
    if (!options.quiet) {
      io.stdout(["Manual next steps:", ...envelope.issues[0].manual_next_steps.map((step) => `  ${step}`)].join("\n"));
    }
  }

  throw new CommanderError(1, "llm-wiki.snapshot", message);
}

function normalizeGitError(repoRoot: string, error: unknown): GitCommandError {
  if (isGitCommandError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    command: "git status",
    exit_code: null,
    stdout: "",
    stderr: message,
    message,
    manual_next_steps: [`cd ${JSON.stringify(repoRoot)}`, "git status"],
  };
}

function isGitCommandError(error: unknown): error is GitCommandError {
  return typeof error === "object" && error !== null && "command" in error && "manual_next_steps" in error;
}

function formatHumanSnapshot(data: SnapshotData): string {
  return [
    "Snapshot committed",
    `Commit: ${data.commit_sha}`,
    `Message: ${data.commit_message}`,
    `Branch: ${data.git.branch ?? "(unknown)"}`,
    `Dirty: ${data.git.dirty === null ? "unknown" : data.git.dirty ? "yes" : "no"}`,
  ].join("\n");
}

function formatLintIssues(issues: LintIssue[]): string {
  return issues
    .map((issue) => `${issue.severity.toUpperCase()} ${issue.rule_id} ${issue.path}: ${issue.message}`)
    .join("\n");
}
