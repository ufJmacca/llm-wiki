import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import Busboy, { type FieldInfo, type FileInfo } from "busboy";

import {
  runAutoIngestSource,
  type AutoIngestOutcome,
  type AutoIngestSafeError,
  type AutoIngestSourceResult,
  type RunAutoIngestSourceInput,
} from "../autoIngest/index.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { INGEST_LOCK_RELATIVE_PATH, withIngestLock } from "../runtime/ingestLock.js";
import { showQueueSource, type AutoIngestMetadata, type QueueStatus } from "../runtime/queue.js";
import {
  capturePreparedUrlSource,
  captureTextSource,
  captureUploadedFileSource,
  prepareUrlSource,
  type PreparedUrlSource,
  type SourceCaptureError,
  type SourceCaptureSuccess,
  type SourceCaptureUploadProvenance,
} from "../sourceCapture/index.js";
import { gitCommandEnv } from "../utils/git.js";
import { err, ok, type Result } from "../utils/result.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_DAEMON_HOST = "127.0.0.1" as const;
export const DEFAULT_DAEMON_PORT = 32123 as const;
export const RAW_UPLOAD_PATH = "/api/raw-upload" as const;
export const UPLOAD_TOKEN_HEADER = "x-llm-wiki-upload-token" as const;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_FIELD_BYTES = 1024 * 1024;
const MAX_UPLOAD_FIELDS = 20;
const ALLOWED_FILE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf"]);
const ALLOWED_FILE_MIME_TYPES = new Set(["text/markdown", "text/plain", "application/pdf"]);
const MARKDOWN_FILE_EXTENSIONS = new Set([".md", ".markdown"]);
const DEFAULT_BROWSER_FILE_MIME_TYPES = new Set(["", "application/octet-stream"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const CORS_ALLOWED_METHODS = "POST, OPTIONS";
const CORS_ALLOWED_HEADERS = `${UPLOAD_TOKEN_HEADER}, content-type`;
const repoUploadQueues = new Map<string, Promise<void>>();
const RUNTIME_LOG_COMMIT_PATH = "curated/log.md";

export type UploadDaemon = {
  host: string;
  port: number;
  url: string;
  uploadPath: typeof RAW_UPLOAD_PATH;
  uploadToken: string;
  uploadSessionId: string;
  commitUploads: boolean;
  close: () => Promise<void>;
};

export type UploadDaemonReady = {
  host: string;
  port: number;
  url: string;
  upload_path: typeof RAW_UPLOAD_PATH;
  upload_token: string;
  upload_session_id: string;
  commit_uploads: boolean;
};

export type UploadCommitRequest = {
  repoRoot: string;
  source_id: string;
  paths: string[];
};

export type UploadCommitResult = {
  attempted: boolean;
  ok: boolean;
  committed_paths?: string[];
  error?: string;
};

export type UploadCommitter = (request: UploadCommitRequest) => Promise<UploadCommitResult>;

export type UploadAutoIngestRequest = {
  repoRoot: string;
  source_id: string;
  capture: SourceCaptureSuccess;
  commit: UploadCommitResult;
};

export type UploadAutoIngestHandler = (request: UploadAutoIngestRequest) => Promise<AutoIngestSourceResult>;

export type UploadAutoIngestConfig = {
  enabled: true;
  run?: UploadAutoIngestHandler;
  lock?: RunAutoIngestSourceInput["lock"];
  now?: RunAutoIngestSourceInput["now"];
  command?: string;
};

export type UploadDaemonOptions = {
  repoRoot: string;
  host?: string;
  port?: number;
  commitUploads?: boolean;
  commitUpload?: UploadCommitter;
  autoIngest?: UploadAutoIngestConfig;
};

export type UploadDaemonErrorCode =
  | "DAEMON_HOST_NOT_LOCAL"
  | "DAEMON_LISTEN_FAILED"
  | "DAEMON_PORT_INVALID"
  | "UPLOAD_AUTH_FAILED"
  | "UPLOAD_COMMIT_FAILED"
  | "UPLOAD_CONTENT_TYPE_UNSUPPORTED"
  | "UPLOAD_METHOD_NOT_ALLOWED"
  | "UPLOAD_MULTIPART_INVALID"
  | "UPLOAD_NOT_FOUND"
  | "UPLOAD_ORIGIN_NOT_ALLOWED"
  | "UPLOAD_PAYLOAD_INVALID"
  | "UPLOAD_TOO_LARGE"
  | "UPLOAD_TYPE_UNSUPPORTED"
  | SourceCaptureError["code"];

export class UploadDaemonError extends Error {
  readonly code: UploadDaemonErrorCode;
  readonly hint: string;
  readonly path: string;
  readonly statusCode: number;

  constructor(options: { code: UploadDaemonErrorCode; message: string; hint: string; path: string; statusCode: number }) {
    super(options.message);
    this.name = "UploadDaemonError";
    this.code = options.code;
    this.hint = options.hint;
    this.path = options.path;
    this.statusCode = options.statusCode;
  }
}

type UploadDaemonConfigError = {
  code: UploadDaemonErrorCode;
  message: string;
  hint: string;
  path: string;
};

type UploadSuccessEnvelope = {
  ok: true;
  data: UploadApiData;
};

type UploadFailureEnvelope = {
  ok: false;
  error: {
    code: UploadDaemonErrorCode;
    message: string;
    hint: string;
  };
  issues: Array<{
    severity: "error";
    code: UploadDaemonErrorCode;
    message: string;
    path: string;
    hint: string;
  }>;
};

type UploadApiData = {
  status: SourceCaptureSuccess["status"];
  source_id: string;
  title: string;
  source_kind: SourceCaptureSuccess["source"]["source_kind"];
  visibility: SourceCaptureSuccess["source"]["visibility"];
  queue_status: SourceCaptureSuccess["source"]["queue_status"];
  queue_path: string;
  source_card_path: string;
  original_path: string;
  created_paths: string[];
  message: string;
  commit: UploadCommitResult;
  auto_ingest?: AutoIngestSourceResult;
};

type MultipartUpload = {
  fields: Map<string, string[]>;
  file: UploadedFile | null;
};

type PreparedUploadPayload =
  | {
      kind: "file";
      title?: string;
      fileName: string;
      content: Buffer;
    }
  | {
      kind: "text";
      title: string;
      text: string;
    }
  | {
      kind: "url";
      source: PreparedUrlSource;
    };

type UploadedFile = {
  fileName: string;
  mimeType: string;
  content: Buffer;
  tooLarge: boolean;
};

type PendingUploadCommits = Map<string, string[]>;

type UploadRequestOptions = {
  repoRoot: string;
  commitUploads: boolean;
  commitUpload: UploadCommitter;
  uploadToken: string;
  uploadSessionId: string;
  pendingUploadCommits: PendingUploadCommits;
  autoIngest: UploadAutoIngestConfig | null;
};

type CorsApproval =
  | {
      approved: true;
      origin: string | null;
    }
  | {
      approved: false;
      origin: string;
    };

type UploadWorkSuccess = {
  capture: SourceCaptureSuccess;
  commit: UploadCommitResult;
  autoIngest?: AutoIngestSourceResult;
};

type UploadCaptureCommitSuccess = Omit<UploadWorkSuccess, "autoIngest">;

export async function startUploadDaemon(options: UploadDaemonOptions): Promise<UploadDaemon> {
  const hostResult = normalizeDaemonHost(options.host ?? DEFAULT_DAEMON_HOST);
  if (!hostResult.ok) {
    throw toUploadDaemonError(hostResult.error);
  }
  const port = options.port ?? DEFAULT_DAEMON_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UploadDaemonError({
      code: "DAEMON_PORT_INVALID",
      message: `Invalid daemon port: ${String(port)}.`,
      path: "--port",
      hint: "Use an integer port from 0 through 65535.",
      statusCode: 400,
    });
  }

  const host = hostResult.value;
  const commitUploads = options.commitUploads === true;
  const commitUpload = options.commitUpload ?? commitUploadWithGit;
  const autoIngest = options.autoIngest?.enabled === true ? options.autoIngest : null;
  const pendingUploadCommits: PendingUploadCommits = new Map();
  const uploadToken = randomBytes(32).toString("hex");
  const uploadSessionId = `upl_${randomBytes(8).toString("hex")}`;
  const server = createServer((request, response) => {
    void handleDaemonRequest(
      {
        repoRoot: options.repoRoot,
        commitUploads,
        commitUpload,
        uploadToken,
        uploadSessionId,
        pendingUploadCommits,
        autoIngest,
      },
      request,
      response,
    );
  });

  await listen(server, port, host);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    await closeServer(server);
    throw new UploadDaemonError({
      code: "DAEMON_LISTEN_FAILED",
      message: "Upload daemon did not bind to a TCP address.",
      path: "--port",
      hint: "Use a different local port and try again.",
      statusCode: 500,
    });
  }

  let closed = false;
  const actualPort = address.port;
  return {
    host,
    port: actualPort,
    url: daemonUrl(address.address, actualPort),
    uploadPath: RAW_UPLOAD_PATH,
    uploadToken,
    uploadSessionId,
    commitUploads,
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      await closeServer(server);
    },
  };
}

