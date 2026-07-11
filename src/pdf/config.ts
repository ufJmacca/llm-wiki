import { createHash } from "node:crypto";
import { parse } from "yaml";

import { loadLocalAgentConfig, type LocalAgentConfig } from "../runtime/config.js";
import { WIKI_CONFIG_RELATIVE_PATH } from "../runtime/repo.js";
import { readTextFileInsideRoot } from "../utils/fs.js";
import { err, ok, type Result } from "../utils/result.js";

export const REQUIRED_PDF_PLUGIN = "pdf@openai-primary-runtime";

export type PdfDetail = "auto" | "low" | "high";

export type PdfIngestionConfig = {
  codexAgent: string;
  requiredPlugin: typeof REQUIRED_PDF_PLUGIN;
  model: string | null;
  reasoningEffort: string;
  pdfDetail: PdfDetail;
  timeoutSeconds: number;
  requireArtifactBeforeIngest: true;
};

export type PdfCodexInvocation = {
  globalPrefix: string[];
  execSuffix: string[];
};

export type PdfIngestionRuntimeConfig = {
  config: PdfIngestionConfig;
  agent: LocalAgentConfig;
  invocation: PdfCodexInvocation;
  fingerprint: string;
};

export type PdfExtractionSettings = {
  model: string | null;
  reasoningEffort: string;
  pdfDetail: PdfDetail;
  force: boolean;
};

export type PdfExtractionSettingOverrides = {
  model?: unknown;
  reasoningEffort?: unknown;
  pdfDetail?: unknown;
  force?: unknown;
};

export type PdfConfigError = {
  code: "PDF_CONFIG_INVALID" | "PDF_CODEX_NOT_READY";
  message: string;
  path: string;
  hint: string;
};

export const DEFAULT_PDF_INGESTION_CONFIG: PdfIngestionConfig = Object.freeze({
  codexAgent: "codex",
  requiredPlugin: REQUIRED_PDF_PLUGIN,
  model: null,
  reasoningEffort: "high",
  pdfDetail: "high",
  timeoutSeconds: 900,
  requireArtifactBeforeIngest: true,
});

const PDF_CONFIG_KEYS = new Set([
  "codex_agent",
  "required_plugin",
  "model",
  "reasoning_effort",
  "pdf_detail",
  "timeout_seconds",
  "require_artifact_before_ingest",
]);

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

const CODEX_EXEC_FLAGS_WITH_VALUE = new Set([
  "-C",
  "--cd",
  "--color",
  "--image",
  "--output-schema",
  "--profile",
  "--sandbox",
]);

const CODEX_EXEC_BOOLEAN_FLAGS = new Set([
  "--ephemeral",
  "--full-auto",
  "--json",
  "--no-alt-screen",
  "--oss",
  "--search",
  "--skip-git-repo-check",
]);

const CODEX_OUTPUT_PATH_FLAGS = new Set(["-o", "--output-last-message"]);

export async function readPdfIngestionConfig(
  repoRoot: string,
): Promise<Result<PdfIngestionConfig, PdfConfigError>> {
  const configFile = await readTextFileInsideRoot(repoRoot, WIKI_CONFIG_RELATIVE_PATH);
  if (!configFile.ok) {
    return invalidPdfConfig(
      configFile.error.message,
      configFile.error.path,
      "Restore .llm-wiki/config.yml before using PDF extraction.",
    );
  }

  let document: unknown;
  try {
    document = parse(configFile.value) as unknown;
  } catch {
    return invalidPdfConfig(
      "Wiki config YAML could not be parsed.",
      WIKI_CONFIG_RELATIVE_PATH,
      "Fix .llm-wiki/config.yml YAML before using PDF extraction.",
    );
  }

  return normalizePdfIngestionConfig(document);
}

