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

export type ProviderConfigErrorCode =
  | "PROVIDER_CONFIG_INVALID"
  | "PROVIDER_CONFIG_MISSING"
  | "PROVIDER_ENV_MISSING";

export type ProviderConfigError = {
  code: ProviderConfigErrorCode;
  message: string;
  path: string;
  hint: string;
};

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
    return err({
      code: "PROVIDER_CONFIG_MISSING",
      message: `Provider is not configured: ${providerName}.`,
      path: `${WIKI_CONFIG_RELATIVE_PATH}:providers.${providerName}`,
      hint: "Add a provider config with type, endpoint, api_key_env, and optional model.",
    });
  }

  const providerRecord = asRecord(provider);
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

  const apiKey = process.env[providerRecord.api_key_env];
  if (apiKey === undefined || apiKey === "") {
    return err({
      code: "PROVIDER_ENV_MISSING",
      message: `Provider secret environment variable is not set: ${providerRecord.api_key_env}.`,
      path: providerRecord.api_key_env,
      hint: "Set the configured environment variable before running provider mode.",
    });
  }

  return ok({
    name: providerName,
    type: "http",
    endpoint: providerRecord.endpoint,
    apiKeyEnv: providerRecord.api_key_env,
    apiKey,
    model: typeof providerRecord.model === "string" && providerRecord.model.trim() !== "" ? providerRecord.model : null,
  });
}

function invalidProvider(providerName: string, message: string): Result<never, ProviderConfigError> {
  return err({
    code: "PROVIDER_CONFIG_INVALID",
    message,
    path: `${WIKI_CONFIG_RELATIVE_PATH}:providers.${providerName}`,
    hint: "Configure providers as type: http, endpoint: <url>, api_key_env: ENV_VAR_NAME, and optional model.",
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findForbiddenSecretKeyPath(value: unknown, path: Array<string | number>): Array<string | number> | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nestedPath = findForbiddenSecretKeyPath(item, [...path, index]);
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
    if (isForbiddenSecretKey(key)) {
      return nextPath;
    }

    const nestedPath = findForbiddenSecretKeyPath(nestedValue, nextPath);
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

function isForbiddenSecretKey(key: string): boolean {
  const normalized = normalizeConfigKey(key);
  if (ALLOWED_SECRET_ENV_KEYS.has(normalized)) {
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