export function uploadDaemonReady(
  daemon: Pick<UploadDaemon, "host" | "port" | "url" | "uploadToken" | "uploadSessionId" | "commitUploads">,
): UploadDaemonReady {
  return {
    host: daemon.host,
    port: daemon.port,
    url: daemon.url,
    upload_path: RAW_UPLOAD_PATH,
    upload_token: daemon.uploadToken,
    upload_session_id: daemon.uploadSessionId,
    commit_uploads: daemon.commitUploads,
  };
}

export function normalizeDaemonHost(host: string): Result<string, UploadDaemonConfigError> {
  const normalized = host.trim().toLowerCase() === "[::1]" ? "::1" : host.trim().toLowerCase();
  if (LOCAL_HOSTS.has(normalized)) {
    return ok(normalized);
  }

  return err({
    code: "DAEMON_HOST_NOT_LOCAL",
    message: `Local upload daemon host is not allowed in MVP: ${host}.`,
    path: "--host",
    hint: "Use 127.0.0.1, localhost, or ::1 for the MVP local upload daemon.",
  });
}

async function handleDaemonRequest(
  options: UploadRequestOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const cors = approveCorsOrigin(request);
    if (!cors.approved) {
      writeJson(response, 403, failureEnvelope(new UploadDaemonError({
        code: "UPLOAD_ORIGIN_NOT_ALLOWED",
        message: "Upload daemon only accepts loopback browser origins.",
        path: "origin",
        hint: "Serve the local Explorer from 127.0.0.1, localhost, or [::1].",
        statusCode: 403,
      })));
      return;
    }

    applyCorsHeaders(response, cors.origin);

    if (request.url?.split("?")[0] !== RAW_UPLOAD_PATH) {
      writeJson(response, 404, failureEnvelope(new UploadDaemonError({
        code: "UPLOAD_NOT_FOUND",
        message: "Upload daemon only serves POST /api/raw-upload.",
        path: request.url ?? "/",
        hint: "Send multipart uploads to /api/raw-upload.",
        statusCode: 404,
      })));
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 405, failureEnvelope(new UploadDaemonError({
        code: "UPLOAD_METHOD_NOT_ALLOWED",
        message: "Raw uploads must use POST.",
        path: RAW_UPLOAD_PATH,
        hint: "Send a multipart/form-data POST request to /api/raw-upload.",
        statusCode: 405,
      })));
      return;
    }

    const csrf = validateUploadToken(request, options.uploadToken);
    if (!csrf.ok) {
      writeJson(response, csrf.error.statusCode, failureEnvelope(csrf.error));
      return;
    }

    const payload = await prepareUploadPayload(request);
    if (!payload.ok) {
      writeJson(response, payload.error.statusCode, failureEnvelope(payload.error));
      return;
    }

    const upload = await runInRepoUploadQueue(
      options.repoRoot,
      () => captureAndCommitUpload(options, payload.value),
    );
    if (!upload.ok) {
      writeJson(response, upload.error.statusCode, failureEnvelope(upload.error));
      return;
    }

    const statusCode = upload.value.capture.status === "added" ? 201 : 200;
    writeJson(response, statusCode, {
      ok: true,
      data: toUploadApiData(upload.value.capture, upload.value.commit, upload.value.autoIngest),
    });
  } catch (error) {
    const daemonError = error instanceof UploadDaemonError
      ? error
      : new UploadDaemonError({
          code: "UPLOAD_MULTIPART_INVALID",
          message: error instanceof Error ? error.message : String(error),
          path: RAW_UPLOAD_PATH,
          hint: "Retry with a valid multipart/form-data upload payload.",
          statusCode: 400,
        });
    writeJson(response, daemonError.statusCode, failureEnvelope(daemonError));
  }
}

