import { err, ok, type Result } from "../utils/result.js";
import { REQUIRED_PDF_PLUGIN, type PdfDetail } from "./config.js";

export type PdfExtractionStatus = "pending" | "running" | "extracted" | "failed";

export type PdfExtractionState = {
  required: true;
  status: PdfExtractionStatus;
  extraction_id: string | null;
  artifact_path: string | null;
  original_hash: string;
  plugin: typeof REQUIRED_PDF_PLUGIN;
  plugin_version: string | null;
  plugin_descriptor: string | null;
  model_descriptor: string | null;
  reasoning_effort: string | null;
  pdf_detail: PdfDetail | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  last_error_code: string | null;
  last_error_message: string | null;
};

export type PdfExtractionStateError = {
  message: string;
};

const STATE_KEYS = new Set<keyof PdfExtractionState>([
  "required",
  "status",
  "extraction_id",
  "artifact_path",
  "original_hash",
  "plugin",
  "plugin_version",
  "plugin_descriptor",
  "model_descriptor",
  "reasoning_effort",
  "pdf_detail",
  "started_at",
  "finished_at",
  "updated_at",
  "last_error_code",
  "last_error_message",
]);

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const EXTRACTION_ID_PATTERN = /^pdfext_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

export function createPendingPdfExtractionState(
  originalHash: string,
  updatedAt: string,
): PdfExtractionState {
  return {
    required: true,
    status: "pending",
    extraction_id: null,
    artifact_path: null,
    original_hash: originalHash,
    plugin: REQUIRED_PDF_PLUGIN,
    plugin_version: null,
    plugin_descriptor: null,
    model_descriptor: null,
    reasoning_effort: null,
    pdf_detail: null,
    started_at: null,
    finished_at: null,
    updated_at: updatedAt,
    last_error_code: null,
    last_error_message: null,
  };
}

export function normalizePdfExtractionState(
  value: unknown,
  options: { sourceDir?: string } = {},
): Result<PdfExtractionState, PdfExtractionStateError> {
  if (!isRecord(value)) {
    return invalid("pdf_extraction must be a mapping.");
  }

  const keys = Object.keys(value);
  if (keys.length !== STATE_KEYS.size || keys.some((key) => !STATE_KEYS.has(key as keyof PdfExtractionState))) {
    return invalid("pdf_extraction must contain exactly the canonical state fields.");
  }

  if (
    value.required !== true
    || !isPdfStatus(value.status)
    || !isNullableSafeExtractionId(value.extraction_id)
    || !isNullableSafePath(value.artifact_path)
    || typeof value.original_hash !== "string"
    || !HASH_PATTERN.test(value.original_hash)
    || value.plugin !== REQUIRED_PDF_PLUGIN
    || !isNullableNonEmptyString(value.plugin_version)
    || !isNullableNonEmptyString(value.plugin_descriptor)
    || !isNullableNonEmptyString(value.model_descriptor)
    || !isNullableNonEmptyString(value.reasoning_effort)
    || !isNullablePdfDetail(value.pdf_detail)
    || !isNullableIsoTimestamp(value.started_at)
    || !isNullableIsoTimestamp(value.finished_at)
    || !isIsoTimestamp(value.updated_at)
    || !isNullableSafeErrorString(value.last_error_code)
    || !isNullableSafeErrorString(value.last_error_message)
  ) {
    return invalid("pdf_extraction contains invalid field values.");
  }

  const state = value as PdfExtractionState;
  if (!pluginDescriptorMatches(state) || !modelDescriptorIsValid(state.model_descriptor)) {
    return invalid("pdf_extraction contains inconsistent plugin or model provenance.");
  }

  const statusError = validateStatusShape(state);
  if (statusError !== null) {
    return invalid(statusError);
  }

  if (options.sourceDir !== undefined && state.artifact_path !== null) {
    const expected = `${options.sourceDir}/extracted/pdf/${state.extraction_id}/document.md`;
    if (state.artifact_path !== expected) {
      return invalid("pdf_extraction artifact_path is outside the selected immutable run.");
    }
  }

  return ok({ ...state });
}

