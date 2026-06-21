import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { RuntimeCommandError } from "../runtime/errors.js";
import { validateTextFileWriteInsideRoot, writeTextFileInsideRoot, type BinaryWriteError } from "../utils/fs.js";

export type RemoteUploadTarget = "github";

export type RemoteUploadInitOptions = {
  target?: string;
};

export type RemoteUploadInitResult = {
  target: RemoteUploadTarget;
  config_path: typeof GITHUB_UPLOAD_CONFIG_PATH;
  form_config_path: typeof GITHUB_UPLOAD_FORM_CONFIG_PATH;
  docs_path: typeof GITHUB_UPLOAD_DOCS_PATH;
  created_paths: string[];
  updated_paths: string[];
  backend_template_paths: string[];
  auth_hooks: typeof AUTH_HOOKS;
  rate_limits: typeof RATE_LIMITS;
  size_limits: typeof SIZE_LIMITS;
  file_type_limits: typeof FILE_TYPE_LIMITS;
  required_secrets: typeof REQUIRED_SECRETS;
  write_mode: "pull_request";
  direct_commit: false;
  default_visibility: "private";
  queue_status: "queued";
  publish_directly: false;
  instructions: string[];
};

const GITHUB_UPLOAD_CONFIG_PATH = ".llm-wiki/upload/github.yml" as const;
const GITHUB_UPLOAD_FORM_CONFIG_PATH = ".llm-wiki/upload/forms/remote-github.json" as const;
const GITHUB_UPLOAD_DOCS_PATH = "docs/remote-upload-github.md" as const;

const BACKEND_TEMPLATE_PATHS = [
  "upload/github/serverless/.env.example",
  "upload/github/serverless/README.md",
  "upload/github/serverless/auth.ts",
  "upload/github/serverless/config.ts",
  "upload/github/serverless/github.ts",
  "upload/github/serverless/package.json",
  "upload/github/serverless/rate-limit.ts",
  "upload/github/serverless/raw-upload.ts",
] as const;

const AUTH_HOOKS = ["verifyUploadRequest", "resolveUploaderIdentity"] as const;
const REQUIRED_SECRETS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "LLM_WIKI_UPLOAD_SIGNING_SECRET",
] as const;
const RATE_LIMITS = {
  enabled: true,
  strategy: "ip_and_identity",
  window_seconds: 60,
  max_requests: 30,
} as const;
const SIZE_LIMITS = {
  max_file_bytes: 26_214_400,
  max_text_bytes: 1_048_576,
} as const;
const FILE_TYPE_LIMITS = {
  allowed_mime_types: ["text/markdown", "text/plain", "application/pdf"],
  allowed_extensions: [".md", ".markdown", ".txt", ".pdf"],
} as const;

type ManagedScaffoldEntry = {
  path: string;
  content: string;
};

export async function initializeRemoteUploadScaffold(
  repoRoot: string,
  options: RemoteUploadInitOptions,
): Promise<{ data: RemoteUploadInitResult; warnings: string[] }> {
  const target = normalizeUploadTarget(options.target);
  const createdPaths: string[] = [];
  const updatedPaths: string[] = [];

  for (const entry of githubRemoteUploadEntries()) {
    const write = await writeTrackedTextFile(repoRoot, entry.path, entry.content);
    if (write === "created") {
      createdPaths.push(entry.path);
    } else if (write === "updated") {
      updatedPaths.push(entry.path);
    }
  }

  return {
    data: {
      target,
      config_path: GITHUB_UPLOAD_CONFIG_PATH,
      form_config_path: GITHUB_UPLOAD_FORM_CONFIG_PATH,
      docs_path: GITHUB_UPLOAD_DOCS_PATH,
      created_paths: createdPaths,
      updated_paths: updatedPaths,
      backend_template_paths: [...BACKEND_TEMPLATE_PATHS],
      auth_hooks: [...AUTH_HOOKS],
      rate_limits: RATE_LIMITS,
      size_limits: SIZE_LIMITS,
      file_type_limits: FILE_TYPE_LIMITS,
      required_secrets: [...REQUIRED_SECRETS],
      write_mode: "pull_request",
      direct_commit: false,
      default_visibility: "private",
      queue_status: "queued",
      publish_directly: false,
      instructions: [
        "Deploy upload/github/serverless/raw-upload.ts to a protected serverless runtime.",
        "Set only environment variables listed in upload/github/serverless/.env.example.",
        "Expose the deployed endpoint through .llm-wiki/upload/forms/remote-github.json when wiring a public upload form.",
      ],
    },
    warnings: [],
  };
}

