import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import { captureUrlSource, type SourceCaptureError, type SourceCaptureSuccess } from "../sourceCapture/index.js";

type RawAddUrlCommandOptions = RawRuntimeCommandOptions & {
  title?: unknown;
};

export function registerAddUrlCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("add-url")
      .description("Fetch a URL and capture its text response into the wiki raw inputs queue")
      .argument("[url]", "http(s) URL to capture")
      .option("--title <title>", "source title; defaults to the last URL path segment or host"),
  ).action(async (url: string | undefined, rawOptions: RawAddUrlCommandOptions) => {
    await runRuntimeCommand({
      command: "add-url",
      rawOptions,
      io,
      run: async ({ repo }) => {
        if (typeof url !== "string" || url.trim().length === 0) {
          throwCaptureCommandError(
            io,
            "add-url",
            repo.rootDir,
            {
              code: "URL_INVALID",
              message: "URL capture requires a valid http(s) URL.",
              path: "url",
              hint: "Pass an absolute http:// or https:// URL to llm-wiki add-url.",
            },
            rawOptions.json === true,
          );
        }

        const capture = await captureUrlSource({
          repoRoot: repo.rootDir,
          url,
          title: typeof rawOptions.title === "string" ? rawOptions.title : undefined,
          command: formatAddUrlCommand(url, rawOptions),
        });
        if (!capture.ok) {
          throwCaptureCommandError(io, "add-url", repo.rootDir, capture.error, rawOptions.json === true);
        }

        return {
          data: capture.value,
        };
      },
      formatHuman: (envelope) => formatHumanAddUrlOutput(envelope.data),
    });
  });
}

function formatHumanAddUrlOutput(output: SourceCaptureSuccess): string {
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
    "URL source captured",
    `Source ID: ${output.source.source_id}`,
    `Title: ${output.source.title}`,
    `Original: ${output.source.original_path}`,
    `Queue: ${output.source.queue_path}`,
  ].join("\n");
}

function formatAddUrlCommand(url: string, rawOptions: RawAddUrlCommandOptions): string {
  const title = typeof rawOptions.title === "string" ? ` --title ${rawOptions.title}` : "";

  return `llm-wiki add-url ${url}${title}`;
}

function throwCaptureCommandError(
  io: CliIo,
  command: "add-url",
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
