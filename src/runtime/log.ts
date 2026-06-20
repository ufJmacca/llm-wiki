import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { validateAppendFileInsideRoot, type BinaryWriteError } from "../utils/fs.js";
import { err, ok, type Result } from "../utils/result.js";

export type RuntimeLogAppendEntry = {
  timestamp: string;
  operation: "add";
  affectedId: string;
  title: string;
  command: string;
  rawSource: string;
  created: string[];
};

const RUNTIME_LOG_PATH = "curated/log.md";

export async function validateRuntimeLogAppendTarget(repoRoot: string) {
  return validateAppendFileInsideRoot(repoRoot, RUNTIME_LOG_PATH);
}

export async function appendRuntimeLogEntry(
  repoRoot: string,
  entry: RuntimeLogAppendEntry,
): Promise<Result<void, BinaryWriteError>> {
  const target = await validateRuntimeLogAppendTarget(repoRoot);
  if (!target.ok) {
    return target;
  }

  let file: Awaited<ReturnType<typeof open>> | undefined;
  let previousSize: number | undefined;

  try {
    file = await open(
      resolve(repoRoot, RUNTIME_LOG_PATH),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o666,
    );
    previousSize = (await file.stat()).size;
    await file.writeFile(formatRuntimeLogEntry(entry), "utf8");
    return ok(undefined);
  } catch (error) {
    if (file !== undefined && previousSize !== undefined) {
      await file.truncate(previousSize).catch(() => undefined);
    }

    return err(runtimeLogAppendError(error));
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function formatRuntimeLogEntry(entry: RuntimeLogAppendEntry): string {
  const lines = [
    "",
    `## [${entry.timestamp}] ${entry.operation} | ${entry.affectedId} | ${entry.title}`,
    "",
    "- actor: cli",
    `- command: ${formatLogScalar(entry.command)}`,
    "- git_branch:",
    "- git_commit:",
    `- raw_source: ${entry.rawSource}`,
    "- created:",
  ];

  for (const createdPath of entry.created) {
    lines.push(`  - ${createdPath}`);
  }

  lines.push("- updated:", "- contradictions:", "- follow_ups:", "");

  return lines.join("\n");
}

function formatLogScalar(value: string): string {
  return JSON.stringify(value);
}

function runtimeLogAppendError(error: unknown): BinaryWriteError {
  return {
    code: "DESTINATION_PARENT_UNSAFE",
    message: error instanceof Error ? error.message : String(error),
    path: RUNTIME_LOG_PATH,
    hint: "Capture writes must stay inside the wiki repository and must not follow symlinks.",
  };
}
