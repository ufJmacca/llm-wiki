import { stringify } from "yaml";

import type { ProposalPolicy } from "../proposals/index.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { showQueueSource, type QueueRecord, type SourceCardFrontmatter } from "../runtime/queue.js";
import {
  readTextFileInsideRoot,
  validateTextFileWriteInsideRoot,
  writeTextFileInsideRoot,
} from "../utils/fs.js";
import {
  createPendingPdfExtractionState,
  normalizePdfExtractionState,
  pdfExtractionStateEqual,
  type PdfExtractionState,
} from "./stateSchema.js";

export type { PdfExtractionState, PdfExtractionStatus } from "./stateSchema.js";

export type PdfExtractionSourceState = {
  sourceId: string;
  sourceDir: string;
  queuePath: string;
  sourceCardPath: string;
  originalPath: string;
  contentHash: string;
  capturedAt: string;
  queueStatus: QueueRecord["status"];
  sourceKind: QueueRecord["source_kind"];
  state: PdfExtractionState;
  statePersisted: boolean;
  queueRecord: QueueRecord;
  sourceCardFrontmatter: SourceCardFrontmatter;
};

export async function readPdfExtractionSourceState(
  repoRoot: string,
  sourceId: string,
): Promise<PdfExtractionSourceState> {
  const shown = await showQueueSource(repoRoot, sourceId);
  if (!shown.ok) {
    throw queueReadError(shown.error.code, shown.error.message, shown.error.path, shown.error.hint);
  }

  const queueState = shown.value.queue_record.pdf_extraction;
  const sourceState = shown.value.source_card.frontmatter.pdf_extraction;
  if (shown.value.queue_record.content_hash !== shown.value.source_card.frontmatter.content_hash) {
    throw new RuntimeCommandError({
      code: "PDF_ORIGINAL_CHANGED",
      message: `Queue and source-card content_hash values disagree for ${sourceId}.`,
      path: shown.value.queue_record.queue_path,
      hint: "Restore the canonical immutable PDF hash in both mirrored source records.",
    });
  }
  if ((queueState === undefined) !== (sourceState === undefined)) {
    throw inconsistentState(sourceId, "Only one mirrored file contains pdf_extraction state.");
  }

  const sourceDir = sourceDirectory(shown.value.source_card.path, sourceId);
  let state: PdfExtractionState;
  let statePersisted: boolean;
  if (queueState === undefined || sourceState === undefined) {
    state = createPendingPdfExtractionState(
      shown.value.queue_record.content_hash,
      shown.value.queue_record.captured_at,
    );
    statePersisted = false;
  } else {
    const normalizedQueue = normalizePdfExtractionState(queueState, { sourceDir });
    const normalizedSource = normalizePdfExtractionState(sourceState, { sourceDir });
    if (!normalizedQueue.ok || !normalizedSource.ok) {
      const message = !normalizedQueue.ok
        ? normalizedQueue.error.message
        : !normalizedSource.ok
          ? normalizedSource.error.message
          : "PDF extraction state is invalid.";
      throw inconsistentState(sourceId, message);
    }
    if (!pdfExtractionStateEqual(normalizedQueue.value, normalizedSource.value)) {
      throw inconsistentState(sourceId, "Queue and source-card pdf_extraction objects disagree.");
    }
    state = normalizedQueue.value;
    statePersisted = true;
  }

  if (state.original_hash !== shown.value.queue_record.content_hash) {
    throw new RuntimeCommandError({
      code: "PDF_ORIGINAL_CHANGED",
      message: `PDF extraction state hash does not match source content_hash for ${sourceId}.`,
      path: shown.value.queue_record.original_path,
      hint: "Restore the immutable original and mirrored PDF state before retrying extraction.",
    });
  }

  return {
    sourceId,
    sourceDir,
    queuePath: shown.value.queue_record.queue_path,
    sourceCardPath: shown.value.source_card.path,
    originalPath: shown.value.queue_record.original_path,
    contentHash: shown.value.queue_record.content_hash,
    capturedAt: shown.value.queue_record.captured_at,
    queueStatus: shown.value.queue_record.status,
    sourceKind: shown.value.queue_record.source_kind,
    state,
    statePersisted,
    queueRecord: shown.value.queue_record,
    sourceCardFrontmatter: shown.value.source_card.frontmatter,
  };
}

