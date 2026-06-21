import { type Command } from "commander";

import type { CliIo } from "../cli.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { searchWiki, type SearchScope, type SearchWikiResult } from "../search/index.js";

type RawSearchOptions = RawRuntimeCommandOptions & {
  scope?: unknown;
};

export function registerSearchCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("search")
      .description("Search local wiki Markdown without Quartz or network access")
      .argument("<query>", "search query")
      .option("--scope <scope>", "search scope: raw, curated, or all", "all"),
  ).action(async (query: string, rawOptions: RawSearchOptions) => {
    await runRuntimeCommand({
      command: "search",
      rawOptions,
      io,
      run: async ({ repo }) => ({
        data: await searchWiki(repo.rootDir, query, {
          scope: normalizeSearchScope(rawOptions.scope),
        }),
      }),
      formatHuman: (envelope) => formatHumanSearch(envelope.data),
    });
  });
}

function normalizeSearchScope(value: unknown): SearchScope {
  if (value === "raw" || value === "curated" || value === "all") {
    return value;
  }

  throw new RuntimeCommandError({
    code: "INVALID_SEARCH_SCOPE",
    message: `Invalid search scope: ${String(value)}`,
    hint: "Use --scope raw, --scope curated, or --scope all.",
    path: "--scope",
  });
}

function formatHumanSearch(data: SearchWikiResult): string {
  if (data.results.length === 0) {
    return `Search results: 0\nQuery: ${data.query}\nScope: ${data.scope}`;
  }

  const lines = [`Search results: ${data.results.length}`, `Query: ${data.query}`, `Scope: ${data.scope}`];
  for (const result of data.results) {
    lines.push(
      "",
      `${result.title} | ${result.path}`,
      `Type: ${result.page_type}`,
      `Score: ${result.score}`,
      `Fields: ${result.match_fields.join(", ")}`,
      `Snippet: ${result.snippet}`,
    );
  }

  return lines.join("\n");
}
