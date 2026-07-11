import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { computeContentHash, parseSourceId, scanMarkdownDocument } from "../scanner/index.js";
import { showQueueSource, type QueueStatus } from "../runtime/queue.js";
import { readTextFileInsideRoot } from "../utils/fs.js";
import { readPdfIngestionConfig } from "./config.js";
import { readValidatedPdfArtifact, type PdfExtractionMetadata } from "./extraction.js";
import {
  createPendingPdfExtractionState,
  isPdfOriginalPath,
  isPdfSignature,
  normalizePdfExtractionState,
  pdfExtractionStateEqual,
  type PdfExtractionState,
  type PdfExtractionStatus,
} from "./stateSchema.js";

export type PdfArtifactHealth = "missing" | "valid" | "stale" | "inconsistent";

export type PdfSourceStatus = {
  applicable: true;
  source_id: string;
  queue_status: QueueStatus | null;
  extraction_status: PdfExtractionStatus | null;
  artifact_health: PdfArtifactHealth;
  required: true;
  extraction_id: string | null;
  artifact_path: string | null;
  plugin: string | null;
  plugin_version: string | null;
  plugin_descriptor: string | null;
  model_descriptor: string | null;
  model_selection: "explicit" | "inherited" | null;
  requested_model: string | null;
  observed_model: string | null;
  reasoning_effort: string | null;
  pdf_detail: "auto" | "low" | "high" | null;
  codex_agent: string | null;
  codex_version: string | null;
  reusable: boolean;
  last_error_code: string | null;
  last_error_message: string | null;
  diagnosis_code: "PDF_ARTIFACT_REQUIRED" | "PDF_ARTIFACT_STALE" | "PDF_ARTIFACT_INCONSISTENT" | null;
  diagnosis_scope: "artifact" | "settings" | "state" | null;
  diagnosis_message: string | null;
  retry_command: string;
  hint: string;
};

export type PdfStatusReadOptions = {
  checkCurrentPluginDescriptor?: boolean;
  currentPluginDescriptor?: string | null;
};

type RawPdfSource = {
  sourceId: string;
  sourceDir: string;
  queueStatus: QueueStatus | null;
  sourceKind: string | null;
  originalPath: string | null;
  queueHash: string | null;
  sourceHash: string | null;
  queueState: unknown;
  sourceState: unknown;
};

export async function readPdfRepositoryStatuses(
  repoRoot: string,
  options: PdfStatusReadOptions = {},
): Promise<ReadonlyMap<string, PdfSourceStatus>> {
  const statuses = new Map<string, PdfSourceStatus>();
  let entries: string[];
  try {
    entries = await readdir(resolve(repoRoot, "raw/queue"));
  } catch {
    return statuses;
  }
  for (const entry of entries.sort()) {
    const match = /^(src_[A-Za-z0-9_-]+)\.json$/u.exec(entry);
    if (match === null) continue;
    const sourceId = match[1] ?? "";
    const status = await readPdfSourceStatus(repoRoot, sourceId, options);
    if (status !== null) statuses.set(sourceId, status);
  }
  return statuses;
}

