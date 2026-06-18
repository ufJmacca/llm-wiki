import { type Command } from "commander";

import type { CliIo } from "../cli.js";
import { initializeQuartzRuntime, QuartzOperationError, syncQuartzContent } from "../quartz/index.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import type { RuntimeSuccessEnvelope } from "../runtime/envelope.js";

type RawExploreInitOptions = RawRuntimeCommandOptions & {
  install?: unknown;
};

type RawExploreSyncOptions = RawRuntimeCommandOptions & {
  profile?: unknown;
};

export function registerExploreCommand(program: Command, io: CliIo): void {
  const explore = program.command("explore").description("Manage local Quartz Explorer runtime and synced content");

  addRuntimeOptions(
    explore
      .command("init")
      .description("Create isolated Quartz runtime placeholders")
      .option("--install", "install Quartz runtime dependencies with npm install", false),
  ).action(async (rawOptions: RawExploreInitOptions) => {
    await runRuntimeCommand({
      command: "explore.init",
      rawOptions,
      io,
      run: async ({ repo }) => {
        try {
          return await initializeQuartzRuntime(repo.rootDir, { install: rawOptions.install === true });
        } catch (error) {
          throw toRuntimeCommandError(error, "explore init");
        }
      },
      formatHuman: (envelope) => formatHumanExploreInit(envelope),
    });
  });

  addRuntimeOptions(
    explore
      .command("sync")
      .description("Materialize profile-selected wiki Markdown into quartz/content")
      .option("--profile <profile>", "sync profile: local, review, public, or github-pages", "local"),
  ).action(async (rawOptions: RawExploreSyncOptions) => {
    await runRuntimeCommand({
      command: "explore.sync",
      rawOptions,
      io,
      run: async ({ repo }) => {
        try {
          return await syncQuartzContent(repo.rootDir, typeof rawOptions.profile === "string" ? rawOptions.profile : "local");
        } catch (error) {
          throw toRuntimeCommandError(error, "explore sync");
        }
      },
      formatHuman: (envelope) => formatHumanExploreSync(envelope),
    });
  });
}

function toRuntimeCommandError(error: unknown, command: string): RuntimeCommandError {
  if (error instanceof RuntimeCommandError) {
    return error;
  }

  if (error instanceof QuartzOperationError) {
    return new RuntimeCommandError({
      code: error.code,
      message: error.message,
      path: error.path,
      hint: error.hint,
    });
  }

  return new RuntimeCommandError({
    code: "EXPLORE_FAILED",
    message: error instanceof Error ? error.message : String(error),
    path: ".",
    hint: `Fix the repository data or permissions, then rerun llm-wiki ${command}.`,
  });
}

function formatHumanExploreInit(
  envelope: RuntimeSuccessEnvelope<"explore.init", Awaited<ReturnType<typeof initializeQuartzRuntime>>["data"]>,
): string {
  const lines = [
    "Quartz Explorer initialized",
    `Path: ${envelope.repo}/quartz`,
    `Runtime files: ${envelope.data.created_paths.length}`,
  ];

  if (envelope.data.install.attempted) {
    lines.push(`Install: ${envelope.data.install.ok ? "completed" : "failed"}`);
  } else {
    lines.push(`Install dependencies: ${envelope.data.install.command}`);
  }

  return lines.join("\n");
}

function formatHumanExploreSync(
  envelope: RuntimeSuccessEnvelope<"explore.sync", Awaited<ReturnType<typeof syncQuartzContent>>["data"]>,
): string {
  return [
    "Quartz Explorer synced",
    `Profile: ${envelope.data.profile}`,
    `Source profile: ${envelope.data.source_profile}`,
    `Content root: ${envelope.data.content_root}`,
    `Materialized Markdown: ${envelope.data.materialized_paths.length}`,
    `Generated review pages: ${envelope.data.generated_paths.length}`,
    `Manifest: ${envelope.data.manifest_path}`,
  ].join("\n");
}
