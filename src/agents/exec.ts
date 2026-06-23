import { spawn, type ChildProcess } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, resolve, win32 } from "node:path";

import type { LocalAgentConfig } from "../runtime/config.js";
import { err, ok, type Result } from "../utils/result.js";

export type LocalAgentAvailability = {
  agentName: string;
  command: string;
  executablePath: string;
  resolvedFrom: "absolute" | "path";
};

export type LocalAgentAvailabilityError = {
  code: "AGENT_COMMAND_UNAVAILABLE";
  agentName: string;
  command: string;
  executablePath: string;
  message: string;
  hint: string;
};

export type LocalAgentAvailabilityOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  pathExt?: string;
};

export type CapturedAgentOutput = {
  text: string;
  truncated: boolean;
  maxBytes: number;
};

export type LocalAgentCommandResult = {
  agentName: string;
  executablePath: string;
  args: string[];
  exitCode: 0;
  signal: null;
  timedOut: false;
  stdout: CapturedAgentOutput;
  stderr: CapturedAgentOutput;
};

export type RunLocalAgentCommandInput = {
  agent: LocalAgentConfig;
  cwd: string;
  taskPrompt: string;
  changesObserved: boolean;
  env?: NodeJS.ProcessEnv;
  outputLimitBytes?: number;
  platform?: NodeJS.Platform;
  timeoutKillGraceMs?: number;
};

export type LocalAgentExecutionErrorOptions = {
  code: "AGENT_COMMAND_UNAVAILABLE" | "AGENT_COMMAND_SPAWN_FAILED" | "AGENT_COMMAND_FAILED" | "AGENT_COMMAND_TIMEOUT";
  message: string;
  hint: string;
  agentName: string;
  command: string;
  executablePath: string;
  argsSummary: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderrTail: string;
  changesObserved: boolean;
};

export class LocalAgentExecutionError extends Error {
  readonly code: LocalAgentExecutionErrorOptions["code"];
  readonly hint: string;
  readonly agentName: string;
  readonly command: string;
  readonly executablePath: string;
  readonly argsSummary: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stderrTail: string;
  readonly changesObserved: boolean;
  readonly changes_observed: boolean;

  constructor(options: LocalAgentExecutionErrorOptions) {
    super(options.message);
    this.name = "LocalAgentExecutionError";
    this.code = options.code;
    this.hint = options.hint;
    this.agentName = options.agentName;
    this.command = options.command;
    this.executablePath = options.executablePath;
    this.argsSummary = options.argsSummary;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.timedOut = options.timedOut;
    this.stderrTail = options.stderrTail;
    this.changesObserved = options.changesObserved;
    this.changes_observed = options.changesObserved;
  }
}

const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_KILL_GRACE_MS = 5_000;
const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_LAUNCHABLE_EXTENSIONS = new Set([".bat", ".cmd", ".com", ".exe"]);
const CODEX_GLOBAL_FLAGS_WITH_VALUE = new Set([
  "-a",
  "--add-dir",
  "--ask-for-approval",
  "-C",
  "-c",
  "--cd",
  "--config",
  "--disable",
  "--enable",
  "-i",
  "--image",
  "--local-provider",
  "-m",
  "--model",
  "-p",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "-s",
  "--sandbox",
]);
const CODEX_GLOBAL_BOOLEAN_FLAGS = new Set([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--no-alt-screen",
  "--oss",
  "--search",
  "--strict-config",
]);

export async function checkLocalAgentAvailability(
  agent: Pick<LocalAgentConfig, "name" | "command">,
  options: LocalAgentAvailabilityOptions = {},
): Promise<Result<LocalAgentAvailability, LocalAgentAvailabilityError>> {
  if (isAbsolute(agent.command)) {
    if (await isExecutableFile(agent.command, options)) {
      return ok({
        agentName: agent.name,
        command: agent.command,
        executablePath: agent.command,
        resolvedFrom: "absolute",
      });
    }

    return unavailableAgentCommand({
      agentName: agent.name,
      command: agent.command,
      executablePath: agent.command,
      hint: "Ensure the configured absolute agent command exists and is executable.",
    });
  }

  const executablePath = await resolveCommandFromPath(agent.command, options);
  if (executablePath !== null) {
    return ok({
      agentName: agent.name,
      command: agent.command,
      executablePath,
      resolvedFrom: "path",
    });
  }

  return unavailableAgentCommand({
    agentName: agent.name,
    command: agent.command,
    executablePath: agent.command,
    hint: "Install the local agent CLI or update PATH so the configured command can be resolved.",
  });
}

