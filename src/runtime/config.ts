import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { parse } from "yaml";

import { readTextFileInsideRoot } from "../utils/fs.js";
import { err, ok, type Result } from "../utils/result.js";
import { WIKI_CONFIG_RELATIVE_PATH } from "./repo.js";

export type HttpProviderConfig = {
  name: string;
  type: "http";
  endpoint: string;
  apiKeyEnv: string;
  apiKey: string;
  model: string | null;
};

export type LocalAgentConfig = {
  name: string;
  type: "local-exec";
  command: string;
  args: string[];
  approvalPolicy: string | null;
  sandboxMode: string | null;
  outputMode: string | null;
  timeoutSeconds: number | null;
};

export type WikiConfigSummary = {
  gitEnabled: boolean;
  agentDefault: string | null;
  localAgents: {
    count: number;
    names: string[];
  };
  providers: {
    count: number;
    names: string[];
  };
};

export type WikiStatusConfigReadiness = {
  agentDefault: string | null;
  localAgents: LocalAgentConfig[];
  providers: {
    count: number;
    names: string[];
  };
  errors: WikiConfigIssue[];
};

export type ProviderConfigErrorCode =
  | "PROVIDER_CONFIG_INVALID"
  | "PROVIDER_CONFIG_MISSING"
  | "PROVIDER_ENV_MISSING";

export type LocalAgentConfigErrorCode =
  | "AGENT_CONFIG_INVALID"
  | "AGENT_CONFIG_MISSING";

export type ProviderConfigError = {
  code: ProviderConfigErrorCode;
  message: string;
  path: string;
  hint: string;
};

export type LocalAgentConfigError = {
  code: LocalAgentConfigErrorCode;
  message: string;
  path: string;
  hint: string;
};

export type WikiConfigIssue = {
  severity: "error";
  code: "wiki_config_unreadable" | "wiki_config_invalid";
  message: string;
  path: typeof WIKI_CONFIG_RELATIVE_PATH;
  hint: string;
};

export type WikiGitConfig = {
  gitEnabled: boolean;
};

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCAL_AGENT_OUTPUT_MODE_GIT_DIFF = "git-diff";
const ALLOWED_SECRET_ENV_KEYS = new Set(["api_key_env"]);
const FORBIDDEN_SECRET_KEY_PATTERNS = [
  /(^|_)api_keys?($|_)/,
  /(^|_)apikeys?($|_)/,
  /(^|_)authorizations?($|_)/,
  /(^|_)bearer($|_)/,
  /(^|_)credentials?($|_)/,
  /(^|_)pass(word)?s?($|_)/,
  /(^|_)passwd($|_)/,
  /(^|_)private_keys?($|_)/,
  /(^|_)secrets?($|_)/,
  /(^|_)tokens?($|_)/,
];

