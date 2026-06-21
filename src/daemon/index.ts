import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";

import Busboy, { type FieldInfo, type FileInfo } from "busboy";

import {
  capturePreparedUrlSource,
  captureTextSource,
  captureUploadedFileSource,
  prepareUrlSource,
  type PreparedUrlSource,
  type SourceCaptureError,
  type SourceCaptureSuccess,
} from "../sourceCapture/index.js";
import { gitCommandEnv } from "../utils/git.js";
import { err, ok, type Result } from "../utils/result.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_DAEMON_HOST = "127.0.0.1" as const;
export const DEFAULT_DAEMON_PORT = 32123 as const;
export const RAW_UPLOAD_PATH = "/api/raw-upload" as const;
export const UPLOAD_TOKEN_HEADER = "x-llm-wiki-upload-token" as const;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_FIELD_BYTES = MAX_UPLOAD_BYTES;
const MAX_UPLOAD_FIELDS = 20;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const repoUploadQueues = new Map<string, Promise<void>>();

export type UploadDaemon = {
  host: string;
  port: number;
  url: string;
  uploadPath: typeof RAW_UPLOAD_PATH;
  uploadToken: string;
  commitUploads: boolean;
  close: () => Promise<void>;
};

export type UploadDaemonReady = {
  host: string;
  port: number;
  url: string;
  upload_path: typeof RAW_UPLOAD_PATH;
  upload_token: string;
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

export type UploadDaemonOptions = {
  repoRoot: string;
  host?: string;
  port?: number;
  commitUploads?: boolean;
  commitUpload?: UploadCommitter;
};

export type UploadDaemonErrorCode =
  | "DAEMON_HOST_NOT_LOCAL"
  | "DAEMON_LISTEN_FAILED"
  | "DAEMON_PORT_INVALID"
  | "UPLOAD_COMMIT_FAILED"
  | "UPLOAD_CONTENT_TYPE_UNSUPPORTED"
  | "UPLOAD_CSRF_TOKEN_INVALID"
  | "UPLOAD_METHOD_NOT_ALLOWED"
  | "UPLOAD_MULTIPART_INVALID"
  | "UPLOAD_NOT_FOUND"
  | "UPLOAD_PAYLOAD_INVALID"
  | "UPLOAD_TOO_LARGE"
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
  commit: UploadCommitResult;
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
  content: Buffer;
  tooLarge: boolean;
};

type PendingUploadCommits = Map<string, string[]>;

type UploadRequestOptions = {
  repoRoot: string;
  commitUploads: boolean;
  commitUpload: UploadCommitter;
  uploadToken: string;
  pendingUploadCommits: PendingUploadCommits;
};

type UploadWorkSuccess = {
  capture: SourceCaptureSuccess;
  commit: UploadCommitResult;
};

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
  const pendingUploadCommits: PendingUploadCommits = new Map();
  const uploadToken = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    void handleDaemonRequest(
      {
        repoRoot: options.repoRoot,
        commitUploads,
        commitUpload,
        uploadToken,
        pendingUploadCommits,
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
  daemon: Pick<UploadDaemon, "host" | "port" | "url" | "uploadToken" | "commitUploads">,
): UploadDaemonReady {
  return {
    host: daemon.host,
    port: daemon.port,
    url: daemon.url,
    upload_path: RAW_UPLOAD_PATH,
    upload_token: daemon.uploadToken,
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
      data: toUploadApiData(upload.value.capture, upload.value.commit),
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
  const capture = await capturePreparedUpload(options.repoRoot, payload);
  if (!capture.ok) {
    return err(capture.error);
  }

  const commit = await commitCapturedUpload(options, capture.value);
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

    return ok({
      kind: "file",
      title,
      fileName: upload.value.file.fileName,
      content: upload.value.file.content,
    });
  }

  if (text !== undefined) {
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
  repoRoot: string,
  payload: PreparedUploadPayload,
): Promise<Result<SourceCaptureSuccess, UploadDaemonError>> {
  if (payload.kind === "file") {
    return mapCaptureResult(await captureUploadedFileSource({
      repoRoot,
      title: payload.title,
      fileName: payload.fileName,
      content: payload.content,
      command: "llm-wiki daemon upload file",
    }));
  }

  if (payload.kind === "text") {
    return mapCaptureResult(await captureTextSource({
      repoRoot,
      title: payload.title,
      text: payload.text,
      command: "llm-wiki daemon upload text",
    }));
  }

  return mapCaptureResult(await capturePreparedUrlSource({
    repoRoot,
    source: payload.source,
    command: "llm-wiki daemon upload url",
  }));
}

async function parseMultipartUpload(request: IncomingMessage): Promise<Result<MultipartUpload, UploadDaemonError>> {
  return new Promise((resolveParse) => {
    const fields = new Map<string, string[]>();
    let file: UploadedFile | null = null;
    let settled = false;
    const busboy = Busboy({
      headers: request.headers,
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        fieldSize: MAX_UPLOAD_FIELD_BYTES,
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
        file = {
          fileName: info.filename || "upload.bin",
          content: Buffer.concat(chunks),
          tooLarge,
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
      code: "UPLOAD_CSRF_TOKEN_INVALID",
      message: "Raw upload requests must include a valid upload token.",
      path: UPLOAD_TOKEN_HEADER,
      hint: `Set the ${UPLOAD_TOKEN_HEADER} header to the daemon upload_token value from readiness output.`,
      statusCode: 403,
    }));
  }

  return ok(undefined);
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
): Promise<UploadCommitResult> {
  if (!options.commitUploads) {
    return {
      attempted: false,
      ok: true,
    };
  }

  const paths = capture.status === "added"
    ? uploadCommitPaths(capture)
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

function uploadCommitPaths(capture: SourceCaptureSuccess): string[] {
  return [...new Set([...capture.created_paths, "curated/log.md"])];
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

function toUploadApiData(capture: SourceCaptureSuccess, commit: UploadCommitResult): UploadApiData {
  return {
    status: capture.status,
    source_id: capture.source.source_id,
    title: capture.source.title,
    source_kind: capture.source.source_kind,
    visibility: capture.source.visibility,
    queue_status: capture.source.queue_status,
    queue_path: capture.source.queue_path,
    source_card_path: capture.source.source_card_path,
    original_path: capture.source.original_path,
    created_paths: capture.created_paths,
    commit,
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