export async function runLocalAgentCommand(input: RunLocalAgentCommandInput): Promise<LocalAgentCommandResult> {
  const outputLimitBytes = normalizeOutputLimit(input.outputLimitBytes);
  const args = [...input.agent.args, input.taskPrompt];
  const argsSummary = summarizeArgs(input.agent.args);
  const availability = await checkLocalAgentAvailability(input.agent, {
    cwd: input.cwd,
    env: input.env,
    platform: input.platform,
  });

  if (!availability.ok) {
    throw new LocalAgentExecutionError({
      code: "AGENT_COMMAND_UNAVAILABLE",
      message: availability.error.message,
      hint: availability.error.hint,
      agentName: input.agent.name,
      command: input.agent.command,
      executablePath: availability.error.executablePath,
      argsSummary,
      exitCode: null,
      signal: null,
      timedOut: false,
      stderrTail: "",
      changesObserved: input.changesObserved,
    });
  }

  const stdout = createTailCapture(outputLimitBytes);
  const stderr = createTailCapture(outputLimitBytes);
  const spawnPlan = createSpawnPlan({
    agentName: input.agent.name,
    executablePath: availability.value.executablePath,
    args: input.agent.args,
    taskPrompt: input.taskPrompt,
    env: input.env,
    platform: input.platform ?? process.platform,
  });

  return new Promise((resolveRun, rejectRun) => {
    let timedOut = false;
    let timeout: NodeJS.Timeout | null = null;
    let killTimeout: NodeJS.Timeout | null = null;
    let settled = false;

    const clearRunTimers = (): void => {
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }

      if (killTimeout !== null) {
        clearTimeout(killTimeout);
        killTimeout = null;
      }
    };

    const rejectWithExecutionError = (options: {
      code: "AGENT_COMMAND_SPAWN_FAILED" | "AGENT_COMMAND_FAILED" | "AGENT_COMMAND_TIMEOUT";
      message: string;
      hint: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
    }): void => {
      rejectRun(new LocalAgentExecutionError({
        code: options.code,
        message: options.message,
        hint: options.hint,
        agentName: input.agent.name,
        command: input.agent.command,
        executablePath: availability.value.executablePath,
        argsSummary,
        exitCode: options.exitCode,
        signal: options.signal,
        timedOut: options.timedOut,
        stderrTail: stderr.value().text,
        changesObserved: input.changesObserved,
      }));
    };

    let child: ChildProcess;
    try {
      child = spawn(spawnPlan.command, spawnPlan.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: [spawnPlan.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
        ...spawnPlan.options,
      });
    } catch (error) {
      settled = true;
      clearRunTimers();
      rejectWithExecutionError({
        code: "AGENT_COMMAND_SPAWN_FAILED",
        message: `Agent command could not be started: ${formatErrorMessage(error)}.`,
        hint: "Check the configured local agent executable and working directory, then rerun agent mode.",
        exitCode: null,
        signal: null,
        timedOut: false,
      });
      return;
    }

    if (spawnPlan.stdin !== null) {
      child.stdin?.once("error", () => {});
      child.stdin?.end(spawnPlan.stdin);
    }

    const settleTimeout = (exitCode: number | null, signal: NodeJS.Signals | null, destroyOutput: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearRunTimers();
      if (destroyOutput) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }

      rejectWithExecutionError({
        code: "AGENT_COMMAND_TIMEOUT",
        message: `Agent command timed out after ${input.agent.timeoutSeconds} second(s).`,
        hint: "Increase agents.<name>.timeout_seconds or rerun after reducing the task size.",
        exitCode,
        signal,
        timedOut: true,
      });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.append(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.append(chunk);
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearRunTimers();
      rejectWithExecutionError({
        code: "AGENT_COMMAND_SPAWN_FAILED",
        message: `Agent command could not be started: ${formatErrorMessage(error)}.`,
        hint: "Check the configured local agent executable and working directory, then rerun agent mode.",
        exitCode: null,
        signal: null,
        timedOut: false,
      });
    });

    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }

      if (timedOut) {
        settleTimeout(exitCode, signal, false);
        return;
      }

      settled = true;
      clearRunTimers();
      const capturedStdout = stdout.value();
      const capturedStderr = stderr.value();
      if (exitCode === 0 && signal === null) {
        resolveRun({
          agentName: input.agent.name,
          executablePath: availability.value.executablePath,
          args,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: capturedStdout,
          stderr: capturedStderr,
        });
        return;
      }

      rejectRun(new LocalAgentExecutionError({
        code: "AGENT_COMMAND_FAILED",
        message: "Agent command exited unsuccessfully.",
        hint: "Inspect the stderr tail and rerun after fixing the local agent command failure.",
        agentName: input.agent.name,
        command: input.agent.command,
        executablePath: availability.value.executablePath,
        argsSummary,
        exitCode,
        signal,
        timedOut: false,
        stderrTail: capturedStderr.text,
        changesObserved: input.changesObserved,
      }));
    });

    if (input.agent.timeoutSeconds !== null) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateSpawnedProcess(child, spawnPlan, "SIGTERM", input.env);
        killTimeout = setTimeout(() => {
          terminateSpawnedProcess(child, spawnPlan, "SIGKILL", input.env);
          settleTimeout(null, "SIGKILL", true);
        }, normalizeTimeoutKillGraceMs(input.timeoutKillGraceMs));
        killTimeout.unref();
      }, Math.max(1, input.agent.timeoutSeconds * 1000));
      timeout.unref();
    }
  });
}