export async function loadProviderConfig(
  repoRoot: string,
  providerName: string,
): Promise<Result<HttpProviderConfig, ProviderConfigError>> {
  if (providerName.trim() === "") {
    return err({
      code: "PROVIDER_CONFIG_INVALID",
      message: "Provider name must not be empty.",
      path: "--provider",
      hint: "Pass --provider <name> for a provider configured under providers.<name>.",
    });
  }

  const configFile = await readTextFileInsideRoot(repoRoot, WIKI_CONFIG_RELATIVE_PATH);
  if (!configFile.ok) {
    return err({
      code: "PROVIDER_CONFIG_INVALID",
      message: configFile.error.message,
      path: configFile.error.path,
      hint: "Restore .llm-wiki/config.yml before using provider mode.",
    });
  }

  let document: unknown;
  try {
    document = parse(configFile.value);
  } catch {
    return err({
      code: "PROVIDER_CONFIG_INVALID",
      message: "Wiki config YAML could not be parsed.",
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Fix .llm-wiki/config.yml YAML before using provider mode.",
    });
  }

  const providers = asRecord(document)?.providers;
  const provider = asRecord(providers)?.[providerName];
  if (provider === undefined) {
    const agentDefault = readAgentDefaultName(document);
    const localAgentConfigured = hasLocalAgentEntry(document, providerName);
    return err({
      code: "PROVIDER_CONFIG_MISSING",
      message: `Provider is not configured: ${providerName}.`,
      path: `${WIKI_CONFIG_RELATIVE_PATH}:providers.${providerName}`,
      hint: localAgentConfigured
        ? `No HTTP provider named ${providerName} is configured. --provider only runs HTTP providers; use --agent ${providerName} for local agent execution, use --auto when agent.default is ${providerName}, or add providers.${providerName} with type, endpoint, api_key_env, and optional model.`
        : agentDefault === providerName
          ? `No HTTP provider named ${providerName} is configured. --provider only runs HTTP providers; agent.default is ${providerName}, but agents.${providerName} is not configured for local agent mode. Add agents.${providerName} with type: local-exec and command, add providers.${providerName} for HTTP provider mode, or omit --provider to generate the manual task prompt.`
        : "Add a provider config with type, endpoint, api_key_env, and optional model.",
    });
  }

  const providerRecord = parseProviderStaticConfig(providerName, provider);
  if (!providerRecord.ok) {
    return providerRecord;
  }

  const apiKey = process.env[providerRecord.value.api_key_env];
  if (apiKey === undefined || apiKey === "") {
    return err({
      code: "PROVIDER_ENV_MISSING",
      message: `Provider secret environment variable is not set: ${providerRecord.value.api_key_env}.`,
      path: providerRecord.value.api_key_env,
      hint: "Set the configured environment variable before running provider mode.",
    });
  }

  return ok({
    name: providerName,
    type: "http",
    endpoint: providerRecord.value.endpoint,
    apiKeyEnv: providerRecord.value.api_key_env,
    apiKey,
    model: typeof providerRecord.value.model === "string" && providerRecord.value.model.trim() !== ""
      ? providerRecord.value.model
      : null,
  });
}

export async function loadDefaultLocalAgentConfig(
  repoRoot: string,
): Promise<Result<LocalAgentConfig, LocalAgentConfigError>> {
  const document = await readAgentConfigDocument(repoRoot);
  if (!document.ok) {
    return document;
  }

  const configRecord = asRecord(document.value);
  if (configRecord === null) {
    return invalidAgentConfig(
      "config root must be a mapping.",
      WIKI_CONFIG_RELATIVE_PATH,
      "Recreate .llm-wiki/config.yml with llm-wiki init or restore the generated mapping structure.",
    );
  }

  const defaultAgent = parseAgentDefaultForAgentConfig(configRecord);
  if (!defaultAgent.ok) {
    return defaultAgent;
  }

  if (defaultAgent.value === null) {
    return err({
      code: "AGENT_CONFIG_MISSING",
      message: "Default local agent is not configured.",
      path: `${WIKI_CONFIG_RELATIVE_PATH}:agent.default`,
      hint: "Set agent.default to the name of a local agent configured under agents.<name>.",
    });
  }

  return readLocalAgentFromDocument(document.value, defaultAgent.value);
}

export async function loadLocalAgentConfig(
  repoRoot: string,
  agentName: string,
): Promise<Result<LocalAgentConfig, LocalAgentConfigError>> {
  const normalizedAgentName = agentName.trim();
  if (normalizedAgentName === "") {
    return err({
      code: "AGENT_CONFIG_INVALID",
      message: "Agent name must not be empty.",
      path: "--agent",
      hint: "Pass --agent <name> for a local agent configured under agents.<name>.",
    });
  }

  const document = await readAgentConfigDocument(repoRoot);
  if (!document.ok) {
    return document;
  }

  return readLocalAgentFromDocument(document.value, normalizedAgentName);
}