export async function readPdfSourceStatus(
  repoRoot: string,
  sourceId: string,
  options: PdfStatusReadOptions = {},
): Promise<PdfSourceStatus | null> {
  if (!parseSourceId(sourceId).ok) return null;
  const raw = await readRawPdfSource(repoRoot, sourceId);
  if (raw === null) return null;
  const applicable = raw.sourceState !== undefined
    || raw.queueState !== undefined
    || (raw.sourceKind === "file" && raw.originalPath !== null && isPdfOriginalPath(raw.originalPath));
  if (!applicable) return null;

  const base = baseStatus(raw);
  const shown = await showQueueSource(repoRoot, sourceId);
  if (!shown.ok) {
    return inconsistent(base, shown.error.message, undefined, "state");
  }
  const canonical: RawPdfSource = {
    sourceId,
    sourceDir: dirname(shown.value.source_card.path),
    queueStatus: shown.value.queue_record.status,
    sourceKind: shown.value.queue_record.source_kind,
    originalPath: shown.value.queue_record.original_path,
    queueHash: shown.value.queue_record.content_hash,
    sourceHash: shown.value.source_card.frontmatter.content_hash,
    queueState: shown.value.queue_record.pdf_extraction,
    sourceState: shown.value.source_card.frontmatter.pdf_extraction,
  };
  if (canonical.sourceKind !== "file" || canonical.originalPath === null || !isPdfOriginalPath(canonical.originalPath)) {
    return inconsistent(baseStatus(canonical), "The source is not an eligible file-backed PDF.", undefined, "state");
  }

  const canonicalBase = baseStatus(canonical);
  if (canonical.queueState === undefined && canonical.sourceState === undefined) {
    const state = createPendingPdfExtractionState(canonical.queueHash ?? `sha256:${"0".repeat(64)}`, new Date(0).toISOString());
    const originalIssue = await originalIntegrityIssue(repoRoot, canonical);
    return originalIssue === null
      ? projectState(canonicalBase, state, "missing", "PDF_ARTIFACT_REQUIRED", "No PDF extraction artifact is selected.")
      : inconsistent(canonicalBase, originalIssue, state, "artifact");
  }
  if (canonical.queueState === undefined || canonical.sourceState === undefined) {
    return inconsistent(canonicalBase, "Queue and source-card PDF extraction state are not both present.", undefined, "state");
  }

  const queueState = normalizePdfExtractionState(canonical.queueState, { sourceDir: canonical.sourceDir });
  const sourceState = normalizePdfExtractionState(canonical.sourceState, { sourceDir: canonical.sourceDir });
  if (!queueState.ok) return inconsistent(canonicalBase, queueState.error.message, undefined, "state");
  if (!sourceState.ok) return inconsistent(canonicalBase, sourceState.error.message, undefined, "state");
  if (!pdfExtractionStateEqual(queueState.value, sourceState.value)) {
    return inconsistent(canonicalBase, "Queue and source-card PDF extraction state disagree.", undefined, "state");
  }
  const state = queueState.value;
  if (
    canonical.queueHash === null
    || canonical.sourceHash === null
    || canonical.queueHash !== canonical.sourceHash
    || state.original_hash !== canonical.queueHash
  ) {
    return inconsistent(canonicalBase, "PDF source and extraction-state hashes disagree.", state, "state");
  }
  const originalIssue = await originalIntegrityIssue(repoRoot, canonical);
  if (originalIssue !== null) return inconsistent(canonicalBase, originalIssue, state, "artifact");
  if (state.status !== "extracted") {
    const message = state.status === "failed"
      ? "The most recent PDF extraction failed and no artifact is selected."
      : `PDF extraction is ${state.status}; no completed artifact is selected.`;
    return projectState(canonicalBase, state, "missing", "PDF_ARTIFACT_REQUIRED", message);
  }

  const selectedFiles = await selectedRunFilesState(repoRoot, state);
  if (selectedFiles === "missing") {
    return projectState(canonicalBase, state, "missing", "PDF_ARTIFACT_REQUIRED", "The selected PDF run is missing document.md or metadata.json.");
  }
  if (selectedFiles === "unsafe") {
    return inconsistent(canonicalBase, "The selected PDF run contains an unsafe, symlinked, or non-file artifact.", state, "artifact");
  }

  let metadata: PdfExtractionMetadata;
  try {
    metadata = (await readValidatedPdfArtifact(repoRoot, sourceId)).metadata;
  } catch (error) {
    return inconsistent(canonicalBase, sanitize(error instanceof Error ? error.message : String(error)), state, "artifact");
  }

  const config = await readPdfIngestionConfig(repoRoot);
  if (!config.ok) {
    return projectState(canonicalBase, state, "stale", "PDF_ARTIFACT_STALE", "Current PDF settings are invalid, so reuse identity cannot be confirmed.", "settings", metadata);
  }
  const expectedModel = config.value.model === null ? null : `explicit:${config.value.model}`;
  if (
    state.plugin !== config.value.requiredPlugin
    || state.model_descriptor !== expectedModel
    || state.reasoning_effort !== config.value.reasoningEffort
    || state.pdf_detail !== config.value.pdfDetail
  ) {
    return projectState(canonicalBase, state, "stale", "PDF_ARTIFACT_STALE", "The selected PDF run does not match current repository extraction settings.", "settings", metadata);
  }

  if (
    options.checkCurrentPluginDescriptor === true
    && options.currentPluginDescriptor !== null
    && options.currentPluginDescriptor !== undefined
    && state.plugin_descriptor !== options.currentPluginDescriptor
  ) {
    return projectState(canonicalBase, state, "stale", "PDF_ARTIFACT_STALE", "The selected PDF run does not match the currently installed plugin version.", "settings", metadata);
  }

  const valid = projectState(canonicalBase, state, "valid", null, null, null, metadata);
  return options.checkCurrentPluginDescriptor === true
    ? {
        ...valid,
        reusable: valid.reusable
          && options.currentPluginDescriptor !== null
          && options.currentPluginDescriptor !== undefined
          && state.plugin_descriptor === options.currentPluginDescriptor,
      }
    : valid;
}

