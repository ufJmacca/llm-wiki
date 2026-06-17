#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { registerInitCommand } from "./commands/init.js";

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

const VERSION = "0.0.0";

const defaultIo: CliIo = {
  stdout: (message) => {
    process.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  },
  stderr: (message) => {
    process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  },
};

export async function runCli(args = process.argv.slice(2), io = defaultIo): Promise<number> {
  if (args.includes("--version") || args.includes("-v")) {
    io.stdout(`llm-wiki ${VERSION}`);
    return 0;
  }

  const program = createProgram(io);

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    throw error;
  }
}

function createProgram(io: CliIo): Command {
  const program = new Command();

  program
    .name("llm-wiki")
    .description("Maintain a local-first LLM-assisted Markdown wiki")
    .exitOverride()
    .configureOutput({
      writeOut: (message) => io.stdout(message),
      writeErr: (message) => io.stderr(message),
    })
    .action(() => {
      io.stdout("llm-wiki CLI baseline");
    });

  registerInitCommand(program, io);

  return program;
}

function isCliEntrypoint(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return moduleUrl === pathToFileURL(argvPath).href;
  }
}

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  runCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      defaultIo.stderr(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
