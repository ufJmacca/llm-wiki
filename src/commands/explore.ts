import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import {
  DEFAULT_DAEMON_PORT,
  startUploadDaemon,
  uploadDaemonReady,
  UploadDaemonError,
  type UploadDaemonReady,
} from "../daemon/index.js";
import { buildQuartzExplorer } from "../quartz/build.js";
import { initializeQuartzRuntime, QuartzOperationError, syncQuartzContent } from "../quartz/index.js";
import {
  DEFAULT_EXPLORER_HOST,
  DEFAULT_EXPLORER_PORT,
  serveQuartzExplorer,
  type QuartzServeReadyResult,
} from "../quartz/server.js";
import { readExplorerState } from "../quartz/state.js";
import {
  addRuntimeOptions,
  runRuntimeCommand,
  type RawRuntimeCommandOptions,
  type RuntimeCommandOptions,
} from "../runtime/command.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import {
  buildRuntimeCommandFailureEnvelope,
  buildRuntimeFailureEnvelope,
  buildRuntimeSuccessEnvelope,
  type RuntimeSuccessEnvelope,
} from "../runtime/envelope.js";
import { resolveWikiRoot } from "../runtime/repo.js";

type RawExploreInitOptions = RawRuntimeCommandOptions & {
  install?: unknown;
};

type RawExploreSyncOptions = RawRuntimeCommandOptions & {
  profile?: unknown;
};

type RawExploreServeOptions = RawRuntimeCommandOptions & {
  profile?: unknown;
  host?: unknown;
  port?: unknown;
  withDaemon?: unknown;
  daemonPort?: unknown;
  commitUploads?: unknown;
};

type RawExploreBuildOptions = RawRuntimeCommandOptions & {
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

  addRuntimeOptions(
    explore
      .command("serve")
      .description("Sync and serve the Quartz Explorer locally")
      .option("--profile <profile>", "sync profile: local, review, public, or github-pages", "local")
      .option("--host <host>", "host interface for the local Explorer server", DEFAULT_EXPLORER_HOST)
      .option("--port <port>", "port for the local Explorer server", String(DEFAULT_EXPLORER_PORT))
      .option("--with-daemon", "start the local raw upload daemon with Explorer", false)
      .option("--daemon-port <port>", "port for the local upload daemon", String(DEFAULT_DAEMON_PORT))
      .option("--commit-uploads", "commit uploaded source artifacts after capture", false),
  ).action(async (rawOptions: RawExploreServeOptions) => {
    await runExploreServeCommand(rawOptions, io);
  });

  addRuntimeOptions(
    explore
      .command("open")
      .description("Print the current Quartz Explorer URL"),
  ).action(async (rawOptions: RawRuntimeCommandOptions) => {
    await runRuntimeCommand({
      command: "explore.open",
      rawOptions,
      io,
      run: async ({ repo }) => {
        const stateResult = await readExplorerState(repo.rootDir);
        if (!stateResult.ok) {
          throw new RuntimeCommandError({
            code: stateResult.error.code,
            message: stateResult.error.message,
            path: stateResult.error.path,
            hint: stateResult.error.hint,
          });
        }

        return {
          data: {
            url: stateResult.value.url,
            opened: false,
          },
          warnings: [],
        };
      },
      formatHuman: (envelope) => envelope.data.url,
    });
  });

  addRuntimeOptions(
    explore
      .command("build")
      .description("Sync, lint, and build Quartz output for a profile")
      .option("--profile <profile>", "build profile: public or github-pages", "public"),
  ).action(async (rawOptions: RawExploreBuildOptions) => {
    await runRuntimeCommand({
      command: "explore.build",
      rawOptions,
      io,
      run: async ({ repo }) => {
        try {
          return await buildQuartzExplorer(repo.rootDir, typeof rawOptions.profile === "string" ? rawOptions.profile : "public");
        } catch (error) {
          throw toRuntimeCommandError(error, "explore build");
        }
      },
      formatHuman: (envelope) => formatHumanExploreBuild(envelope),
    });
  });
}

