import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { parseInitJson, pathExists, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

type UploadInitEnvelope = {
  ok: true;
  command: "upload.init";
  repo: string;
  data: {
    target: "github";
    config_path: ".llm-wiki/upload/github.yml";
    form_config_path: ".llm-wiki/upload/forms/remote-github.json";
    docs_path: "docs/remote-upload-github.md";
    created_paths: string[];
    updated_paths: string[];
    backend_template_paths: string[];
    auth_hooks: string[];
    rate_limits: {
      enabled: true;
      strategy: "ip_and_identity";
      window_seconds: number;
      max_requests: number;
    };
    size_limits: {
      max_file_bytes: number;
      max_text_bytes: number;
    };
    file_type_limits: {
      allowed_mime_types: string[];
      allowed_extensions: string[];
    };
    required_secrets: string[];
    write_mode: "pull_request";
    direct_commit: false;
    default_visibility: "private";
    queue_status: "queued";
    publish_directly: false;
    instructions: string[];
  };
  warnings: string[];
};

type UploadFailureEnvelope = {
  ok: false;
  command: "upload.init";
  repo: string;
  error: {
    code: string;
    message: string;
    hint: string;
  };
  issues: Array<{
    severity: "error";
    code: string;
    message: string;
    path: string;
    hint: string;
  }>;
};

const EXPECTED_CREATED_PATHS = [
  ".llm-wiki/upload/forms/remote-github.json",
  ".llm-wiki/upload/github.yml",
  "docs/remote-upload-github.md",
  "upload/github/serverless/.env.example",
  "upload/github/serverless/README.md",
  "upload/github/serverless/auth.ts",
  "upload/github/serverless/config.ts",
  "upload/github/serverless/github.ts",
  "upload/github/serverless/package.json",
  "upload/github/serverless/rate-limit.ts",
  "upload/github/serverless/raw-upload.ts",
] as const;

const REQUIRED_SECRETS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "LLM_WIKI_UPLOAD_SIGNING_SECRET",
] as const;

const execFileAsync = promisify(execFile);

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

function parseUploadInit(stdout: string[]): UploadInitEnvelope {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as UploadInitEnvelope;
}

function parseUploadFailure(stdout: string[]): UploadFailureEnvelope {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as UploadFailureEnvelope;
}

async function expectGeneratedServerlessTypescriptCompiles(wikiDir: string): Promise<void> {
  const serverlessDir = resolve(wikiDir, "upload/github/serverless");
  const tsconfigPath = resolve(serverlessDir, "tsconfig.json");
  await writeFile(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: [resolve(process.cwd(), "node_modules/@types")],
        },
        include: ["*.ts"],
      },
      null,
      2,
    ),
  );

  await execFileAsync(process.execPath, [resolve(process.cwd(), "node_modules/typescript/bin/tsc"), "-p", tsconfigPath, "--noEmit"], {
    cwd: serverlessDir,
  });
}