export function normalizePdfIngestionConfig(
  document: unknown,
): Result<PdfIngestionConfig, PdfConfigError> {
  const root = asRecord(document);
  if (root === null) {
    return invalidPdfConfig(
      "Config root must be a mapping.",
      WIKI_CONFIG_RELATIVE_PATH,
      "Restore the generated .llm-wiki/config.yml mapping structure.",
    );
  }

  if (!("pdf_ingestion" in root)) {
    return ok({ ...DEFAULT_PDF_INGESTION_CONFIG });
  }

  const value = asRecord(root.pdf_ingestion);
  const basePath = `${WIKI_CONFIG_RELATIVE_PATH}:pdf_ingestion`;
  if (value === null) {
    return invalidPdfConfig(
      "pdf_ingestion must be a mapping when present.",
      basePath,
      "Use the documented pdf_ingestion mapping or remove it to inherit defaults.",
    );
  }

  const unknownKey = Object.keys(value).find((key) => !PDF_CONFIG_KEYS.has(key));
  if (unknownKey !== undefined) {
    return invalidPdfConfig(
      `Unsupported pdf_ingestion field: ${unknownKey}.`,
      `${basePath}.${unknownKey}`,
      "Remove unsupported PDF settings and use only the documented fields.",
    );
  }

  const codexAgent = nonEmptyStringField(value, "codex_agent", DEFAULT_PDF_INGESTION_CONFIG.codexAgent, basePath);
  if (!codexAgent.ok) {
    return codexAgent;
  }

  const requiredPlugin = nonEmptyStringField(
    value,
    "required_plugin",
    DEFAULT_PDF_INGESTION_CONFIG.requiredPlugin,
    basePath,
  );
  if (!requiredPlugin.ok) {
    return requiredPlugin;
  }
  if (requiredPlugin.value !== REQUIRED_PDF_PLUGIN) {
    return invalidPdfConfig(
      `Only ${REQUIRED_PDF_PLUGIN} is supported for PDF ingestion.`,
      `${basePath}.required_plugin`,
      `Set required_plugin to ${REQUIRED_PDF_PLUGIN}; this experiment has no provider fallback.`,
    );
  }

  const model = optionalNonEmptyStringField(value, "model", basePath);
  if (!model.ok) {
    return model;
  }

  const reasoningEffort = nonEmptyStringField(
    value,
    "reasoning_effort",
    DEFAULT_PDF_INGESTION_CONFIG.reasoningEffort,
    basePath,
  );
  if (!reasoningEffort.ok) {
    return reasoningEffort;
  }

  const pdfDetail = value.pdf_detail ?? DEFAULT_PDF_INGESTION_CONFIG.pdfDetail;
  if (!isPdfDetail(pdfDetail)) {
    return invalidPdfConfig(
      "pdf_ingestion.pdf_detail must be auto, low, or high.",
      `${basePath}.pdf_detail`,
      "Set pdf_detail to auto, low, or high.",
    );
  }

  const timeoutSeconds = value.timeout_seconds ?? DEFAULT_PDF_INGESTION_CONFIG.timeoutSeconds;
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    return invalidPdfConfig(
      "pdf_ingestion.timeout_seconds must be a positive integer.",
      `${basePath}.timeout_seconds`,
      "Set timeout_seconds to a positive whole number of seconds.",
    );
  }

  const requireArtifact = value.require_artifact_before_ingest
    ?? DEFAULT_PDF_INGESTION_CONFIG.requireArtifactBeforeIngest;
  if (requireArtifact !== true) {
    return invalidPdfConfig(
      "pdf_ingestion.require_artifact_before_ingest must remain true for this experiment.",
      `${basePath}.require_artifact_before_ingest`,
      "Set require_artifact_before_ingest to true; bypass is unsupported.",
    );
  }

  return ok({
    codexAgent: codexAgent.value,
    requiredPlugin: REQUIRED_PDF_PLUGIN,
    model: model.value,
    reasoningEffort: reasoningEffort.value,
    pdfDetail,
    timeoutSeconds,
    requireArtifactBeforeIngest: true,
  });
}

export async function loadPdfIngestionRuntimeConfig(
  repoRoot: string,
): Promise<Result<PdfIngestionRuntimeConfig, PdfConfigError>> {
  const config = await readPdfIngestionConfig(repoRoot);
  if (!config.ok) {
    return config;
  }

  const agent = await loadLocalAgentConfig(repoRoot, config.value.codexAgent);
  if (!agent.ok) {
    return err({
      code: "PDF_CODEX_NOT_READY",
      message: `PDF Codex agent is not ready: ${agent.error.message}`,
      path: agent.error.path,
      hint: `Configure agents.${config.value.codexAgent} as a Codex local-exec agent before extracting PDFs.`,
    });
  }

  if (!isCodexCommand(agent.value.command)) {
    return err({
      code: "PDF_CODEX_NOT_READY",
      message: `PDF agent ${agent.value.name} must use the Codex executable.`,
      path: `${WIKI_CONFIG_RELATIVE_PATH}:agents.${agent.value.name}.command`,
      hint: "Set the referenced local agent command to codex or an absolute executable whose basename is codex.",
    });
  }

  const invocation = parsePdfCodexInvocation(agent.value);
  if (!invocation.ok) {
    return invocation;
  }

  const fingerprintInput = {
    config: config.value,
    agent: {
      name: agent.value.name,
      type: agent.value.type,
      command: agent.value.command,
      args: agent.value.args,
      approvalPolicy: agent.value.approvalPolicy,
      sandboxMode: agent.value.sandboxMode,
      outputMode: agent.value.outputMode,
    },
    invocation: invocation.value,
  };

  return ok({
    config: config.value,
    agent: agent.value,
    invocation: invocation.value,
    fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex")}`,
  });
}