async function runExploreServeCommand(rawOptions: RawExploreServeOptions, io: CliIo): Promise<void> {
  const options = normalizeRuntimeOptions(rawOptions);
  const resolvedRepo = await resolveWikiRoot({ repoPath: options.repo });

  if (!resolvedRepo.ok) {
    const envelope = buildRuntimeFailureEnvelope("explore.serve", resolvedRepo.error);
    if (options.json) {
      io.stdout(JSON.stringify(envelope));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.explore.serve", envelope.error.message);
  }

  let readyEmitted = false;
  let uploadDaemon: Awaited<ReturnType<typeof startUploadDaemon>> | undefined;
  try {
    if (rawOptions.withDaemon === true) {
      uploadDaemon = await startUploadDaemon({
        repoRoot: resolvedRepo.value.rootDir,
        port: normalizeDaemonPort(rawOptions.daemonPort),
        commitUploads: rawOptions.commitUploads === true,
      });
    }

    await serveQuartzExplorer(resolvedRepo.value.rootDir, {
      profile: typeof rawOptions.profile === "string" ? rawOptions.profile : "local",
      host: typeof rawOptions.host === "string" ? rawOptions.host : DEFAULT_EXPLORER_HOST,
      port: normalizePort(rawOptions.port),
      onReady: (readyResult, warnings) => {
        readyEmitted = true;
        const data = withDaemonReady(readyResult, uploadDaemon);
        if (options.json) {
          io.stdout(
            JSON.stringify(
              buildRuntimeSuccessEnvelope("explore.serve", resolvedRepo.value.rootDir, data, warnings),
            ),
          );
          return;
        }

        if (!options.quiet) {
          io.stdout(formatHumanExploreServeReady(data));
        }
      },
    });
  } catch (error) {
    const commandError = toRuntimeCommandError(error, "explore serve");
    const envelope = buildRuntimeCommandFailureEnvelope("explore.serve", commandError, resolvedRepo.value.rootDir);
    if (readyEmitted) {
      if (!options.json) {
        io.stderr(`Error: ${envelope.error.message}`);
      }

      throw new CommanderError(1, "llm-wiki.explore.serve", envelope.error.message);
    }

    if (options.json) {
      io.stdout(JSON.stringify(envelope));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.explore.serve", envelope.error.message);
  } finally {
    await uploadDaemon?.close();
  }

  if (readyEmitted) {
    return;
  }

  throw new CommanderError(1, "llm-wiki.explore.serve", "Quartz Explorer did not report a startup URL.");
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

  if (error instanceof UploadDaemonError) {
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

function withDaemonReady(
  readyResult: QuartzServeReadyResult,
  daemon: Awaited<ReturnType<typeof startUploadDaemon>> | undefined,
): QuartzServeReadyResult | (QuartzServeReadyResult & { daemon: UploadDaemonReady }) {
  if (daemon === undefined) {
    return readyResult;
  }

  return {
    ...readyResult,
    daemon: uploadDaemonReady(daemon),
  };
}

function normalizeRuntimeOptions(rawOptions: RawRuntimeCommandOptions): RuntimeCommandOptions {
  return {
    repo: typeof rawOptions.repo === "string" ? rawOptions.repo : undefined,
    json: rawOptions.json === true,
    quiet: rawOptions.quiet === true,
  };
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

function normalizePort(rawPort: unknown): number {
  const value = typeof rawPort === "string" ? Number(rawPort) : DEFAULT_EXPLORER_PORT;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RuntimeCommandError({
      code: "EXPLORE_PORT_INVALID",
      message: `Invalid Explorer port: ${String(rawPort)}.`,
      path: "--port",
      hint: "Use an integer port from 1 through 65535.",
    });
  }

  return value;
}

function normalizeDaemonPort(rawPort: unknown): number {
  const value = typeof rawPort === "string" ? Number(rawPort) : DEFAULT_DAEMON_PORT;
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new RuntimeCommandError({
      code: "DAEMON_PORT_INVALID",
      message: `Invalid daemon port: ${String(rawPort)}.`,
      path: "--daemon-port",
      hint: "Use an integer port from 0 through 65535.",
    });
  }

  return value;
}

function formatHumanExploreServeReady(result: QuartzServeReadyResult | (QuartzServeReadyResult & { daemon: UploadDaemonReady })): string {
  const lines = [
    "Quartz Explorer serving",
    `Profile: ${result.profile}`,
    `URL: ${result.url}`,
    `State: ${result.state_path}`,
  ];

  if ("daemon" in result) {
    lines.push(`Upload endpoint: ${result.daemon.url}${result.daemon.upload_path}`);
    lines.push(`Upload token header: x-llm-wiki-upload-token: ${result.daemon.upload_token}`);
    lines.push(`Commit uploads: ${result.daemon.commit_uploads ? "enabled" : "disabled"}`);
  }

  return lines.join("\n");
}

function formatHumanExploreBuild(
  envelope: RuntimeSuccessEnvelope<"explore.build", Awaited<ReturnType<typeof buildQuartzExplorer>>["data"]>,
): string {
  return [
    "Quartz Explorer built",
    `Profile: ${envelope.data.profile}`,
    `Output: ${envelope.data.output_path}`,
    `Manifest: ${envelope.data.sync.manifest_path}`,
  ].join("\n");
}