export async function readWikiConfigSummary(repoRoot: string): Promise<Result<WikiConfigSummary, WikiConfigIssue>> {
  let source: string;
  try {
    source = await readFile(resolve(repoRoot, WIKI_CONFIG_RELATIVE_PATH), "utf8");
  } catch (error) {
    return err({
      severity: "error",
      code: "wiki_config_unreadable",
      message: `Could not read ${WIKI_CONFIG_RELATIVE_PATH}: ${formatConfigError(error)}`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Ensure .llm-wiki/config.yml is readable and was created by llm-wiki init.",
    });
  }

  let config: unknown;
  try {
    config = parse(source) as unknown;
  } catch (error) {
    return err({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Could not parse ${WIKI_CONFIG_RELATIVE_PATH}: ${formatConfigError(error)}`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Fix the YAML syntax in .llm-wiki/config.yml or recreate it with llm-wiki init.",
    });
  }

  const gitConfig = configGitEnabled(config);
  if (!gitConfig.ok) {
    return gitConfig;
  }

  const configRecord = asRecord(config);
  if (configRecord === null) {
    return err({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: config root must be a mapping.`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Recreate .llm-wiki/config.yml with llm-wiki init or restore the generated mapping structure.",
    });
  }

  const agentDefault = parseAgentDefaultForIssue(configRecord);
  if (!agentDefault.ok) {
    return agentDefault;
  }

  const localAgents = parseLocalAgentsForIssue(configRecord);
  if (!localAgents.ok) {
    return localAgents;
  }

  const providers = parseProviderSummaryForIssue(configRecord);
  if (!providers.ok) {
    return providers;
  }

  return ok({
    gitEnabled: gitConfig.value,
    agentDefault: agentDefault.value,
    localAgents: {
      count: localAgents.value.length,
      names: localAgents.value,
    },
    providers: {
      count: providers.value.length,
      names: providers.value,
    },
  });
}

