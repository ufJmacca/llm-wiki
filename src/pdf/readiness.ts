import { spawn } from "node:child_process";

import { checkLocalAgentAvailability } from "../agents/index.js";
import { err, ok, type Result } from "../utils/result.js";
import {
  DEFAULT_PDF_INGESTION_CONFIG,
  loadPdfIngestionRuntimeConfig,
  readPdfIngestionConfig,
  type PdfIngestionRuntimeConfig,
  type PdfConfigError,
} from "./config.js";

export type PdfPluginRecord = {
  id: string;
  installed: boolean;
  enabled: boolean;
  version: string | null;
  descriptor: string | null;
};

export type PdfReadinessErrorCode =
  | PdfConfigError["code"]
  | "PDF_PLUGIN_LIST_FAILED"
  | "PDF_PLUGIN_LIST_MALFORMED"
  | "PDF_PLUGIN_MISSING"
  | "PDF_PLUGIN_DISABLED";

export type PdfReadinessError = {
  code: PdfReadinessErrorCode;
  message: string;
  path: string;
  hint: string;
  executablePath?: string;
  exitCode?: number | null;
  stderrTail?: string;
  timedOut?: boolean;
  plugin?: PdfPluginRecord;
};

export type PdfPreflightSuccess = {
  runtime: PdfIngestionRuntimeConfig;
  executablePath: string;
  args: string[];
  plugin: PdfPluginRecord;
};

export type PdfPreflightOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputLimitBytes?: number;
};

export type PdfReadinessStatus = {
  config_valid: boolean;
  codex_agent: string;
  required_plugin: string;
  executable_ready: boolean;
  executable_path: string | null;
  plugin_list_ready: boolean;
  plugin_installed: boolean | null;
  plugin_enabled: boolean | null;
  plugin_version: string | null;
  plugin_descriptor: string | null;
  stable_descriptor_permits_reuse: boolean;
  ready: boolean;
  issues: Array<{
    code: PdfReadinessErrorCode;
    message: string;
    path: string;
    hint: string;
  }>;
};

type PluginListProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

const PLUGIN_LIST_TIMEOUT_MS = 15_000;
const PLUGIN_LIST_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const STDERR_TAIL_LIMIT = 4 * 1024;

export function parseCodexPluginListJson(
  source: string,
): Result<PdfPluginRecord[], PdfReadinessError> {
  let document: unknown;
  try {
    document = JSON.parse(source) as unknown;
  } catch {
    return malformedPluginList("Codex plugin-list output is not valid JSON.");
  }

  const root = asRecord(document);
  if (root === null || !Array.isArray(root.installed)) {
    return malformedPluginList("Codex plugin-list output must contain an installed array.");
  }

  const plugins: PdfPluginRecord[] = [];
  const identifiers = new Set<string>();
  for (const [index, rawPlugin] of root.installed.entries()) {
    const plugin = asRecord(rawPlugin);
    if (plugin === null) {
      return malformedPluginList(`Codex plugin-list installed record ${index} must be an object.`);
    }

    if (
      typeof plugin.pluginId !== "string"
      || plugin.pluginId.trim() === ""
      || plugin.pluginId.trim() !== plugin.pluginId
      || typeof plugin.installed !== "boolean"
      || typeof plugin.enabled !== "boolean"
    ) {
      return malformedPluginList(
        `Codex plugin-list installed record ${index} has invalid pluginId, installed, or enabled fields.`,
      );
    }

    if (
      plugin.version !== undefined
      && plugin.version !== null
      && (typeof plugin.version !== "string" || plugin.version.trim() === "" || plugin.version.trim() !== plugin.version)
    ) {
      return malformedPluginList(`Codex plugin-list installed record ${index} has an invalid version field.`);
    }

    if (identifiers.has(plugin.pluginId)) {
      return malformedPluginList(`Codex plugin-list output contains duplicate identifier ${plugin.pluginId}.`);
    }
    identifiers.add(plugin.pluginId);

    const version = typeof plugin.version === "string" ? plugin.version : null;
    plugins.push({
      id: plugin.pluginId,
      installed: plugin.installed,
      enabled: plugin.enabled,
      version,
      descriptor: version === null ? null : `${plugin.pluginId}#version:${version}`,
    });
  }

  return ok(plugins);
}