export function toUploadScaffoldRuntimeCommandError(error: unknown, command: string): RuntimeCommandError {
  if (error instanceof RuntimeCommandError) {
    return error;
  }

  return new RuntimeCommandError({
    code: "UPLOAD_SCAFFOLD_FAILED",
    message: error instanceof Error ? error.message : String(error),
    path: ".",
    hint: `Fix repository permissions or scaffold inputs, then rerun llm-wiki ${command}.`,
  });
}

function normalizeUploadTarget(target: string | undefined): RemoteUploadTarget {
  const normalized = target?.trim().toLowerCase();
  if (normalized === "github") {
    return normalized;
  }

  if (normalized === undefined || normalized === "") {
    throw new RuntimeCommandError({
      code: "UPLOAD_TARGET_REQUIRED",
      message: "Remote upload scaffold target is required.",
      path: "--target",
      hint: "Use llm-wiki upload init --target github.",
    });
  }

  throw new RuntimeCommandError({
    code: "UPLOAD_TARGET_UNSUPPORTED",
    message: `Unsupported remote upload target: ${target}.`,
    path: "--target",
    hint: "Use llm-wiki upload init --target github.",
  });
}

function githubRemoteUploadEntries(): ManagedScaffoldEntry[] {
  return [
    { path: GITHUB_UPLOAD_FORM_CONFIG_PATH, content: githubUploadFormConfigContent() },
    { path: GITHUB_UPLOAD_CONFIG_PATH, content: githubUploadConfigContent() },
    { path: GITHUB_UPLOAD_DOCS_PATH, content: githubUploadDocsContent() },
    { path: "upload/github/serverless/.env.example", content: githubUploadEnvExampleContent() },
    { path: "upload/github/serverless/README.md", content: githubUploadBackendReadmeContent() },
    { path: "upload/github/serverless/auth.ts", content: githubUploadAuthTemplateContent() },
    { path: "upload/github/serverless/config.ts", content: githubUploadConfigTemplateContent() },
    { path: "upload/github/serverless/github.ts", content: githubUploadGitHubTemplateContent() },
    { path: "upload/github/serverless/package.json", content: githubUploadPackageJsonContent() },
    { path: "upload/github/serverless/rate-limit.ts", content: githubUploadRateLimitTemplateContent() },
    { path: "upload/github/serverless/raw-upload.ts", content: githubUploadRawUploadTemplateContent() },
  ];
}

async function writeTrackedTextFile(repoRoot: string, path: string, content: string): Promise<"created" | "updated" | "skipped"> {
  const validation = await validateTextFileWriteInsideRoot(repoRoot, path);
  if (!validation.ok) {
    throw uploadWriteError(path, validation.error);
  }

  const existingContent = await readOptionalTextFile(repoRoot, path);
  if (existingContent === content) {
    return "skipped";
  }

  const write = await writeTextFileInsideRoot(repoRoot, path, content);
  if (!write.ok) {
    throw uploadWriteError(path, write.error);
  }

  return existingContent === null ? "created" : "updated";
}

