import type { Command } from "commander";

import type { CliIo } from "../cli.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import {
  initializeRemoteUploadScaffold,
  toUploadScaffoldRuntimeCommandError,
  type RemoteUploadInitResult,
} from "../uploadScaffold/index.js";
import type { RuntimeSuccessEnvelope } from "../runtime/envelope.js";

type RawUploadInitOptions = RawRuntimeCommandOptions & {
  target?: unknown;
};

export function registerUploadCommand(program: Command, io: CliIo): void {
  const upload = program.command("upload").description("Manage remote upload scaffolds");

  addRuntimeOptions(
    upload
      .command("init")
      .description("Generate an authenticated, rate-limited remote upload scaffold")
      .option("--target <target>", "remote upload target: github"),
  ).action(async (rawOptions: RawUploadInitOptions) => {
    await runRuntimeCommand({
      command: "upload.init",
      rawOptions,
      io,
      run: async ({ repo }) => {
        try {
          return await initializeRemoteUploadScaffold(repo.rootDir, {
            target: typeof rawOptions.target === "string" ? rawOptions.target : undefined,
          });
        } catch (error) {
          throw toUploadScaffoldRuntimeCommandError(error, "upload init");
        }
      },
      formatHuman: formatHumanUploadInit,
    });
  });
}

function formatHumanUploadInit(envelope: RuntimeSuccessEnvelope<"upload.init", RemoteUploadInitResult>): string {
  return [
    "Remote upload scaffold initialized",
    `Target: ${envelope.data.target}`,
    `Config: ${envelope.data.config_path}`,
    `Form config: ${envelope.data.form_config_path}`,
    `Docs: ${envelope.data.docs_path}`,
    `Auth hooks: ${envelope.data.auth_hooks.join(", ")}`,
    `Rate limit: ${envelope.data.rate_limits.max_requests} requests / ${envelope.data.rate_limits.window_seconds} seconds by ${envelope.data.rate_limits.strategy}`,
    `Size limits: ${envelope.data.size_limits.max_file_bytes} byte files, ${envelope.data.size_limits.max_text_bytes} byte text fields`,
    `Allowed types: ${envelope.data.file_type_limits.allowed_mime_types.join(", ")}`,
    `Required secrets: ${envelope.data.required_secrets.join(", ")}`,
    `Write mode: ${envelope.data.write_mode}`,
    `Queued visibility: ${envelope.data.default_visibility}`,
    `Created paths: ${envelope.data.created_paths.length === 0 ? "(none)" : envelope.data.created_paths.join(", ")}`,
    `Updated paths: ${envelope.data.updated_paths.length === 0 ? "(none)" : envelope.data.updated_paths.join(", ")}`,
    ...envelope.data.instructions.map((instruction) => `Next: ${instruction}`),
  ].join("\n");
}