export function formatHumanPdfSourceStatus(status: PdfSourceStatus): string[] {
  return [
    `PDF extraction status: ${status.extraction_status ?? "inconsistent"}`,
    `PDF artifact health: ${status.artifact_health}`,
    `PDF extraction ID: ${status.extraction_id ?? "none"}`,
    `PDF artifact path: ${status.artifact_path ?? "none"}`,
    `PDF plugin: ${status.plugin ?? "none"}`,
    `PDF plugin version: ${status.plugin_version ?? "none"}`,
    `PDF plugin descriptor: ${status.plugin_descriptor ?? "none"}`,
    `PDF model selection: ${status.model_selection ?? "unknown"}`,
    `PDF requested model: ${status.requested_model ?? "none"}`,
    `PDF model descriptor: ${status.model_descriptor ?? "none"}`,
    `PDF observed model: ${status.observed_model ?? "none"}`,
    `PDF reasoning effort: ${status.reasoning_effort ?? "none"}`,
    `PDF detail: ${status.pdf_detail ?? "none"}`,
    `PDF Codex agent: ${status.codex_agent ?? "none"}`,
    `PDF Codex version: ${status.codex_version ?? "none"}`,
    `PDF reusable: ${status.reusable ? "yes" : "no"}`,
    `PDF last error code: ${status.last_error_code ?? "none"}`,
    `PDF last error: ${status.last_error_message ?? "none"}`,
    `PDF diagnosis: ${status.diagnosis_code ?? "none"}`,
    `PDF diagnosis detail: ${status.diagnosis_message ?? "none"}`,
    `PDF retry: ${status.retry_command}`,
  ];
}

function baseStatus(raw: RawPdfSource): Pick<PdfSourceStatus, "source_id" | "queue_status" | "retry_command" | "hint"> {
  return {
    source_id: raw.sourceId,
    queue_status: raw.queueStatus,
    retry_command: `llm-wiki extract pdf ${raw.sourceId}`,
    hint: `Run llm-wiki extract pdf ${raw.sourceId} to create or reselect a validated canonical artifact.`,
  };
}

function projectState(
  base: ReturnType<typeof baseStatus>,
  state: PdfExtractionState,
  health: PdfArtifactHealth,
  diagnosisCode: PdfSourceStatus["diagnosis_code"],
  diagnosisMessage: string | null,
  diagnosisScope: PdfSourceStatus["diagnosis_scope"] = diagnosisCode === "PDF_ARTIFACT_STALE"
    ? "settings"
    : diagnosisCode === null
      ? null
      : "artifact",
  metadata?: PdfExtractionMetadata,
): PdfSourceStatus {
  return {
    applicable: true,
    ...base,
    extraction_status: state.status,
    artifact_health: health,
    required: true,
    extraction_id: state.extraction_id,
    artifact_path: state.artifact_path,
    plugin: sanitizeNullable(state.plugin),
    plugin_version: sanitizeNullable(state.plugin_version),
    plugin_descriptor: sanitizeNullable(state.plugin_descriptor),
    model_descriptor: sanitizeNullable(state.model_descriptor),
    model_selection: metadata?.model_selection ?? null,
    requested_model: sanitizeNullable(metadata?.requested_model ?? null),
    observed_model: sanitizeNullable(metadata?.observed_model ?? null),
    reasoning_effort: sanitizeNullable(state.reasoning_effort),
    pdf_detail: state.pdf_detail,
    codex_agent: sanitizeNullable(metadata?.codex_agent ?? null),
    codex_version: sanitizeNullable(metadata?.codex_version ?? null),
    reusable: health === "valid" && state.plugin_descriptor !== null && state.model_descriptor !== null,
    last_error_code: safeLastErrorCode(state.last_error_code),
    last_error_message: state.last_error_message === null
      ? null
      : "PDF extraction failed; use the error code and retry guidance to inspect it locally.",
    diagnosis_code: diagnosisCode,
    diagnosis_scope: diagnosisScope,
    diagnosis_message: diagnosisMessage,
  };
}

function inconsistent(
  base: ReturnType<typeof baseStatus>,
  message: string,
  state?: PdfExtractionState,
  scope: Extract<PdfSourceStatus["diagnosis_scope"], "artifact" | "state"> = "state",
): PdfSourceStatus {
  if (state !== undefined) {
    return projectState(base, state, "inconsistent", "PDF_ARTIFACT_INCONSISTENT", sanitize(message), scope);
  }
  return {
    applicable: true,
    ...base,
    extraction_status: null,
    artifact_health: "inconsistent",
    required: true,
    extraction_id: null,
    artifact_path: null,
    plugin: null,
    plugin_version: null,
    plugin_descriptor: null,
    model_descriptor: null,
    model_selection: null,
    requested_model: null,
    observed_model: null,
    reasoning_effort: null,
    pdf_detail: null,
    codex_agent: null,
    codex_version: null,
    reusable: false,
    last_error_code: null,
    last_error_message: null,
    diagnosis_code: "PDF_ARTIFACT_INCONSISTENT",
    diagnosis_scope: scope,
    diagnosis_message: sanitize(message),
  };
}