function approveCorsOrigin(request: IncomingMessage): CorsApproval {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin.trim() === "") {
    return {
      approved: true,
      origin: null,
    };
  }

  return isAllowedLoopbackOrigin(origin)
    ? {
        approved: true,
        origin,
      }
    : {
        approved: false,
        origin,
      };
}

function isAllowedLoopbackOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return parsed.protocol === "http:" && LOCAL_HOSTS.has(hostname) && parsed.port !== "";
}

function applyCorsHeaders(response: ServerResponse, origin: string | null): void {
  if (origin === null) {
    return;
  }

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
  response.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  response.setHeader("Access-Control-Max-Age", "600");
  response.setHeader("Vary", "Origin");
}

async function runInRepoUploadQueue<T>(repoRoot: string, work: () => Promise<T>): Promise<T> {
  const queueKey = resolve(repoRoot);
  const previous = repoUploadQueues.get(queueKey) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const next = previous.catch(() => undefined).then(() => current);
  repoUploadQueues.set(queueKey, next);

  await previous.catch(() => undefined);

  try {
    return await work();
  } finally {
    release();
    if (repoUploadQueues.get(queueKey) === next) {
      repoUploadQueues.delete(queueKey);
    }
  }
}

async function captureAndCommitUpload(
  options: UploadRequestOptions,
  payload: PreparedUploadPayload,
): Promise<Result<UploadWorkSuccess, UploadDaemonError>> {
  const captureCommit = options.commitUploads
    ? await captureAndCommitUploadWithIngestLock(options, payload)
    : await captureAndCommitPreparedUpload(options, payload);
  if (!captureCommit.ok) {
    return captureCommit;
  }

  return ok({
    ...captureCommit.value,
    autoIngest: await runUploadAutoIngest(options, captureCommit.value.capture, captureCommit.value.commit),
  });
}

