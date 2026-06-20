import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import {
  listQueue,
  setQueueStatus,
  showQueueSource,
  type QueueCommandError,
  type QueueListResult,
  type QueueSetStatusResult,
  type QueueShowResult,
} from "../runtime/queue.js";

export function registerQueueCommand(program: Command, io: CliIo): void {
  const queueCommand = addRuntimeOptions(
    program
      .command("queue")
      .description("List and manage raw source queue items")
      .argument("[action]", "optional action: show or set-status")
      .argument("[source_id]", "source ID for show or set-status")
      .argument("[status]", "next status for set-status"),
  );

  queueCommand.action(async (
    action: string | undefined,
    sourceId: string | undefined,
    status: string | undefined,
    rawOptions: RawRuntimeCommandOptions | Command,
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
        hint: "Use llm-wiki queue, llm-wiki queue show <source_id>, or llm-wiki queue set-status <source_id> <status>.",
      },
      runtimeOptions.json === true,
    );
  });
}

function normalizeCommanderOptions(rawOptions: RawRuntimeCommandOptions | Command): RawRuntimeCommandOptions {
  if (isCommanderCommand(rawOptions)) {
    return rawOptions.opts() as RawRuntimeCommandOptions;
  }

  return rawOptions;
}

function isCommanderCommand(value: RawRuntimeCommandOptions | Command): value is Command {
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

function throwQueueCommandError(
  io: CliIo,
  command: "queue" | "queue show" | "queue set-status",
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
