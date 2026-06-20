#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { registerAddCommand } from "./commands/add.js";
import { registerAddTextCommand } from "./commands/addText.js";
import { registerAddUrlCommand } from "./commands/addUrl.js";
import { registerInitCommand } from "./commands/init.js";
import { registerStatusCommand } from "./commands/status.js";

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  stdin?: () => Promise<string>;
};

const VERSION = "0.0.0";

const defaultIo: CliIo = {
  stdout: (message) => {
    process.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  },
  stderr: (message) => {
    process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  },
  stdin: readProcessStdin,
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
  registerAddCommand(program, io);
  registerAddTextCommand(program, io);
  registerAddUrlCommand(program, io);
  registerStatusCommand(program, io);

  return program;
}

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
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