async function captureAndCommitUploadWithIngestLock(
  options: UploadRequestOptions,
  payload: PreparedUploadPayload,
): Promise<Result<UploadCaptureCommitSuccess, UploadDaemonError>> {
  try {
    return await withIngestLock(
      options.repoRoot,
      { label: "upload-raw-commit" },
      () => captureAndCommitPreparedUpload(options, payload),
    );
  } catch (error) {
    if (error instanceof RuntimeCommandError && error.code === "INGEST_LOCK_BUSY") {
      return err(new UploadDaemonError({
        code: "UPLOAD_COMMIT_FAILED",
        message: "Upload commit is waiting for another ingest worker.",
        path: INGEST_LOCK_RELATIVE_PATH,
        hint: "Wait for the active ingest worker to finish, then retry the upload or rerun without --commit-uploads.",
        statusCode: 409,
      }));
    }

    throw error;
  }
}

async function captureAndCommitPreparedUpload(
  options: UploadRequestOptions,
  payload: PreparedUploadPayload,
): Promise<Result<UploadCaptureCommitSuccess, UploadDaemonError>> {
  const includeRuntimeLogInCommit = await shouldStageRuntimeLogForRawCommit(options);
  const capture = await capturePreparedUpload(options, payload);
  if (!capture.ok) {
    return err(capture.error);
  }

  const commit = await commitCapturedUpload(options, capture.value, includeRuntimeLogInCommit);
  if (!commit.ok) {
    return err(new UploadDaemonError({
      code: "UPLOAD_COMMIT_FAILED",
      message: commit.error ?? "Upload commit failed.",
      path: ".git",
      hint: "Fix Git state or rerun without --commit-uploads.",
      statusCode: 500,
    }));
  }

  return ok({
    capture: capture.value,
    commit,
  });
}

async function runUploadAutoIngest(
  options: Pick<UploadRequestOptions, "repoRoot" | "autoIngest">,
  capture: SourceCaptureSuccess,
  commit: UploadCommitResult,
): Promise<AutoIngestSourceResult | undefined> {
  if (options.autoIngest === null) {
    return undefined;
  }

  if (capture.source.queue_status !== "queued") {
    return uploadAutoIngestNotEligibleResult(capture.source);
  }

  const run = options.autoIngest.run ?? defaultUploadAutoIngestRunner(options.autoIngest);
  try {
    return await run({
      repoRoot: options.repoRoot,
      source_id: capture.source.source_id,
      capture,
      commit,
    });
  } catch (error) {
    return uploadAutoIngestThrownResult(options.repoRoot, capture.source, error);
  }
}

function defaultUploadAutoIngestRunner(config: UploadAutoIngestConfig): UploadAutoIngestHandler {
  return async (request) => runAutoIngestSource({
    repoRoot: request.repoRoot,
    sourceId: request.source_id,
    lock: config.lock,
    now: config.now,
    command: config.command ?? "llm-wiki explore serve --with-daemon --auto-ingest-uploads upload",
  });
}

function uploadAutoIngestNotEligibleResult(source: SourceCaptureSuccess["source"]): AutoIngestSourceResult {
  const outcome: AutoIngestOutcome = source.queue_status === "ingesting" ? "deferred" : "skipped";

  return {
    source_id: source.source_id,
    previous_status: source.queue_status,
    final_status: source.queue_status,
    outcome,
    attempted: false,
    agent: null,
    applied_paths: [],
    auto_ingest: null,
    error: {
      code: "AUTO_INGEST_SOURCE_NOT_ELIGIBLE",
      message: `Upload-triggered auto-ingest only processes queued sources; current status is ${source.queue_status}.`,
      path: source.queue_path,
      hint: duplicateAutoIngestHint(source.queue_status),
    },
  };
}

function duplicateAutoIngestHint(status: QueueStatus): string {
  if (status === "ingested") {
    return "This source is already ingested; upload-triggered auto-ingest was skipped.";
  }

  if (status === "blocked") {
    return "This source is blocked; use manual retry guidance to review it, mark it queued, and rerun auto-ingest.";
  }

  if (status === "ingesting") {
    return "Another worker is already processing this source; upload-triggered auto-ingest was deferred.";
  }

  return "Only queued sources are eligible for upload-triggered auto-ingest.";
}

async function uploadAutoIngestThrownResult(
  repoRoot: string,
  source: SourceCaptureSuccess["source"],
  error: unknown,
): Promise<AutoIngestSourceResult> {
  const safeError = uploadAutoIngestSafeError(error, source.source_id);
  const current = await readUploadAutoIngestCurrentState(repoRoot, source);

  return {
    source_id: source.source_id,
    previous_status: source.queue_status,
    final_status: current.status,
    outcome: "skipped",
    attempted: false,
    agent: null,
    applied_paths: [],
    auto_ingest: current.autoIngest,
    error: safeError,
  };
}