export async function synchronizePdfExtractionState(
  repoRoot: string,
  expected: PdfExtractionSourceState,
  nextState: PdfExtractionState,
): Promise<PdfExtractionSourceState> {
  const current = await readPdfExtractionSourceState(repoRoot, expected.sourceId);
  if (
    current.queuePath !== expected.queuePath
    || current.sourceCardPath !== expected.sourceCardPath
    || current.originalPath !== expected.originalPath
    || current.contentHash !== expected.contentHash
    || current.queueStatus !== expected.queueStatus
    || !pdfExtractionStateEqual(current.state, expected.state)
  ) {
    throw inconsistentState(expected.sourceId, "PDF source or mirrored state changed before synchronization.");
  }

  const normalized = normalizePdfExtractionState(nextState, { sourceDir: current.sourceDir });
  if (!normalized.ok || normalized.value.original_hash !== current.contentHash) {
    throw inconsistentState(
      expected.sourceId,
      normalized.ok ? "Next PDF state hash differs from content_hash." : normalized.error.message,
    );
  }

  const [sourceSnapshot, queueSnapshot] = await Promise.all([
    readRequiredText(repoRoot, current.sourceCardPath),
    readRequiredText(repoRoot, current.queuePath),
  ]);
  const sourceContent = formatSourceCardState(
    sourceSnapshot,
    { ...current.sourceCardFrontmatter, pdf_extraction: normalized.value },
  );
  const { queue_path: _queuePath, ...queueRecord } = current.queueRecord;
  const queueContent = `${JSON.stringify({ ...queueRecord, pdf_extraction: normalized.value }, null, 2)}\n`;

  for (const path of [current.sourceCardPath, current.queuePath]) {
    const target = await validateTextFileWriteInsideRoot(repoRoot, path);
    if (!target.ok) {
      throw stateWriteError(path, target.error.message);
    }
  }

  const sourceWrite = await writeTextFileInsideRoot(repoRoot, current.sourceCardPath, sourceContent);
  if (!sourceWrite.ok) {
    await restoreMirrors(repoRoot, current, sourceSnapshot, queueSnapshot, sourceWrite.error.message);
  }

  const queueWrite = await writeTextFileInsideRoot(repoRoot, current.queuePath, queueContent);
  if (!queueWrite.ok) {
    await restoreMirrors(repoRoot, current, sourceSnapshot, queueSnapshot, queueWrite.error.message);
  }

  try {
    const refreshed = await readPdfExtractionSourceState(repoRoot, current.sourceId);
    if (!refreshed.statePersisted || !pdfExtractionStateEqual(refreshed.state, normalized.value)) {
      throw new Error("Mirrored state readback did not match the requested state.");
    }
    return refreshed;
  } catch (error) {
    return restoreMirrors(
      repoRoot,
      current,
      sourceSnapshot,
      queueSnapshot,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function createPdfExtractionProposalPolicy(allowedPath: string): ProposalPolicy {
  return {
    rejectionCode: "PDF_WORKSPACE_MUTATION_REJECTED",
    writeFailedCode: "PDF_APPLY_FAILED",
    rejectedPathHint: `PDF extraction may write only ${allowedPath}.`,
    duplicatePathHint: "PDF extraction must propose exactly one document.md path.",
    writeRejectedHint: `PDF extraction may write only ${allowedPath}.`,
    writeFailedHint: "Fix the private extraction run destination and retry.",
    pathRejectedMessage: (path) => `PDF extraction proposal path is not allowed: ${path}.`,
    duplicatePathMessage: (path) => `PDF extraction proposed the path more than once: ${path}.`,
    allowPath: (normalizedPath) => normalizedPath === allowedPath
      ? null
      : {
          message: `PDF extraction proposal path is not the selected document.md: ${normalizedPath}.`,
          hint: `Write only ${allowedPath}.`,
          path: normalizedPath,
        },
  };
}

async function restoreMirrors(
  repoRoot: string,
  source: PdfExtractionSourceState,
  sourceSnapshot: string,
  queueSnapshot: string,
  cause: string,
): Promise<never> {
  const queueRestore = await writeTextFileInsideRoot(repoRoot, source.queuePath, queueSnapshot);
  const sourceRestore = await writeTextFileInsideRoot(repoRoot, source.sourceCardPath, sourceSnapshot);
  const [queueReadback, sourceReadback] = await Promise.all([
    readTextFileInsideRoot(repoRoot, source.queuePath),
    readTextFileInsideRoot(repoRoot, source.sourceCardPath),
  ]);
  if (
    !queueRestore.ok
    || !sourceRestore.ok
    || !queueReadback.ok
    || !sourceReadback.ok
    || queueReadback.value !== queueSnapshot
    || sourceReadback.value !== sourceSnapshot
  ) {
    throw stateWriteError(source.sourceCardPath, `PDF state rollback failed after: ${cause}`);
  }

  throw stateWriteError(source.sourceCardPath, cause);
}

async function readRequiredText(repoRoot: string, path: string): Promise<string> {
  const result = await readTextFileInsideRoot(repoRoot, path);
  if (!result.ok) {
    throw stateWriteError(path, result.error.message);
  }
  return result.value;
}

function formatSourceCardState(content: string, frontmatter: SourceCardFrontmatter): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---([\s\S]*)$/u);
  if (match === null) {
    throw stateWriteError("_source.md", "Source card frontmatter delimiters are invalid.");
  }
  return `---\n${stringify(frontmatter).trimEnd()}\n---${match[1] ?? ""}`;
}

function sourceDirectory(sourceCardPath: string, sourceId: string): string {
  const suffix = `/${sourceId}/_source.md`;
  if (!sourceCardPath.endsWith(suffix)) {
    throw inconsistentState(sourceId, "Source card path does not match its source ID.");
  }
  return sourceCardPath.slice(0, -"/_source.md".length);
}

function queueReadError(code: string, message: string, path: string, hint: string): RuntimeCommandError {
  if (code === "PDF_ARTIFACT_INCONSISTENT") {
    return new RuntimeCommandError({ code, message, path, hint });
  }
  return new RuntimeCommandError({
    code,
    message,
    path,
    hint,
  });
}

function inconsistentState(sourceId: string, message: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "PDF_ARTIFACT_INCONSISTENT",
    message,
    path: sourceId,
    hint: "Repair the queue/source-card PDF state consistently before retrying extraction.",
  });
}

function stateWriteError(path: string, message: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "PDF_STATE_WRITE_FAILED",
    message: `Could not synchronize PDF extraction state: ${message}`,
    path,
    hint: "Restore writable queue and source-card files, verify their mirrored state, and retry.",
  });
}
