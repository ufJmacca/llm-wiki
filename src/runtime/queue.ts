import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { stringify } from "yaml";

import { parseSourceId, parseQueueItem, scanMarkdownDocument, type ScannerIssue } from "../scanner/index.js";
import { err, ok, type Result } from "../utils/result.js";
import { appendRuntimeLogEntry, validateRuntimeLogAppendTarget } from "./log.js";

export type QueueStatus = "queued" | "ingesting" | "ingested" | "blocked";
export type QueueSourceKind = "file" | "text" | "url";
export type QueueVisibility = "private" | "public";

export type QueueCommandErrorCode =
  | "QUEUE_ACTION_INVALID"
  | "QUEUE_DIRECTORY_INVALID"
  | "QUEUE_ITEM_INVALID"
  | "QUEUE_ITEM_MISSING"
  | "QUEUE_ITEM_NOT_FOUND"
  | "QUEUE_PATH_UNSAFE"
  | "QUEUE_SOURCE_CARD_INVALID"
  | "QUEUE_SOURCE_CARD_MISMATCH"
  | "QUEUE_SOURCE_CARD_MISSING"
  | "QUEUE_STATUS_INVALID"
  | "QUEUE_STATUS_TRANSITION_INVALID"
  | "QUEUE_WRITE_FAILED"
  | "SOURCE_ID_INVALID";

export type QueueCommandError = {
  code: QueueCommandErrorCode;
  message: string;
  path: string;
  hint: string;
};

export type QueueListItem = {
  source_id: string;
  title: string;
  kind: QueueSourceKind;
  source_kind: QueueSourceKind;
  status: QueueStatus;
  visibility: QueueVisibility;
  source_card_path: string;
  queue_path: string;
  original_path: string;
  updated_at: string;
};

export type QueueRecordSummary = {
  source_id: string;
  captured_at: string;
  status: QueueStatus;
};

export type QueueListResult = {
  items: QueueListItem[];
  counts: {
    total: number;
    queued: number;
    ingesting: number;
    ingested: number;
    blocked: number;
  };
};

export type QueueShowResult = {
  queue_record: QueueRecord;
  source_card: {
    path: string;
    frontmatter: SourceCardFrontmatter;
  };
};

export type QueueSetStatusResult = {
  source_id: string;
  previous_status: QueueStatus;
  status: QueueStatus;
  source_card_path: string;
  queue_path: string;
  updated_at: string;
  log_path: "curated/log.md";
};

export type AutoIngestMetadata = {
  enabled: boolean;
  attempt_count: number;
  last_attempt_at: string;
  last_result: string;
  last_error_code: string | null;
  last_error_message: string | null;
};

export type QueueRecord = {
  source_id: string;
  title: string;
  kind: QueueSourceKind;
  source_kind: QueueSourceKind;
  origin: string;
  origin_url?: string;
  captured_at: string;
  content_hash: string;
  status: QueueStatus;
  visibility: QueueVisibility;
  path: string;
  original_path: string;
  updated_at?: string;
  auto_ingest?: AutoIngestMetadata;
  queue_path: string;
  [key: string]: unknown;
};

export type SourceCardFrontmatter = {
  type: "raw_source";
  source_id: string;
  title: string;
  source_kind: QueueSourceKind;
  origin: string;
  origin_url?: string | null;
  captured_at: string;
  content_hash: string;
  status: QueueStatus;
  visibility: QueueVisibility;
  updated_at?: string;
  auto_ingest?: AutoIngestMetadata;
  [key: string]: unknown;
};

