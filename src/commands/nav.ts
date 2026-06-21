import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import {
  getBacklinks,
  getGraph,
  getOrphans,
  getOutlinks,
  getPageSources,
  type NavGraphResult,
  type NavLinksResult,
  type NavOrphansResult,
  type NavSourcesResult,
} from "../nav/index.js";

export function registerNavCommand(program: Command, io: CliIo): void {
  const navCommand = program.command("nav").description("Inspect wiki links, source relations, and graph shape");

  addRuntimeOptions(navCommand.command("backlinks").argument("<page>", "page path or title")).action(
    async (page: string, rawOptions: RawRuntimeCommandOptions) => {
      await runRuntimeCommand({
        command: "nav backlinks",
        rawOptions,
        io,
        run: async ({ repo }) => ({
          data: await getBacklinks(repo.rootDir, page),
        }),
        formatHuman: (envelope) => formatHumanLinks("Backlinks", envelope.data),
      });
    },
  );

  addRuntimeOptions(navCommand.command("outlinks").argument("<page>", "page path or title")).action(
    async (page: string, rawOptions: RawRuntimeCommandOptions) => {
      await runRuntimeCommand({
        command: "nav outlinks",
        rawOptions,
        io,
        run: async ({ repo }) => ({
          data: await getOutlinks(repo.rootDir, page),
        }),
        formatHuman: (envelope) => formatHumanLinks("Outlinks", envelope.data),
      });
    },
  );

  addRuntimeOptions(navCommand.command("sources").argument("<page>", "page path or title")).action(
    async (page: string, rawOptions: RawRuntimeCommandOptions) => {
      await runRuntimeCommand({
        command: "nav sources",
        rawOptions,
        io,
        run: async ({ repo }) => ({
          data: await getPageSources(repo.rootDir, page),
        }),
        formatHuman: (envelope) => formatHumanSources(envelope.data),
      });
    },
  );

  addRuntimeOptions(navCommand.command("orphans")).action(async (rawOptions: RawRuntimeCommandOptions) => {
    await runRuntimeCommand({
      command: "nav orphans",
      rawOptions,
      io,
      run: async ({ repo }) => ({
        data: await getOrphans(repo.rootDir),
      }),
      formatHuman: (envelope) => formatHumanOrphans(envelope.data),
    });
  });

  addRuntimeOptions(navCommand.command("graph")).action(async (rawOptions: RawRuntimeCommandOptions) => {
    await runRuntimeCommand({
      command: "nav graph",
      rawOptions,
      io,
      run: async ({ repo }) => ({
        data: await getGraph(repo.rootDir),
      }),
      formatHuman: (envelope) => formatHumanGraph(envelope.data),
    });
  });

  navCommand.action(() => {
    throw new CommanderError(1, "llm-wiki.nav", "Missing nav action.");
  });
}

function formatHumanLinks(label: string, data: NavLinksResult): string {
  const lines = [`${label}: ${data.links.length}`, `Page: ${data.page.path}`];
  for (const link of data.links) {
    lines.push("", `${link.raw} -> ${link.to_path ?? "(unresolved)"}`, `From: ${link.from_path}:${link.line}`);
  }

  return lines.join("\n");
}

function formatHumanSources(data: NavSourcesResult): string {
  const lines = [`Sources: ${data.sources.length}`, `Page: ${data.page.path}`];
  for (const source of data.sources) {
    lines.push(
      "",
      `${source.source_id} | ${source.title}`,
      `Source card: ${source.source_card_path ?? "(missing)"}`,
      `Summary: ${source.summary_path ?? "(missing)"}`,
    );
  }

  return lines.join("\n");
}

function formatHumanOrphans(data: NavOrphansResult): string {
  if (data.orphans.length === 0) {
    return "Orphans: 0";
  }

  return ["Orphans: " + data.orphans.length, ...data.orphans.map((page) => `${page.path} | ${page.title}`)].join("\n");
}

function formatHumanGraph(data: NavGraphResult): string {
  return [`Graph nodes: ${data.nodes.length}`, `Graph edges: ${data.edges.length}`].join("\n");
}