export async function preflightPdfIngestion(
  repoRoot: string,
  options: PdfPreflightOptions = {},
): Promise<Result<PdfPreflightSuccess, PdfReadinessError>> {
  const runtime = await loadPdfIngestionRuntimeConfig(repoRoot);
  if (!runtime.ok) {
    return runtime;
  }

  const availability = await checkLocalAgentAvailability(runtime.value.agent, {
    cwd: repoRoot,
    env: options.env,
  });
  if (!availability.ok) {
    return err({
      code: "PDF_CODEX_NOT_READY",
      message: `PDF Codex executable is not ready: ${availability.error.message}`,
      path: `.llm-wiki/config.yml:agents.${runtime.value.agent.name}.command`,
      hint: availability.error.hint,
      executablePath: availability.error.executablePath,
      exitCode: null,
      stderrTail: "",
      timedOut: false,
    });
  }

  const args = [...runtime.value.invocation.globalPrefix, "plugin", "list", "--json"];
  const processResult = await runPluginListProcess(
    availability.value.executablePath,
    args,
    repoRoot,
    options,
  );
  if (!processResult.ok) {
    return processResult;
  }

  if (processResult.value.timedOut || processResult.value.exitCode !== 0) {
    return err({
      code: "PDF_PLUGIN_LIST_FAILED",
      message: processResult.value.timedOut
        ? "Codex plugin discovery timed out."
        : "Codex plugin discovery exited unsuccessfully.",
      path: runtime.value.agent.command,
      hint: "Run codex plugin list --json, fix Codex readiness, and retry PDF extraction.",
      executablePath: availability.value.executablePath,
      exitCode: processResult.value.exitCode,
      stderrTail: sanitizeStderr(processResult.value.stderr),
      timedOut: processResult.value.timedOut,
    });
  }

  const parsed = parseCodexPluginListJson(processResult.value.stdout);
  if (!parsed.ok) {
    return err({
      ...parsed.error,
      executablePath: availability.value.executablePath,
      exitCode: 0,
      stderrTail: sanitizeStderr(processResult.value.stderr),
      timedOut: false,
    });
  }

  const plugin = parsed.value.find((candidate) => candidate.id === runtime.value.config.requiredPlugin);
  if (plugin === undefined || !plugin.installed) {
    return err({
      code: "PDF_PLUGIN_MISSING",
      message: `Required Codex plugin is not installed: ${runtime.value.config.requiredPlugin}.`,
      path: runtime.value.config.requiredPlugin,
      hint: "Install the required plugin in Codex, then rerun the command. llm-wiki never installs plugins automatically.",
      executablePath: availability.value.executablePath,
      exitCode: 0,
      stderrTail: "",
      timedOut: false,
      plugin,
    });
  }

  if (!plugin.enabled) {
    return err({
      code: "PDF_PLUGIN_DISABLED",
      message: `Required Codex plugin is disabled: ${runtime.value.config.requiredPlugin}.`,
      path: runtime.value.config.requiredPlugin,
      hint: "Enable the required plugin in Codex, then rerun the command. llm-wiki never changes plugin state.",
      executablePath: availability.value.executablePath,
      exitCode: 0,
      stderrTail: "",
      timedOut: false,
      plugin,
    });
  }

  return ok({
    runtime: runtime.value,
    executablePath: availability.value.executablePath,
    args,
    plugin,
  });
}

export async function getPdfReadinessStatus(repoRoot: string): Promise<PdfReadinessStatus> {
  const config = await readPdfIngestionConfig(repoRoot);
  if (!config.ok) {
    return failedReadinessStatus({
      configValid: false,
      codexAgent: DEFAULT_PDF_INGESTION_CONFIG.codexAgent,
      requiredPlugin: DEFAULT_PDF_INGESTION_CONFIG.requiredPlugin,
      error: config.error,
    });
  }

  const preflight = await preflightPdfIngestion(repoRoot);
  if (!preflight.ok) {
    return failedReadinessStatus({
      configValid: true,
      codexAgent: config.value.codexAgent,
      requiredPlugin: config.value.requiredPlugin,
      error: preflight.error,
    });
  }

  return {
    config_valid: true,
    codex_agent: preflight.value.runtime.config.codexAgent,
    required_plugin: preflight.value.plugin.id,
    executable_ready: true,
    executable_path: preflight.value.executablePath,
    plugin_list_ready: true,
    plugin_installed: true,
    plugin_enabled: true,
    plugin_version: preflight.value.plugin.version,
    plugin_descriptor: preflight.value.plugin.descriptor,
    stable_descriptor_permits_reuse: preflight.value.plugin.descriptor !== null,
    ready: true,
    issues: [],
  };
}

