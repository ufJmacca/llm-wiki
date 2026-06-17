import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import {
  buildRuntimeFailureEnvelope,
  buildRuntimeSuccessEnvelope,
  type RuntimeSuccessEnvelope,
} from "./envelope.js";
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

export type RuntimeCommandResult<Data> = {
  data: Data;
  warnings?: string[];
};

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

  const commandResult = await config.run({ repo: resolvedRepo.value, options });
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

function normalizeRuntimeOptions(rawOptions: RawRuntimeCommandOptions): RuntimeCommandOptions {
  return {
    repo: typeof rawOptions.repo === "string" ? rawOptions.repo : undefined,
    json: rawOptions.json === true,
    quiet: rawOptions.quiet === true,
  };
}