async function readRawPdfSource(repoRoot: string, sourceId: string): Promise<RawPdfSource | null> {
  const queuePath = `raw/queue/${sourceId}.json`;
  const queueRead = await readTextFileInsideRoot(repoRoot, queuePath);
  if (!queueRead.ok) return null;
  let queue: Record<string, unknown>;
  try {
    const parsed = JSON.parse(queueRead.value) as unknown;
    if (!isRecord(parsed)) return null;
    queue = parsed;
  } catch {
    return null;
  }
  const sourceCardPath = safeSourceCardPath(queue.path);
  let frontmatter: Record<string, unknown> = {};
  if (sourceCardPath !== null) {
    const sourceRead = await readTextFileInsideRoot(repoRoot, sourceCardPath);
    if (sourceRead.ok) {
      frontmatter = scanMarkdownDocument({ path: sourceCardPath, content: sourceRead.value }).frontmatter ?? {};
    }
  }
  const originalPath = stringValue(queue.original_path) ?? stringValue(frontmatter.original_path);
  const sourceDir = sourceCardPath === null ? dirname(originalPath ?? "raw/inputs/unknown/_source.md") : dirname(sourceCardPath);
  return {
    sourceId,
    sourceDir,
    queueStatus: queueStatusValue(queue.status),
    sourceKind: stringValue(queue.source_kind) ?? stringValue(queue.kind),
    originalPath,
    queueHash: stringValue(queue.content_hash),
    sourceHash: stringValue(frontmatter.content_hash),
    queueState: queue.pdf_extraction,
    sourceState: frontmatter.pdf_extraction,
  };
}

async function originalIntegrityIssue(repoRoot: string, source: RawPdfSource): Promise<string | null> {
  if (source.originalPath === null || source.queueHash === null || source.sourceHash === null) {
    return "The PDF original path or canonical source hash is missing.";
  }
  let content: Buffer;
  try {
    const absolute = resolve(repoRoot, source.originalPath);
    const relativePath = relative(resolve(repoRoot), absolute);
    if (relativePath.startsWith("..") || relativePath.includes("\0")) {
      return "The PDF original path is outside the repository.";
    }
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return "The PDF original is unsafe or is not a regular file.";
    }
    content = await readFile(absolute);
  } catch {
    return "The PDF original is missing, unreadable, or unsafe.";
  }
  if (!isPdfSignature(content)) return "The selected original does not begin with a valid PDF signature.";
  if (computeContentHash(content) !== source.queueHash || source.queueHash !== source.sourceHash) {
    return "The PDF original bytes do not match the canonical source hash.";
  }
  return null;
}

function safeSourceCardPath(value: unknown): string | null {
  if (typeof value !== "string" || !/^raw\/inputs\/.+\/_source\.md$/u.test(value)) return null;
  if (value.includes("\\") || value.includes("\0") || value.split("/").includes("..")) return null;
  return value;
}

async function selectedRunFilesState(
  repoRoot: string,
  state: PdfExtractionState,
): Promise<"present" | "missing" | "unsafe"> {
  if (state.artifact_path === null) return "missing";
  const metadataPath = state.artifact_path.replace(/\/document\.md$/u, "/metadata.json");
  if (metadataPath === state.artifact_path) return "unsafe";
  for (const path of [state.artifact_path, metadataPath]) {
    const absolute = resolve(repoRoot, path);
    const relativePath = relative(resolve(repoRoot), absolute);
    if (relativePath.startsWith("..") || relativePath.includes("\0")) return "unsafe";
    try {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) return "unsafe";
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return "missing";
      return "unsafe";
    }
  }
  return "present";
}

function queueStatusValue(value: unknown): QueueStatus | null {
  return value === "queued" || value === "ingesting" || value === "ingested" || value === "blocked" ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function sanitize(value: string): string {
  return value
    .replace(/[ -]/gu, " ")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^,\s;]+/giu, "$1=[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

function sanitizeNullable(value: string | null): string | null {
  if (value === null) return null;
  const sanitized = sanitize(value);
  return sanitized === "" ? null : sanitized;
}

const SAFE_LAST_ERROR_CODES = new Set([
  "PDF_APPLY_FAILED",
  "PDF_ARTIFACT_INCONSISTENT",
  "PDF_CODEX_EXTRACTION_FAILED",
  "PDF_DOCUMENT_INVALID",
  "PDF_EXTRACTION_INTERRUPTED",
  "PDF_EXTRACTION_TIMEOUT",
  "PDF_ORIGINAL_CHANGED",
  "PDF_SOURCE_NOT_PDF",
  "PDF_STATE_WRITE_FAILED",
  "PDF_WORKSPACE_MUTATION_REJECTED",
]);

function safeLastErrorCode(value: string | null): string | null {
  if (value === null) return null;
  return SAFE_LAST_ERROR_CODES.has(value) ? value : "PDF_CODEX_EXTRACTION_FAILED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