function failedReadinessStatus(input: {
  configValid: boolean;
  codexAgent: string;
  requiredPlugin: string;
  error: PdfReadinessError;
}): PdfReadinessStatus {
  const plugin = input.error.plugin;
  const executableReady = input.error.code !== "PDF_CONFIG_INVALID"
    && input.error.code !== "PDF_CODEX_NOT_READY";
  const pluginListReady = input.error.code === "PDF_PLUGIN_MISSING"
    || input.error.code === "PDF_PLUGIN_DISABLED";

  return {
    config_valid: input.configValid,
    codex_agent: input.codexAgent,
    required_plugin: input.requiredPlugin,
    executable_ready: executableReady,
    executable_path: input.error.executablePath ?? null,
    plugin_list_ready: pluginListReady,
    plugin_installed: input.error.code === "PDF_PLUGIN_MISSING" ? false : plugin?.installed ?? null,
    plugin_enabled: input.error.code === "PDF_PLUGIN_DISABLED" ? false : plugin?.enabled ?? null,
    plugin_version: plugin?.version ?? null,
    plugin_descriptor: plugin?.descriptor ?? null,
    stable_descriptor_permits_reuse: false,
    ready: false,
    issues: [{
      code: input.error.code,
      message: input.error.message,
      path: input.error.path,
      hint: input.error.hint,
    }],
  };
}

async function runPluginListProcess(
  executablePath: string,
  args: string[],
  cwd: string,
  options: PdfPreflightOptions,
): Promise<Result<PluginListProcessResult, PdfReadinessError>> {
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, PLUGIN_LIST_TIMEOUT_MS);
  const outputLimit = normalizePositiveInteger(options.outputLimitBytes, PLUGIN_LIST_OUTPUT_LIMIT_BYTES);

  return new Promise((resolveRun) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | null = null;

    const settle = (value: Result<PluginListProcessResult, PdfReadinessError>): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      resolveRun(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executablePath, args, {
        cwd,
        env: { ...(options.env ?? process.env), PWD: cwd },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      settle(pluginListSpawnError(executablePath, error));
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendLimited(stdout, chunk, outputLimit);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendLimited(stderr, chunk, outputLimit);
    });
    child.once("error", (error) => {
      settle(pluginListSpawnError(executablePath, error));
    });
    child.once("close", (exitCode) => {
      settle(ok({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exitCode,
        timedOut,
      }));
    });

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 100).unref();
    }, timeoutMs);
    timeout.unref();
  });
}

function pluginListSpawnError(
  executablePath: string,
  error: unknown,
): Result<never, PdfReadinessError> {
  return err({
    code: "PDF_PLUGIN_LIST_FAILED",
    message: `Codex plugin discovery could not start: ${error instanceof Error ? error.message : String(error)}.`,
    path: executablePath,
    hint: "Check the configured Codex executable and retry plugin discovery.",
    executablePath,
    exitCode: null,
    stderrTail: "",
    timedOut: false,
  });
}

function malformedPluginList(message: string): Result<never, PdfReadinessError> {
  return err({
    code: "PDF_PLUGIN_LIST_MALFORMED",
    message,
    path: "codex plugin list --json",
    hint: "Use a supported Codex release whose plugin-list JSON matches the documented schema.",
  });
}

function appendLimited(current: Buffer, chunk: Buffer | string, limit: number): Buffer {
  const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  return next.length <= limit ? next : next.subarray(next.length - limit);
}

function sanitizeStderr(value: string): string {
  return value
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .slice(-STDERR_TAIL_LIMIT);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
