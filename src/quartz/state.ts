import { readFileSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { writeTextFileInsideRoot } from "../utils/fs.js";
import { err, ok, type Result } from "../utils/result.js";

export const EXPLORER_STATE_PATH = ".llm-wiki/cache/explorer-state.json" as const;

export type ExplorerState = {
  version: 1;
  instance_id?: string;
  profile: string;
  host: string;
  port: number;
  ws_port?: number;
  url: string;
  updated_at: string;
  watch_paths: string[];
};

export type ExplorerStateErrorCode =
  | "EXPLORER_STATE_INVALID"
  | "EXPLORER_STATE_MISSING"
  | "EXPLORER_STATE_WRITE_FAILED";

export type ExplorerStateError = {
  code: ExplorerStateErrorCode;
  message: string;
  path: typeof EXPLORER_STATE_PATH;
  hint: string;
};

export async function writeExplorerState(repoRoot: string, state: ExplorerState): Promise<Result<void, ExplorerStateError>> {
  const writeResult = await writeTextFileInsideRoot(
    repoRoot,
    EXPLORER_STATE_PATH,
    `${JSON.stringify(state, null, 2)}\n`,
  );
  if (!writeResult.ok) {
    return err({
      code: "EXPLORER_STATE_WRITE_FAILED",
      message: "Failed to record current Quartz Explorer state.",
      path: EXPLORER_STATE_PATH,
      hint: writeResult.error.hint,
    });
  }

  return ok(undefined);
}

export async function removeExplorerState(repoRoot: string): Promise<void> {
  await rm(resolve(repoRoot, EXPLORER_STATE_PATH), { force: true });
}

export function removeExplorerStateSync(repoRoot: string): void {
  rmSync(resolve(repoRoot, EXPLORER_STATE_PATH), { force: true });
}

export async function removeExplorerStateIfCurrent(repoRoot: string, expected: ExplorerState): Promise<void> {
  let content: string;
  try {
    content = await readFile(resolve(repoRoot, EXPLORER_STATE_PATH), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (explorerStateMatches(content, expected)) {
    await removeExplorerState(repoRoot);
  }
}

export function removeExplorerStateIfCurrentSync(repoRoot: string, expected: ExplorerState): void {
  let content: string;
  try {
    content = readFileSync(resolve(repoRoot, EXPLORER_STATE_PATH), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (explorerStateMatches(content, expected)) {
    removeExplorerStateSync(repoRoot);
  }
}

export async function readExplorerState(repoRoot: string): Promise<Result<ExplorerState, ExplorerStateError>> {
  let content: string;
  try {
    content = await readFile(resolve(repoRoot, EXPLORER_STATE_PATH), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return err({
        code: "EXPLORER_STATE_MISSING",
        message: "No current Quartz Explorer URL is recorded.",
        path: EXPLORER_STATE_PATH,
        hint: "Run llm-wiki explore serve --profile local first.",
      });
    }

    return err({
      code: "EXPLORER_STATE_INVALID",
      message: "Could not read current Quartz Explorer state.",
      path: EXPLORER_STATE_PATH,
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before running llm-wiki explore open.",
    });
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isExplorerState(parsed)) {
      return err(invalidState("Explorer state is missing required fields."));
    }

    try {
      const url = new URL(parsed.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return err(invalidState("Explorer state URL must be http or https."));
      }
    } catch {
      return err(invalidState("Explorer state URL is invalid."));
    }

    return ok(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return err(invalidState("Explorer state is not valid JSON."));
    }

    return err({
      code: "EXPLORER_STATE_INVALID",
      message: "Could not parse current Quartz Explorer state.",
      path: EXPLORER_STATE_PATH,
      hint: error instanceof Error ? error.message : "Remove the invalid state file and rerun llm-wiki explore serve.",
    });
  }
}

function invalidState(message: string): ExplorerStateError {
  return {
    code: "EXPLORER_STATE_INVALID",
    message,
    path: EXPLORER_STATE_PATH,
    hint: "Remove the invalid state file and rerun llm-wiki explore serve --profile local.",
  };
}

function isExplorerState(value: unknown): value is ExplorerState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    (value.instance_id === undefined || typeof value.instance_id === "string") &&
    typeof value.profile === "string" &&
    typeof value.host === "string" &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    (value.ws_port === undefined || (typeof value.ws_port === "number" && Number.isInteger(value.ws_port))) &&
    typeof value.url === "string" &&
    typeof value.updated_at === "string" &&
    Array.isArray(value.watch_paths) &&
    value.watch_paths.every((entry) => typeof entry === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function explorerStateMatches(content: string, expected: ExplorerState): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isExplorerState(parsed)) {
      return false;
    }

    return (
      parsed.instance_id === expected.instance_id &&
      parsed.profile === expected.profile &&
      parsed.host === expected.host &&
      parsed.port === expected.port &&
      parsed.ws_port === expected.ws_port &&
      parsed.url === expected.url &&
      parsed.updated_at === expected.updated_at
    );
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
