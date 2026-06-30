import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import {
  buildRuntimePartialFailureEnvelope,
  buildRuntimeCommandFailureEnvelope,
  buildRuntimeFailureEnvelope,
  buildRuntimeSuccessEnvelope,
  type RuntimeIssue,
  type RuntimeSuccessEnvelope,
} from "./envelope.js";
import { RuntimeCommandError } from "./errors.js";
import { resolveWikiRoot, type WikiRoot } from "./repo.js";

export type RuntimeCommandOptions = {
  repo?: string;
  json: boolean;
  quiet: boolean;
};

export type RawRuntimeCommandOptions = {
  repo?: unknown;
  json?: unknown;
  quiet?: unknown;
};

export type RuntimeCommandContext = {
  repo: WikiRoot;
  options: RuntimeCommandOptions;
};

export type RuntimeCommandSuccessResult<Data> = {
  data: Data;
  warnings?: string[];
};

export type RuntimeCommandPartialFailureResult<Data> = {
  data: Data;
  warnings?: string[];
  error: RuntimeCommandError;
  issues?: RuntimeIssue[];
};

export type RuntimeCommandResult<Data> =
  | RuntimeCommandSuccessResult<Data>
  | RuntimeCommandPartialFailureResult<Data>;

export type RuntimeCommandConfig<CommandName extends string, Data> = {
  command: CommandName;
  rawOptions: RawRuntimeCommandOptions;
  io: CliIo;
  run: (context: RuntimeCommandContext) => Promise<RuntimeCommandResult<Data>>;
  formatHuman: (envelope: RuntimeSuccessEnvelope<CommandName, Data>) => string;
};

export function addRuntimeOptions(command: Command): Command {
  return command
    .option("--repo <path>", "wiki repository root or descendant path")
    .option("--json", "print machine-readable command output", false)
    .option("--quiet", "suppress human non-error output", false);
}

export async function runRuntimeCommand<CommandName extends string, Data>(
  config: RuntimeCommandConfig<CommandName, Data>,
): Promise<void> {
  const options = normalizeRuntimeOptions(config.rawOptions);
  const resolvedRepo = await resolveWikiRoot({ repoPath: options.repo });

  if (!resolvedRepo.ok) {
    const envelope = buildRuntimeFailureEnvelope(config.command, resolvedRepo.error);
    if (options.json) {
      config.io.stdout(JSON.stringify(envelope));
    } else {
      config.io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, `llm-wiki.${config.command}`, envelope.error.message);
  }

  let commandResult: RuntimeCommandResult<Data>;
  try {
    commandResult = await config.run({ repo: resolvedRepo.value, options });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw error;
    }

    const commandError = error instanceof RuntimeCommandError
      ? error
      : new RuntimeCommandError({
          code: `${normalizeCommandCode(config.command)}_FAILED`,
          message: error instanceof Error ? error.message : String(error),
          hint: `Fix the repository data or permissions, then rerun llm-wiki ${config.command}.`,
          path: ".",
        });

    const envelope = buildRuntimeCommandFailureEnvelope(config.command, commandError, resolvedRepo.value.rootDir);
    if (options.json) {
      config.io.stdout(JSON.stringify(envelope));
    } else {
      config.io.stderr(`Error: ${envelope.error.message}\nHint: ${envelope.error.hint}`);
    }

    throw new CommanderError(1, `llm-wiki.${config.command}`, envelope.error.message);
  }
  if (isPartialFailureResult(commandResult)) {
    const issues = commandResult.issues ?? [
      {
        severity: "error" as const,
        code: commandResult.error.code,
        message: commandResult.error.message,
        path: commandResult.error.path,
        hint: commandResult.error.hint,
      },
    ];
    const envelope = buildRuntimePartialFailureEnvelope(
      config.command,
      resolvedRepo.value.rootDir,
      commandResult.data,
      commandResult.error,
      issues,
      commandResult.warnings ?? [],
    );

    if (options.json) {
      config.io.stdout(JSON.stringify(envelope));
    } else {
      if (!options.quiet) {
        config.io.stdout(config.formatHuman(buildRuntimeSuccessEnvelope(
          config.command,
          resolvedRepo.value.rootDir,
          commandResult.data,
          commandResult.warnings ?? [],
        )));
      }
      config.io.stderr(`Error: ${envelope.error.message}\nHint: ${envelope.error.hint}`);
    }

    throw new CommanderError(1, `llm-wiki.${config.command}`, envelope.error.message);
  }

  const envelope = buildRuntimeSuccessEnvelope(
    config.command,
    resolvedRepo.value.rootDir,
    commandResult.data,
    commandResult.warnings ?? [],
  );

  if (options.json) {
    config.io.stdout(JSON.stringify(envelope));
    return;
  }

  if (!options.quiet) {
    config.io.stdout(config.formatHuman(envelope));
  }
}

function normalizeCommandCode(command: string): string {
  return command.trim().toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "") || "COMMAND";
}

function normalizeRuntimeOptions(rawOptions: RawRuntimeCommandOptions): RuntimeCommandOptions {
  return {
    repo: typeof rawOptions.repo === "string" ? rawOptions.repo : undefined,
    json: rawOptions.json === true,
    quiet: rawOptions.quiet === true,
  };
}

function isPartialFailureResult<Data>(
  result: RuntimeCommandResult<Data>,
): result is RuntimeCommandPartialFailureResult<Data> {
  return "error" in result;
}