async function readUploadAutoIngestCurrentState(
  repoRoot: string,
  source: SourceCaptureSuccess["source"],
): Promise<{ status: QueueStatus; autoIngest: AutoIngestMetadata | null }> {
  const shown = await showQueueSource(repoRoot, source.source_id);
  if (!shown.ok) {
    return {
      status: source.queue_status,
      autoIngest: null,
    };
  }

  return {
    status: shown.value.queue_record.status,
    autoIngest: shown.value.queue_record.auto_ingest ?? null,
  };
}

function uploadAutoIngestSafeError(error: unknown, sourceId: string): AutoIngestSafeError {
  if (error instanceof RuntimeCommandError) {
    return {
      code: error.code,
      message: safeAutoIngestMessage(error.message),
      path: error.path,
      hint: safeAutoIngestMessage(error.hint),
    };
  }

  return {
    code: "AUTO_INGEST_FAILED",
    message: error instanceof Error ? safeAutoIngestMessage(error.message) : safeAutoIngestMessage(String(error)),
    path: sourceId,
    hint: "Fix the local agent or repository state, then retry auto-ingest manually.",
  };
}

function safeAutoIngestMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

async function prepareUploadPayload(
  request: IncomingMessage,
): Promise<Result<PreparedUploadPayload, UploadDaemonError>> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().includes("multipart/form-data")) {
    return err(new UploadDaemonError({
      code: "UPLOAD_CONTENT_TYPE_UNSUPPORTED",
      message: "Raw upload payload must use multipart/form-data.",
      path: "content-type",
      hint: "Send file, text, or url fields as multipart/form-data.",
      statusCode: 415,
    }));
  }

  const upload = await parseMultipartUpload(request);
  if (!upload.ok) {
    return upload;
  }

  const title = firstField(upload.value.fields, "title");
  const text = firstField(upload.value.fields, "text");
  const url = firstField(upload.value.fields, "url");
  const payloadCount = [upload.value.file !== null, text !== undefined, url !== undefined].filter(Boolean).length;
  if (payloadCount !== 1) {
    return err(new UploadDaemonError({
      code: "UPLOAD_PAYLOAD_INVALID",
      message: "Raw upload payload must include exactly one file, text note, or URL.",
      path: RAW_UPLOAD_PATH,
      hint: "Include one multipart field: file, text, or url.",
      statusCode: 400,
    }));
  }

  if (upload.value.file !== null) {
    if (upload.value.file.tooLarge) {
      return err(new UploadDaemonError({
        code: "UPLOAD_TOO_LARGE",
        message: `Uploaded file exceeds the ${MAX_UPLOAD_BYTES} byte limit.`,
        path: "file",
        hint: "Upload a smaller file or capture it locally with llm-wiki add.",
        statusCode: 413,
      }));
    }

    const fileType = validateUploadedFileType(upload.value.file);
    if (!fileType.ok) {
      return fileType;
    }

    return ok({
      kind: "file",
      title,
      fileName: upload.value.file.fileName,
      content: upload.value.file.content,
    });
  }

  if (text !== undefined) {
    if (title === undefined || title.trim() === "") {
      return err(new UploadDaemonError({
        code: "UPLOAD_PAYLOAD_INVALID",
        message: "Text uploads require a title.",
        path: "title",
        hint: "Include a non-empty title field with pasted text uploads.",
        statusCode: 400,
      }));
    }
    if (text.length === 0) {
      return err(new UploadDaemonError({
        code: "UPLOAD_PAYLOAD_INVALID",
        message: "Text uploads require a non-empty text field.",
        path: "text",
        hint: "Include pasted text content before uploading.",
        statusCode: 400,
      }));
    }

    return ok({
      kind: "text",
      title: title ?? "",
      text,
    });
  }

  if (url !== undefined) {
    const preparedUrl = await prepareUrlSource({
      title,
      url,
    });
    if (!preparedUrl.ok) {
      return err(toUploadCaptureError(preparedUrl.error));
    }

    return ok({
      kind: "url",
      source: preparedUrl.value,
    });
  }

  return err(new UploadDaemonError({
    code: "UPLOAD_PAYLOAD_INVALID",
    message: "Raw upload payload must include exactly one file, text note, or URL.",
    path: RAW_UPLOAD_PATH,
    hint: "Include one multipart field: file, text, or url.",
    statusCode: 400,
  }));
}

