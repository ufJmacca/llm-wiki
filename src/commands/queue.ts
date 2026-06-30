import { CommanderError, type Command } from "commander";

import {
  runAutoIngestBatch,
  runAutoIngestSource,
  runAutoIngestWatch,
  type AutoIngestBatchResult,
  type AutoIngestSourceResult,
  type AutoIngestWatchEvent,
  type AutoIngestWatchSummary,
} from "../autoIngest/index.js";
import type { CliIo } from "../cli.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import {
  buildRuntimeCommandFailureEnvelope,
  buildRuntimeFailureEnvelope,
  type RuntimeIssue,
} from "../runtime/envelope.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import {
  listQueue,
  setQueueStatus,
  showQueueSource,
  type QueueListResult,
  type QueueSetStatusResult,
  type QueueShowResult,
} from "../runtime/queue.js";
import { resolveWikiRoot } from "../runtime/repo.js";

type QueueIngestData = Omit<AutoIngestBatchResult, "agent"> & {
  agent: string | null;
};

type RawQueueCommandOptions = RawRuntimeCommandOptions & {
  auto?: unknown;
  limit?: unknown;
  sourceId?: unknown;
  watch?: unknown;
};

type QueueCliCommandError = {
  code: string;
  message: string;
  path: string;
  hint: string;
};

export function registerQueueCommand(program: Command, io: CliIo): void {
  const queueCommand = addRuntimeOptions(
    program
      .command("queue")
      .description("List and manage raw source queue items")
      .argument("[action]", "optional action: ingest, show or set-status")
      .argument("[source_id]", "source ID for show or set-status")
      .argument("[status]", "next status for set-status")
      .option("--auto", "run queue ingest with the configured default local agent", false)
      .option("--limit <n>", "maximum number of queued sources to auto-ingest")
      .option("--source-id <source_id>", "specific source ID for queue ingest")
      .option("--watch", "keep processing newly queued sources until interrupted", false),
  );

  queueCommand.action(async (
    action: string | undefined,
    sourceId: string | undefined,
    status: string | undefined,
    rawOptions: RawQueueCommandOptions | Command,
  ) => {
    const runtimeOptions = normalizeCommanderOptions(rawOptions);

    if (action === undefined || action === "show" || action === "set-status") {
      rejectQueueIngestOptionsOutsideIngest(action, runtimeOptions, io);
    }

    if (action === undefined) {
      await runRuntimeCommand({
        command: "queue",
        rawOptions: runtimeOptions,
        io,
        run: async ({ repo }) => {
          const queue = await listQueue(repo.rootDir);
          if (!queue.ok) {
            throwQueueCommandError(io, "queue", repo.rootDir, queue.error, runtimeOptions.json === true);
          }

          return {
            data: queue.value,
          };
        },
        formatHuman: (envelope) => formatHumanQueueList(envelope.data),
      });
      return;
    }

    if (action === "show") {
      if (sourceId === undefined) {
        throwMissingQueueArgument(io, "queue show", "source_id", runtimeOptions.json === true);
      }

      await runRuntimeCommand({
        command: "queue show",
        rawOptions: runtimeOptions,
        io,
        run: async ({ repo }) => {
          const queueItem = await showQueueSource(repo.rootDir, sourceId);
          if (!queueItem.ok) {
            throwQueueCommandError(io, "queue show", repo.rootDir, queueItem.error, runtimeOptions.json === true);
          }

          return {
            data: queueItem.value,
          };
        },
        formatHuman: (envelope) => formatHumanQueueShow(envelope.data),
      });
      return;
    }

    if (action === "set-status") {
      if (sourceId === undefined) {
        throwMissingQueueArgument(io, "queue set-status", "source_id", runtimeOptions.json === true);
      }

      if (status === undefined) {
        throwMissingQueueArgument(io, "queue set-status", "status", runtimeOptions.json === true);
      }

      await runRuntimeCommand({
        command: "queue set-status",
        rawOptions: runtimeOptions,
        io,
        run: async ({ repo }) => {
          const updated = await setQueueStatus(repo.rootDir, sourceId, status, {
            command: `llm-wiki queue set-status ${sourceId} ${status}`,
          });
          if (!updated.ok) {
            throwQueueCommandError(io, "queue set-status", repo.rootDir, updated.error, runtimeOptions.json === true);
          }

          return {
            data: updated.value,
          };
        },
        formatHuman: (envelope) => formatHumanQueueSetStatus(envelope.data),
      });
      return;
    }

    if (action === "ingest") {
      const target = resolveQueueIngestTarget(sourceId, status, runtimeOptions, io);
      if (runtimeOptions.auto !== true) {
        throwQueueCommandError(
          io,
          "queue ingest",
          "",
          {
            code: "QUEUE_INGEST_AUTO_REQUIRED",
            message: "queue ingest requires --auto.",
            path: "--auto",
            hint: "Run llm-wiki queue ingest --auto to process queued sources with the configured default agent.",
          },
          runtimeOptions.json === true,
        );
      }

      const limit = parseQueueIngestLimit(runtimeOptions.limit, runtimeOptions, io);
      rejectQueueIngestTargetLimit(target, limit, runtimeOptions, io);
      rejectQueueIngestWatchOptions(runtimeOptions.watch === true, target, limit, runtimeOptions, io);

      if (runtimeOptions.watch === true) {
        await runQueueIngestWatchCommand(runtimeOptions, io);
        return;
      }

      await runRuntimeCommand({
        command: "queue ingest",
        rawOptions: runtimeOptions,
        io,
        run: async ({ repo }) => {
          const data = target === undefined
            ? await runQueueIngestBatch(repo.rootDir, limit)
            : batchDataFromSourceResult(await runAutoIngestSource({
                repoRoot: repo.rootDir,
                sourceId: target,
                command: `llm-wiki queue ingest --auto --source-id ${target}`,
              }));

          if (queueIngestIsIncomplete(data)) {
            return {
              data,
              error: queueIngestIncompleteError(data),
              issues: queueIngestIssues(data),
            };
          }

          return {
            data,
          };
        },
        formatHuman: (envelope) => formatHumanQueueIngest(envelope.data),
      });
      return;
    }

    throwQueueCommandError(
      io,
      "queue",
      "",
      {
        code: "QUEUE_ACTION_INVALID",
        message: `Unknown queue action: ${action}`,
        path: "action",
        hint: "Use llm-wiki queue, llm-wiki queue ingest --auto, llm-wiki queue show <source_id>, or llm-wiki queue set-status <source_id> <status>.",
      },
      runtimeOptions.json === true,
    );
  });
}

