import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import {
  addRuntimeOptions,
  type RawRuntimeCommandOptions,
  type RuntimeCommandOptions,
} from "../runtime/command.js";
import { buildRuntimeFailureEnvelope, buildRuntimeSuccessEnvelope } from "../runtime/envelope.js";
import { resolveWikiRoot } from "../runtime/repo.js";
import { lintWiki, lintWikiWithFix, type LintIssue, type LintResult } from "../lint/index.js";

type RawLintOptions = RawRuntimeCommandOptions & {
  fix?: unknown;
  profile?: unknown;
  strict?: unknown;
};

type LintData = {
  issues: LintIssue[];
  counts: LintResult["counts"];
  fixed_paths: string[];
};

export function registerLintCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("lint")
      .description("Validate wiki source, queue, curated, profile, and link integrity")
      .option("--fix", "apply deterministic safe fixes", false)
      .option("--profile <profile>", "profile name for profile-specific safety checks")
      .option("--strict", "enable strict profile safety checks", false),
  ).action(async (rawOptions: RawLintOptions) => {
    await runLintCommand(rawOptions, io);
  });
}

async function runLintCommand(rawOptions: RawLintOptions, io: CliIo): Promise<void> {
  const options = normalizeOptions(rawOptions);
  const resolvedRepo = await resolveWikiRoot({ repoPath: options.repo });

  if (!resolvedRepo.ok) {
    const envelope = buildRuntimeFailureEnvelope("lint", resolvedRepo.error);
    if (options.json) {
      io.stdout(JSON.stringify(envelope));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.lint", envelope.error.message);
  }

  let result: LintResult;
  try {
    result = rawOptions.fix === true
      ? await lintWikiWithFix(resolvedRepo.value.rootDir, {
          profile: typeof rawOptions.profile === "string" ? rawOptions.profile : undefined,
          strict: rawOptions.strict === true,
        })
      : await lintWiki(resolvedRepo.value.rootDir, {
          profile: typeof rawOptions.profile === "string" ? rawOptions.profile : undefined,
          strict: rawOptions.strict === true,
        });
  } catch (error) {
    throwLintScanError(io, resolvedRepo.value.rootDir, error, options);
  }

  const data: LintData = {
    issues: result.issues,
    counts: result.counts,
    fixed_paths: result.fixed_paths,
  };

  if (result.counts.error > 0) {
    const envelope = {
      ok: false,
      command: "lint" as const,
      repo: resolvedRepo.value.rootDir,
      error: {
        code: "lint_failed" as const,
        message: formatFailureMessage(result.counts),
        hint: "Fix error-severity lint issues, or rerun with --fix for deterministic safe repairs.",
      },
      issues: result.issues,
    };

    if (options.json) {
      io.stdout(JSON.stringify(envelope));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
      if (!options.quiet) {
        io.stdout(formatHumanIssues(result));
      }
    }

    throw new CommanderError(1, "llm-wiki.lint", envelope.error.message);
  }

  const envelope = buildRuntimeSuccessEnvelope("lint", resolvedRepo.value.rootDir, data, []);
  if (options.json) {
    io.stdout(JSON.stringify(envelope));
    return;
  }

  if (!options.quiet) {
    io.stdout(formatHumanIssues(result));
  }
}

function normalizeOptions(rawOptions: RawLintOptions): RuntimeCommandOptions {
  return {
    repo: typeof rawOptions.repo === "string" ? rawOptions.repo : undefined,
    json: rawOptions.json === true,
    quiet: rawOptions.quiet === true,
  };
}

function formatFailureMessage(counts: LintResult["counts"]): string {
  const issueText = `${counts.error} error${counts.error === 1 ? "" : "s"}`;
  const warningText = `${counts.warning} warning${counts.warning === 1 ? "" : "s"}`;

  return `Lint found ${issueText} and ${warningText}.`;
}

function throwLintScanError(io: CliIo, repoRoot: string, error: unknown, options: RuntimeCommandOptions): never {
  const detail = error instanceof Error ? error.message : String(error);
  const message = "Lint failed while scanning repository.";
  const envelope = {
    ok: false,
    command: "lint" as const,
    repo: repoRoot,
    error: {
      code: "lint_failed" as const,
      message,
      hint: "Fix unreadable or invalid wiki files, then rerun llm-wiki lint.",
    },
    issues: [
      {
        rule_id: "lint_scan_failed",
        severity: "error" as const,
        path: ".",
        message: `${message} ${detail}`,
        fix_hint: "Fix unreadable Markdown, JSON, or profile files before rerunning lint.",
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

  throw new CommanderError(1, "llm-wiki.lint", envelope.error.message);
}

function formatHumanIssues(result: LintResult): string {
  const lines = [
    `Lint issues: ${result.counts.total}`,
    `Counts: ${result.counts.error} errors, ${result.counts.warning} warnings, ${result.counts.fixed} fixed`,
  ];

  for (const issue of result.issues) {
    lines.push(
      "",
      `${issue.severity.toUpperCase()} ${issue.rule_id}`,
      `Path: ${issue.path}${issue.line === undefined ? "" : `:${issue.line}`}`,
      issue.message,
      `Fix: ${issue.fix_hint}`,
    );
  }

  return lines.join("\n");
}