function createSpawnPlan(input: {
  agentName: string;
  executablePath: string;
  args: string[];
  taskPrompt: string;
  env: NodeJS.ProcessEnv | undefined;
  platform: NodeJS.Platform;
}): {
  command: string;
  args: string[];
  options?: { detached?: boolean; windowsVerbatimArguments?: boolean };
  timeoutKillStrategy: "posix-process-group" | "windows-process-tree";
  stdin: string | null;
} {
  const useStdinPrompt = supportsCodexExecStdinPrompt(input);
  if (input.platform === "win32" && isWindowsBatchShim(input.executablePath)) {
    const command = input.env?.ComSpec ?? input.env?.COMSPEC ?? "cmd.exe";
    const commandArgs = [...input.args, useStdinPrompt ? "-" : input.taskPrompt];
    const commandLine = [quoteCmdArgument(input.executablePath), ...commandArgs.map(quoteCmdArgument)].join(" ");
    return {
      command,
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      options: { windowsVerbatimArguments: true },
      timeoutKillStrategy: "windows-process-tree",
      stdin: useStdinPrompt ? input.taskPrompt : null,
    };
  }

  return {
    command: input.executablePath,
    args: [...input.args, useStdinPrompt ? "-" : input.taskPrompt],
    options: input.platform === "win32" ? undefined : { detached: true },
    timeoutKillStrategy: input.platform === "win32" ? "windows-process-tree" : "posix-process-group",
    stdin: useStdinPrompt ? input.taskPrompt : null,
  };
}

function isWindowsBatchShim(path: string): boolean {
  return /\.(?:bat|cmd)$/iu.test(path);
}

function supportsCodexExecStdinPrompt(input: {
  agentName: string;
  args: string[];
}): boolean {
  return input.agentName === "codex" && findCodexExecSubcommandIndex(input.args) !== null;
}

function findCodexExecSubcommandIndex(args: string[]): number | null {
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "exec" || arg === "e") {
      return index;
    }

    if (arg === "--" || !arg.startsWith("-")) {
      return null;
    }

    const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (CODEX_GLOBAL_FLAGS_WITH_VALUE.has(flagName)) {
      index += arg.includes("=") ? 1 : 2;
      continue;
    }

    if (CODEX_GLOBAL_BOOLEAN_FLAGS.has(arg)) {
      index += 1;
      continue;
    }

    return null;
  }

  return null;
}

function unavailableAgentCommand(input: {
  agentName: string;
  command: string;
  executablePath: string;
  hint: string;
}): Result<never, LocalAgentAvailabilityError> {
  return err({
    code: "AGENT_COMMAND_UNAVAILABLE",
    agentName: input.agentName,
    command: input.command,
    executablePath: input.executablePath,
    message: `Agent command is not available: ${input.command}.`,
    hint: input.hint,
  });
}

async function resolveCommandFromPath(
  command: string,
  options: LocalAgentAvailabilityOptions,
): Promise<string | null> {
  const pathEnv = resolvePathEnv(options);
  const pathEntries = pathEnv.split(delimiter).filter((entry) => entry.trim() !== "");
  const candidateNames = commandCandidateNames(command, options);
  const relativePathBase = options.cwd ?? process.cwd();

  for (const pathEntry of pathEntries) {
    for (const candidateName of candidateNames) {
      const candidatePath = isAbsolute(pathEntry)
        ? resolve(pathEntry, candidateName)
        : resolve(relativePathBase, pathEntry, candidateName);
      if (await isExecutableFile(candidatePath, options)) {
        return candidatePath;
      }
    }
  }

  return null;
}