function normalizeCommanderOptions(rawOptions: RawRuntimeCommandOptions | Command): RawQueueCommandOptions {
  if (isCommanderCommand(rawOptions)) {
    return rawOptions.opts() as RawQueueCommandOptions;
  }

  return rawOptions as RawQueueCommandOptions;
}

function isCommanderCommand(value: RawQueueCommandOptions | Command): value is Command {
  return typeof (value as { opts?: unknown }).opts === "function";
}

function rejectQueueIngestOptionsOutsideIngest(
  action: string | undefined,
  rawOptions: RawQueueCommandOptions,
  io: CliIo,
): void {
  const option = firstQueueIngestOnlyOption(rawOptions);
  if (option === undefined) {
    return;
  }

  throwQueueCommandError(
    io,
    queueCommandName(action),
    "",
    {
      code: "QUEUE_INGEST_OPTION_INVALID",
      message: `${option} can only be used with queue ingest.`,
      path: option,
      hint: "Run llm-wiki queue ingest --auto, or remove ingest-only options from queue list, show, and set-status commands.",
    },
    rawOptions.json === true,
  );
}

function firstQueueIngestOnlyOption(
  rawOptions: RawQueueCommandOptions,
): "--auto" | "--limit" | "--source-id" | "--watch" | undefined {
  if (rawOptions.auto === true) {
    return "--auto";
  }

  if (rawOptions.limit !== undefined) {
    return "--limit";
  }

  if (rawOptions.sourceId !== undefined) {
    return "--source-id";
  }

  if (rawOptions.watch === true) {
    return "--watch";
  }

  return undefined;
}

