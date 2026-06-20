import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import { readRuntimeLog, type RuntimeLogReadError, type RuntimeLogReadResult } from "../runtime/log.js";

export function registerLogCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("log")
      .description("Read parsed runtime entries from curated/log.md"),
  ).action(async (rawOptions: RawRuntimeCommandOptions) => {
    await runRuntimeCommand({
      command: "log",
      rawOptions,
      io,
      run: async ({ repo }) => {
        const log = await readRuntimeLog(repo.rootDir);
        if (!log.ok) {
          throwLogCommandError(io, repo.rootDir, log.error, rawOptions.json === true);
        }

        return {
          data: log.value,
        };
      },
      formatHuman: (envelope) => formatHumanLog(envelope.data),
    });
  });
}

function formatHumanLog(data: RuntimeLogReadResult): string {
  const lines = [`Log entries: ${data.counts.total}`];
  for (const entry of data.entries) {
    lines.push("", `[${entry.timestamp}] ${entry.operation} | ${entry.affectedId} | ${entry.title}`);
  }

  if (data.issues.length > 0) {
    lines.push("", `Log issues: ${data.issues.length}`);
    for (const issue of data.issues) {
      lines.push(`${issue.severity}: ${issue.code} ${issue.path}${issue.line === undefined ? "" : `:${issue.line}`}`);
    }
  }

  return lines.join("\n");
}

function throwLogCommandError(io: CliIo, repo: string, error: RuntimeLogReadError, json: boolean): never {
  if (json) {
    io.stdout(
      JSON.stringify({
        ok: false,
        command: "log",
        repo,
        error: {
          code: error.code,
          message: error.message,
          hint: error.hint,
        },
        issues: [
          {
            severity: "error",
            code: error.code,
            message: error.message,
            path: error.path,
            hint: error.hint,
          },
        ],
      }),
    );
  } else {
    io.stderr(`Error: ${error.message}`);
  }

  throw new CommanderError(1, "llm-wiki.log", error.message);
}
