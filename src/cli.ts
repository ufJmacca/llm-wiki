#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

const VERSION = "0.0.0";

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export async function runCli(args = process.argv.slice(2), io = defaultIo): Promise<number> {
  if (args.includes("--version") || args.includes("-v")) {
    io.stdout(`llm-wiki ${VERSION}`);
    return 0;
  }

  io.stdout("llm-wiki CLI baseline");
  return 0;
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