function queueCommandName(action: string | undefined): "queue" | "queue show" | "queue set-status" {
  if (action === "show") {
    return "queue show";
  }

  if (action === "set-status") {
    return "queue set-status";
  }

  return "queue";
}

async function runQueueIngestBatch(repoRoot: string, limit: number | undefined): Promise<QueueIngestData> {
  const result = await runAutoIngestBatch({
    repoRoot,
    ...(limit === undefined ? {} : { limit }),
    command: limit === undefined ? "llm-wiki queue ingest --auto" : `llm-wiki queue ingest --auto --limit ${limit}`,
  });

  return result;
}

function resolveQueueIngestTarget(
  positionalSourceId: string | undefined,
  positionalStatus: string | undefined,
  rawOptions: RawQueueCommandOptions,
  io: CliIo,
): string | undefined {
  const optionSourceId = typeof rawOptions.sourceId === "string" ? rawOptions.sourceId : undefined;
  if (positionalSourceId !== undefined || positionalStatus !== undefined) {
    throwQueueCommandError(
      io,
      "queue ingest",
      "",
      {
        code: "QUEUE_INGEST_ARGUMENT_INVALID",
        message: "queue ingest accepts a source target only through --source-id.",
        path: "source_id",
        hint: "Run llm-wiki queue ingest --auto --source-id <source_id>.",
      },
      rawOptions.json === true,
    );
  }

  return optionSourceId;
}

function parseQueueIngestLimit(
  rawLimit: unknown,
  rawOptions: RawQueueCommandOptions,
  io: CliIo,
): number | undefined {
  if (rawLimit === undefined) {
    return undefined;
  }

  const limitText = String(rawLimit);
  if (!/^\d+$/.test(limitText)) {
    throwQueueCommandError(
      io,
      "queue ingest",
      "",
      {
        code: "QUEUE_INGEST_LIMIT_INVALID",
        message: `Invalid queue ingest limit: ${limitText}`,
        path: "--limit",
        hint: "Pass --limit <n> as a non-negative integer.",
      },
      rawOptions.json === true,
    );
  }

  const limit = Number(limitText);
  if (!Number.isSafeInteger(limit)) {
    throwQueueCommandError(
      io,
      "queue ingest",
      "",
      {
        code: "QUEUE_INGEST_LIMIT_INVALID",
        message: `Invalid queue ingest limit: ${limitText}`,
        path: "--limit",
        hint: "Pass --limit <n> as a non-negative integer.",
      },
      rawOptions.json === true,
    );
  }

  return limit;
}

function rejectQueueIngestTargetLimit(
  target: string | undefined,
  limit: number | undefined,
  rawOptions: RawQueueCommandOptions,
  io: CliIo,
): void {
  if (target === undefined || limit === undefined) {
    return;
  }

  throwQueueCommandError(
    io,
    "queue ingest",
    "",
    {
      code: "QUEUE_INGEST_ARGUMENT_INVALID",
      message: "queue ingest cannot combine --source-id and --limit.",
      path: "--limit",
      hint: "Run llm-wiki queue ingest --auto --source-id <source_id> or omit --source-id when using --limit.",
    },
    rawOptions.json === true,
  );
}

function rejectQueueIngestWatchOptions(
  watch: boolean,
  target: string | undefined,
  limit: number | undefined,
  rawOptions: RawQueueCommandOptions,
  io: CliIo,
): void {
  if (!watch) {
    return;
  }

  if (target !== undefined) {
    throwQueueCommandError(
      io,
      "queue ingest",
      "",
      {
        code: "QUEUE_INGEST_ARGUMENT_INVALID",
        message: "queue ingest --watch cannot combine with --source-id.",
        path: "--source-id",
        hint: "Run llm-wiki queue ingest --auto --watch to process discovered queued sources.",
      },
      rawOptions.json === true,
    );
  }

  if (limit !== undefined) {
    throwQueueCommandError(
      io,
      "queue ingest",
      "",
      {
        code: "QUEUE_INGEST_ARGUMENT_INVALID",
        message: "queue ingest --watch cannot combine with --limit.",
        path: "--limit",
        hint: "Run llm-wiki queue ingest --auto --watch, or omit --watch for a bounded batch.",
      },
      rawOptions.json === true,
    );
  }
}