export function pdfExtractionStateEqual(left: PdfExtractionState, right: PdfExtractionState): boolean {
  return [...STATE_KEYS].every((key) => left[key] === right[key]);
}

export function isPdfSignature(content: Uint8Array): boolean {
  return content.length >= 5
    && content[0] === 0x25
    && content[1] === 0x50
    && content[2] === 0x44
    && content[3] === 0x46
    && content[4] === 0x2d;
}

export function isPdfOriginalPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

export function isSafeExtractionId(value: string): boolean {
  return EXTRACTION_ID_PATTERN.test(value);
}

function validateStatusShape(state: PdfExtractionState): string | null {
  if (state.status === "pending") {
    return allNull([
      state.extraction_id,
      state.artifact_path,
      state.plugin_version,
      state.plugin_descriptor,
      state.model_descriptor,
      state.reasoning_effort,
      state.pdf_detail,
      state.started_at,
      state.finished_at,
      state.last_error_code,
      state.last_error_message,
    ])
      ? null
      : "pending pdf_extraction state must not identify a run, artifact, settings, or error.";
  }

  if (state.status === "running") {
    return state.extraction_id !== null
      && state.artifact_path === null
      && state.reasoning_effort !== null
      && state.pdf_detail !== null
      && state.started_at !== null
      && state.finished_at === null
      && state.last_error_code === null
      && state.last_error_message === null
      ? null
      : "running pdf_extraction state has an invalid run, artifact, timestamp, setting, or error shape.";
  }

  if (state.status === "extracted") {
    return state.extraction_id !== null
      && state.artifact_path !== null
      && state.reasoning_effort !== null
      && state.pdf_detail !== null
      && state.started_at !== null
      && state.finished_at !== null
      && state.last_error_code === null
      && state.last_error_message === null
      ? null
      : "extracted pdf_extraction state must identify a completed validated artifact without an error.";
  }

  return state.extraction_id !== null
    && state.artifact_path === null
    && state.reasoning_effort !== null
    && state.pdf_detail !== null
    && state.started_at !== null
    && state.finished_at !== null
    && state.last_error_code !== null
    && state.last_error_message !== null
    ? null
    : "failed pdf_extraction state must identify the failed attempt, clear the artifact, and record an error.";
}

function pluginDescriptorMatches(state: PdfExtractionState): boolean {
  return state.plugin_version === null
    ? state.plugin_descriptor === null
    : state.plugin_descriptor === `${state.plugin}#version:${state.plugin_version}`;
}

function modelDescriptorIsValid(value: string | null): boolean {
  return value === null || (value.startsWith("explicit:") && value.slice("explicit:".length).trim() !== "");
}

function isPdfStatus(value: unknown): value is PdfExtractionStatus {
  return value === "pending" || value === "running" || value === "extracted" || value === "failed";
}

function isNullableSafeExtractionId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && isSafeExtractionId(value));
}

function isNullableSafePath(value: unknown): value is string | null {
  if (value === null) {
    return true;
  }
  return typeof value === "string"
    && value.trim() !== ""
    && !value.includes("\0")
    && !value.includes("\\")
    && !value.startsWith("/")
    && !value.split("/").includes("..");
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim() !== "");
}

function isNullablePdfDetail(value: unknown): value is PdfDetail | null {
  return value === null || value === "auto" || value === "low" || value === "high";
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isNullableIsoTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value);
}

function isNullableSafeErrorString(value: unknown): value is string | null {
  return value === null
    || (typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001F\u007F]/u.test(value));
}

function allNull(values: unknown[]): boolean {
  return values.every((value) => value === null);
}

function invalid(message: string): Result<never, PdfExtractionStateError> {
  return err({ message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