describe("remote upload scaffold", () => {
  it("generates a deterministic GitHub serverless scaffold with PR-first private queue defaults", async () => {
    await withTempWorkspace("llm-wiki-upload-github-scaffold-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["upload", "init", "--target", "github", "--repo", wikiDir, "--json"]);
      const payload = parseUploadInit(result.stdout);
      const config = parse(await readGeneratedFile(wikiDir, ".llm-wiki/upload/github.yml")) as {
        target: string;
        backend: { configured: boolean; template: string; handler_path: string };
        form: { enabled: boolean; config_path: string; endpoint_env: string };
        auth: { required: boolean; hooks: string[] };
        rate_limit: { enabled: boolean; strategy: string; window_seconds: number; max_requests: number };
        limits: { max_file_bytes: number; max_text_bytes: number; allowed_mime_types: string[]; allowed_extensions: string[] };
        write: { mode: string; direct_commit: boolean; branch_prefix: string };
        queue: { status: string; visibility: string; publish_directly: boolean };
        secrets: { source: string; required: string[] };
      };
      const formConfig = JSON.parse(await readGeneratedFile(wikiDir, ".llm-wiki/upload/forms/remote-github.json")) as {
        enabled: boolean;
        target: string;
        backend_configured: boolean;
        endpoint_env: string;
        allowed_extensions: string[];
        max_file_bytes: number;
        publish_directly: boolean;
      };
      const firstRawUpload = await readGeneratedFile(wikiDir, "upload/github/serverless/raw-upload.ts");
      const firstDocs = await readGeneratedFile(wikiDir, "docs/remote-upload-github.md");
      const repeat = await runCliBuffered(["upload", "init", "--target", "github", "--repo", wikiDir, "--json"]);
      const repeatPayload = parseUploadInit(repeat.stdout);
      const repeatRawUpload = await readGeneratedFile(wikiDir, "upload/github/serverless/raw-upload.ts");
      const repeatDocs = await readGeneratedFile(wikiDir, "docs/remote-upload-github.md");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.created_paths).toEqual(EXPECTED_CREATED_PATHS);
      expect(payload.data.updated_paths).toEqual([]);
      expect(payload.data.backend_template_paths).toEqual([
        "upload/github/serverless/.env.example",
        "upload/github/serverless/README.md",
        "upload/github/serverless/auth.ts",
        "upload/github/serverless/config.ts",
        "upload/github/serverless/github.ts",
        "upload/github/serverless/package.json",
        "upload/github/serverless/rate-limit.ts",
        "upload/github/serverless/raw-upload.ts",
      ]);
      expect(payload.data).toMatchObject({
        target: "github",
        config_path: ".llm-wiki/upload/github.yml",
        form_config_path: ".llm-wiki/upload/forms/remote-github.json",
        docs_path: "docs/remote-upload-github.md",
        auth_hooks: ["verifyUploadRequest", "resolveUploaderIdentity"],
        rate_limits: {
          enabled: true,
          strategy: "ip_and_identity",
          window_seconds: 60,
          max_requests: 30,
        },
        size_limits: {
          max_file_bytes: 26214400,
          max_text_bytes: 1048576,
        },
        file_type_limits: {
          allowed_extensions: [".md", ".markdown", ".txt", ".pdf"],
          allowed_mime_types: ["text/markdown", "text/plain", "application/pdf"],
        },
        required_secrets: [...REQUIRED_SECRETS],
        write_mode: "pull_request",
        direct_commit: false,
        default_visibility: "private",
        queue_status: "queued",
        publish_directly: false,
      });
      expect(payload.data.instructions).toContain("Deploy upload/github/serverless/raw-upload.ts to a protected serverless runtime.");
      expect(config).toMatchObject({
        target: "github",
        backend: {
          configured: true,
          template: "serverless",
          handler_path: "upload/github/serverless/raw-upload.ts",
        },
        form: {
          enabled: true,
          config_path: ".llm-wiki/upload/forms/remote-github.json",
          endpoint_env: "LLM_WIKI_REMOTE_UPLOAD_URL",
        },
        auth: {
          required: true,
          hooks: ["verifyUploadRequest", "resolveUploaderIdentity"],
        },
        rate_limit: {
          enabled: true,
          strategy: "ip_and_identity",
          window_seconds: 60,
          max_requests: 30,
        },
        write: {
          mode: "pull_request",
          direct_commit: false,
          branch_prefix: "llm-wiki/upload/",
        },
        queue: {
          status: "queued",
          visibility: "private",
          publish_directly: false,
        },
        secrets: {
          source: "env",
          required: [...REQUIRED_SECRETS],
        },
      });
      expect(config.limits.allowed_mime_types).toEqual(["text/markdown", "text/plain", "application/pdf"]);
      expect(formConfig).toEqual({
        enabled: true,
        target: "github",
        backend_configured: true,
        endpoint_env: "LLM_WIKI_REMOTE_UPLOAD_URL",
        allowed_extensions: [".md", ".markdown", ".txt", ".pdf"],
        max_file_bytes: 26214400,
        publish_directly: false,
      });
      expect(repeat.exitCode).toBe(0);
      expect(repeatPayload.data.created_paths).toEqual([]);
      expect(repeatPayload.data.updated_paths).toEqual([]);
      expect(repeatRawUpload).toBe(firstRawUpload);
      expect(repeatDocs).toBe(firstDocs);
    });
  });

  it("documents authentication, rate limiting, size/type checks, env secrets, and queued private PR behavior", async () => {
    await withTempWorkspace("llm-wiki-upload-github-docs-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/upload/forms/remote-github.json"))).toBe(false);

      // Act
      const result = await runCliBuffered(["upload", "init", "--target", "github", "--repo", wikiDir]);
      const docs = await readGeneratedFile(wikiDir, "docs/remote-upload-github.md");
      const backendReadme = await readGeneratedFile(wikiDir, "upload/github/serverless/README.md");
      const authTemplate = await readGeneratedFile(wikiDir, "upload/github/serverless/auth.ts");
      const rateLimitTemplate = await readGeneratedFile(wikiDir, "upload/github/serverless/rate-limit.ts");
      const envExample = await readGeneratedFile(wikiDir, "upload/github/serverless/.env.example");
      const githubTemplate = await readGeneratedFile(wikiDir, "upload/github/serverless/github.ts");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(result.stdout.join("\n")).toContain("Remote upload scaffold initialized");
      expect(result.stdout.join("\n")).toContain("Docs: docs/remote-upload-github.md");
      expect(result.stdout.join("\n")).toContain("Auth hooks: verifyUploadRequest, resolveUploaderIdentity");
      expect(result.stdout.join("\n")).toContain("Rate limit: 30 requests / 60 seconds by ip_and_identity");
      expect(result.stdout.join("\n")).toContain("Size limits: 26214400 byte files, 1048576 byte text fields");
      expect(result.stdout.join("\n")).toContain("Required secrets: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY");
      expect(result.stdout.join("\n")).toContain("Write mode: pull_request");
      expect(result.stdout.join("\n")).toContain("Queued visibility: private");
      expect(result.stdout.join("\n")).toContain(".llm-wiki/upload/forms/remote-github.json");
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/upload/forms/remote-github.json"))).toBe(true);
      expect(docs).toContain("Authentication is required before accepting an upload.");
      expect(docs).toContain("Upload signatures bind the request method, path, body digest, and timestamp");
      expect(docs).toContain("Rate limiting is enabled by default: 30 requests per 60 seconds");
      expect(docs).toContain("The scaffold rejects unsupported file types and payloads larger than 26214400 bytes.");
      expect(docs).toContain("binary uploads such as PDFs from JSON `contentBase64` before hashing or writing raw originals");
      expect(docs).toContain("Secrets must come from environment variables only.");
      expect(docs).toContain("The default write mode is GitHub pull request, not direct commit.");
      expect(docs).toContain("Remote uploads are queued private raw inputs and are never published directly.");
      expect(backendReadme).toContain("Deploy this template behind your authenticated serverless provider.");
      expect(backendReadme).toContain("HMAC-SHA256 over timestamp, method, path, and body digest");
      expect(backendReadme).toContain("Binary payloads such as PDFs use base64 `contentBase64`");
      expect(authTemplate).toContain("export async function verifyUploadRequest");
      expect(authTemplate).toContain("process.env.LLM_WIKI_UPLOAD_SIGNING_SECRET");
      expect(authTemplate).toContain("const SIGNATURE_FRESHNESS_SECONDS = 300");
      expect(authTemplate).toContain("Upload signature timestamp is stale.");
      expect(authTemplate).toContain("bodyBytes: Uint8Array");
      expect(authTemplate).not.toContain("request.clone().arrayBuffer()");
      expect(authTemplate).toContain("body-sha256:");
      expect(authTemplate).toContain("method: request.method");
      expect(authTemplate).toContain("path: requestPath(request)");
      expect(rateLimitTemplate).toContain("maxRequests: 30");
      expect(rateLimitTemplate).toContain("windowSeconds: 60");
      expect(envExample).toContain("GITHUB_APP_PRIVATE_KEY=");
      expect(envExample).not.toContain("-----BEGIN");
      expect(githubTemplate).toContain("mode: \"pull_request\"");
      expect(githubTemplate).toContain("createPullRequest");
      expect(githubTemplate).not.toContain("directCommit");
    });
  });

  it("generates a raw upload handler that applies the remote upload safety flow", async () => {
    await withTempWorkspace("llm-wiki-upload-handler-flow-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["upload", "init", "--target", "github", "--repo", wikiDir, "--json"]);
      const rawUpload = await readGeneratedFile(wikiDir, "upload/github/serverless/raw-upload.ts");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(rawUpload).toContain("const rawBody = await readLimitedRequestBody(request, maxUploadRequestBodyBytes())");
      expect(rawUpload).toContain("await verifyUploadRequest(request, rawBody)");
      expect(rawUpload.indexOf("const rawBody")).toBeLessThan(rawUpload.indexOf("await verifyUploadRequest(request, rawBody)"));
      expect(rawUpload).toContain("await resolveUploaderIdentity(request)");
      expect(rawUpload).toContain("await assertWithinRateLimit(rateLimitKey(request, identity.id))");
      expect(rawUpload).toContain("uploadConfig.maxFileBytes");
      expect(rawUpload).toContain("uploadConfig.maxTextBytes");
      expect(rawUpload).toContain("const textUpload = isTextUpload(payload.mimeType, extension)");
      expect(rawUpload).toContain("const decodedContent = decodeUploadContent(payload, textUpload)");
      expect(rawUpload).toContain("const maxPayloadBytes = textUpload ? uploadConfig.maxTextBytes : uploadConfig.maxFileBytes");
      expect(rawUpload).toContain("if (decodedContent.bytes.byteLength > maxPayloadBytes)");
      expect(rawUpload).toContain("function maxUploadRequestBodyBytes(): number");
      expect(rawUpload).toContain("const encodedFileBytes = Math.ceil(uploadConfig.maxFileBytes / 3) * 4");
      expect(rawUpload).toContain("return maxPayloadBytes + 65536");
      expect(rawUpload).toContain("async function readLimitedRequestBody(request: Request, maxBytes: number): Promise<Buffer | null>");
      expect(rawUpload).toContain("if (!/^[0-9]+$/.test(trimmedContentLength))");
      expect(rawUpload).toContain("if (totalBytes > maxBytes)");
      expect(rawUpload).toContain("function isTextUpload(mimeType: string, extension: string): boolean");
      expect(rawUpload).toContain("const allowedMimeTypes: readonly string[] = uploadConfig.allowedMimeTypes");
      expect(rawUpload).toContain("const allowedExtensions: readonly string[] = uploadConfig.allowedExtensions");
      expect(rawUpload).toContain('typeof body.title !== "string"');
      expect(rawUpload).toContain("body.title.trim() === \"\"");
      expect(rawUpload).toContain('typeof body.filename !== "string"');
      expect(rawUpload).toContain('typeof body.mimeType !== "string"');
      expect(rawUpload).toContain("contentBase64?: string");
      expect(rawUpload).toContain("function decodeUploadContent(payload: RemoteUploadPayload, textUpload: boolean): DecodedUploadContent | null");
      expect(rawUpload).toContain("const decoded = decodeBase64Content(payload.contentBase64)");
      expect(rawUpload).toContain('encoding: "base64"');
      expect(rawUpload).toContain("invalid_upload");
      expect(rawUpload).toContain("unsupported_file_type");
      expect(rawUpload).toContain("const contentHash = contentHashFor(decodedContent.bytes)");
      expect(rawUpload).toContain("const sourceId = buildSourceId(payload.title, contentHash, capturedAt)");
      expect(rawUpload).toContain('slug.slice(0, 64).replace(/_+$/g, "")');
      expect(rawUpload).toContain("const sourceDir = `raw/inputs/${year}/${month}/${sourceId}`");
      expect(rawUpload).toContain("const originalPath = `${sourceDir}/original${extension}`");
      expect(rawUpload).toContain("const sourceCardPath = `${sourceDir}/_source.md`");
      expect(rawUpload).toContain("raw/queue/${sourceId}.json");
      expect(rawUpload).toContain("kind: sourceKind");
      expect(rawUpload).toContain("source_kind: sourceMetadata.source_kind");
      expect(rawUpload).toContain("origin: sourceMetadata.origin");
      expect(rawUpload).toContain("captured_at: sourceMetadata.captured_at");
      expect(rawUpload).toContain("content_hash: sourceMetadata.content_hash");
      expect(rawUpload).toContain("visibility: sourceMetadata.visibility");
      expect(rawUpload).toContain("path: sourceMetadata.path");
      expect(rawUpload).toContain("original_path: sourceMetadata.original_path");
      expect(rawUpload).toContain("content: decodedContent.content");
      expect(rawUpload).toContain("encoding: decodedContent.encoding");
      expect(rawUpload).toContain("type: raw_source");
      expect(rawUpload).toContain("source_kind: ${source.source_kind}");
      expect(rawUpload).toContain("content_hash: ${source.content_hash}");
      expect(rawUpload).toContain("Original file: [[${source.original_path}|");
      expect(rawUpload).toContain("await createQueuedRawUploadPullRequest");
      expect(rawUpload).toContain('write_mode: "pull_request"');
      expect(rawUpload).toContain("publish_directly: false");
      await expectGeneratedServerlessTypescriptCompiles(wikiDir);
    });
  });

  it("rejects unsupported remote upload targets without writing scaffold files", async () => {
    await withTempWorkspace("llm-wiki-upload-unsupported-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["upload", "init", "--target", "s3", "--repo", wikiDir, "--json"]);
      const payload = parseUploadFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error).toMatchObject({
        code: "UPLOAD_TARGET_UNSUPPORTED",
        message: "Unsupported remote upload target: s3.",
        hint: "Use llm-wiki upload init --target github.",
      });
      expect(payload.issues[0]).toMatchObject({
        severity: "error",
        code: "UPLOAD_TARGET_UNSUPPORTED",
        path: "--target",
      });
      expect(await pathExists(resolve(wikiDir, "docs/remote-upload-github.md"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/upload/forms/remote-github.json"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, "upload/github/serverless/raw-upload.ts"))).toBe(false);
    });
  });
});