export async function readWikiStatusConfigReadiness(repoRoot: string): Promise<WikiStatusConfigReadiness> {
  let source: string;
  try {
    source = await readFile(resolve(repoRoot, WIKI_CONFIG_RELATIVE_PATH), "utf8");
  } catch (error) {
    return {
      agentDefault: null,
      localAgents: [],
      providers: {
        count: 0,
        names: [],
      },
      errors: [
        {
          severity: "error",
          code: "wiki_config_unreadable",
          message: `Could not read ${WIKI_CONFIG_RELATIVE_PATH}: ${formatConfigError(error)}`,
          path: WIKI_CONFIG_RELATIVE_PATH,
          hint: "Ensure .llm-wiki/config.yml is readable and was created by llm-wiki init.",
        },
      ],
    };
  }

  let config: unknown;
  try {
    config = parse(source) as unknown;
  } catch (error) {
    return {
      agentDefault: null,
      localAgents: [],
      providers: {
        count: 0,
        names: [],
      },
      errors: [
        {
          severity: "error",
          code: "wiki_config_invalid",
          message: `Could not parse ${WIKI_CONFIG_RELATIVE_PATH}: ${formatConfigError(error)}`,
          path: WIKI_CONFIG_RELATIVE_PATH,
          hint: "Fix the YAML syntax in .llm-wiki/config.yml or recreate it with llm-wiki init.",
        },
      ],
    };
  }

  const configRecord = asRecord(config);
  if (configRecord === null) {
    return {
      agentDefault: null,
      localAgents: [],
      providers: {
        count: 0,
        names: [],
      },
      errors: [
        {
          severity: "error",
          code: "wiki_config_invalid",
          message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: config root must be a mapping.`,
          path: WIKI_CONFIG_RELATIVE_PATH,
          hint: "Recreate .llm-wiki/config.yml with llm-wiki init or restore the generated mapping structure.",
        },
      ],
    };
  }

  const errors: WikiConfigIssue[] = [];
  const agentDefault = parseAgentDefaultForIssue(configRecord);
  if (!agentDefault.ok) {
    errors.push(agentDefault.error);
  }

  const localAgents = parseLocalAgentsForStatus(configRecord, errors);
  const providerNames = parseProviderNamesForStatus(configRecord, errors);

  return {
    agentDefault: agentDefault.ok ? agentDefault.value : null,
    localAgents,
    providers: {
      count: providerNames.length,
      names: providerNames,
    },
    errors,
  };
}

export async function readWikiGitConfig(repoRoot: string): Promise<Result<WikiGitConfig, WikiConfigIssue>> {
  let source: string;
  try {
    source = await readFile(resolve(repoRoot, WIKI_CONFIG_RELATIVE_PATH), "utf8");
  } catch (error) {
    return err({
      severity: "error",
      code: "wiki_config_unreadable",
      message: `Could not read ${WIKI_CONFIG_RELATIVE_PATH}: ${formatConfigError(error)}`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Ensure .llm-wiki/config.yml is readable and was created by llm-wiki init.",
    });
  }

  let config: unknown;
  try {
    config = parse(source) as unknown;
  } catch (error) {
    return err({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Could not parse ${WIKI_CONFIG_RELATIVE_PATH}: ${formatConfigError(error)}`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Fix the YAML syntax in .llm-wiki/config.yml or recreate it with llm-wiki init.",
    });
  }

  const gitConfig = configGitEnabled(config);
  if (!gitConfig.ok) {
    return gitConfig;
  }

  return ok({ gitEnabled: gitConfig.value });
}

async function readAgentConfigDocument(repoRoot: string): Promise<Result<unknown, LocalAgentConfigError>> {
  const configFile = await readTextFileInsideRoot(repoRoot, WIKI_CONFIG_RELATIVE_PATH);
  if (!configFile.ok) {
    return err({
      code: "AGENT_CONFIG_INVALID",
      message: configFile.error.message,
      path: configFile.error.path,
      hint: "Restore .llm-wiki/config.yml before using local agent mode.",
    });
  }

  try {
    return ok(parse(configFile.value) as unknown);
  } catch {
    return err({
      code: "AGENT_CONFIG_INVALID",
      message: "Wiki config YAML could not be parsed.",
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Fix .llm-wiki/config.yml YAML before using local agent mode.",
    });
  }
}

function readLocalAgentFromDocument(
  document: unknown,
  agentName: string,
): Result<LocalAgentConfig, LocalAgentConfigError> {
  const configRecord = asRecord(document);
  if (configRecord === null) {
    return invalidAgentConfig(
      "config root must be a mapping.",
      WIKI_CONFIG_RELATIVE_PATH,
      "Recreate .llm-wiki/config.yml with llm-wiki init or restore the generated mapping structure.",
    );
  }

  const agentsRecord = parseLocalAgentRecordForAgentConfig(configRecord);
  if (!agentsRecord.ok) {
    return agentsRecord;
  }

  const agentEntry = findLocalAgentEntry(agentsRecord.value, agentName);
  if (agentEntry === undefined) {
    return err({
      code: "AGENT_CONFIG_MISSING",
      message: `Local agent is not configured: ${agentName}.`,
      path: `${WIKI_CONFIG_RELATIVE_PATH}:agents.${agentName}`,
      hint: `Add agents.${agentName} with type: local-exec, command, and optional args before using local agent mode.`,
    });
  }

  return parseLocalAgentConfig(agentName, agentEntry);
}

function parseAgentDefaultForAgentConfig(
  configRecord: Record<string, unknown>,
): Result<string | null, LocalAgentConfigError> {
  if (!("agent" in configRecord)) {
    return ok(null);
  }

  const agentRecord = asRecord(configRecord.agent);
  if (agentRecord === null) {
    return invalidAgentConfig(
      "agent must be a mapping when present.",
      `${WIKI_CONFIG_RELATIVE_PATH}:agent`,
      "Set agent to a YAML mapping such as agent: { default: codex } or recreate the config with llm-wiki init.",
    );
  }

  if (!("default" in agentRecord)) {
    return ok(null);
  }

  if (typeof agentRecord.default !== "string" || agentRecord.default.trim() === "") {
    return invalidAgentConfig(
      "agent.default must be a non-empty string when present.",
      `${WIKI_CONFIG_RELATIVE_PATH}:agent.default`,
      "Set agent.default to the name of a local agent configured under agents.<name>.",
    );
  }

  return ok(agentRecord.default.trim());
}

function parseAgentDefaultForIssue(configRecord: Record<string, unknown>): Result<string | null, WikiConfigIssue> {
  const result = parseAgentDefaultForAgentConfig(configRecord);
  if (!result.ok) {
    return err(agentConfigIssue(result.error));
  }

  return result;
}

function parseLocalAgentsForAgentConfig(
  configRecord: Record<string, unknown>,
): Result<Map<string, LocalAgentConfig>, LocalAgentConfigError> {
  const agentsRecord = parseLocalAgentRecordForAgentConfig(configRecord);
  if (!agentsRecord.ok) {
    return agentsRecord;
  }

  const agents = new Map<string, LocalAgentConfig>();
  for (const [rawName, rawAgent] of Object.entries(agentsRecord.value)) {
    const name = rawName.trim();
    if (name === "") {
      return invalidAgentConfig(
        "Agent name must not be empty.",
        `${WIKI_CONFIG_RELATIVE_PATH}:agents`,
        "Configure local agents under non-empty keys such as agents.codex.",
      );
    }

    const agent = parseLocalAgentConfig(name, rawAgent);
    if (!agent.ok) {
      return agent;
    }

    agents.set(name, agent.value);
  }

  return ok(agents);
}

function parseLocalAgentRecordForAgentConfig(
  configRecord: Record<string, unknown>,
): Result<Record<string, unknown>, LocalAgentConfigError> {
  if (!("agents" in configRecord)) {
    return ok({});
  }

  const agentsRecord = asRecord(configRecord.agents);
  if (agentsRecord === null) {
    return invalidAgentConfig(
      "agents must be a mapping when present.",
      `${WIKI_CONFIG_RELATIVE_PATH}:agents`,
      "Configure local agents under agents.<name> with type: local-exec and command.",
    );
  }

  return ok(agentsRecord);
}

function findLocalAgentEntry(
  agentsRecord: Record<string, unknown>,
  agentName: string,
): unknown {
  for (const [rawName, rawAgent] of Object.entries(agentsRecord)) {
    if (rawName.trim() === agentName) {
      return rawAgent;
    }
  }

  return undefined;
}

function parseLocalAgentsForIssue(configRecord: Record<string, unknown>): Result<string[], WikiConfigIssue> {
  const agents = parseLocalAgentsForAgentConfig(configRecord);
  if (!agents.ok) {
    return err(agentConfigIssue(agents.error));
  }

  return ok([...agents.value.keys()].sort());
}

function parseLocalAgentsForStatus(
  configRecord: Record<string, unknown>,
  errors: WikiConfigIssue[],
): LocalAgentConfig[] {
  const agentsRecord = parseLocalAgentRecordForAgentConfig(configRecord);
  if (!agentsRecord.ok) {
    errors.push(agentConfigIssue(agentsRecord.error));
    return [];
  }

  const agents: LocalAgentConfig[] = [];
  for (const [rawName, rawAgent] of Object.entries(agentsRecord.value)) {
    const name = rawName.trim();
    if (name === "") {
      errors.push(agentConfigIssue({
        code: "AGENT_CONFIG_INVALID",
        message: "Agent name must not be empty.",
        path: `${WIKI_CONFIG_RELATIVE_PATH}:agents`,
        hint: "Configure local agents under non-empty keys such as agents.codex.",
      }));
      continue;
    }

    const agent = parseLocalAgentConfig(name, rawAgent);
    if (!agent.ok) {
      errors.push(agentConfigIssue(agent.error));
      continue;
    }

    agents.push(agent.value);
  }

  return agents.sort((left, right) => left.name.localeCompare(right.name));
}

function parseLocalAgentConfig(name: string, value: unknown): Result<LocalAgentConfig, LocalAgentConfigError> {
  const agentRecord = asRecord(value);
  const basePath = `${WIKI_CONFIG_RELATIVE_PATH}:agents.${name}`;
  if (agentRecord === null) {
    return invalidAgentConfig(
      "Agent config must be a mapping.",
      basePath,
      "Configure local agents as mappings with type: local-exec, command, and optional args.",
    );
  }

  const forbiddenSecretKeyPath = findForbiddenSecretKeyPath(agentRecord, [], { allowSecretEnvKeys: false });
  if (forbiddenSecretKeyPath !== null) {
    return invalidAgentConfig(
      "Agent config must not contain secret-like fields.",
      `${basePath}.${formatConfigPath(forbiddenSecretKeyPath)}`,
      "Remove literal secret fields from local agent config and keep secrets in the process environment.",
    );
  }

  if (agentRecord.type !== "local-exec") {
    return invalidAgentConfig(
      "Agent type must be local-exec.",
      `${basePath}.type`,
      "Set type: local-exec for local CLI agents.",
    );
  }

  if (typeof agentRecord.command !== "string" || agentRecord.command.trim() === "") {
    return invalidAgentConfig(
      "Agent command must not be empty.",
      `${basePath}.command`,
      "Set command to a PATH command name such as codex or an absolute executable path.",
    );
  }

  const command = agentRecord.command.trim();
  if (!isCommandReference(command)) {
    return invalidAgentConfig(
      "Agent command must be a PATH command name or an absolute executable path.",
      `${basePath}.command`,
      "Use command: codex to resolve from PATH, or configure an absolute executable path.",
    );
  }

  const args = parseAgentArgs(agentRecord.args, `${basePath}.args`);
  if (!args.ok) {
    return args;
  }

  const approvalPolicy = parseOptionalAgentString(
    agentRecord.approval_policy,
    `${basePath}.approval_policy`,
    "Agent approval_policy must be a non-empty string when present.",
  );
  if (!approvalPolicy.ok) {
    return approvalPolicy;
  }

  const sandboxMode = parseOptionalAgentString(
    agentRecord.sandbox_mode,
    `${basePath}.sandbox_mode`,
    "Agent sandbox_mode must be a non-empty string when present.",
  );
  if (!sandboxMode.ok) {
    return sandboxMode;
  }

  const outputMode = parseOptionalAgentString(
    agentRecord.output_mode,
    `${basePath}.output_mode`,
    "Agent output_mode must be a non-empty string when present.",
  );
  if (!outputMode.ok) {
    return outputMode;
  }
  if (outputMode.value !== null && outputMode.value !== LOCAL_AGENT_OUTPUT_MODE_GIT_DIFF) {
    return invalidAgentConfig(
      "Agent output_mode must be git-diff when present.",
      `${basePath}.output_mode`,
      "Set output_mode: git-diff to use temporary workspace diff extraction, or omit it.",
    );
  }

  const timeoutSeconds = parseOptionalTimeoutSeconds(agentRecord.timeout_seconds, `${basePath}.timeout_seconds`);
  if (!timeoutSeconds.ok) {
    return timeoutSeconds;
  }

  return ok({
    name,
    type: "local-exec",
    command,
    args: args.value,
    approvalPolicy: approvalPolicy.value,
    sandboxMode: sandboxMode.value,
    outputMode: outputMode.value,
    timeoutSeconds: timeoutSeconds.value,
  });
}

function parseAgentArgs(value: unknown, path: string): Result<string[], LocalAgentConfigError> {
  if (value === undefined) {
    return ok([]);
  }

  if (!Array.isArray(value) || !value.every((arg) => typeof arg === "string")) {
    return invalidAgentConfig(
      "Agent args must be an array of strings when present.",
      path,
      "Set args to a YAML array such as args: [exec], or omit args for no command arguments.",
    );
  }

  return ok([...value]);
}

function parseOptionalAgentString(
  value: unknown,
  path: string,
  message: string,
): Result<string | null, LocalAgentConfigError> {
  if (value === undefined) {
    return ok(null);
  }

  if (typeof value !== "string" || value.trim() === "") {
    return invalidAgentConfig(
      message,
      path,
      "Use a non-empty string value or omit this field.",
    );
  }

  return ok(value.trim());
}

function parseOptionalTimeoutSeconds(value: unknown, path: string): Result<number | null, LocalAgentConfigError> {
  if (value === undefined) {
    return ok(null);
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return invalidAgentConfig(
      "Agent timeout_seconds must be a positive integer when present.",
      path,
      "Set timeout_seconds to a positive whole number of seconds, or omit it.",
    );
  }

  return ok(value);
}

function parseProviderSummaryForIssue(configRecord: Record<string, unknown>): Result<string[], WikiConfigIssue> {
  if (!("providers" in configRecord)) {
    return ok([]);
  }

  const providersRecord = asRecord(configRecord.providers);
  if (providersRecord === null) {
    return err({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: providers must be a mapping when present.`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Configure HTTP providers under providers.<name>, or remove the providers field.",
    });
  }

  for (const providerName of Object.keys(providersRecord)) {
    const name = providerName.trim();
    if (name === "") {
      return err({
        severity: "error",
        code: "wiki_config_invalid",
        message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: Provider name must not be empty.`,
        path: WIKI_CONFIG_RELATIVE_PATH,
        hint: "Configure providers under non-empty keys such as providers.local.",
      });
    }

    const provider = parseProviderStaticConfig(name, providersRecord[providerName]);
    if (!provider.ok) {
      return err(providerConfigIssue(provider.error));
    }
  }

  return ok(Object.keys(providersRecord).map((name) => name.trim()).sort());
}

