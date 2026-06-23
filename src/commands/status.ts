import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import {
  addRuntimeOptions,
  runRuntimeCommand,
  type RawRuntimeCommandOptions,
  type RuntimeCommandOptions,
} from "../runtime/command.js";
import { getWikiStatus, type StatusData } from "../runtime/status.js";

export function registerStatusCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("status")
      .description("Report runtime readiness for an existing LLM Wiki workspace"),
  ).action(async (rawOptions: RawRuntimeCommandOptions) => {
    await runRuntimeCommand({
      command: "status",
      rawOptions,
      io,
      run: async ({ repo, options }) => {
        try {
          return {
            data: await getWikiStatus(repo.rootDir),
          };
        } catch (error) {
          throwStatusScanError(io, repo.rootDir, error, options);
        }
      },
      formatHuman: (envelope) => formatHumanStatus(envelope.repo, envelope.data),
    });
  });
}

function throwStatusScanError(io: CliIo, repoRoot: string, error: unknown, options: RuntimeCommandOptions): never {
  const detail = error instanceof Error ? error.message : String(error);
  const message = "Status failed while scanning repository.";
  const envelope = {
    ok: false,
    command: "status" as const,
    repo: repoRoot,
    error: {
      code: "status_failed" as const,
      message,
      hint: "Fix unreadable or invalid wiki files, then rerun llm-wiki status.",
    },
    issues: [
      {
        severity: "error" as const,
        code: "status_scan_failed",
        message: `${message} ${detail}`,
        path: ".",
        hint: "Fix unreadable Markdown, JSON, profile, or runtime files before rerunning status.",
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

  throw new CommanderError(1, "llm-wiki.status", envelope.error.message);
}

function formatHumanStatus(repo: string, data: StatusData): string {
  return [
    "LLM Wiki status",
    `Repo: ${repo}`,
    `Config: ${formatConfigStatus(data)}`,
    ...formatConfigErrorLines(data),
    `Default agent: ${data.agents.default ?? "none"}`,
    `Local agents: ${formatNamedCount(data.agents.local.count, data.agents.local.names)}`,
    ...formatCodexAvailabilityLines(data),
    `HTTP providers: ${formatNamedCount(data.providers.count, data.providers.names)}`,
    `--auto: ${formatAutoReadiness(data)}`,
    `Health: ${data.health.state}`,
    `Lint: ${data.lint.counts.error} errors, ${data.lint.counts.warning} warnings`,
    `Queue: ${data.queue.counts.total} total, ${data.queue.counts.queued} queued, ${data.queue.counts.ingesting} ingesting, ${data.queue.counts.ingested} ingested, ${data.queue.counts.blocked} blocked`,
    `Git: ${formatGitStatus(data)}`,
    `Profiles: ${data.profiles.valid}/${data.profiles.total} valid`,
    `Explorer: ${data.explorer.ready ? "ready" : data.explorer.initialized ? "initialized" : "not initialized"}`,
  ].join("\n");
}

function formatConfigErrorLines(data: StatusData): string[] {
  return data.config.errors.map((error) => `Config error: ${error.message}`);
}

function formatConfigStatus(data: StatusData): string {
  if (data.config.valid) {
    return data.config.git_enabled ? "valid, Git enabled" : "valid, Git disabled";
  }

  return `${data.config.errors.length} config error(s)`;
}

function formatNamedCount(count: number, names: string[]): string {
  if (count === 0) {
    return "none";
  }

  return `${count} (${names.join(", ")})`;
}

function formatCodexAvailabilityLines(data: StatusData): string[] {
  const codex = data.agents.local.items.find((agent) => agent.name === "codex");
  if (codex === undefined) {
    return [];
  }

  if (codex.available) {
    return ["Codex executable: available"];
  }

  return [`Codex executable: unavailable (${codex.availability_error?.message ?? "command unavailable"})`];
}

function formatAutoReadiness(data: StatusData): string {
  if (data.auto.can_run) {
    return `ready (${data.auto.agent})`;
  }

  return `blocked (${data.auto.reason ?? "default local agent is not ready"})`;
}

function formatGitStatus(data: StatusData): string {
  if (data.git.enabled === null) {
    return "unknown until config is fixed";
  }

  if (!data.git.enabled && !data.git.repository) {
    return "disabled";
  }

  const state = [
    data.git.branch === null ? "branch unknown" : `branch ${data.git.branch}`,
    data.git.head === null ? "head unknown" : `head ${data.git.head}`,
    data.git.dirty === null ? "dirty unknown" : data.git.dirty ? "dirty" : "clean",
  ].join(", ");

  return data.git.errors.length === 0 ? state : `${state}, ${data.git.errors.length} git error(s)`;
}
