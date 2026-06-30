import { CommanderError, type Command } from "commander";

import {
  runAutoIngestBatch,
  runAutoIngestSource,
  type AutoIngestBatchResult,
  type AutoIngestSourceResult,
} from "../autoIngest/index.js";
import type { CliIo } from "../cli.js";
import {
  addRuntimeOptions,
  runRuntimeCommand,
  type RawRuntimeCommandOptions,
  type RuntimeCommandOptions,
} from "../runtime/command.js";
import {
  buildRuntimeCommandFailureEnvelope,
  buildRuntimeFailureEnvelope,
  buildRuntimeSuccessEnvelope,
  type RuntimeSuccessEnvelope,
} from "../runtime/envelope.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import {
  listQueue,
  setQueueStatus,
  showQueueSource,
  type QueueCommandError,
  type QueueListResult,
  type QueueSetStatusResult,
  type QueueShowResult,
} from "../runtime/queue.js";
import { resolveWikiRoot } from "../runtime/repo.js";

type RawQueueCommandOptions = RawRuntimeCommandOptions & {
  auto?: unknown;
  limit?: unknown;
  sourceId?: unknown;
  watch?: unknown;
};

type QueueIngestData = {
  agent: string | null;
  results: AutoIngestSourceResult[];
  counts: AutoIngestBatchResult["counts"];
};

type QueueIngestRequest = {
  sourceId: string | undefined;
  limit: number | undefined;
  watch: boolean;
};

const QUEUE_INGEST_WATCH_INTERVAL_MS = 1_000;
const QUEUE_INGEST_WATCH_RECENT_RESULTS_LIMIT = 25;

