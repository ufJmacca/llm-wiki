import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import { captureFileSource, type SourceCaptureError, type SourceCaptureSuccess } from "../sourceCapture/index.js";

type RawAddCommandOptions = RawRuntimeCommandOptions & {
  title?: unknown;
};

export function registerAddCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("add")
      .description("Capture a local source file into the wiki raw inputs queue")
      .argument("[path]", "local file path to capture")
      .option("--title <title>", "source title; defaults to the file name"),
  ).action(async (sourcePath: string | undefined, rawOptions: RawAddCommandOptions) => {
    await runRuntimeCommand({
      command: "add",
      rawOptions,
      io,
      run: async ({ repo }) => {
        if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) {
          throwCaptureCommandError(
            io,
            "add",
            repo.rootDir,
            {
              code: "SOURCE_PATH_REQUIRED",
              message: "Source capture requires a local file path.",
              path: "path",
              hint: "Pass a local file path to llm-wiki add.",
            },
            rawOptions.json === true,
          );
        }

        const capture = await captureFileSource({
          repoRoot: repo.rootDir,
          sourcePath,
          title: typeof rawOptions.title === "string" ? rawOptions.title : undefined,
          command: formatAddCommand(sourcePath, rawOptions),
        });
        if (!capture.ok) {
          throwCaptureCommandError(io, "add", repo.rootDir, capture.error, rawOptions.json === true);
        }

        return {
          data: capture.value,
        };
      },
      formatHuman: (envelope) => formatHumanAddOutput(envelope.data),
    });
  });
}

function formatHumanAddOutput(output: SourceCaptureSuccess): string {
  if (output.status === "duplicate") {
    return [
      "Source already captured",
      `Source ID: ${output.source.source_id}`,
      `Title: ${output.source.title}`,
      `Status: duplicate`,
      `Existing card: ${output.source.source_card_path}`,
    ].join("\n");
  }

  return [
    "Source captured",
    `Source ID: ${output.source.source_id}`,
    `Title: ${output.source.title}`,
    `Original: ${output.source.original_path}`,
    `Queue: ${output.source.queue_path}`,
  ].join("\n");
}

function formatAddCommand(sourcePath: string, rawOptions: RawAddCommandOptions): string {
  const title = typeof rawOptions.title === "string" ? ` --title ${rawOptions.title}` : "";

  return `llm-wiki add ${sourcePath}${title}`;
}

function throwCaptureCommandError(
  io: CliIo,
  command: "add",
  repo: string,
  error: SourceCaptureError,
  json: boolean,
): never {
  if (json) {
    io.stdout(
      JSON.stringify({
        ok: false,
        command,
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

  throw new CommanderError(1, `llm-wiki.${command}`, error.message);
}