export function resolvePdfExtractionSettings(
  config: PdfIngestionConfig,
  overrides: PdfExtractionSettingOverrides = {},
): Result<PdfExtractionSettings, PdfConfigError> {
  const modelValue = overrides.model === undefined ? config.model : overrides.model;
  if (modelValue !== null && (typeof modelValue !== "string" || modelValue.trim() === "")) {
    return invalidPdfFlag("PDF model must be a non-empty string.", "--pdf-model");
  }

  const effortValue = overrides.reasoningEffort === undefined
    ? config.reasoningEffort
    : overrides.reasoningEffort;
  if (typeof effortValue !== "string" || effortValue.trim() === "") {
    return invalidPdfFlag("PDF reasoning effort must be a non-empty string.", "--pdf-reasoning-effort");
  }

  const detailValue = overrides.pdfDetail === undefined ? config.pdfDetail : overrides.pdfDetail;
  if (!isPdfDetail(detailValue)) {
    return invalidPdfFlag("PDF detail must be auto, low, or high.", "--pdf-detail");
  }

  if (overrides.force !== undefined && typeof overrides.force !== "boolean") {
    return invalidPdfFlag("PDF force must be a boolean flag.", "--force");
  }

  return ok({
    model: typeof modelValue === "string" ? modelValue.trim() : null,
    reasoningEffort: effortValue.trim(),
    pdfDetail: detailValue,
    force: overrides.force === true,
  });
}

export function parsePdfCodexInvocation(
  agent: Pick<LocalAgentConfig, "name" | "args" | "approvalPolicy" | "sandboxMode">,
): Result<PdfCodexInvocation, PdfConfigError> {
  const argsPath = `${WIKI_CONFIG_RELATIVE_PATH}:agents.${agent.name}.args`;
  const parsedExecIndex = findParsedExecIndex(agent.args);
  if (!parsedExecIndex.ok) {
    return invalidPdfConfig(parsedExecIndex.error, argsPath, codexArgsHint(agent.name));
  }

  const prefix = agent.args.slice(0, parsedExecIndex.value);
  const suffix = agent.args.slice(parsedExecIndex.value + 1);
  const collision = findManagedSettingCollision([...prefix, ...suffix]);
  if (collision !== null) {
    return invalidPdfConfig(
      `Configured Codex arguments conflict with PDF-managed ${collision.setting}.`,
      argsPath,
      `Remove ${collision.flag} from agents.${agent.name}.args; use the matching pdf_ingestion setting or PDF CLI option.`,
    );
  }

  const suffixError = validateExecSuffix(suffix);
  if (suffixError !== null) {
    return invalidPdfConfig(suffixError, argsPath, codexArgsHint(agent.name));
  }

  const structuredPrefix: string[] = [];
  if (agent.approvalPolicy !== null) {
    if (hasFlag(prefix, "--ask-for-approval")) {
      return invalidPdfConfig(
        "Codex approval policy is configured more than once.",
        argsPath,
        "Keep approval_policy in the structured agent field and remove the duplicate argv flag.",
      );
    }
    structuredPrefix.push("--ask-for-approval", agent.approvalPolicy);
  }
  if (agent.sandboxMode !== null) {
    if (hasFlag(prefix, "--sandbox") || hasFlag(prefix, "-s")) {
      return invalidPdfConfig(
        "Codex sandbox mode is configured more than once.",
        argsPath,
        "Keep sandbox_mode in the structured agent field and remove the duplicate argv flag.",
      );
    }
    structuredPrefix.push("--sandbox", agent.sandboxMode);
  }

  return ok({
    globalPrefix: [...prefix, ...structuredPrefix],
    execSuffix: suffix,
  });
}

function findParsedExecIndex(args: string[]): Result<number, string> {
  let index = 0;
  let execIndex: number | null = null;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "exec") {
      if (execIndex !== null) {
        return err("Configured Codex arguments must contain exactly one exec subcommand.");
      }
      execIndex = index;
      break;
    }

    if (arg === "-" || arg === "--" || !arg.startsWith("-")) {
      return err("Configured Codex arguments contain a positional prompt or ambiguous subcommand before exec.");
    }

    const parsedFlag = splitFlag(arg);
    if (isManagedModelFlag(parsedFlag.name)) {
      return err("Configured Codex arguments conflict with PDF-managed model selection.");
    }
    if (!CODEX_GLOBAL_FLAGS_WITH_VALUE.has(parsedFlag.name) && !CODEX_GLOBAL_BOOLEAN_FLAGS.has(parsedFlag.name)) {
      return err(`Configured Codex global flag is not supported by the PDF runner: ${parsedFlag.name}.`);
    }

    if (CODEX_GLOBAL_FLAGS_WITH_VALUE.has(parsedFlag.name) && parsedFlag.inlineValue === null) {
      if (index + 1 >= args.length) {
        return err(`Configured Codex flag is missing its value: ${parsedFlag.name}.`);
      }
      index += 2;
      continue;
    }
    index += 1;
  }

  if (execIndex === null) {
    return err("Configured Codex arguments must contain exactly one exec subcommand.");
  }

  return ok(execIndex);
}