export type QueueTransitionAutoIngestOptions = {
  enabled: boolean;
  result: string;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type QueueTransitionOptions = {
  now?: Date;
  command?: string;
  autoIngest?: QueueTransitionAutoIngestOptions;
};

type QueueFileRecord = {
  queuePath: string;
  record: QueueRecord;
};

type SourceCardDocument = {
  path: string;
  frontmatter: SourceCardFrontmatter;
  content: string;
};

const QUEUE_DIR = "raw/queue";
const SOURCE_CARD_NAME = "_source.md";
const VALID_STATUSES = new Set<QueueStatus>(["queued", "ingesting", "ingested", "blocked"]);
const VALID_TRANSITIONS: Record<QueueStatus, readonly QueueStatus[]> = {
  queued: ["ingesting"],
  ingesting: ["ingested", "blocked"],
  ingested: [],
  blocked: ["queued"],
};

export async function listQueue(repoRoot: string): Promise<Result<QueueListResult, QueueCommandError>> {
  const queueFiles = await readQueueRecords(repoRoot);
  if (!queueFiles.ok) {
    return queueFiles;
  }

  const items = queueFiles.value.map(({ record }) => toQueueListItem(record));

  return ok({
    items,
    counts: countQueueItems(items),
  });
}

export async function listQueueRecordSummaries(
  repoRoot: string,
): Promise<Result<QueueRecordSummary[], QueueCommandError>> {
  const queueFiles = await readQueueRecords(repoRoot);
  if (!queueFiles.ok) {
    return queueFiles;
  }

  return ok(queueFiles.value.map(({ record }) => ({
    source_id: record.source_id,
    captured_at: record.captured_at,
    status: record.status,
  })));
}

export async function showQueueSource(
  repoRoot: string,
  sourceId: string,
): Promise<Result<QueueShowResult, QueueCommandError>> {
  const sourceIdValidation = validateSourceId(sourceId);
  if (!sourceIdValidation.ok) {
    return sourceIdValidation;
  }

  const queueRecord = await findQueueRecord(repoRoot, sourceId);
  if (!queueRecord.ok) {
    return queueRecord;
  }

  if (queueRecord.value === null) {
    const sourceCard = await findSourceCardBySourceId(repoRoot, sourceId);
    if (!sourceCard.ok) {
      return sourceCard;
    }

    if (sourceCard.value !== null) {
      return err({
        code: "QUEUE_ITEM_MISSING",
        message: `Source card has no queue item: ${sourceId}`,
        path: `raw/queue/${sourceId}.json`,
        hint: "Restore the queue JSON for this source or mark the source ingested through the queue workflow.",
      });
    }

    return err({
      code: "QUEUE_ITEM_NOT_FOUND",
      message: `Queue item not found: ${sourceId}`,
      path: `raw/queue/${sourceId}.json`,
      hint: "Run llm-wiki queue to list known source IDs.",
    });
  }

  return readConsistentQueueSource(repoRoot, queueRecord.value.record);
}

export async function setQueueStatus(
  repoRoot: string,
  sourceId: string,
  nextStatusText: string,
  options: { now?: Date; command?: string } = {},
): Promise<Result<QueueSetStatusResult, QueueCommandError>> {
  return transitionQueueStatus(repoRoot, sourceId, nextStatusText, options);
}

export async function transitionQueueStatus(
  repoRoot: string,
  sourceId: string,
  nextStatusText: string,
  options: QueueTransitionOptions = {},
): Promise<Result<QueueSetStatusResult, QueueCommandError>> {
  const nextStatus = parseQueueStatus(nextStatusText);
  if (nextStatus === null) {
    return err({
      code: "QUEUE_STATUS_INVALID",
      message: `Unsupported queue status: ${nextStatusText}`,
      path: "status",
      hint: "Use one of queued, ingesting, ingested, or blocked.",
    });
  }

  const shown = await showQueueSource(repoRoot, sourceId);
  if (!shown.ok) {
    return shown;
  }

  const previousStatus = shown.value.queue_record.status;
  if (!VALID_TRANSITIONS[previousStatus].includes(nextStatus)) {
    return err({
      code: "QUEUE_STATUS_TRANSITION_INVALID",
      message: `Invalid queue status transition: ${previousStatus} -> ${nextStatus}`,
      path: shown.value.queue_record.queue_path,
      hint: `Valid transitions are queued -> ingesting, ingesting -> ingested, ingesting -> blocked, and blocked -> queued.`,
    });
  }

  const updatedAt = (options.now ?? new Date()).toISOString();
  const logTarget = await validateRuntimeLogAppendTarget(repoRoot);
  if (!logTarget.ok) {
    return err(binaryWriteToQueueError(logTarget.error));
  }

  const nextQueueRecord: QueueRecord = {
    ...shown.value.queue_record,
    status: nextStatus,
    updated_at: updatedAt,
    ...nextAutoIngestField(shown.value.queue_record.auto_ingest, nextStatus, updatedAt, options.autoIngest),
  };
  const nextSourceCardFrontmatter: SourceCardFrontmatter = {
    ...shown.value.source_card.frontmatter,
    status: nextStatus,
    updated_at: updatedAt,
    ...nextAutoIngestField(
      shown.value.source_card.frontmatter.auto_ingest,
      nextStatus,
      updatedAt,
      options.autoIngest,
    ),
  };

  const sourceCardContent = await readTextFileInsideRoot(repoRoot, shown.value.source_card.path);
  if (!sourceCardContent.ok) {
    return sourceCardContent;
  }

  const queueContent = await readTextFileInsideRoot(repoRoot, shown.value.queue_record.queue_path);
  if (!queueContent.ok) {
    return queueContent;
  }

  const sourceCardWrite = await writeTextFileInsideRoot(
    repoRoot,
    shown.value.source_card.path,
    formatUpdatedSourceCard(sourceCardContent.value, nextSourceCardFrontmatter, nextStatus),
  );
  if (!sourceCardWrite.ok) {
    await rollbackTextFilesInsideRoot(repoRoot, [
      { path: shown.value.source_card.path, content: sourceCardContent.value },
    ]);
    return sourceCardWrite;
  }

  const queueWrite = await writeTextFileInsideRoot(
    repoRoot,
    shown.value.queue_record.queue_path,
    `${JSON.stringify(omitRuntimeQueuePath(nextQueueRecord), null, 2)}\n`,
  );
  if (!queueWrite.ok) {
    await rollbackTextFilesInsideRoot(repoRoot, [
      { path: shown.value.queue_record.queue_path, content: queueContent.value },
      { path: shown.value.source_card.path, content: sourceCardContent.value },
    ]);
    return queueWrite;
  }

  const logWrite = await appendRuntimeLogEntry(repoRoot, {
    timestamp: updatedAt,
    operation: "ingest",
    affectedId: sourceId,
    title: `Status changed to ${nextStatus}`,
    command: options.command ?? `llm-wiki queue set-status ${sourceId} ${nextStatus}`,
    rawSource: shown.value.source_card.path,
    updated: [shown.value.queue_record.queue_path, shown.value.source_card.path],
    statusTransition: `${previousStatus} -> ${nextStatus}`,
  });
  if (!logWrite.ok) {
    await rollbackTextFilesInsideRoot(repoRoot, [
      { path: shown.value.queue_record.queue_path, content: queueContent.value },
      { path: shown.value.source_card.path, content: sourceCardContent.value },
    ]);
    return err(binaryWriteToQueueError(logWrite.error));
  }

  return ok({
    source_id: sourceId,
    previous_status: previousStatus,
    status: nextStatus,
    source_card_path: shown.value.source_card.path,
    queue_path: shown.value.queue_record.queue_path,
    updated_at: updatedAt,
    log_path: "curated/log.md",
  });
}

function toQueueListItem(record: QueueRecord): QueueListItem {
  return {
    source_id: record.source_id,
    title: record.title,
    kind: record.kind,
    source_kind: record.source_kind,
    status: record.status,
    visibility: record.visibility,
    source_card_path: record.path,
    queue_path: record.queue_path,
    original_path: record.original_path,
    updated_at: record.updated_at ?? record.captured_at,
  };
}

function countQueueItems(items: readonly QueueListItem[]): QueueListResult["counts"] {
  const counts: QueueListResult["counts"] = {
    total: items.length,
    queued: 0,
    ingesting: 0,
    ingested: 0,
    blocked: 0,
  };

  for (const item of items) {
    counts[item.status] += 1;
  }

  return counts;
}

function nextAutoIngestField(
  current: AutoIngestMetadata | undefined,
  nextStatus: QueueStatus,
  updatedAt: string,
  options: QueueTransitionAutoIngestOptions | undefined,
): { auto_ingest: AutoIngestMetadata } | Record<string, never> {
  if (options === undefined) {
    return {};
  }

  const transitionStartsAttempt = nextStatus === "ingesting";
  const transitionFinishesMissingAttempt =
    current === undefined && (nextStatus === "ingested" || nextStatus === "blocked");
  const lastAttemptAt = transitionStartsAttempt || current === undefined ? updatedAt : current.last_attempt_at;

  return {
    auto_ingest: {
      enabled: options.enabled,
      attempt_count:
        (current?.attempt_count ?? 0) + (transitionStartsAttempt || transitionFinishesMissingAttempt ? 1 : 0),
      last_attempt_at: lastAttemptAt,
      last_result: options.result,
      last_error_code: options.errorCode ?? null,
      last_error_message: options.errorMessage ?? null,
    },
  };
}

async function findQueueRecord(
  repoRoot: string,
  sourceId: string,
): Promise<Result<QueueFileRecord | null, QueueCommandError>> {
  const queuePath = `${QUEUE_DIR}/${sourceId}.json`;
  const record = await readQueueRecordFile(repoRoot, queuePath);
  if (!record.ok) {
    if (record.error.code === "QUEUE_SOURCE_CARD_MISSING") {
      return ok(null);
    }

    return record;
  }

  return ok(record.value);
}

async function readQueueRecords(repoRoot: string): Promise<Result<QueueFileRecord[], QueueCommandError>> {
  const queueDir = await resolveExistingPathInsideRoot(repoRoot, QUEUE_DIR, "directory");
  if (!queueDir.ok) {
    if (queueDir.error.code === "QUEUE_SOURCE_CARD_MISSING") {
      return ok([]);
    }

    return err({
      code: "QUEUE_DIRECTORY_INVALID",
      message: queueDir.error.message,
      path: QUEUE_DIR,
      hint: "Restore raw/queue as a directory inside the wiki repository.",
    });
  }

  let queueFileNames: string[];

  try {
    queueFileNames = await readdir(queueDir.value.absolutePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return ok([]);
    }

    return err({
      code: "QUEUE_DIRECTORY_INVALID",
      message: error instanceof Error ? error.message : "Could not read raw/queue.",
      path: QUEUE_DIR,
      hint: "Ensure raw/queue is a readable directory inside the wiki repository.",
    });
  }

  const records: QueueFileRecord[] = [];
  for (const queueFileName of queueFileNames.sort()) {
    if (!queueFileName.endsWith(".json")) {
      continue;
    }

    const record = await readQueueRecordFile(repoRoot, `${QUEUE_DIR}/${queueFileName}`);
    if (!record.ok) {
      return record;
    }

    records.push(record.value);
  }

  return ok(records.sort((left, right) => left.record.source_id.localeCompare(right.record.source_id)));
}

async function readQueueRecordFile(
  repoRoot: string,
  queuePath: string,
): Promise<Result<QueueFileRecord, QueueCommandError>> {
  const content = await readTextFileInsideRoot(repoRoot, queuePath);
  if (!content.ok) {
    return content;
  }

  const scan = parseQueueItem({ path: queuePath, content: content.value });
  if (scan.issues.some((issue) => issue.severity === "error") || scan.item === undefined) {
    return err(scannerIssueToQueueError(scan.issues[0], "QUEUE_ITEM_INVALID", queuePath));
  }

  const normalized = normalizeQueueRecord(queuePath, scan.item);
  if (!normalized.ok) {
    return normalized;
  }

  if (basename(queuePath, ".json") !== normalized.value.source_id) {
    return err({
      code: "QUEUE_ITEM_INVALID",
      message: `Queue file name does not match source ID: ${queuePath}`,
      path: queuePath,
      hint: "Name queue files as raw/queue/<source_id>.json.",
    });
  }

  return ok({
    queuePath,
    record: normalized.value,
  });
}

function normalizeQueueRecord(
  queuePath: string,
  item: Record<string, unknown>,
): Result<QueueRecord, QueueCommandError> {
  const status = parseQueueStatus(item.status);
  const kind = parseSourceKind(item.kind);
  const sourceKind = parseSourceKind(item.source_kind);
  const visibility = parseVisibility(item.visibility);
  const autoIngest = normalizeAutoIngestMetadata(item.auto_ingest);

  if (status === null || kind === null || sourceKind === null || visibility === null) {
    return err({
      code: "QUEUE_ITEM_INVALID",
      message: `Queue item has unsupported field values in ${queuePath}.`,
      path: queuePath,
      hint: "Use supported kind/source_kind, status, and visibility values in the queue JSON.",
    });
  }

  if (!autoIngest.ok) {
    return err({
      code: "QUEUE_ITEM_INVALID",
      message: `Queue item has invalid auto_ingest metadata in ${queuePath}.`,
      path: queuePath,
      hint: "Use auto_ingest.enabled, attempt_count, last_attempt_at, last_result, last_error_code, and last_error_message.",
    });
  }

  if (kind !== sourceKind) {
    return err({
      code: "QUEUE_ITEM_INVALID",
      message: `Queue kind and source_kind differ in ${queuePath}.`,
      path: queuePath,
      hint: "Keep kind and source_kind aligned for source queue records.",
    });
  }

  return ok({
    ...item,
    source_id: String(item.source_id),
    title: String(item.title),
    kind,
    source_kind: sourceKind,
    origin: typeof item.origin === "string" ? item.origin : "",
    ...(typeof item.origin_url === "string" ? { origin_url: item.origin_url } : {}),
    captured_at: typeof item.captured_at === "string" ? item.captured_at : "",
    content_hash: typeof item.content_hash === "string" ? item.content_hash : "",
    status,
    visibility,
    path: String(item.path),
    original_path: String(item.original_path),
    ...(typeof item.updated_at === "string" ? { updated_at: item.updated_at } : {}),
    ...(autoIngest.value === undefined ? {} : { auto_ingest: autoIngest.value }),
    queue_path: queuePath,
  });
}

async function readConsistentQueueSource(
  repoRoot: string,
  record: QueueRecord,
): Promise<Result<QueueShowResult, QueueCommandError>> {
  const sourceCard = await readSourceCard(repoRoot, record.path);
  if (!sourceCard.ok) {
    return sourceCard;
  }

  const originalPath = await validateOriginalPath(repoRoot, record.original_path);
  if (!originalPath.ok) {
    return originalPath;
  }

  const mismatch = findQueueSourceCardMismatch(record, sourceCard.value.frontmatter);
  if (mismatch !== null) {
    return err({
      code: "QUEUE_SOURCE_CARD_MISMATCH",
      message: `Queue item and source card disagree for ${record.source_id}: ${mismatch}`,
      path: sourceCard.value.path,
      hint: "Repair either raw/queue JSON or the source card so source_id, title, source_kind, status, and visibility match.",
    });
  }

  return ok({
    queue_record: record,
    source_card: {
      path: sourceCard.value.path,
      frontmatter: sourceCard.value.frontmatter,
    },
  });
}

async function readSourceCard(
  repoRoot: string,
  sourceCardPath: string,
): Promise<Result<SourceCardDocument, QueueCommandError>> {
  const sourceCard = await readTextFileInsideRoot(repoRoot, sourceCardPath);
  if (!sourceCard.ok) {
    if (sourceCard.error.code === "QUEUE_PATH_UNSAFE") {
      return sourceCard;
    }

    return err({
      code: "QUEUE_SOURCE_CARD_MISSING",
      message: `Source card is missing: ${sourceCardPath}`,
      path: sourceCardPath,
      hint: "Restore the _source.md file referenced by the queue item.",
    });
  }

  const scan = scanMarkdownDocument({ path: sourceCardPath, content: sourceCard.value });
  if (scan.issues.some((issue) => issue.severity === "error") || scan.frontmatter === undefined) {
    return err(scannerIssueToQueueError(scan.issues[0], "QUEUE_SOURCE_CARD_INVALID", sourceCardPath));
  }

  const frontmatter = normalizeSourceCardFrontmatter(sourceCardPath, scan.frontmatter);
  if (!frontmatter.ok) {
    return frontmatter;
  }

  return ok({
    path: sourceCardPath,
    frontmatter: frontmatter.value,
    content: sourceCard.value,
  });
}

function normalizeSourceCardFrontmatter(
  path: string,
  frontmatter: Record<string, unknown>,
): Result<SourceCardFrontmatter, QueueCommandError> {
  const status = parseQueueStatus(frontmatter.status);
  const sourceKind = parseSourceKind(frontmatter.source_kind);
  const visibility = parseVisibility(frontmatter.visibility);
  const autoIngest = normalizeAutoIngestMetadata(frontmatter.auto_ingest);

  if (
    frontmatter.type !== "raw_source" ||
    typeof frontmatter.source_id !== "string" ||
    typeof frontmatter.title !== "string" ||
    sourceKind === null ||
    typeof frontmatter.origin !== "string" ||
    typeof frontmatter.captured_at !== "string" ||
    typeof frontmatter.content_hash !== "string" ||
    status === null ||
    visibility === null
  ) {
    return err({
      code: "QUEUE_SOURCE_CARD_INVALID",
      message: `Source card frontmatter is missing required raw_source fields in ${path}.`,
      path,
      hint: "Keep _source.md frontmatter aligned with the generated raw source schema.",
    });
  }

  if (!autoIngest.ok) {
    return err({
      code: "QUEUE_SOURCE_CARD_INVALID",
      message: `Source card frontmatter has invalid auto_ingest metadata in ${path}.`,
      path,
      hint: "Use auto_ingest.enabled, attempt_count, last_attempt_at, last_result, last_error_code, and last_error_message.",
    });
  }

  return ok({
    ...frontmatter,
    type: "raw_source",
    source_id: frontmatter.source_id,
    title: frontmatter.title,
    source_kind: sourceKind,
    origin: frontmatter.origin,
    ...(typeof frontmatter.origin_url === "string" || frontmatter.origin_url === null
      ? { origin_url: frontmatter.origin_url }
      : {}),
    captured_at: frontmatter.captured_at,
    content_hash: frontmatter.content_hash,
    status,
    visibility,
    ...(typeof frontmatter.updated_at === "string" ? { updated_at: frontmatter.updated_at } : {}),
    ...(autoIngest.value === undefined ? {} : { auto_ingest: autoIngest.value }),
  });
}

function findQueueSourceCardMismatch(record: QueueRecord, frontmatter: SourceCardFrontmatter): string | null {
  const comparisons: Array<[field: string, left: unknown, right: unknown]> = [
    ["source_id", record.source_id, frontmatter.source_id],
    ["title", record.title, frontmatter.title],
    ["source_kind", record.source_kind, frontmatter.source_kind],
    ["status", record.status, frontmatter.status],
    ["visibility", record.visibility, frontmatter.visibility],
  ];

  const scalarMismatch = comparisons.find(([, left, right]) => left !== right)?.[0] ?? null;
  if (scalarMismatch !== null) {
    return scalarMismatch;
  }

  if (!autoIngestMetadataEqual(record.auto_ingest, frontmatter.auto_ingest)) {
    return "auto_ingest";
  }

  return null;
}

async function findSourceCardBySourceId(
  repoRoot: string,
  sourceId: string,
): Promise<Result<SourceCardDocument | null, QueueCommandError>> {
  const parts = parseSourceId(sourceId);
  if (!parts.ok) {
    return err(scannerIssueToQueueError(parts.error, "SOURCE_ID_INVALID", sourceId));
  }

  const sourceCardPath = `raw/inputs/${parts.value.year}/${parts.value.month}/${sourceId}/${SOURCE_CARD_NAME}`;
  const sourceCard = await readSourceCard(repoRoot, sourceCardPath);
  if (!sourceCard.ok) {
    if (sourceCard.error.code === "QUEUE_SOURCE_CARD_MISSING") {
      return ok(null);
    }

    return sourceCard;
  }

  return ok(sourceCard.value);
}

async function validateOriginalPath(repoRoot: string, originalPath: string): Promise<Result<void, QueueCommandError>> {
  const originalFile = await resolveExistingPathInsideRoot(repoRoot, originalPath, "file");
  if (!originalFile.ok) {
    if (originalFile.error.code !== "QUEUE_SOURCE_CARD_MISSING") {
      return originalFile;
    }

    return err({
      code: "QUEUE_ITEM_INVALID",
      message: `Queue original is missing: ${originalPath}`,
      path: originalPath,
      hint: "Restore the raw original referenced by the queue item.",
    });
  }

  return ok(undefined);
}

function formatUpdatedSourceCard(
  currentContent: string,
  frontmatter: SourceCardFrontmatter,
  status: QueueStatus,
): string {
  const match = currentContent.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?([\s\S]*)$/);
  const body = match?.[1] ?? "";
  const updatedBody = replaceIngestStatusLine(body, status);

  return `---\n${stringify(frontmatter).trimEnd()}\n---\n${updatedBody}`;
}

