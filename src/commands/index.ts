import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import { rebuildIndexCache, type IndexRebuildResult } from "../index/rebuild.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";

export function registerIndexCommand(program: Command, io: CliIo): void {
  const indexCommand = program.command("index").description("Maintain rebuildable wiki index caches");

  addRuntimeOptions(indexCommand.command("rebuild").description("Rebuild cache files from Markdown and raw state")).action(
    async (rawOptions: RawRuntimeCommandOptions) => {
      await runRuntimeCommand({
        command: "index rebuild",
        rawOptions,
        io,
        run: async ({ repo, options }) => {
          try {
            return {
              data: await rebuildIndexCache(repo.rootDir),
            };
          } catch (error) {
            throwIndexRebuildError(io, repo.rootDir, error, options.json);
          }
        },
        formatHuman: (envelope) => formatHumanIndexRebuild(envelope.data),
      });
    },
  );

  indexCommand.action(() => {
    throw new CommanderError(1, "llm-wiki.index", "Missing index action. Use llm-wiki index rebuild.");
  });
}

function formatHumanIndexRebuild(data: IndexRebuildResult): string {
  return [
    "Index cache rebuilt",
    `Cache files: ${data.cache_files.length}`,
    `Pages: ${data.pages}`,
    `Sources: ${data.sources}`,
    `Queue items: ${data.queue_items}`,
    `Links: ${data.links}`,
    `Content hash: ${data.content_hash}`,
  ].join("\n");
}

function throwIndexRebuildError(io: CliIo, repoRoot: string, error: unknown, json: boolean): never {
  const message = error instanceof Error ? error.message : String(error);
  const envelope = {
    ok: false,
    command: "index rebuild" as const,
    repo: repoRoot,
    error: {
      code: "INDEX_REBUILD_FAILED",
      message,
      hint: "Fix unsafe or unwritable generated cache paths, then rerun llm-wiki index rebuild.",
    },
    issues: [
      {
        severity: "error" as const,
        code: "INDEX_REBUILD_FAILED",
        message,
        path: indexRebuildIssuePath(message),
        hint: "Generated cache writes must stay inside .llm-wiki/cache and must not follow symlinks.",
      },
    ],
  };

  if (json) {
    io.stdout(JSON.stringify(envelope));
  } else {
    io.stderr(`Error: ${message}`);
  }

  throw new CommanderError(1, "llm-wiki.index rebuild", message);
}

function indexRebuildIssuePath(message: string): string {
  const cachePaths = [...message.matchAll(/\.llm-wiki\/cache(?:\/[^\s:]+)?/g)].map((match) => match[0]);
  return cachePaths.at(-1) ?? ".llm-wiki/cache";
}