function validateExecSuffix(args: string[]): string | null {
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "-" || arg === "--" || arg === "exec" || !arg.startsWith("-")) {
      return "Configured Codex exec suffix contains a positional prompt, stdin marker, or ambiguous subcommand.";
    }

    const parsed = splitFlag(arg);
    if (CODEX_OUTPUT_PATH_FLAGS.has(parsed.name)) {
      return `Configured Codex exec flag writes an unmanaged output path: ${parsed.name}.`;
    }
    if (!CODEX_EXEC_FLAGS_WITH_VALUE.has(parsed.name) && !CODEX_EXEC_BOOLEAN_FLAGS.has(parsed.name)) {
      return `Configured Codex exec flag is not supported by the PDF runner: ${parsed.name}.`;
    }

    if (CODEX_EXEC_FLAGS_WITH_VALUE.has(parsed.name) && parsed.inlineValue === null) {
      if (index + 1 >= args.length || args[index + 1].startsWith("-")) {
        return `Configured Codex exec flag is missing its value: ${parsed.name}.`;
      }
      index += 2;
      continue;
    }
    index += 1;
  }

  return null;
}

function findManagedSettingCollision(args: string[]): { setting: "model" | "reasoning effort"; flag: string } | null {
  for (let index = 0; index < args.length; index += 1) {
    const parsed = splitFlag(args[index]);
    if (isManagedModelFlag(parsed.name)) {
      return { setting: "model", flag: parsed.name };
    }

    if (parsed.name === "-c" || parsed.name === "--config") {
      const value = parsed.inlineValue ?? args[index + 1] ?? "";
      if (configKey(value) === "model_reasoning_effort") {
        return { setting: "reasoning effort", flag: parsed.name };
      }
      if (parsed.inlineValue === null) {
        index += 1;
      }
    }
  }

  return null;
}

function splitFlag(arg: string): { name: string; inlineValue: string | null } {
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex < 0) {
    return { name: arg, inlineValue: null };
  }

  return {
    name: arg.slice(0, equalsIndex),
    inlineValue: arg.slice(equalsIndex + 1),
  };
}

function isManagedModelFlag(name: string): boolean {
  return name === "-m" || name === "--model";
}

function configKey(value: string): string {
  const equalsIndex = value.indexOf("=");
  return (equalsIndex < 0 ? value : value.slice(0, equalsIndex)).trim();
}

function hasFlag(args: string[], expected: string): boolean {
  return args.some((arg) => splitFlag(arg).name === expected);
}

function isCodexCommand(command: string): boolean {
  const basename = command.split(/[\\/]/u).pop()?.toLowerCase() ?? "";
  return basename === "codex" || basename === "codex.exe" || basename === "codex.cmd" || basename === "codex.bat";
}

function isPdfDetail(value: unknown): value is PdfDetail {
  return value === "auto" || value === "low" || value === "high";
}

function nonEmptyStringField(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
  basePath: string,
): Result<string, PdfConfigError> {
  const value = record[key] ?? fallback;
  if (typeof value !== "string" || value.trim() === "") {
    return invalidPdfConfig(
      `pdf_ingestion.${key} must be a non-empty string.`,
      `${basePath}.${key}`,
      `Set ${key} to a non-empty string or omit it to use the default.`,
    );
  }

  return ok(value.trim());
}

function optionalNonEmptyStringField(
  record: Record<string, unknown>,
  key: string,
  basePath: string,
): Result<string | null, PdfConfigError> {
  const value = record[key];
  if (value === undefined) {
    return ok(null);
  }
  if (typeof value !== "string" || value.trim() === "") {
    return invalidPdfConfig(
      `pdf_ingestion.${key} must be a non-empty string when present.`,
      `${basePath}.${key}`,
      `Set ${key} to a non-empty string or omit it to inherit the active Codex model.`,
    );
  }

  return ok(value.trim());
}

function invalidPdfConfig(
  message: string,
  path: string,
  hint: string,
): Result<never, PdfConfigError> {
  return err({ code: "PDF_CONFIG_INVALID", message, path, hint });
}

function invalidPdfFlag(message: string, path: string): Result<never, PdfConfigError> {
  return invalidPdfConfig(message, path, "Pass a supported non-empty PDF extraction setting.");
}

function codexArgsHint(agentName: string): string {
  return `Configure agents.${agentName}.args with one exec subcommand, safe flags only, and no positional prompt or PDF-managed setting.`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