async function capturePreparedUpload(
  options: Pick<UploadRequestOptions, "repoRoot" | "uploadSessionId">,
  payload: PreparedUploadPayload,
): Promise<Result<SourceCaptureSuccess, UploadDaemonError>> {
  if (payload.kind === "file") {
    return mapCaptureResult(await captureUploadedFileSource({
      repoRoot: options.repoRoot,
      title: payload.title,
      fileName: payload.fileName,
      content: payload.content,
      command: "llm-wiki explore serve --with-daemon upload file",
      uploadProvenance: localUploadProvenance(options.uploadSessionId, safeUploadOrigin(payload.fileName)),
    }));
  }

  if (payload.kind === "text") {
    return mapCaptureResult(await captureTextSource({
      repoRoot: options.repoRoot,
      title: payload.title,
      text: payload.text,
      command: "llm-wiki explore serve --with-daemon upload text",
      uploadProvenance: localUploadProvenance(options.uploadSessionId, "text"),
    }));
  }

  return mapCaptureResult(await capturePreparedUrlSource({
    repoRoot: options.repoRoot,
    source: payload.source,
    command: "llm-wiki explore serve --with-daemon upload url",
    uploadProvenance: localUploadProvenance(options.uploadSessionId, "url"),
  }));
}

function localUploadProvenance(uploadSessionId: string, originKind: string): SourceCaptureUploadProvenance {
  return {
    origin: `local-upload:${originKind}`,
    uploader: "local",
    upload_session_id: uploadSessionId,
    uploaded_via: "local-explorer",
  };
}

function safeUploadOrigin(fileName: string): string {
  return basename(fileName.trim() || "upload.bin");
}

async function parseMultipartUpload(request: IncomingMessage): Promise<Result<MultipartUpload, UploadDaemonError>> {
  return new Promise((resolveParse) => {
    const fields = new Map<string, string[]>();
    let file: UploadedFile | null = null;
    let settled = false;
    const busboy = Busboy({
      headers: request.headers,
      limits: {
        fileSize: MAX_UPLOAD_BYTES + 1,
        fieldSize: MAX_UPLOAD_FIELD_BYTES + 1,
        files: 1,
        fields: MAX_UPLOAD_FIELDS,
      },
    });

    const multipartError = (message: string): UploadDaemonError => new UploadDaemonError({
      code: "UPLOAD_MULTIPART_INVALID",
      message,
      path: RAW_UPLOAD_PATH,
      hint: "Retry with a valid multipart/form-data upload payload.",
      statusCode: 400,
    });

    const cleanupRequestListeners = (): void => {
      request.off("aborted", onRequestAborted);
      request.off("close", onRequestClose);
      request.off("error", onRequestError);
    };

    const settle = (result: Result<MultipartUpload, UploadDaemonError>): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupRequestListeners();
      resolveParse(result);
    };

    const settleInterrupted = (message: string): void => {
      if (settled) {
        return;
      }

      request.unpipe(busboy);
      busboy.destroy();
      settle(err(multipartError(message)));
    };

    function onRequestAborted(): void {
      settleInterrupted("Raw upload request was aborted before the multipart payload finished.");
    }

    function onRequestClose(): void {
      if (!request.complete) {
        settleInterrupted("Raw upload connection closed before the multipart payload finished.");
      }
    }

    function onRequestError(error: Error): void {
      settleInterrupted(error.message);
    }

    request.on("aborted", onRequestAborted);
    request.on("close", onRequestClose);
    request.on("error", onRequestError);

    busboy.on("field", (name: string, value: string, info: FieldInfo) => {
      if (info.nameTruncated || info.valueTruncated) {
        settle(err(truncatedFieldError(name, info)));
        return;
      }
      if (Buffer.byteLength(value, "utf8") > MAX_UPLOAD_FIELD_BYTES) {
        settle(err(oversizedFieldError(name)));
        return;
      }

      const existing = fields.get(name) ?? [];
      existing.push(value);
      fields.set(name, existing);
    });
    busboy.on("file", (name: string, stream: NodeJS.ReadableStream, info: FileInfo) => {
      if (name !== "file") {
        stream.resume();
        settle(err(new UploadDaemonError({
          code: "UPLOAD_PAYLOAD_INVALID",
          message: `Raw upload file parts must use the "file" field; received "${name}".`,
          path: name,
          hint: "Use exactly one multipart source field: file, text, or url.",
          statusCode: 400,
        })));
        return;
      }

      const chunks: Buffer[] = [];
      let tooLarge = false;
      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      stream.on("limit", () => {
        tooLarge = true;
      });
      stream.on("end", () => {
        const content = Buffer.concat(chunks);
        file = {
          fileName: info.filename || "upload.bin",
          mimeType: normalizeMimeType(info.mimeType),
          content,
          tooLarge: tooLarge || content.byteLength > MAX_UPLOAD_BYTES,
        };
      });
    });
    busboy.on("error", (error: Error) => {
      settle(err(multipartError(error.message)));
    });
    busboy.on("filesLimit", () => {
      settle(err(new UploadDaemonError({
        code: "UPLOAD_PAYLOAD_INVALID",
        message: "Raw upload payload may include only one file.",
        path: "file",
        hint: "Upload one source file per request.",
        statusCode: 400,
      })));
    });
    busboy.on("fieldsLimit", () => {
      settle(err(new UploadDaemonError({
        code: "UPLOAD_PAYLOAD_INVALID",
        message: `Raw upload payload may include at most ${MAX_UPLOAD_FIELDS} non-file fields.`,
        path: "field",
        hint: "Use exactly one multipart source field: file, text, or url.",
        statusCode: 400,
      })));
    });
    busboy.on("finish", () => {
      settle(ok({ fields, file }));
    });
    request.pipe(busboy);
  });
}