function parseProviderNamesForStatus(
  configRecord: Record<string, unknown>,
  errors: WikiConfigIssue[],
): string[] {
  if (!("providers" in configRecord)) {
    return [];
  }

  const providersRecord = asRecord(configRecord.providers);
  if (providersRecord === null) {
    errors.push({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: providers must be a mapping when present.`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Configure HTTP providers under providers.<name>, or remove the providers field.",
    });
    return [];
  }

  const names: string[] = [];
  for (const [rawProviderName, rawProvider] of Object.entries(providersRecord)) {
    const name = rawProviderName.trim();
    if (name === "") {
      errors.push({
        severity: "error",
        code: "wiki_config_invalid",
        message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: Provider name must not be empty.`,
        path: WIKI_CONFIG_RELATIVE_PATH,
        hint: "Configure providers under non-empty keys such as providers.local.",
      });
      continue;
    }

    const provider = parseProviderStaticConfig(name, rawProvider);
    if (!provider.ok) {
      errors.push(providerConfigIssue(provider.error));
      continue;
    }

    names.push(name);
  }

  return names.sort();
}

type ProviderStaticConfig = {
  type: "http";
  endpoint: string;
  api_key_env: string;
  model?: unknown;
};

function parseProviderStaticConfig(
  providerName: string,
  value: unknown,
): Result<ProviderStaticConfig, ProviderConfigError> {
  const providerRecord = asRecord(value);
  if (providerRecord === null) {
    return invalidProvider(providerName, "Provider config must be a mapping.");
  }

  const forbiddenSecretKeyPath = findForbiddenSecretKeyPath(providerRecord, []);
  if (forbiddenSecretKeyPath !== null) {
    return err({
      code: "PROVIDER_CONFIG_INVALID",
      message: "Provider config must reference secrets by environment variable name only.",
      path: `${WIKI_CONFIG_RELATIVE_PATH}:providers.${providerName}.${formatConfigPath(forbiddenSecretKeyPath)}`,
      hint: "Remove literal secret fields and use api_key_env: ENV_VAR_NAME.",
    });
  }

  if (providerRecord.type !== "http") {
    return invalidProvider(providerName, "Provider type must be http.");
  }

  if (typeof providerRecord.endpoint !== "string" || !isHttpUrl(providerRecord.endpoint)) {
    return invalidProvider(providerName, "Provider endpoint must be an http or https URL.");
  }

  if (typeof providerRecord.api_key_env !== "string" || !ENV_NAME_PATTERN.test(providerRecord.api_key_env)) {
    return invalidProvider(providerName, "Provider api_key_env must be an environment variable name.");
  }

  return ok({
    type: "http",
    endpoint: providerRecord.endpoint,
    api_key_env: providerRecord.api_key_env,
    model: providerRecord.model,
  });
}

