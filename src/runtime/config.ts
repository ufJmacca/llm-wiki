import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";

import { err, ok, type Result } from "../utils/result.js";
import { WIKI_CONFIG_RELATIVE_PATH } from "./repo.js";

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

function configGitEnabled(config: unknown): Result<boolean, WikiConfigIssue> {
  if (!isRecord(config)) {
    return err({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: config root must be a mapping.`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Recreate .llm-wiki/config.yml with llm-wiki init or restore the generated mapping structure.",
    });
  }

  const features = config.features;
  if (!("features" in config)) {
    return ok(false);
  }

  if (!isRecord(features)) {
    return err({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: features must be a mapping when present.`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Set features to a YAML mapping such as features: { git: true } or recreate the config with llm-wiki init.",
    });
  }

  if ("git" in features && typeof features.git !== "boolean") {
    return err({
      severity: "error",
      code: "wiki_config_invalid",
      message: `Invalid ${WIKI_CONFIG_RELATIVE_PATH}: features.git must be a boolean when present.`,
      path: WIKI_CONFIG_RELATIVE_PATH,
      hint: "Set features.git to true or false in .llm-wiki/config.yml.",
    });
  }

  return ok(features.git === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatConfigError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, " ").trim();
  }

  return String(error);
}