function validateUploadToken(request: IncomingMessage, expectedToken: string): Result<void, UploadDaemonError> {
  const actualToken = request.headers[UPLOAD_TOKEN_HEADER];
  if (typeof actualToken !== "string" || !constantTimeEquals(actualToken, expectedToken)) {
    return err(new UploadDaemonError({
      code: "UPLOAD_AUTH_FAILED",
      message: "Upload authentication failed.",
      path: UPLOAD_TOKEN_HEADER,
      hint: "Refresh the local Explorer session and retry the upload.",
      statusCode: 403,
    }));
  }

  return ok(undefined);
}

function validateUploadedFileType(file: UploadedFile): Result<void, UploadDaemonError> {
  const extension = uploadedFileExtension(file.fileName);
  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
    return err(new UploadDaemonError({
      code: "UPLOAD_TYPE_UNSUPPORTED",
      message: "File uploads must use .md, .markdown, .txt, or .pdf extensions.",
      path: "file",
      hint: "Upload Markdown, plain text, or PDF files.",
      statusCode: 415,
    }));
  }

  if (!isAllowedUploadedFileMimeType(extension, file.mimeType)) {
    return err(new UploadDaemonError({
      code: "UPLOAD_TYPE_UNSUPPORTED",
      message: "File uploads must use text/markdown, text/plain, or application/pdf MIME types.",
      path: "file",
      hint: "Upload Markdown, plain text, or PDF files with a supported content type.",
      statusCode: 415,
    }));
  }

  return ok(undefined);
}

function isAllowedUploadedFileMimeType(extension: string, mimeType: string): boolean {
  return ALLOWED_FILE_MIME_TYPES.has(mimeType) ||
    (MARKDOWN_FILE_EXTENSIONS.has(extension) && DEFAULT_BROWSER_FILE_MIME_TYPES.has(mimeType));
}

function uploadedFileExtension(fileName: string): string {
  const safeFileName = basename(fileName.trim() || "upload.bin").toLowerCase();
  const dotIndex = safeFileName.lastIndexOf(".");
  return dotIndex >= 0 ? safeFileName.slice(dotIndex) : "";
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.byteLength !== expectedBuffer.byteLength) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function truncatedFieldError(name: string, info: FieldInfo): UploadDaemonError {
  const path = info.nameTruncated ? "field" : name;
  return new UploadDaemonError({
    code: "UPLOAD_TOO_LARGE",
    message: info.nameTruncated
      ? "Multipart field name exceeds the upload limit."
      : `Multipart field "${name}" exceeds the ${MAX_UPLOAD_FIELD_BYTES} byte limit.`,
    path,
    hint: "Upload a smaller text, URL, or title value, or capture it locally with llm-wiki add-text.",
    statusCode: 413,
  });
}

function oversizedFieldError(name: string): UploadDaemonError {
  return new UploadDaemonError({
    code: "UPLOAD_TOO_LARGE",
    message: `Multipart field "${name}" exceeds the ${MAX_UPLOAD_FIELD_BYTES} byte limit.`,
    path: name,
    hint: "Upload a smaller text, URL, or title value, or capture it locally with llm-wiki add-text.",
    statusCode: 413,
  });
}

function mapCaptureResult(
  result: Result<SourceCaptureSuccess, SourceCaptureError>,
): Result<SourceCaptureSuccess, UploadDaemonError> {
  if (result.ok) {
    return result;
  }

  return err(toUploadCaptureError(result.error));
}

function toUploadCaptureError(error: SourceCaptureError): UploadDaemonError {
  return new UploadDaemonError({
    code: error.code,
    message: error.message,
    path: error.path,
    hint: error.hint,
    statusCode: 400,
  });
}

async function commitCapturedUpload(
  options: Pick<UploadRequestOptions, "repoRoot" | "commitUploads" | "commitUpload" | "pendingUploadCommits">,
  capture: SourceCaptureSuccess,
  includeRuntimeLog: boolean,
): Promise<UploadCommitResult> {
  if (!options.commitUploads) {
    return {
      attempted: false,
      ok: true,
    };
  }

  const paths = capture.status === "added"
    ? uploadCommitPaths(capture, includeRuntimeLog)
    : options.pendingUploadCommits.get(capture.source.source_id);
  if (paths === undefined || paths.length === 0) {
    return {
      attempted: false,
      ok: true,
    };
  }

  const commit = await options.commitUpload({
    repoRoot: options.repoRoot,
    source_id: capture.source.source_id,
    paths,
  });
  if (commit.ok) {
    options.pendingUploadCommits.delete(capture.source.source_id);
  } else {
    options.pendingUploadCommits.set(capture.source.source_id, paths);
  }

  return commit;
}

