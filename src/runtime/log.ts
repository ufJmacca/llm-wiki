import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { parseLogEntries, type RuntimeLogEntry, type ScannerIssue } from "../scanner/index.js";
import { validateAppendFileInsideRoot, validateReadFileInsideRoot, type BinaryWriteError } from "../utils/fs.js";
import { err, ok, type Result } from "../utils/result.js";

export type RuntimeLogAppendEntry = {
  timestamp: string;
  operation: "add" | "ingest";
  affectedId: string;
  title: string;
  command: string;
  rawSource?: string;
  created?: string[];
  updated?: string[];
  statusTransition?: string;
};

export type RuntimeLogReadResult = {
  entries: RuntimeLogEntry[];
  issues: ScannerIssue[];
  counts: {
    total: number;
  };
};

export type RuntimeLogReadError = {
  code: "LOG_READ_FAILED";
  message: string;
  path: typeof RUNTIME_LOG_PATH;
  hint: string;
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

export async function readRuntimeLog(repoRoot: string): Promise<Result<RuntimeLogReadResult, RuntimeLogReadError>> {
  let file: Awaited<ReturnType<typeof open>> | undefined;

  try {
    const target = await validateReadFileInsideRoot(repoRoot, RUNTIME_LOG_PATH);
    if (!target.ok) {
      return err(runtimeLogReadError(target.error.message));
    }

    file = await open(target.value.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const content = await file.readFile("utf8");
    const scan = parseLogEntries({ path: RUNTIME_LOG_PATH, content });

    return ok({
      entries: scan.entries,
      issues: scan.issues,
      counts: {
        total: scan.entries.length,
      },
    });
  } catch (error) {
    return err(runtimeLogReadError(error instanceof Error ? error.message : String(error)));
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function runtimeLogReadError(message: string): RuntimeLogReadError {
  return {
    code: "LOG_READ_FAILED",
    message,
    path: RUNTIME_LOG_PATH,
    hint: "Ensure curated/log.md is a readable regular file inside the wiki repository.",
  };
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
    `- raw_source:${entry.rawSource === undefined ? "" : ` ${entry.rawSource}`}`,
    ...(entry.statusTransition === undefined ? [] : [`- status: ${entry.statusTransition}`]),
    "- created:",
  ];

  for (const createdPath of entry.created ?? []) {
    lines.push(`  - ${createdPath}`);
  }

  lines.push("- updated:");
  for (const updatedPath of entry.updated ?? []) {
    lines.push(`  - ${updatedPath}`);
  }

  lines.push("- contradictions:", "- follow_ups:", "");

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
