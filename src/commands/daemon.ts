import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  startUploadDaemon,
  uploadDaemonReady,
  UploadDaemonError,
  type UploadDaemonReady,
} from "../daemon/index.js";
import { addRuntimeOptions, type RawRuntimeCommandOptions, type RuntimeCommandOptions } from "../runtime/command.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import {
  buildRuntimeCommandFailureEnvelope,
  buildRuntimeFailureEnvelope,
  buildRuntimeSuccessEnvelope,
  type RuntimeSuccessEnvelope,
} from "../runtime/envelope.js";
import { resolveWikiRoot } from "../runtime/repo.js";

type RawDaemonCommandOptions = RawRuntimeCommandOptions & {
  host?: unknown;
  port?: unknown;
  commitUploads?: unknown;
};

export function registerDaemonCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("daemon")
      .description("Run a localhost-only raw source upload daemon")
      .option("--host <host>", "host interface for the local upload daemon", DEFAULT_DAEMON_HOST)
      .option("--port <port>", "port for the local upload daemon", String(DEFAULT_DAEMON_PORT))
      .option("--commit-uploads", "commit uploaded source artifacts after capture", false),
  ).action(async (rawOptions: RawDaemonCommandOptions) => {
    await runDaemonCommand(rawOptions, io);
  });
}

async function runDaemonCommand(rawOptions: RawDaemonCommandOptions, io: CliIo): Promise<void> {
  const options = normalizeRuntimeOptions(rawOptions);
  const resolvedRepo = await resolveWikiRoot({ repoPath: options.repo });

  if (!resolvedRepo.ok) {
    const envelope = buildRuntimeFailureEnvelope("daemon", resolvedRepo.error);
    if (options.json) {
      io.stdout(JSON.stringify(envelope));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.daemon", envelope.error.message);
  }

  let daemon: Awaited<ReturnType<typeof startUploadDaemon>> | undefined;
  try {
    daemon = await startUploadDaemon({
      repoRoot: resolvedRepo.value.rootDir,
      host: typeof rawOptions.host === "string" ? rawOptions.host : DEFAULT_DAEMON_HOST,
      port: normalizeDaemonPort(rawOptions.port),
      commitUploads: rawOptions.commitUploads === true,
    });
  } catch (error) {
    const commandError = toRuntimeCommandError(error);
    const envelope = buildRuntimeCommandFailureEnvelope("daemon", commandError, resolvedRepo.value.rootDir);
    if (options.json) {
      io.stdout(JSON.stringify(envelope));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.daemon", envelope.error.message);
  }

  const ready = uploadDaemonReady(daemon);
  const envelope = buildRuntimeSuccessEnvelope("daemon", resolvedRepo.value.rootDir, ready, []);
  if (options.json) {
    io.stdout(JSON.stringify(envelope));
  } else if (!options.quiet) {
    io.stdout(formatHumanDaemonReady(envelope));
  }

  await waitForDaemonShutdown(daemon);
}

function normalizeDaemonPort(rawPort: unknown): number {
  const value = typeof rawPort === "string" ? Number(rawPort) : DEFAULT_DAEMON_PORT;
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new RuntimeCommandError({
      code: "DAEMON_PORT_INVALID",
      message: `Invalid daemon port: ${String(rawPort)}.`,
      path: "--port",
      hint: "Use an integer port from 0 through 65535.",
    });
  }

  return value;
}

async function waitForDaemonShutdown(daemon: Awaited<ReturnType<typeof startUploadDaemon>>): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    let settled = false;
    const cleanup = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolveShutdown();
    };
    const onSignal = (): void => {
      void daemon.close().finally(finish);
    };

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

function toRuntimeCommandError(error: unknown): RuntimeCommandError {
  if (error instanceof RuntimeCommandError) {
    return error;
  }

  if (error instanceof UploadDaemonError) {
    return new RuntimeCommandError({
      code: error.code,
      message: error.message,
      path: error.path,
      hint: error.hint,
    });
  }

  return new RuntimeCommandError({
    code: "DAEMON_FAILED",
    message: error instanceof Error ? error.message : String(error),
    path: ".",
    hint: "Fix daemon options or repository state, then rerun llm-wiki daemon.",
  });
}

function normalizeRuntimeOptions(rawOptions: RawRuntimeCommandOptions): RuntimeCommandOptions {
  return {
    repo: typeof rawOptions.repo === "string" ? rawOptions.repo : undefined,
    json: rawOptions.json === true,
    quiet: rawOptions.quiet === true,
  };
}

function formatHumanDaemonReady(envelope: RuntimeSuccessEnvelope<"daemon", UploadDaemonReady>): string {
  return [
    "LLM Wiki upload daemon serving",
    `URL: ${envelope.data.url}`,
    `Upload endpoint: ${envelope.data.url}${envelope.data.upload_path}`,
    `Upload session ID: ${envelope.data.upload_session_id}`,
    `Upload token header: x-llm-wiki-upload-token: ${envelope.data.upload_token}`,
    `Commit uploads: ${envelope.data.commit_uploads ? "enabled" : "disabled"}`,
  ].join("\n");
}