async function runQueueIngestWatchCommand(rawOptions: RawQueueCommandOptions, io: CliIo): Promise<void> {
  const json = rawOptions.json === true;
  const quiet = rawOptions.quiet === true;
  const resolvedRepo = await resolveWikiRoot({
    repoPath: typeof rawOptions.repo === "string" ? rawOptions.repo : undefined,
  });

  if (!resolvedRepo.ok) {
    const envelope = buildRuntimeFailureEnvelope("queue ingest", resolvedRepo.error);
    if (json) {
      io.stdout(JSON.stringify({
        event: "summary",
        ...envelope,
        summary: preflightFailureWatchSummary(),
      }));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.queue ingest", envelope.error.message);
  }

  const repoRoot = resolvedRepo.value.rootDir;
  const controller = new AbortController();
  const signalHandlers = installQueueIngestWatchSignalHandlers(controller);

  try {
    let summary: AutoIngestWatchSummary;
    try {
      summary = await runAutoIngestWatch({
        repoRoot,
        signal: controller.signal,
        command: "llm-wiki queue ingest --auto --watch",
        onEvent: async (event) => {
          writeQueueIngestWatchEvent(io, repoRoot, event, { json, quiet });
        },
      });
    } catch (error) {
      const commandError = toQueueIngestWatchRuntimeError(error);
      const envelope = buildRuntimeCommandFailureEnvelope("queue ingest", commandError, repoRoot);
      if (json) {
        io.stdout(JSON.stringify({
          event: "summary",
          ...envelope,
          summary: preflightFailureWatchSummary(),
        }));
      } else {
        io.stderr(`Error: ${envelope.error.message}\nHint: ${envelope.error.hint}`);
      }

      throw new CommanderError(1, "llm-wiki.queue ingest", envelope.error.message);
    }

    if (summary.exit_code !== 0) {
      const error = queueIngestWatchIncompleteError(summary);
      if (!json) {
        io.stderr(`Error: ${error.message}\nHint: ${error.hint}`);
      }

      throw new CommanderError(1, "llm-wiki.queue ingest", error.message);
    }
  } finally {
    signalHandlers.dispose();
  }
}

function batchDataFromSourceResult(result: AutoIngestSourceResult): QueueIngestData {
  const results = [result];

  return {
    agent: result.agent,
    results,
    counts: countQueueIngestResults(1, results),
  };
}

function countQueueIngestResults(
  selected: number,
  results: readonly AutoIngestSourceResult[],
): QueueIngestData["counts"] {
  const counts: QueueIngestData["counts"] = {
    selected,
    attempted: 0,
    ingested: 0,
    blocked: 0,
    skipped: 0,
    deferred: 0,
  };

  for (const result of results) {
    if (result.attempted) {
      counts.attempted += 1;
    }

    if (result.outcome === "ingested") {
      counts.ingested += 1;
    } else if (result.outcome === "blocked") {
      counts.blocked += 1;
    } else if (result.outcome === "skipped") {
      counts.skipped += 1;
    } else {
      counts.deferred += 1;
    }
  }

  return counts;
}

function queueIngestIsIncomplete(data: QueueIngestData): boolean {
  return data.results.some((result) => result.outcome !== "ingested");
}

function queueIngestIncompleteError(data: QueueIngestData): RuntimeCommandError {
  const incompleteCount = data.results.filter((result) => result.outcome !== "ingested").length;

  return new RuntimeCommandError({
    code: "QUEUE_INGEST_INCOMPLETE",
    message: `Queue auto-ingest completed with ${incompleteCount} incomplete result${incompleteCount === 1 ? "" : "s"}.`,
    path: "raw/queue",
    hint: "Review the per-source results, fix blocked or deferred sources, then rerun llm-wiki queue ingest --auto.",
  });
}

function queueIngestWatchIncompleteError(summary: AutoIngestWatchSummary): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "QUEUE_INGEST_WATCH_INCOMPLETE",
    message: `Queue auto-ingest watch completed with ${summary.failure_count} session failure${summary.failure_count === 1 ? "" : "s"}.`,
    path: "raw/queue",
    hint: "Review blocked or deferred watch results, then rerun llm-wiki queue ingest --auto --watch.",
  });
}