function replaceIngestStatusLine(body: string, status: QueueStatus): string {
  const lineEnding = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Ingest status\s*$/.test(line));

  if (headingIndex === -1) {
    return `${body.trimEnd()}\n\n## Ingest status\n\n- Status: ${status}\n`;
  }

  const sectionEndIndex = lines.findIndex((line, index) => index > headingIndex && /^#{1,2}\s+/.test(line));
  const sectionEnd = sectionEndIndex === -1 ? lines.length : sectionEndIndex;
  const statusIndex = lines.findIndex(
    (line, index) => index > headingIndex && index < sectionEnd && /^- Status:/.test(line),
  );

  if (statusIndex === -1) {
    let insertIndex = headingIndex + 1;
    while (insertIndex < sectionEnd && (lines[insertIndex] ?? "").trim() === "") {
      insertIndex += 1;
    }

    lines.splice(insertIndex, 0, `- Status: ${status}`);
  } else {
    lines[statusIndex] = `- Status: ${status}`;
  }

  return lines.join(lineEnding);
}

async function readTextFileInsideRoot(repoRoot: string, relativePath: string): Promise<Result<string, QueueCommandError>> {
  const safePath = await resolveExistingPathInsideRoot(repoRoot, relativePath, "file");
  if (!safePath.ok) {
    return safePath;
  }

  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const fileStat = await lstat(safePath.value.absolutePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return err({
        code: "QUEUE_PATH_UNSAFE",
        message: `Queue path is not a safe file: ${relativePath}`,
        path: relativePath,
        hint: "Queue and source card paths must be regular files inside the wiki repository.",
      });
    }

    file = await open(safePath.value.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    return ok(await file.readFile("utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return err({
        code: "QUEUE_SOURCE_CARD_MISSING",
        message: `Queue path does not exist: ${relativePath}`,
        path: relativePath,
        hint: "Restore the missing queue or source card file.",
      });
    }

    return err({
      code: "QUEUE_PATH_UNSAFE",
      message: error instanceof Error ? error.message : String(error),
      path: relativePath,
      hint: "Queue operations must read regular files inside the wiki repository without following symlinks.",
    });
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function writeTextFileInsideRoot(
  repoRoot: string,
  relativePath: string,
  content: string,
): Promise<Result<void, QueueCommandError>> {
  const safePath = await resolveExistingPathInsideRoot(repoRoot, relativePath, "file");
  if (!safePath.ok) {
    return safePath;
  }

  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const fileStat = await lstat(safePath.value.absolutePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return err({
        code: "QUEUE_PATH_UNSAFE",
        message: `Queue path is not a safe file: ${relativePath}`,
        path: relativePath,
        hint: "Queue and source card paths must be regular files inside the wiki repository.",
      });
    }

    file = await open(safePath.value.absolutePath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    await file.writeFile(content, "utf8");
    return ok(undefined);
  } catch (error) {
    return err({
      code: "QUEUE_WRITE_FAILED",
      message: error instanceof Error ? error.message : String(error),
      path: relativePath,
      hint: "Ensure queue JSON and source card files are writable regular files.",
    });
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function rollbackTextFilesInsideRoot(
  repoRoot: string,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  for (const file of files) {
    await writeTextFileInsideRoot(repoRoot, file.path, file.content).catch(() => undefined);
  }
}

async function resolveExistingPathInsideRoot(
  repoRoot: string,
  containedPath: string,
  expectedKind: "directory" | "file",
): Promise<Result<{ absolutePath: string }, QueueCommandError>> {
  const normalizedPath = normalizeContainedPath(containedPath);
  if (!normalizedPath.ok) {
    return normalizedPath;
  }

  const rootPath = resolve(repoRoot);
  const absolutePath = resolve(rootPath, normalizedPath.value);
  const relativeToRoot = relative(rootPath, absolutePath);
  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    return err(queuePathUnsafe(containedPath));
  }

  try {
    const rootRealPath = await realpath(rootPath);
    const pathReady = await validateExistingPathSegments(rootPath, rootRealPath, normalizedPath.value, expectedKind);
    if (!pathReady.ok) {
      return pathReady;
    }
  } catch (error) {
    return err({
      code: "QUEUE_PATH_UNSAFE",
      message: error instanceof Error ? error.message : String(error),
      path: normalizedPath.value,
      hint: "Queue operations must stay inside the wiki repository without following symlinks.",
    });
  }

  return ok({ absolutePath });
}

async function validateExistingPathSegments(
  rootPath: string,
  rootRealPath: string,
  relativePath: string,
  expectedKind: "directory" | "file",
): Promise<Result<void, QueueCommandError>> {
  const segments = relativePath.split("/");
  let currentPath = rootPath;
  let currentRelativePath = "";

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    currentRelativePath = currentRelativePath === "" ? segment : `${currentRelativePath}/${segment}`;
    currentPath = resolve(currentPath, segment);

    try {
      const pathStat = await lstat(currentPath);
      if (pathStat.isSymbolicLink()) {
        return err(queuePathUnsafe(currentRelativePath));
      }

      const isLastSegment = index === segments.length - 1;
      if (!isLastSegment && !pathStat.isDirectory()) {
        return err(queuePathUnsafe(currentRelativePath));
      }

      if (isLastSegment) {
        const isExpectedKind = expectedKind === "file" ? pathStat.isFile() : pathStat.isDirectory();
        if (!isExpectedKind) {
          return err({
            code: "QUEUE_PATH_UNSAFE",
            message: `Queue path is not a safe ${expectedKind}: ${relativePath}`,
            path: relativePath,
            hint: "Queue metadata paths must be regular files or directories inside the wiki repository.",
          });
        }
      }

      const resolvedPath = await realpath(currentPath);
      if (!isInsideRealPath(rootRealPath, resolvedPath)) {
        return err(queuePathUnsafe(currentRelativePath));
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return err({
          code: "QUEUE_SOURCE_CARD_MISSING",
          message: `Queue path does not exist: ${relativePath}`,
          path: relativePath,
          hint: "Restore the missing queue or source card file.",
        });
      }

      return err({
        code: "QUEUE_PATH_UNSAFE",
        message: error instanceof Error ? error.message : String(error),
        path: currentRelativePath || relativePath,
        hint: "Queue operations must read regular files inside the wiki repository without following symlinks.",
      });
    }
  }

  return ok(undefined);
}

function normalizeContainedPath(path: string): Result<string, QueueCommandError> {
  if (
    path.trim() === "" ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").includes("..")
  ) {
    return err(queuePathUnsafe(path));
  }

  const normalizedPath = path.replace(/\/+/g, "/").replace(/\/+$/, "");
  if (normalizedPath === "" || normalizedPath === ".") {
    return err(queuePathUnsafe(path));
  }

  return ok(normalizedPath);
}

function isInsideRealPath(rootRealPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootRealPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function parseQueueStatus(value: unknown): QueueStatus | null {
  return typeof value === "string" && VALID_STATUSES.has(value as QueueStatus) ? (value as QueueStatus) : null;
}

function parseSourceKind(value: unknown): QueueSourceKind | null {
  return value === "file" || value === "text" || value === "url" ? value : null;
}

function parseVisibility(value: unknown): QueueVisibility | null {
  return value === "private" || value === "public" ? value : null;
}

function normalizeAutoIngestMetadata(value: unknown): Result<AutoIngestMetadata | undefined, "invalid"> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (!isRecord(value)) {
    return err("invalid");
  }

  const enabled = value.enabled;
  const attemptCount = value.attempt_count;
  const lastAttemptAt = value.last_attempt_at;
  const lastResult = value.last_result;
  const lastErrorCode = value.last_error_code;
  const lastErrorMessage = value.last_error_message;

  if (
    typeof enabled !== "boolean" ||
    typeof attemptCount !== "number" ||
    !Number.isInteger(attemptCount) ||
    attemptCount < 0 ||
    typeof lastAttemptAt !== "string" ||
    typeof lastResult !== "string" ||
    !isNullableString(lastErrorCode) ||
    !isNullableString(lastErrorMessage)
  ) {
    return err("invalid");
  }

  return ok({
    enabled,
    attempt_count: attemptCount,
    last_attempt_at: lastAttemptAt,
    last_result: lastResult,
    last_error_code: lastErrorCode,
    last_error_message: lastErrorMessage,
  });
}

function autoIngestMetadataEqual(
  left: AutoIngestMetadata | undefined,
  right: AutoIngestMetadata | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return (
    left.enabled === right.enabled &&
    left.attempt_count === right.attempt_count &&
    left.last_attempt_at === right.last_attempt_at &&
    left.last_result === right.last_result &&
    left.last_error_code === right.last_error_code &&
    left.last_error_message === right.last_error_message
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validateSourceId(sourceId: string): Result<void, QueueCommandError> {
  const parsed = parseSourceId(sourceId);
  if (!parsed.ok) {
    return err(scannerIssueToQueueError(parsed.error, "SOURCE_ID_INVALID", sourceId));
  }

  return ok(undefined);
}

function omitRuntimeQueuePath(record: QueueRecord): Omit<QueueRecord, "queue_path"> {
  const { queue_path: _queuePath, ...jsonRecord } = record;

  return jsonRecord;
}

function scannerIssueToQueueError(
  issue: ScannerIssue | undefined,
  fallbackCode: QueueCommandErrorCode,
  fallbackPath: string,
): QueueCommandError {
  if (issue === undefined) {
    return {
      code: fallbackCode,
      message: `Queue data is invalid: ${fallbackPath}`,
      path: fallbackPath,
      hint: "Repair the queue JSON or source card and try again.",
    };
  }

  return {
    code: fallbackCode === "SOURCE_ID_INVALID" ? "SOURCE_ID_INVALID" : fallbackCode,
    message: issue.message,
    path: issue.path,
    hint: issue.hint,
  };
}

function queuePathUnsafe(path: string): QueueCommandError {
  return {
    code: "QUEUE_PATH_UNSAFE",
    message: `Queue path is unsafe: ${path}`,
    path,
    hint: "Queue metadata paths must be relative paths inside the wiki repository.",
  };
}

function binaryWriteToQueueError(error: { message: string; path: string; hint: string }): QueueCommandError {
  return {
    code: "QUEUE_WRITE_FAILED",
    message: error.message,
    path: error.path,
    hint: error.hint,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