export function registerQueueCommand(program: Command, io: CliIo): void {
  const queueCommand = addRuntimeOptions(
    program
      .command("queue")
      .description("List and manage raw source queue items")
      .argument("[action]", "optional action: show or set-status")
      .argument("[source_id]", "source ID for show or set-status")
      .argument("[status]", "next status for set-status")
      .option("--auto", "run queue ingest with the configured default local agent", false)
      .option("--limit <n>", "maximum number of queued sources to auto-ingest")
      .option("--source-id <source_id>", "auto-ingest only one source ID")
      .option("--watch", "keep processing newly queued sources until interrupted", false),
  );

  queueCommand.action(async (
    action: string | undefined,
    sourceId: string | undefined,
    status: string | undefined,
    rawOptions: RawQueueCommandOptions | Command,
  ) => {
    const runtimeOptions = normalizeCommanderOptions(rawOptions);

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

    if (action === "ingest") {
      if (runtimeOptions.auto !== true) {
        throwQueueCommandError(
          io,
          "queue ingest",
          "",
          {
            code: "QUEUE_ACTION_INVALID",
            message: "queue ingest requires --auto.",
            path: "--auto",
            hint: "Run llm-wiki queue ingest --auto, optionally with --limit <n>, --source-id <source_id>, or --watch.",
          },
          runtimeOptions.json === true,
        );
      }

      await runQueueIngestCommand({
        io,
        rawOptions: runtimeOptions,
        positionalSourceId: sourceId,
        extraStatusArgument: status,
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

    throwQueueCommandError(
      io,
      "queue",
      "",
      {
        code: "QUEUE_ACTION_INVALID",
        message: `Unknown queue action: ${action}`,
        path: "action",
        hint: "Use llm-wiki queue, llm-wiki queue show <source_id>, llm-wiki queue set-status <source_id> <status>, or llm-wiki queue ingest --auto.",
      },
      runtimeOptions.json === true,
    );
  });
}

async function runQueueIngestCommand(input: {
  io: CliIo;
  rawOptions: RawQueueCommandOptions;
  positionalSourceId: string | undefined;
  extraStatusArgument: string | undefined;
}): Promise<void> {
  const options = normalizeRuntimeOptions(input.rawOptions);
  const resolvedRepo = await resolveWikiRoot({ repoPath: options.repo });

  if (!resolvedRepo.ok) {
    const envelope = buildRuntimeFailureEnvelope("queue ingest", resolvedRepo.error);
    if (options.json) {
      input.io.stdout(JSON.stringify(envelope));
    } else {
      input.io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.queue ingest", envelope.error.message);
  }

  try {
    const request = normalizeQueueIngestRequest(
      input.rawOptions,
      input.positionalSourceId,
      input.extraStatusArgument,
    );
    const data = request.watch
      ? await runQueueIngestWatch(resolvedRepo.value.rootDir, request)
      : await runQueueIngestOnce(resolvedRepo.value.rootDir, request);
    const envelope = buildRuntimeSuccessEnvelope("queue ingest", resolvedRepo.value.rootDir, data, []);

    if (options.json) {
      input.io.stdout(JSON.stringify(envelope));
    } else if (!options.quiet) {
      input.io.stdout(formatHumanQueueIngest(envelope));
    }

    if (queueIngestNeedsAttention(data)) {
      const message = "Auto-ingest completed with work requiring attention.";
      if (!options.json && options.quiet) {
        input.io.stderr(`Error: ${message}`);
      }

      throw new CommanderError(
        1,
        "llm-wiki.queue ingest",
        message,
      );
    }
  } catch (error) {
    if (error instanceof CommanderError) {
      throw error;
    }

    const commandError = error instanceof RuntimeCommandError
      ? error
      : new RuntimeCommandError({
          code: "QUEUE_INGEST_FAILED",
          message: error instanceof Error ? error.message : String(error),
          hint: "Fix the queue, agent configuration, or repository state, then rerun llm-wiki queue ingest --auto.",
          path: ".",
        });
    const envelope = buildRuntimeCommandFailureEnvelope("queue ingest", commandError, resolvedRepo.value.rootDir);

    if (options.json) {
      input.io.stdout(JSON.stringify(envelope));
    } else {
      input.io.stderr(`Error: ${envelope.error.message}\nHint: ${envelope.error.hint}`);
    }

    throw new CommanderError(1, "llm-wiki.queue ingest", envelope.error.message);
  }
}

function normalizeQueueIngestRequest(
  rawOptions: RawQueueCommandOptions,
  positionalSourceId: string | undefined,
  extraStatusArgument: string | undefined,
): QueueIngestRequest {
  if (extraStatusArgument !== undefined) {
    throw new RuntimeCommandError({
      code: "QUEUE_ARGUMENT_INVALID",
      message: "queue ingest received too many positional arguments.",
      path: "status",
      hint: "Run llm-wiki queue ingest --auto, optionally with --source-id <source_id>.",
    });
  }

  const optionSourceId = typeof rawOptions.sourceId === "string" ? rawOptions.sourceId : undefined;
  if (positionalSourceId !== undefined && optionSourceId !== undefined && positionalSourceId !== optionSourceId) {
    throw new RuntimeCommandError({
      code: "QUEUE_ARGUMENT_INVALID",
      message: "queue ingest received conflicting source IDs.",
      path: "--source-id",
      hint: "Pass the source ID once, preferably with --source-id <source_id>.",
    });
  }

  return {
    sourceId: optionSourceId ?? positionalSourceId,
    limit: normalizeQueueIngestLimit(rawOptions.limit),
    watch: rawOptions.watch === true,
  };
}

function normalizeQueueIngestLimit(rawLimit: unknown): number | undefined {
  if (rawLimit === undefined) {
    return undefined;
  }

  if (typeof rawLimit !== "string" || rawLimit.trim() === "") {
    throw new RuntimeCommandError({
      code: "QUEUE_LIMIT_INVALID",
      message: `Invalid queue ingest limit: ${String(rawLimit)}.`,
      path: "--limit",
      hint: "Use a non-negative integer limit, such as --limit 1.",
    });
  }

  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RuntimeCommandError({
      code: "QUEUE_LIMIT_INVALID",
      message: `Invalid queue ingest limit: ${rawLimit}.`,
      path: "--limit",
      hint: "Use a non-negative integer limit, such as --limit 1.",
    });
  }

  return limit;
}

async function runQueueIngestOnce(repoRoot: string, request: QueueIngestRequest): Promise<QueueIngestData> {
  if (request.sourceId !== undefined) {
    const result = await runAutoIngestSource({
      repoRoot,
      sourceId: request.sourceId,
      command: `llm-wiki queue ingest --auto --source-id ${request.sourceId}`,
    });

    return {
      agent: result.agent,
      results: [result],
      counts: countQueueIngestResults(1, [result]),
    };
  }

  const result = await runAutoIngestBatch({
    repoRoot,
    limit: request.limit,
    command: "llm-wiki queue ingest --auto",
  });

  return result;
}

async function runQueueIngestWatch(repoRoot: string, request: QueueIngestRequest): Promise<QueueIngestData> {
  const aggregate: QueueIngestData = emptyQueueIngestData();
  let stopRequested = false;
  let wakeWatch: (() => void) | undefined;
  const onSignal = (): void => {
    stopRequested = true;
    wakeWatch?.();
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    do {
      mergeQueueIngestData(aggregate, await runQueueIngestOnce(repoRoot, request));
      if (!stopRequested) {
        await waitForQueueIngestWatchTick(() => stopRequested, (wake) => {
          wakeWatch = wake;
        });
        wakeWatch = undefined;
      }
    } while (!stopRequested);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  return aggregate;
}

async function waitForQueueIngestWatchTick(
  stopped: () => boolean,
  setWake: (wake: () => void) => void,
): Promise<void> {
  if (stopped()) {
    return;
  }

  await new Promise<void>((resolveTick) => {
    const timeout = setTimeout(resolveTick, QUEUE_INGEST_WATCH_INTERVAL_MS);
    setWake(() => {
      clearTimeout(timeout);
      resolveTick();
    });
  });
}

function emptyQueueIngestData(): QueueIngestData {
  return {
    agent: null,
    results: [],
    counts: countQueueIngestResults(0, []),
  };
}

function mergeQueueIngestData(target: QueueIngestData, next: QueueIngestData): void {
  target.agent ??= next.agent;
  target.results.push(...next.results);
  if (target.results.length > QUEUE_INGEST_WATCH_RECENT_RESULTS_LIMIT) {
    target.results.splice(0, target.results.length - QUEUE_INGEST_WATCH_RECENT_RESULTS_LIMIT);
  }
  target.counts.selected += next.counts.selected;
  target.counts.attempted += next.counts.attempted;
  target.counts.ingested += next.counts.ingested;
  target.counts.blocked += next.counts.blocked;
  target.counts.skipped += next.counts.skipped;
  target.counts.deferred += next.counts.deferred;
}

function countQueueIngestResults(
  selected: number,
  results: readonly AutoIngestSourceResult[],
): AutoIngestBatchResult["counts"] {
  const counts: AutoIngestBatchResult["counts"] = {
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

function queueIngestNeedsAttention(data: QueueIngestData): boolean {
  return data.counts.blocked > 0 || data.counts.deferred > 0 || data.counts.skipped > 0;
}

function normalizeRuntimeOptions(rawOptions: RawRuntimeCommandOptions): RuntimeCommandOptions {
  return {
    repo: typeof rawOptions.repo === "string" ? rawOptions.repo : undefined,
    json: rawOptions.json === true,
    quiet: rawOptions.quiet === true,
  };
}

function normalizeCommanderOptions(rawOptions: RawQueueCommandOptions | Command): RawQueueCommandOptions {
  if (isCommanderCommand(rawOptions)) {
    return rawOptions.opts() as RawQueueCommandOptions;
  }

  return rawOptions;
}

function isCommanderCommand(value: RawQueueCommandOptions | Command): value is Command {
  return typeof (value as { opts?: unknown }).opts === "function";
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

function formatHumanQueueIngest(envelope: RuntimeSuccessEnvelope<"queue ingest", QueueIngestData>): string {
  const data = envelope.data;
  const lines = [
    `Queue auto-ingest selected: ${data.counts.selected}`,
    `Counts: attempted ${data.counts.attempted}, ingested ${data.counts.ingested}, blocked ${data.counts.blocked}, skipped ${data.counts.skipped}, deferred ${data.counts.deferred}`,
  ];

  for (const result of data.results) {
    lines.push(
      "",
      `${result.source_id} | ${result.outcome}`,
      `Final status: ${result.final_status ?? "unknown"}`,
      `Attempted: ${result.attempted ? "yes" : "no"}`,
    );

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

function throwQueueCommandError(
  io: CliIo,
  command: "queue" | "queue show" | "queue set-status" | "queue ingest",
  repo: string,
  error: QueueCommandError,
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