function invalidAgentConfig(
  message: string,
  path: string,
  hint: string,
): Result<never, LocalAgentConfigError> {
  return err({
    code: "AGENT_CONFIG_INVALID",
    message,
    path,
    hint,
  });
}

function agentConfigIssue(error: LocalAgentConfigError): WikiConfigIssue {
  return {
    severity: "error",
    code: "wiki_config_invalid",
    message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: ${error.message}`,
    path: WIKI_CONFIG_RELATIVE_PATH,
    hint: error.hint,
  };
}

function providerConfigIssue(error: ProviderConfigError): WikiConfigIssue {
  return {
    severity: "error",
    code: "wiki_config_invalid",
    message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: ${error.message}`,
    path: WIKI_CONFIG_RELATIVE_PATH,
    hint: error.hint,
  };
}

function invalidProvider(providerName: string, message: string): Result<never, ProviderConfigError> {
  return err({
    code: "PROVIDER_CONFIG_INVALID",
    message,
    path: `${WIKI_CONFIG_RELATIVE_PATH}:providers.${providerName}`,
    hint: "Configure providers as type: http, endpoint: <url>, api_key_env: ENV_VAR_NAME, and optional model.",
  });
}

function configGitEnabled(config: unknown): Result<boolean, WikiConfigIssue> {
  const configRecord = asRecord(config);
  if (configRecord === null) {
    return err({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: config root must be a mapping.`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Recreate .llm-wiki/config.yml with llm-wiki init or restore the generated mapping structure.",
    });
  }

  const features = configRecord.features;
  if (!("features" in configRecord)) {
    return ok(false);
  }

  const featuresRecord = asRecord(features);
  if (featuresRecord === null) {
    return err({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: features must be a mapping when present.`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Set features to a YAML mapping such as features: { git: true } or recreate the config with llm-wiki init.",
    });
  }

  if ("git" in featuresRecord && typeof featuresRecord.git !== "boolean") {
    return err({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: features.git must be a boolean when present.`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Set features.git to true or false in .llm-wiki/config.yml.",
    });
  }

  return ok(featuresRecord.git === true);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findForbiddenSecretKeyPath(
  value: unknown,
  path: Array<string | number>,
  options: { allowSecretEnvKeys: boolean } = { allowSecretEnvKeys: true },
): Array<string | number> | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nestedPath = findForbiddenSecretKeyPath(item, [...path, index], options);
      if (nestedPath !== null) {
        return nestedPath;
      }
    }

    return null;
  }

  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(record)) {
    const nextPath = [...path, key];
    if (isForbiddenSecretKey(key, options)) {
      return nextPath;
    }

    const nestedPath = findForbiddenSecretKeyPath(nestedValue, nextPath, options);
    if (nestedPath !== null) {
      return nestedPath;
    }
  }

  return null;
}

function formatConfigPath(path: Array<string | number>): string {
  return path
    .map((segment) => typeof segment === "number" ? `[${segment}]` : segment)
    .join(".")
    .replaceAll(".[", "[");
}

function isForbiddenSecretKey(key: string, options: { allowSecretEnvKeys: boolean }): boolean {
  const normalized = normalizeConfigKey(key);
  if (options.allowSecretEnvKeys && ALLOWED_SECRET_ENV_KEYS.has(normalized)) {
    return false;
  }

  return FORBIDDEN_SECRET_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeConfigKey(key: string): string {
  return key
    .trim()
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

function readAgentDefaultName(document: unknown): string | null {
  const agent = asRecord(asRecord(document)?.agent);
  const defaultAgent = agent?.default;
  return typeof defaultAgent === "string" && defaultAgent.trim() !== "" ? defaultAgent.trim() : null;
}

function hasLocalAgentEntry(document: unknown, agentName: string): boolean {
  return findLocalAgentEntry(asRecord(asRecord(document)?.agents) ?? {}, agentName) !== undefined;
}

function isCommandReference(command: string): boolean {
  return isAbsolute(command) || (!command.includes("/") && !command.includes("\\") && !/\s/u.test(command));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatConfigError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, " ").trim();
  }

  return String(error);
}