function uploadCommitPaths(capture: SourceCaptureSuccess, includeRuntimeLog: boolean): string[] {
  return [
    ...new Set([
      ...capture.created_paths,
      ...(includeRuntimeLog ? [RUNTIME_LOG_COMMIT_PATH] : []),
    ]),
  ];
}

async function shouldStageRuntimeLogForRawCommit(
  options: Pick<UploadRequestOptions, "repoRoot" | "commitUploads">,
): Promise<boolean> {
  if (!options.commitUploads) {
    return false;
  }

  if (!(await gitCommandSucceeds(options.repoRoot, ["rev-parse", "--is-inside-work-tree"]))) {
    return true;
  }

  const unstagedClean = await gitQuietDiffClean(
    options.repoRoot,
    ["diff", "--quiet", "--", RUNTIME_LOG_COMMIT_PATH],
  );
  const stagedClean = await gitQuietDiffClean(
    options.repoRoot,
    ["diff", "--cached", "--quiet", "--", RUNTIME_LOG_COMMIT_PATH],
  );

  return unstagedClean && stagedClean;
}

async function gitCommandSucceeds(repoRoot: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd: repoRoot, env: gitCommandEnv() });
    return true;
  } catch {
    return false;
  }
}

async function gitQuietDiffClean(repoRoot: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd: repoRoot, env: gitCommandEnv() });
    return true;
  } catch (error) {
    if (isExecExitCode(error, 1)) {
      return false;
    }

    return true;
  }
}

function isExecExitCode(error: unknown, code: number): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

async function commitUploadWithGit(request: UploadCommitRequest): Promise<UploadCommitResult> {
  const paths = [...new Set(request.paths)].sort();
  if (paths.length === 0) {
    return {
      attempted: false,
      ok: true,
    };
  }

  try {
    const gitEnv = gitCommandEnv();
    await execFileAsync("git", ["add", "--", ...paths], { cwd: request.repoRoot, env: gitEnv });
    await execFileAsync(
      "git",
      ["commit", "-m", `chore: upload raw source ${request.source_id}`, "--", ...paths],
      { cwd: request.repoRoot, env: gitEnv },
    );

    return {
      attempted: true,
      ok: true,
      committed_paths: paths,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      committed_paths: paths,
      error: formatGitError(error),
    };
  }
}

function toUploadApiData(
  capture: SourceCaptureSuccess,
  commit: UploadCommitResult,
  autoIngest: AutoIngestSourceResult | undefined,
): UploadApiData {
  return {
    status: capture.status,
    source_id: capture.source.source_id,
    title: capture.source.title,
    source_kind: capture.source.source_kind,
    visibility: capture.source.visibility,
    queue_status: autoIngest?.final_status ?? capture.source.queue_status,
    queue_path: capture.source.queue_path,
    source_card_path: capture.source.source_card_path,
    original_path: capture.source.original_path,
    created_paths: capture.created_paths,
    message: capture.status === "added"
      ? "Raw source uploaded and queued for ingest."
      : "Raw source was already captured; no new artifacts were created.",
    commit,
    ...(autoIngest === undefined ? {} : { auto_ingest: autoIngest }),
  };
}

function failureEnvelope(error: UploadDaemonError): UploadFailureEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      hint: error.hint,
    },
    issues: [
      {
        severity: "error",
        code: error.code,
        message: error.message,
        path: error.path,
        hint: error.hint,
      },
    ],
  };
}

function writeJson(response: ServerResponse, statusCode: number, body: UploadSuccessEnvelope | UploadFailureEnvelope): void {
  const content = `${JSON.stringify(body)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
  });
  response.end(content);
}

function firstField(fields: Map<string, string[]>, name: string): string | undefined {
  const value = fields.get(name)?.[0];
  if (value === undefined) {
    return undefined;
  }

  return value;
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      rejectListen(new UploadDaemonError({
        code: "DAEMON_LISTEN_FAILED",
        message: error.message,
        path: "--port",
        hint: "Use a different local daemon port and try again.",
        statusCode: 500,
      }));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }

      resolveClose();
    });
  });
}

function daemonUrl(host: string, port: number): string {
  const urlHost = host.includes(":") ? `[${host}]` : host;

  return `http://${urlHost}:${port}`;
}

function toUploadDaemonError(error: UploadDaemonConfigError): UploadDaemonError {
  return new UploadDaemonError({
    code: error.code,
    message: error.message,
    path: error.path,
    hint: error.hint,
    statusCode: 400,
  });
}

function formatGitError(error: unknown): string {
  if (isExecError(error)) {
    if (error.code === "ENOENT") {
      return "Git executable was not found on PATH.";
    }

    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const detail = stderr || stdout || error.message;
    return detail.replace(/\s+/g, " ").trim();
  }

  return error instanceof Error ? error.message : String(error);
}

function isExecError(error: unknown): error is Error & { code?: unknown; stderr?: unknown; stdout?: unknown } {
  return error instanceof Error;
}