function commandCandidateNames(command: string, options: LocalAgentAvailabilityOptions): string[] {
  if ((options.platform ?? process.platform) !== "win32") {
    return [command];
  }

  if (/\.[^\\/]+$/u.test(command)) {
    return [command];
  }

  const pathExt = resolvePathExt(options);
  return pathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => `${command}${extension.startsWith(".") ? extension : `.${extension}`}`);
}

async function isExecutableFile(path: string, options: LocalAgentAvailabilityOptions): Promise<boolean> {
  try {
    const candidate = await stat(path);
    if (!candidate.isFile()) {
      return false;
    }

    if ((options.platform ?? process.platform) === "win32") {
      return WINDOWS_LAUNCHABLE_EXTENSIONS.has(extname(path).toLowerCase());
    }

    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathEnv(options: LocalAgentAvailabilityOptions): string {
  if (options.pathEnv !== undefined) {
    return options.pathEnv;
  }

  if (options.env !== undefined) {
    return readEnvironmentValue(options.env, "PATH", options.platform ?? process.platform) ?? "";
  }

  return process.env.PATH ?? "";
}

function resolvePathExt(options: LocalAgentAvailabilityOptions): string {
  if (options.pathExt !== undefined) {
    return options.pathExt;
  }

  if (options.env !== undefined) {
    return readEnvironmentValue(options.env, "PATHEXT", options.platform ?? process.platform) ?? DEFAULT_WINDOWS_PATHEXT;
  }

  return process.env.PATHEXT ?? DEFAULT_WINDOWS_PATHEXT;
}

function readEnvironmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  const exact = env[key];
  if (exact !== undefined) {
    return exact;
  }

  if (platform !== "win32") {
    return undefined;
  }

  const normalizedKey = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === normalizedKey) {
      return value;
    }
  }

  return undefined;
}

function terminateSpawnedProcess(
  child: ChildProcess,
  spawnPlan: { timeoutKillStrategy: "posix-process-group" | "windows-process-tree" },
  signal: NodeJS.Signals,
  env: NodeJS.ProcessEnv | undefined,
): void {
  if (spawnPlan.timeoutKillStrategy === "windows-process-tree") {
    killWindowsProcessTree(child.pid, env);
    if (process.platform !== "win32") {
      child.kill(signal);
    }
    return;
  }

  if (process.platform !== "win32" && killPosixProcessGroup(child.pid, signal)) {
    return;
  }

  child.kill(signal);
}

function killPosixProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined) {
    return false;
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isProcessAlreadyGone(error)) {
      return true;
    }

    return false;
  }
}

function isProcessAlreadyGone(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ESRCH";
}

function killWindowsProcessTree(pid: number | undefined, env: NodeJS.ProcessEnv | undefined): void {
  if (pid === undefined) {
    return;
  }

  const command = process.platform === "win32"
    ? win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
    : "taskkill";
  const killer = spawn(command, ["/pid", String(pid), "/t", "/f"], {
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", () => {});
  killer.unref();
}

function createTailCapture(maxBytes: number): { append: (chunk: Buffer | string) => void; value: () => CapturedAgentOutput } {
  let chunks = Buffer.alloc(0);
  let truncated = false;

  return {
    append: (chunk) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks = Buffer.concat([chunks, next]);
      if (chunks.length > maxBytes) {
        chunks = chunks.subarray(chunks.length - maxBytes);
        truncated = true;
      }
    },
    value: () => ({
      text: chunks.toString("utf8"),
      truncated,
      maxBytes,
    }),
  };
}

function normalizeOutputLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_OUTPUT_LIMIT_BYTES;
  }

  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_OUTPUT_LIMIT_BYTES;
  }

  return Math.floor(value);
}

function normalizeTimeoutKillGraceMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_KILL_GRACE_MS;
  }

  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_TIMEOUT_KILL_GRACE_MS;
  }

  return Math.floor(value);
}

function quoteCmdArgument(value: string): string {
  if (value.length === 0) {
    return "\"\"";
  }

  return `"${value.replace(/["^&|<>()%!]/gu, "^$&")}"`;
}

function summarizeArgs(args: string[]): string {
  return [...args.map(formatSummaryArg), "<task-prompt>"].join(" ");
}

function formatSummaryArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/u.test(arg)) {
    return arg;
  }

  return JSON.stringify(arg);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