async function readOptionalTextFile(repoRoot: string, path: string): Promise<string | null> {
  try {
    return await readFile(resolve(repoRoot, path), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function uploadWriteError(path: string, error: BinaryWriteError): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "UPLOAD_SCAFFOLD_WRITE_FAILED",
    message: `Failed to write ${path}.`,
    path,
    hint: error.hint,
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function githubUploadConfigContent(): string {
  return `target: github
mode: remote-upload
backend:
  configured: true
  template: serverless
  handler_path: upload/github/serverless/raw-upload.ts
  env_file_example: upload/github/serverless/.env.example
form:
  enabled: true
  config_path: .llm-wiki/upload/forms/remote-github.json
  endpoint_env: LLM_WIKI_REMOTE_UPLOAD_URL
auth:
  required: true
  hooks:
    - verifyUploadRequest
    - resolveUploaderIdentity
rate_limit:
  enabled: true
  strategy: ip_and_identity
  window_seconds: 60
  max_requests: 30
limits:
  max_file_bytes: 26214400
  max_text_bytes: 1048576
  allowed_mime_types:
    - text/markdown
    - text/plain
    - application/pdf
  allowed_extensions:
    - .md
    - .markdown
    - .txt
    - .pdf
write:
  mode: pull_request
  direct_commit: false
  branch_prefix: llm-wiki/upload/
queue:
  status: queued
  visibility: private
  publish_directly: false
secrets:
  source: env
  required:
${REQUIRED_SECRETS.map((secret) => `    - ${secret}`).join("\n")}
`;
}

function githubUploadFormConfigContent(): string {
  return `${JSON.stringify(
    {
      enabled: true,
      target: "github",
      backend_configured: true,
      endpoint_env: "LLM_WIKI_REMOTE_UPLOAD_URL",
      allowed_extensions: FILE_TYPE_LIMITS.allowed_extensions,
      max_file_bytes: SIZE_LIMITS.max_file_bytes,
      publish_directly: false,
    },
    null,
    2,
  )}
`;
}

function githubUploadDocsContent(): string {
  return `# GitHub Remote Upload Scaffold

This scaffold is a template for authenticated remote upload intake. It is not a hosted service.

## Safety Defaults

Authentication is required before accepting an upload.
Upload signatures bind the request method, path, body digest, and timestamp; timestamps older than 300 seconds are rejected.
Rate limiting is enabled by default: 30 requests per 60 seconds using the ip_and_identity key.
The scaffold rejects unsupported file types and payloads larger than 26214400 bytes.
Secrets must come from environment variables only.
The default write mode is GitHub pull request, not direct commit.
Remote uploads are queued private raw inputs and are never published directly.

## Generated Files

- \`.llm-wiki/upload/github.yml\` records backend configuration and upload safety defaults.
- \`.llm-wiki/upload/forms/remote-github.json\` enables a future upload form only after this backend scaffold exists.
- \`upload/github/serverless/raw-upload.ts\` is the serverless handler template.
- \`upload/github/serverless/auth.ts\` contains the authentication hooks.
- \`upload/github/serverless/rate-limit.ts\` contains the default rate limiter hook.
- \`upload/github/serverless/github.ts\` sketches PR-first GitHub writes.
- \`upload/github/serverless/.env.example\` lists required environment variables without secret values.

## Required Environment Variables

${REQUIRED_SECRETS.map((secret) => `- \`${secret}\``).join("\n")}

## Upload Flow

1. Reject non-POST requests and read the request body with a hard byte cap before hashing or parsing.
2. Verify the signed method, path, body digest, and fresh timestamp with \`verifyUploadRequest\`.
3. Resolve the uploader identity with \`resolveUploaderIdentity\`.
4. Apply the default rate limit before accepting upload fields.
5. Reject files outside the allowed MIME types or extensions.
6. Decode text uploads from JSON \`content\` and binary uploads such as PDFs from JSON \`contentBase64\` before hashing or writing raw originals.
7. Write source artifacts as private raw input files with a queued status.
8. Open a GitHub pull request for review.
9. Do not publish uploaded content directly.

After deploying the serverless endpoint, set the endpoint outside the repository using \`LLM_WIKI_REMOTE_UPLOAD_URL\` or your hosting provider's equivalent configuration.
`;
}

function githubUploadEnvExampleContent(): string {
  return `${REQUIRED_SECRETS.map((secret) => `${secret}=`).join("\n")}
LLM_WIKI_REMOTE_UPLOAD_URL=
`;
}

function githubUploadBackendReadmeContent(): string {
  return `# GitHub Serverless Upload Template

Deploy this template behind your authenticated serverless provider.

The handler is intentionally incomplete around provider-specific request parsing and GitHub App token creation. Keep those parts explicit in your deployment repo so secrets stay in environment variables and uploaded content enters the wiki through pull requests.

Defaults:

- Authentication hooks: \`verifyUploadRequest\`, \`resolveUploaderIdentity\`.
- Upload signature: HMAC-SHA256 over timestamp, method, path, and body digest with a 300 second freshness window.
- Rate limit: 30 requests per 60 seconds by ip_and_identity.
- Max file size: 26214400 bytes.
- Max text field size: 1048576 bytes.
- Binary payloads such as PDFs use base64 \`contentBase64\` and are decoded before hashing or writing.
- Write mode: pull_request.
- Uploaded source visibility: private.
- Uploaded queue status: queued.
- Direct publishing: disabled.
`;
}

function githubUploadAuthTemplateContent(): string {
  return `import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type UploadIdentity = {
  id: string;
  label: string;
};

const SIGNATURE_FRESHNESS_SECONDS = 300;

export async function verifyUploadRequest(request: Request, bodyBytes: Uint8Array): Promise<void> {
  const signingSecret = process.env.LLM_WIKI_UPLOAD_SIGNING_SECRET;
  if (!signingSecret) {
    throw new Response("Upload signing secret is not configured.", { status: 500 });
  }

  const signature = request.headers.get("x-llm-wiki-upload-signature");
  const timestamp = request.headers.get("x-llm-wiki-upload-timestamp");
  if (!signature || !timestamp) {
    throw new Response("Upload authentication headers are required.", { status: 401 });
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds)) {
    throw new Response("Upload timestamp is invalid.", { status: 401 });
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (ageSeconds > SIGNATURE_FRESHNESS_SECONDS) {
    throw new Response("Upload signature timestamp is stale.", { status: 401 });
  }

  const bodyDigest = requestBodyDigest(bodyBytes);
  const expected = createHmac("sha256", signingSecret)
    .update(canonicalSignaturePayload({
      timestamp,
      method: request.method,
      path: requestPath(request),
      bodyDigest,
    }))
    .digest("hex");
  if (!constantTimeEqual(signature, expected)) {
    throw new Response("Upload signature is invalid.", { status: 401 });
  }
}

export async function resolveUploaderIdentity(request: Request): Promise<UploadIdentity> {
  const subject = request.headers.get("x-llm-wiki-uploader") ?? "anonymous";
  return {
    id: subject,
    label: subject,
  };
}

type SignatureParts = {
  timestamp: string;
  method: string;
  path: string;
  bodyDigest: string;
};

function canonicalSignaturePayload(parts: SignatureParts): string {
  return [
    "v1",
    "timestamp:" + parts.timestamp,
    "method:" + parts.method.toUpperCase(),
    "path:" + parts.path,
    "body-sha256:" + parts.bodyDigest,
  ].join("\\n");
}

function requestBodyDigest(bodyBytes: Uint8Array): string {
  return createHash("sha256").update(bodyBytes).digest("hex");
}

function requestPath(request: Request): string {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
`;
}

function githubUploadConfigTemplateContent(): string {
  return `export const uploadConfig = {
  maxFileBytes: 26214400,
  maxTextBytes: 1048576,
  allowedMimeTypes: ["text/markdown", "text/plain", "application/pdf"],
  allowedExtensions: [".md", ".markdown", ".txt", ".pdf"],
  queue: {
    status: "queued",
    visibility: "private",
    publishDirectly: false,
  },
  github: {
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    appId: process.env.GITHUB_APP_ID,
    appPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    appInstallationId: process.env.GITHUB_APP_INSTALLATION_ID,
  },
} as const;
`;
}

function githubUploadGitHubTemplateContent(): string {
  return `export type QueuedUploadArtifact = {
  sourceId: string;
  files: Array<{ path: string; content: string; encoding: "utf8" | "base64" }>;
};

export const githubWriteDefaults = {
  mode: "pull_request",
  branchPrefix: "llm-wiki/upload/",
} as const;

export async function createQueuedRawUploadPullRequest(upload: QueuedUploadArtifact): Promise<{ url: string }> {
  return createPullRequest({
    branchName: \`\${githubWriteDefaults.branchPrefix}\${upload.sourceId}\`,
    title: \`Queue remote upload \${upload.sourceId}\`,
    body: "Adds a queued private raw source from the remote upload backend.",
    files: upload.files,
  });
}

export async function createPullRequest(request: {
  branchName: string;
  title: string;
  body: string;
  files: Array<{ path: string; content: string; encoding: "utf8" | "base64" }>;
}): Promise<{ url: string }> {
  void request;
  throw new Error("Wire this template to the GitHub App installation token for your deployment.");
}
`;
}

function githubUploadPackageJsonContent(): string {
  return `{
  "name": "llm-wiki-github-upload-template",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "@octokit/rest": "^21.0.0"
  }
}
`;
}

function githubUploadRateLimitTemplateContent(): string {
  return `export const defaultRateLimit = {
  enabled: true,
  strategy: "ip_and_identity",
  maxRequests: 30,
  windowSeconds: 60,
} as const;

const buckets = new Map<string, { count: number; resetAt: number }>();

export async function assertWithinRateLimit(key: string, now = Date.now()): Promise<void> {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + defaultRateLimit.windowSeconds * 1000 });
    return;
  }

  if (bucket.count >= defaultRateLimit.maxRequests) {
    throw new Response("Upload rate limit exceeded.", { status: 429 });
  }

  bucket.count += 1;
}
`;
}

function githubUploadRawUploadTemplateContent(): string {
  return `import { createHash } from "node:crypto";

import { verifyUploadRequest, resolveUploaderIdentity } from "./auth.js";
import { uploadConfig } from "./config.js";
import { createQueuedRawUploadPullRequest, type QueuedUploadArtifact } from "./github.js";
import { assertWithinRateLimit } from "./rate-limit.js";

type RemoteUploadPayload = {
  title: string;
  filename: string;
  mimeType: string;
  content?: string;
  contentBase64?: string;
};

type DecodedUploadContent = {
  bytes: Buffer;
  content: string;
  encoding: "utf8" | "base64";
};

type RawSourceMetadata = {
  source_id: string;
  title: string;
  source_kind: "file";
  origin: string;
  captured_at: string;
  content_hash: string;
  status: typeof uploadConfig.queue.status;
  visibility: typeof uploadConfig.queue.visibility;
  path: string;
  original_path: string;
};

export async function handleRemoteUpload(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const rawBody = await readLimitedRequestBody(request, maxUploadRequestBodyBytes());
  if (!rawBody) {
    return Response.json({ ok: false, error: "upload_too_large" }, { status: 413 });
  }

  await verifyUploadRequest(request, rawBody);
  const identity = await resolveUploaderIdentity(request);
  await assertWithinRateLimit(rateLimitKey(request, identity.id));

  const payload = readUploadPayload(rawBody);
  if (!payload) {
    return Response.json({ ok: false, error: "invalid_upload" }, { status: 400 });
  }

  const extension = extensionFromFilename(payload.filename);
  const allowedMimeTypes: readonly string[] = uploadConfig.allowedMimeTypes;
  const allowedExtensions: readonly string[] = uploadConfig.allowedExtensions;
  const hasAllowedMimeType = allowedMimeTypes.includes(payload.mimeType);
  const hasAllowedExtension = allowedExtensions.includes(extension);
  if (!hasAllowedMimeType || !hasAllowedExtension) {
    return Response.json({ ok: false, error: "unsupported_file_type" }, { status: 415 });
  }

  const textUpload = isTextUpload(payload.mimeType, extension);
  const decodedContent = decodeUploadContent(payload, textUpload);
  if (!decodedContent) {
    return Response.json({ ok: false, error: "invalid_upload" }, { status: 400 });
  }

  const maxPayloadBytes = textUpload ? uploadConfig.maxTextBytes : uploadConfig.maxFileBytes;
  if (decodedContent.bytes.byteLength > maxPayloadBytes) {
    return Response.json({ ok: false, error: "upload_too_large" }, { status: 413 });
  }

  const capturedAt = new Date().toISOString();
  const contentHash = contentHashFor(decodedContent.bytes);
  const sourceId = buildSourceId(payload.title, contentHash, capturedAt);
  const year = capturedAt.slice(0, 4);
  const month = capturedAt.slice(5, 7);
  const sourceDir = \`raw/inputs/\${year}/\${month}/\${sourceId}\`;
  const originalPath = \`\${sourceDir}/original\${extension}\`;
  const sourceCardPath = \`\${sourceDir}/_source.md\`;
  const queuePath = \`raw/queue/\${sourceId}.json\`;
  const sourceKind = "file";
  const sourceMetadata: RawSourceMetadata = {
    source_id: sourceId,
    title: payload.title,
    source_kind: sourceKind,
    origin: \`remote-upload:\${payload.filename}\`,
    captured_at: capturedAt,
    content_hash: contentHash,
    status: uploadConfig.queue.status,
    visibility: uploadConfig.queue.visibility,
    path: sourceCardPath,
    original_path: originalPath,
  };
  const queuedUpload: QueuedUploadArtifact = {
    sourceId,
    files: [
      {
        path: originalPath,
        content: decodedContent.content,
        encoding: decodedContent.encoding,
      },
      {
        path: sourceCardPath,
        content: sourceCardContent(sourceMetadata, identity.label),
        encoding: "utf8",
      },
      {
        path: queuePath,
        content: JSON.stringify({
          kind: sourceKind,
          source_id: sourceMetadata.source_id,
          title: sourceMetadata.title,
          source_kind: sourceMetadata.source_kind,
          origin: sourceMetadata.origin,
          captured_at: sourceMetadata.captured_at,
          content_hash: sourceMetadata.content_hash,
          status: sourceMetadata.status,
          visibility: sourceMetadata.visibility,
          path: sourceMetadata.path,
          original_path: sourceMetadata.original_path,
        }, null, 2) + "\\n",
        encoding: "utf8",
      },
    ],
  };
  const pullRequest = await createQueuedRawUploadPullRequest(queuedUpload);

  return Response.json({
    ok: true,
    data: {
      status: "queued",
      visibility: "private",
      write_mode: "pull_request",
      publish_directly: false,
      pull_request_url: pullRequest.url,
    },
  });
}

function rateLimitKey(request: Request, identityId: string): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown-ip";
  return \`\${forwardedFor}:\${identityId}\`;
}

function maxUploadRequestBodyBytes(): number {
  const encodedFileBytes = Math.ceil(uploadConfig.maxFileBytes / 3) * 4;
  const maxPayloadBytes = Math.max(uploadConfig.maxTextBytes, encodedFileBytes);
  return maxPayloadBytes + 65536;
}

async function readLimitedRequestBody(request: Request, maxBytes: number): Promise<Buffer | null> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const trimmedContentLength = contentLengthHeader.trim();
    if (!/^[0-9]+$/.test(trimmedContentLength)) {
      return null;
    }

    const contentLength = Number(trimmedContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
      return null;
    }
  }

  if (!request.body) {
    return Buffer.alloc(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks, totalBytes);
}

function readUploadPayload(rawBody: Buffer): RemoteUploadPayload | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }

  if (!isRecord(body)) {
    return null;
  }

  if (
    typeof body.title !== "string" ||
    body.title.trim() === "" ||
    typeof body.filename !== "string" ||
    body.filename.trim() === "" ||
    typeof body.mimeType !== "string" ||
    body.mimeType.trim() === ""
  ) {
    return null;
  }

  if (body.content !== undefined && typeof body.content !== "string") {
    return null;
  }

  if (body.contentBase64 !== undefined && typeof body.contentBase64 !== "string") {
    return null;
  }

  return {
    title: body.title,
    filename: body.filename,
    mimeType: body.mimeType,
    content: body.content,
    contentBase64: body.contentBase64,
  };
}

function decodeUploadContent(payload: RemoteUploadPayload, textUpload: boolean): DecodedUploadContent | null {
  if (textUpload) {
    if (typeof payload.content !== "string") {
      return null;
    }

    return {
      bytes: Buffer.from(payload.content, "utf8"),
      content: payload.content,
      encoding: "utf8",
    };
  }

  if (typeof payload.contentBase64 !== "string") {
    return null;
  }

  const decoded = decodeBase64Content(payload.contentBase64);
  if (!decoded) {
    return null;
  }

  return {
    bytes: decoded.bytes,
    content: decoded.normalized,
    encoding: "base64",
  };
}

function decodeBase64Content(contentBase64: string): { bytes: Buffer; normalized: string } | null {
  const normalized = contentBase64.replace(/\\s+/g, "");
  if (normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return null;
  }

  return {
    bytes: Buffer.from(normalized, "base64"),
    normalized,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extensionFromFilename(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot === -1 ? "" : filename.slice(lastDot).toLowerCase();
}

function isTextUpload(mimeType: string, extension: string): boolean {
  return mimeType.startsWith("text/") || [".md", ".markdown", ".txt"].includes(extension);
}

function sourceCardContent(source: RawSourceMetadata, uploader: string): string {
  return \`---
type: raw_source
source_id: \${source.source_id}
title: \${JSON.stringify(source.title)}
source_kind: \${source.source_kind}
origin: \${JSON.stringify(source.origin)}
captured_at: \${source.captured_at}
content_hash: \${source.content_hash}
status: \${source.status}
visibility: \${source.visibility}
tags: []
curated_summary:
ingested_at:
supersedes:
superseded_by:
uploader: \${JSON.stringify(uploader)}
---

# \${markdownHeadingText(source.title)}

Original file: [[\${source.original_path}|\${source.original_path.split("/").at(-1) ?? "original"}]]

Queued private raw input from the authenticated remote upload scaffold.

## Capture notes

## Human notes

## Ingest status

- Status: \${source.status}
- Curated summary:
\`;
}

function contentHashFor(content: Buffer): string {
  return \`sha256:\${createHash("sha256").update(content).digest("hex")}\`;
}

function buildSourceId(title: string, contentHash: string, capturedAt: string): string {
  const year = capturedAt.slice(0, 4);
  const month = capturedAt.slice(5, 7);
  const day = capturedAt.slice(8, 10);
  const shortHash = contentHash.replace(/^sha256:/, "").slice(0, 12);
  return \`src_\${year}_\${month}_\${day}_\${sourceSlug(title)}_\${shortHash}\`;
}

function sourceSlug(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_");
  return slug.length > 0 ? slug.slice(0, 64).replace(/_+$/g, "") : "upload";
}

function markdownHeadingText(title: string): string {
  return title.replace(/[\\u0000-\\u001f\\u007f]+/g, " ").replace(/\\s+/g, " ").trim();
}
`;
}
