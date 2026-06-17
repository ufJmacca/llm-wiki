import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import { DEFAULT_INIT_OPTIONS, type InitAgent, SUPPORTED_INIT_AGENTS } from "../config/defaults.js";
import { createWiki } from "../scaffold/createWiki.js";
import { resolveSafeTargetPath, type ScaffoldWriteReport } from "../utils/fs.js";
import { ok, type Result } from "../utils/result.js";
import type { CliIo } from "../cli.js";

export type InitOptions = {
  agent: InitAgent;
  obsidian: boolean;
  dataview: boolean;
  git: boolean;
  quartzReady: boolean;
  force: boolean;
  json: boolean;
};

export type InitCommandOutput = {
  command: "init";
  targetDir: string;
  options: InitOptions;
  scaffold: ScaffoldWriteReport;
};

type RawInitOptions = Partial<Record<keyof InitOptions, unknown>>;
type PreparedInitCommand = Omit<InitCommandOutput, "scaffold">;

export function parseInitAgent(value: string): InitAgent {
  if (isInitAgent(value)) {
    return value;
  }

  throw new InvalidArgumentError(
    `unsupported agent "${value}"; expected one of ${SUPPORTED_INIT_AGENTS.join(", ")}`,
  );
}

export function registerInitCommand(program: Command, io: CliIo): void {
  program
    .command("init")
    .description("Initialize a new LLM Wiki workspace")
    .argument("<dir>", "wiki directory to initialize")
    .addOption(
      new Option("--agent <agent>", "agent instruction profile")
        .default(DEFAULT_INIT_OPTIONS.agent)
        .argParser(parseInitAgent),
    )
    .option("--obsidian", "record Obsidian starter config intent", DEFAULT_INIT_OPTIONS.obsidian)
    .option("--dataview", "record Dataview dashboard intent", DEFAULT_INIT_OPTIONS.dataview)
    .option("--git", "record Git initialization intent", DEFAULT_INIT_OPTIONS.git)
    .option("--no-git", "disable Git initialization intent")
    .option("--quartz-ready", "record future Quartz Explorer readiness intent", DEFAULT_INIT_OPTIONS.quartzReady)
    .option("--force", "allow replacing existing generated files in later scaffold slices", DEFAULT_INIT_OPTIONS.force)
    .option("--json", "print machine-readable command dispatch output", DEFAULT_INIT_OPTIONS.json)
    .action(async (targetDir: string, rawOptions: RawInitOptions) => {
      const prepared = prepareInitCommand(targetDir, rawOptions);

      if (!prepared.ok) {
        throwCommandError(io, prepared.error);
        return;
      }

      const scaffold = await createWiki(prepared.value.targetDir, prepared.value.options);
      if (!scaffold.ok) {
        throwCommandError(io, scaffold.error);
        return;
      }

      const output: InitCommandOutput = {
        ...prepared.value,
        scaffold: scaffold.value,
      };

      if (output.options.json) {
        io.stdout(JSON.stringify(output));
        return;
      }

      io.stdout(`llm-wiki initialized ${output.targetDir}`);
    });
}

export function prepareInitCommand(
  targetDir: string,
  rawOptions: RawInitOptions = {},
): Result<PreparedInitCommand> {
  const options = normalizeInitOptions(rawOptions);
  const safeTargetDir = resolveSafeTargetPath(targetDir);
  if (!safeTargetDir.ok) {
    return safeTargetDir;
  }

  return ok({
    command: "init",
    targetDir: safeTargetDir.value,
    options,
  });
}

function normalizeInitOptions(rawOptions: RawInitOptions): InitOptions {
  return {
    agent: normalizeAgent(rawOptions.agent),
    obsidian: normalizeBoolean(rawOptions.obsidian, DEFAULT_INIT_OPTIONS.obsidian),
    dataview: normalizeBoolean(rawOptions.dataview, DEFAULT_INIT_OPTIONS.dataview),
    git: normalizeBoolean(rawOptions.git, DEFAULT_INIT_OPTIONS.git),
    quartzReady: normalizeBoolean(rawOptions.quartzReady, DEFAULT_INIT_OPTIONS.quartzReady),
    force: normalizeBoolean(rawOptions.force, DEFAULT_INIT_OPTIONS.force),
    json: normalizeBoolean(rawOptions.json, DEFAULT_INIT_OPTIONS.json),
  };
}

function normalizeAgent(value: unknown): InitAgent {
  if (typeof value === "string") {
    return parseInitAgent(value);
  }

  return DEFAULT_INIT_OPTIONS.agent;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isInitAgent(value: string): value is InitAgent {
  return SUPPORTED_INIT_AGENTS.includes(value as InitAgent);
}

function throwCommandError(io: CliIo, error: Error): never {
  io.stderr(error.message);
  throw new CommanderError(1, "llm-wiki.init", error.message);
}
