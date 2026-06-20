import type { Command } from "commander";

import type { CliIo } from "../cli.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import { WIKI_CONFIG_RELATIVE_PATH } from "../runtime/repo.js";

type StatusData = {
  configPath: typeof WIKI_CONFIG_RELATIVE_PATH;
};

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
      run: async () => ({
        data: {
          configPath: WIKI_CONFIG_RELATIVE_PATH,
        },
      }),
      formatHuman: (envelope) =>
        ["LLM Wiki status", `Repo: ${envelope.repo}`, `Config: ${envelope.data.configPath}`].join("\n"),
    });
  });
}
