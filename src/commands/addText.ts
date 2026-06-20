import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import { captureTextSource, type SourceCaptureError, type SourceCaptureSuccess } from "../sourceCapture/index.js";

type RawAddTextCommandOptions = RawRuntimeCommandOptions & {
  title?: unknown;
  text?: unknown;
};

export function registerAddTextCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("add-text")
      .description("Capture pasted text into the wiki raw inputs queue")
      .argument("[text]", "text content to capture")
      .option("--title <title>", "source title")
      .option("--text <text>", "text content to capture"),
  ).action(async (textArgument: string | undefined, rawOptions: RawAddTextCommandOptions) => {
    await runRuntimeCommand({
      command: "add-text",
      rawOptions,
      io,
      run: async ({ repo }) => {
        const title = typeof rawOptions.title === "string" ? rawOptions.title : "";
        if (title.trim().length === 0) {
          throwCaptureCommandError(
            io,
            "add-text",
            repo.rootDir,
            {
              code: "TITLE_REQUIRED",
              message: "Source capture requires a title.",
              path: "title",
              hint: "Pass --title <title>.",
            },
            rawOptions.json === true,
          );
        }

        const text = await readTextInput(io, rawOptions.text, textArgument);
        const capture = await captureTextSource({
          repoRoot: repo.rootDir,
          title,
          text,
          command: formatAddTextCommand(title),
        });
        if (!capture.ok) {
          throwCaptureCommandError(io, "add-text", repo.rootDir, capture.error, rawOptions.json === true);
        }

        return {
          data: capture.value,
        };
      },
      formatHuman: (envelope) => formatHumanAddTextOutput(envelope.data),
    });
  });
}

async function readTextInput(io: CliIo, textOption: unknown, textArgument: string | undefined): Promise<string> {
  if (typeof textOption === "string") {
    return textOption;
  }

  if (textArgument !== undefined) {
    return textArgument;
  }

  return (await io.stdin?.()) ?? "";
}

function formatHumanAddTextOutput(output: SourceCaptureSuccess): string {
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
    "Text source captured",
    `Source ID: ${output.source.source_id}`,
    `Title: ${output.source.title}`,
    `Original: ${output.source.original_path}`,
    `Queue: ${output.source.queue_path}`,
  ].join("\n");
}

function formatAddTextCommand(title: string): string {
  return `llm-wiki add-text --title ${title}`;
}

function throwCaptureCommandError(
  io: CliIo,
  command: "add-text",
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