function queueIngestIssues(data: QueueIngestData): RuntimeIssue[] {
  return data.results
    .filter((result) => result.outcome !== "ingested")
    .map((result) => {
      const error = result.error;

      return {
        severity: "error",
        code: error?.code ?? "QUEUE_INGEST_INCOMPLETE",
        message: error?.message ?? `Queue auto-ingest ${result.outcome} for ${result.source_id}.`,
        path: error?.path ?? `raw/queue/${result.source_id}.json`,
        hint: error?.hint ?? "Review this source queue state before retrying auto-ingest.",
      };
    });
}

function formatHumanQueueList(data: QueueListResult): string {
  if (data.items.length === 0) {
    return "Queue items: 0";
  }

  const lines = [
    `Queue items: ${data.counts.total}`,
    `Counts: queued ${data.counts.queued}, ingesting ${data.counts.ingesting}, ingested ${data.counts.ingested}, blocked ${data.counts.blocked}`,
  ];

  for (const item of data.items) {
    lines.push(
      "",
      `${item.source_id} | ${item.title}`,
      `Kind: ${item.source_kind}`,
      `Status: ${item.status}`,
      `Visibility: ${item.visibility}`,
      `Updated: ${item.updated_at}`,
      `Source card: ${item.source_card_path}`,
      `Queue: ${item.queue_path}`,
      `Original: ${item.original_path}`,
    );
  }

  return lines.join("\n");
}

function formatHumanQueueShow(data: QueueShowResult): string {
  return [
    `Source ID: ${data.queue_record.source_id}`,
    `Title: ${data.queue_record.title}`,
    `Kind: ${data.queue_record.source_kind}`,
    `Status: ${data.queue_record.status}`,
    `Visibility: ${data.queue_record.visibility}`,
    `Queue: ${data.queue_record.queue_path}`,
    `Source card: ${data.source_card.path}`,
    `Original: ${data.queue_record.original_path}`,
  ].join("\n");
}

function formatHumanQueueSetStatus(data: QueueSetStatusResult): string {
  return [
    "Queue status updated",
    `Source ID: ${data.source_id}`,
    `Status: ${data.previous_status} -> ${data.status}`,
    `Updated: ${data.updated_at}`,
    `Queue: ${data.queue_path}`,
    `Source card: ${data.source_card_path}`,
    `Log: ${data.log_path}`,
  ].join("\n");
}

function formatHumanQueueIngest(data: QueueIngestData): string {
  const lines = [
    "Queue auto-ingest results",
    `Agent: ${data.agent ?? "(not resolved)"}`,
    `Selected: ${data.counts.selected}`,
    `Attempted: ${data.counts.attempted}`,
    `Counts: ingested ${data.counts.ingested}, blocked ${data.counts.blocked}, skipped ${data.counts.skipped}, deferred ${data.counts.deferred}`,
  ];

  if (data.results.length === 0) {
    lines.push("", "No eligible queued sources.");
    return lines.join("\n");
  }

  for (const result of data.results) {
    lines.push(
      "",
      `${result.source_id} | ${result.outcome} | ${result.attempted ? "attempted" : "not attempted"}`,
      `Status: ${result.previous_status ?? "(missing)"} -> ${result.final_status ?? "(missing)"}`,
    );

    if (result.applied_paths.length > 0) {
      lines.push(`Applied: ${result.applied_paths.join(", ")}`);
    }

    if (result.error !== null) {
      lines.push(`Error: ${result.error.code}: ${result.error.message}`, `Hint: ${result.error.hint}`);
      if (result.error.issues !== undefined && result.error.issues.length > 0) {
        lines.push(
          "Issues:",
          ...result.error.issues.map((issue) => `- ${issue.code} (${issue.path}): ${issue.message}`),
        );
      }
    }
  }

  return lines.join("\n");
}

function writeQueueIngestWatchEvent(
  io: CliIo,
  repoRoot: string,
  event: AutoIngestWatchEvent,
  options: { json: boolean; quiet: boolean },
): void {
  if (options.json) {
    io.stdout(JSON.stringify(formatJsonQueueIngestWatchEvent(repoRoot, event)));
    return;
  }

  if (options.quiet) {
    return;
  }

  if (event.event === "result") {
    io.stdout(formatHumanQueueIngestWatchResult(event.result));
  } else {
    io.stdout(formatHumanQueueIngestWatchSummary(event.summary));
  }
}

function formatJsonQueueIngestWatchEvent(repoRoot: string, event: AutoIngestWatchEvent): Record<string, unknown> {
  if (event.event === "result") {
    return {
      event: "result",
      command: "queue ingest",
      repo: repoRoot,
      agent: event.agent,
      result: event.result,
      counts: event.counts,
    };
  }

  return {
    event: "summary",
    ok: event.summary.exit_code === 0,
    command: "queue ingest",
    repo: repoRoot,
    summary: event.summary,
  };
}

function formatHumanQueueIngestWatchResult(result: AutoIngestSourceResult): string {
  const lines = [
    "Queue auto-ingest watch result",
    `${result.source_id} | ${result.outcome} | ${result.attempted ? "attempted" : "not attempted"}`,
    `Status: ${result.previous_status ?? "(missing)"} -> ${result.final_status ?? "(missing)"}`,
  ];

  if (result.applied_paths.length > 0) {
    lines.push(`Applied: ${result.applied_paths.join(", ")}`);
  }

  if (result.error !== null) {
    lines.push(`Error: ${result.error.code}: ${result.error.message}`, `Hint: ${result.error.hint}`);
  }

  return lines.join("\n");
}

function formatHumanQueueIngestWatchSummary(summary: AutoIngestWatchSummary): string {
  return [
    "Queue auto-ingest watch summary",
    `Agent: ${summary.agent}`,
    `Selected: ${summary.counts.selected}`,
    `Attempted: ${summary.counts.attempted}`,
    `Counts: ingested ${summary.counts.ingested}, blocked ${summary.counts.blocked}, skipped ${summary.counts.skipped}, deferred ${summary.counts.deferred}`,
    `Interrupted: ${summary.interrupted ? "yes" : "no"}`,
    `Session failures: ${summary.failure_count}`,
  ].join("\n");
}

function preflightFailureWatchSummary(): Omit<AutoIngestWatchSummary, "agent"> & { agent: null } {
  return {
    agent: null,
    counts: {
      selected: 0,
      attempted: 0,
      ingested: 0,
      blocked: 0,
      skipped: 0,
      deferred: 0,
    },
    interrupted: false,
    failure_count: 1,
    exit_code: 1,
  };
}

function installQueueIngestWatchSignalHandlers(controller: AbortController): { dispose: () => void } {
  const onSigint = (): void => {
    controller.abort();
  };
  const onSigterm = (): void => {
    controller.abort();
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return {
    dispose: () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

function toQueueIngestWatchRuntimeError(error: unknown): RuntimeCommandError {
  if (error instanceof RuntimeCommandError) {
    return error;
  }

  return new RuntimeCommandError({
    code: "QUEUE_INGEST_WATCH_FAILED",
    message: error instanceof Error ? error.message : String(error),
    path: "raw/queue",
    hint: "Fix the repository state, then rerun llm-wiki queue ingest --auto --watch.",
  });
}

function throwQueueCommandError(
  io: CliIo,
  command: "queue" | "queue ingest" | "queue show" | "queue set-status",
  repo: string,
  error: QueueCliCommandError,
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

function throwMissingQueueArgument(
  io: CliIo,
  command: "queue show" | "queue set-status",
  argument: "source_id" | "status",
  json: boolean,
): never {
  const message = `Missing required argument: ${argument}`;
  if (json) {
    io.stdout(
      JSON.stringify({
        ok: false,
        command,
        repo: "",
        error: {
          code: "QUEUE_ARGUMENT_MISSING",
          message,
          hint: "Pass the required queue command argument.",
        },
        issues: [
          {
            severity: "error",
            code: "QUEUE_ARGUMENT_MISSING",
            message,
            path: argument,
            hint: "Pass the required queue command argument.",
          },
        ],
      }),
    );
  } else {
    io.stderr(`Error: ${message}`);
  }

  throw new CommanderError(1, `llm-wiki.${command}`, message);
}
