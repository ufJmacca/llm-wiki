import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { runAutoIngestWatch, type AutoIngestSourceResult } from "../src/autoIngest/index.js";
import { startUploadDaemon, UPLOAD_TOKEN_HEADER, type UploadCommitter, type UploadDaemon } from "../src/daemon/index.js";
import { syncQuartzContent } from "../src/quartz/index.js";
import { showQueueSource, transitionQueueStatus, type AutoIngestMetadata, type QueueStatus } from "../src/runtime/queue.js";
import { parseLogEntries } from "../src/scanner/index.js";
import {
  parseInitJson,
  pathExists,
  readGeneratedFile,
  readTreeSnapshot,
  runCliBuffered,
  withTempWorkspace,
} from "./helpers/init.js";

const execFileAsync = promisify(execFile);

type UploadSuccessEnvelope = {
  ok: true;
  data: {
    status: "added" | "duplicate";
    source_id: string;
    title: string;
    source_kind: "file" | "text" | "url";
    visibility: "private";
    queue_status: "queued" | "ingesting" | "ingested" | "blocked";
    queue_path: string;
    source_card_path: string;
    original_path: string;
    created_paths: string[];
    message: string;
    commit: {
      attempted: boolean;
      ok: boolean;
    };
    auto_ingest?: AutoIngestSourceResult;
  };
};

type UploadFailureEnvelope = {
  ok: false;
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

const ONE_MIB = 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TEST_AUTO_INGEST_NOW = "2999-06-30T10:00:00.000Z";
const UPLOAD_SUCCESS_AGENT_SOURCE = [
  `#!${process.execPath}`,
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const cwd = process.cwd();",
  "const prompt = fs.readFileSync(0, 'utf8') || process.argv[process.argv.length - 1] || '';",
  "const sourceId = prompt.match(/Source ID: (src_[^\\n]+)/)?.[1];",
  "if (!sourceId) {",
  "  console.error('missing source id');",
  "  process.exit(2);",
  "}",
  "if (!prompt.includes('Queue status: ingesting')) {",
  "  console.error('prompt was not rebuilt after queued -> ingesting');",
  "  process.exit(3);",
  "}",
  "const title = 'Daemon Auto Ingest ' + sourceId;",
  "const summary = [",
  "  '---',",
  "  'type: source_summary',",
  "  'title: ' + JSON.stringify(title),",
  "  'visibility: private',",
  "  'source_ids:',",
  "  '  - ' + sourceId,",
  "  'source_id: ' + sourceId,",
  "  '---',",
  "  '',",
  "  '# ' + title,",
  "  '',",
  "  'The daemon upload exercised the real shared worker.',",
  "  '',",
  "].join('\\n');",
  "const index = [",
  "  '---',",
  "  'type: index',",
  "  'title: Index',",
  "  'visibility: private',",
  "  'source_ids: []',",
  "  '---',",
  "  '',",
  "  '# Index',",
  "  '',",
  "  '- [[sources/' + sourceId + '|' + title + ']]',",
  "  '',",
  "].join('\\n');",
  "const existingLog = fs.readFileSync(path.join(cwd, 'curated/log.md'), 'utf8').trimEnd();",
  "const logEntry = [",
  "  '## [2999-06-30T09:59:00.000Z] ingest | ' + sourceId + ' | Agent ingest completed',",
  "  '',",
  "  '- actor: codex',",
  "  '- command: \"llm-wiki ingest ' + sourceId + ' --auto\"',",
  "  '- git_branch:',",
  "  '- git_commit:',",
  "  '- raw_source:',",
  "  '- created:',",
  "  '  - curated/sources/' + sourceId + '.md',",
  "  '- updated:',",
  "  '  - curated/index.md',",
  "  '- contradictions:',",
  "  '- follow_ups:',",
  "  '',",
  "].join('\\n');",
  "fs.mkdirSync(path.join(cwd, 'curated/sources'), { recursive: true });",
  "fs.writeFileSync(path.join(cwd, 'curated/sources', sourceId + '.md'), summary, 'utf8');",
  "fs.writeFileSync(path.join(cwd, 'curated/index.md'), index, 'utf8');",
  "fs.writeFileSync(path.join(cwd, 'curated/log.md'), existingLog + '\\n\\n' + logEntry, 'utf8');",
  "",
].join("\n");

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function initializeGitWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
  await execFileAsync("git", ["config", "user.name", "llm-wiki-test"], { cwd: targetDir });
  await execFileAsync("git", ["config", "user.email", "llm-wiki-test@example.invalid"], { cwd: targetDir });
}

async function gitCommitPaths(repoRoot: string, revision: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["show", "--format=", "--name-only", revision], { cwd: repoRoot });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

async function gitShow(repoRoot: string, revisionPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["show", revisionPath], { cwd: repoRoot });

  return stdout;
}

async function commitUploadWithGitForTest(
  request: Parameters<UploadCommitter>[0],
): Promise<Awaited<ReturnType<UploadCommitter>>> {
  const paths = [...new Set(request.paths)].sort();
  await execFileAsync("git", ["add", "--", ...paths], { cwd: request.repoRoot });
  await execFileAsync(
    "git",
    ["commit", "-m", `chore: upload raw source ${request.source_id}`, "--", ...paths],
    { cwd: request.repoRoot },
  );

  return {
    attempted: true,
    ok: true,
    committed_paths: paths,
  };
}

async function configureDefaultLocalAgent(wikiDir: string, command: string): Promise<void> {
  const configPath = resolve(wikiDir, ".llm-wiki/config.yml");
  const config = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    [
      config.replace("default: generic", "default: codex").trimEnd(),
      "agents:",
      "  codex:",
      "    type: local-exec",
      `    command: ${JSON.stringify(command)}`,
      "    timeout_seconds: 10",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function createExecutable(workspaceDir: string, fileName: string, source: string): Promise<string> {
  const binDir = resolve(workspaceDir, "bin");
  const executablePath = resolve(binDir, fileName);
  await mkdir(binDir, { recursive: true });
  await writeFile(executablePath, source, "utf8");
  await chmod(executablePath, 0o755);

  return executablePath;
}

async function uploadForm(daemon: UploadDaemon, form: FormData): Promise<{ status: number; body: UploadSuccessEnvelope }> {
  const result = await postUploadForm(daemon, form);

  return {
    status: result.status,
    body: result.body as UploadSuccessEnvelope,
  };
}

async function postUploadForm(
  daemon: UploadDaemon,
  form: FormData,
): Promise<{ status: number; body: UploadSuccessEnvelope | UploadFailureEnvelope }> {
  const response = await fetch(`${daemon.url}/api/raw-upload`, {
    method: "POST",
    headers: {
      [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
    },
    body: form,
  });

  return {
    status: response.status,
    body: await response.json() as UploadSuccessEnvelope | UploadFailureEnvelope,
  };
}

async function sendAbortedMultipartUpload(daemon: UploadDaemon): Promise<void> {
  const boundary = "----llm-wiki-aborted-upload";
  const partialBody = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="text"`,
    "",
    "Partial upload that never sends a final boundary.",
  ].join("\r\n");
  const request = [
    `POST ${daemon.uploadPath} HTTP/1.1`,
    `Host: ${daemon.host}:${daemon.port}`,
    `${UPLOAD_TOKEN_HEADER}: ${daemon.uploadToken}`,
    `Content-Type: multipart/form-data; boundary=${boundary}`,
    `Content-Length: ${Buffer.byteLength(partialBody) + 1024}`,
    "Connection: close",
    "",
    partialBody,
  ].join("\r\n");

  await new Promise<void>((resolveAbort, rejectAbort) => {
    const socket = createConnection({ host: daemon.host, port: daemon.port });
    let settled = false;
    let connected = false;

    const settle = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      if (error) {
        rejectAbort(error);
        return;
      }

      resolveAbort();
    };

    socket.once("connect", () => {
      connected = true;
      socket.write(request, () => {
        socket.destroy();
      });
    });
    socket.once("close", () => {
      settle();
    });
    socket.once("error", (error) => {
      settle(connected ? undefined : error);
    });
  });

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
}

function textUploadForm(title: string, text: string): FormData {
  const form = new FormData();
  form.set("title", title);
  form.set("text", text);

  return form;
}

function fileUploadForm(fileName: string, content: BlobPart, type: string): FormData {
  const form = new FormData();
  form.set("file", new Blob([content], { type }), fileName);

  return form;
}

function urlUploadForm(url: string, title?: string): FormData {
  const form = new FormData();
  if (title !== undefined) {
    form.set("title", title);
  }
  form.set("url", url);

  return form;
}

async function readQueueRecord(wikiDir: string, queuePath: string): Promise<{
  status: QueueStatus;
  auto_ingest?: AutoIngestMetadata;
}> {
  return JSON.parse(await readGeneratedFile(wikiDir, queuePath)) as {
    status: QueueStatus;
    auto_ingest?: AutoIngestMetadata;
  };
}

async function transitionForTest(
  wikiDir: string,
  sourceId: string,
  nextStatus: "ingesting" | "ingested" | "blocked",
): Promise<void> {
  const result = await transitionQueueStatus(wikiDir, sourceId, nextStatus, {
    now: new Date("2999-06-30T12:00:00.000Z"),
    command: `test transition ${sourceId} ${nextStatus}`,
  });

  expect(result.ok).toBe(true);
}

async function markDuplicateFixtureStatus(
  wikiDir: string,
  sourceId: string,
  status: "ingesting" | "ingested" | "blocked",
): Promise<void> {
  await transitionForTest(wikiDir, sourceId, "ingesting");
  if (status !== "ingesting") {
    await transitionForTest(wikiDir, sourceId, status);
  }
}

async function markAutoIngestedForTest(wikiDir: string, sourceId: string): Promise<AutoIngestMetadata> {
  const started = await transitionQueueStatus(wikiDir, sourceId, "ingesting", {
    now: new Date("2999-06-30T12:00:00.000Z"),
    command: `auto-ingest test ${sourceId}`,
    autoIngest: {
      enabled: true,
      result: "ingesting",
      errorCode: null,
      errorMessage: null,
    },
  });
  expect(started.ok).toBe(true);

  const completed = await transitionQueueStatus(wikiDir, sourceId, "ingested", {
    now: new Date("2999-06-30T12:01:00.000Z"),
    command: `auto-ingest test ${sourceId}`,
    autoIngest: {
      enabled: true,
      result: "ingested",
      errorCode: null,
      errorMessage: null,
    },
  });
  expect(completed.ok).toBe(true);

  const shown = await showQueueSource(wikiDir, sourceId);
  expect(shown.ok).toBe(true);
  if (!shown.ok || shown.value.queue_record.auto_ingest === undefined) {
    throw new Error(`Expected auto-ingest metadata for ${sourceId}.`);
  }

  return shown.value.queue_record.auto_ingest;
}

async function markAutoBlockedForTest(
  wikiDir: string,
  sourceId: string,
  code: string,
  message: string,
): Promise<AutoIngestMetadata> {
  const started = await transitionQueueStatus(wikiDir, sourceId, "ingesting", {
    now: new Date("2999-06-30T12:00:00.000Z"),
    command: `auto-ingest test ${sourceId}`,
    autoIngest: {
      enabled: true,
      result: "ingesting",
      errorCode: null,
      errorMessage: null,
    },
  });
  expect(started.ok).toBe(true);

  const blocked = await transitionQueueStatus(wikiDir, sourceId, "blocked", {
    now: new Date("2999-06-30T12:01:00.000Z"),
    command: `auto-ingest test ${sourceId}`,
    autoIngest: {
      enabled: true,
      result: "blocked",
      errorCode: code,
      errorMessage: message,
    },
  });
  expect(blocked.ok).toBe(true);

  const shown = await showQueueSource(wikiDir, sourceId);
  expect(shown.ok).toBe(true);
  if (!shown.ok || shown.value.queue_record.auto_ingest === undefined) {
    throw new Error(`Expected blocked auto-ingest metadata for ${sourceId}.`);
  }

  return shown.value.queue_record.auto_ingest;
}

async function successfulAutoIngestResult(wikiDir: string, sourceId: string): Promise<AutoIngestSourceResult> {
  const metadata = await markAutoIngestedForTest(wikiDir, sourceId);

  return {
    source_id: sourceId,
    previous_status: "queued",
    final_status: "ingested",
    outcome: "ingested",
    attempted: true,
    agent: "test-agent",
    applied_paths: [
      `curated/sources/${sourceId}.md`,
      "curated/index.md",
      "curated/log.md",
    ],
    auto_ingest: metadata,
    error: null,
  };
}

function expectSafeFailureEnvelope(
  payload: UploadFailureEnvelope,
  forbiddenValues: string[],
): void {
  const serialized = JSON.stringify(payload);

  for (const forbiddenValue of forbiddenValues) {
    expect(serialized).not.toContain(forbiddenValue);
  }
  expect(payload.error.message).not.toMatch(/\/tmp\/|\/workspace\/|[A-Z]:\\/);
  for (const issue of payload.issues) {
    expect(issue.message).not.toMatch(/\/tmp\/|\/workspace\/|[A-Z]:\\/);
    expect(issue.path).not.toMatch(/\/tmp\/|\/workspace\/|[A-Z]:\\/);
  }
}

function parseSourceCardFrontmatter<T>(content: string): T {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(frontmatter).not.toBeNull();

  return parse(frontmatter?.[1] ?? "") as T;
}

async function expectExplorerUploadProvenance(
  wikiDir: string,
  upload: { body: UploadSuccessEnvelope },
  sourceKind: "file" | "text" | "url",
): Promise<void> {
  const expectedCommand = `llm-wiki explore serve --with-daemon upload ${sourceKind}`;
  const sourceCard = await readGeneratedFile(wikiDir, upload.body.data.source_card_path);
  const runtimeLog = await readGeneratedFile(wikiDir, "curated/log.md");

  expect(sourceCard).not.toContain("llm-wiki daemon");
  expect(runtimeLog).not.toContain("llm-wiki daemon");
  expect(runtimeLog).toContain(upload.body.data.source_id);
  expect(runtimeLog).toContain(expectedCommand);
  expect(runtimeLog).toContain(`- raw_source: ${upload.body.data.source_card_path}`);
}

async function withTextServer(body: string, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(body);
  });
  await listen(server);

  try {
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Test server did not bind to a TCP port.");
    }

    await run(`http://127.0.0.1:${address.port}/source.txt`);
  } finally {
    await closeServer(server);
  }
}

async function withDeferredTextServer(
  body: string,
  run: (control: { url: string; waitForRequest: Promise<void>; release: () => void }) => Promise<void>,
): Promise<void> {
  let markRequestSeen = (): void => undefined;
  let releaseResponse = (): void => undefined;
  const waitForRequest = new Promise<void>((resolveRequest) => {
    markRequestSeen = resolveRequest;
  });
  const waitForRelease = new Promise<void>((resolveRelease) => {
    releaseResponse = resolveRelease;
  });
  const server = createServer((_request, response) => {
    markRequestSeen();
    void waitForRelease.then(() => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(body);
    });
  });
  await listen(server);

  try {
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Test server did not bind to a TCP port.");
    }

    await run({
      url: `http://127.0.0.1:${address.port}/source.txt`,
      waitForRequest,
      release: releaseResponse,
    });
  } finally {
    releaseResponse();
    await closeServer(server);
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
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

describe("local upload daemon", () => {
  it("generates a distinct non-secret upload session ID for each daemon run", async () => {
    await withTempWorkspace("llm-wiki-daemon-session-id-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      let firstDaemon: UploadDaemon | undefined;
      let secondDaemon: UploadDaemon | undefined;

      try {
        // Act
        firstDaemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });
        secondDaemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

        // Assert
        expect(firstDaemon.uploadSessionId).toMatch(/^upl_[a-f0-9]{16}$/);
        expect(secondDaemon.uploadSessionId).toMatch(/^upl_[a-f0-9]{16}$/);
        expect(firstDaemon.uploadSessionId).not.toBe(secondDaemon.uploadSessionId);
        expect(firstDaemon.uploadSessionId).not.toBe(firstDaemon.uploadToken);
        expect(secondDaemon.uploadSessionId).not.toBe(secondDaemon.uploadToken);
      } finally {
        await secondDaemon?.close();
        await firstDaemon?.close();
      }
    });
  });

  it("binds to 127.0.0.1 by default and captures multipart file uploads as private source artifacts", async () => {
    await withTempWorkspace("llm-wiki-daemon-file-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const fileContent = "# Meeting Notes\n\nPrivate upload body.\n";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        const form = new FormData();
        form.set("file", new Blob([fileContent], { type: "text/markdown" }), "Meeting Notes.md");

        // Act
        const upload = await uploadForm(daemon, form);
        const rawOriginalResponse = await fetch(`${daemon.url}/${upload.body.data.original_path}`);

        // Assert
        expect(daemon.host).toBe("127.0.0.1");
        expect(daemon.uploadSessionId).toMatch(/^upl_[a-f0-9]{16}$/);
        expect(daemon.uploadSessionId).not.toBe(daemon.uploadToken);
        expect(upload.status).toBe(201);
        expect(upload.body).toMatchObject({
          ok: true,
          data: {
            status: "added",
            title: "Meeting Notes",
            source_kind: "file",
            visibility: "private",
            queue_status: "queued",
            commit: {
              attempted: false,
              ok: true,
            },
          },
        });
        expect(upload.body.data.message).toBe("Raw source uploaded and queued for ingest.");
        expect(upload.body.data.source_id).toMatch(/^src_\d{4}_\d{2}_\d{2}_meeting_notes_[a-f0-9]{12}$/);
        expect(upload.body.data.original_path).toMatch(/raw\/inputs\/\d{4}\/\d{2}\/.+\/original\.md$/);
        expect(upload.body.data.source_card_path).toBe(upload.body.data.original_path.replace(/original\.md$/, "_source.md"));
        expect(upload.body.data.queue_path).toBe(`raw/queue/${upload.body.data.source_id}.json`);
        expect(upload.body.data.created_paths).toEqual([
          upload.body.data.original_path,
          upload.body.data.source_card_path,
          upload.body.data.queue_path,
        ]);
        expect(await readGeneratedFile(wikiDir, upload.body.data.original_path)).toBe(fileContent);
        expect(JSON.parse(await readGeneratedFile(wikiDir, upload.body.data.queue_path))).toMatchObject({
          source_id: upload.body.data.source_id,
          title: "Meeting Notes",
          source_kind: "file",
          origin: "local-upload:Meeting Notes.md",
          uploader: "local",
          upload_session_id: daemon.uploadSessionId,
          uploaded_via: "local-explorer",
          visibility: "private",
          status: "queued",
          path: upload.body.data.source_card_path,
          original_path: upload.body.data.original_path,
        });
        expect(parseSourceCardFrontmatter(await readGeneratedFile(wikiDir, upload.body.data.source_card_path))).toMatchObject({
          source_id: upload.body.data.source_id,
          title: "Meeting Notes",
          source_kind: "file",
          origin: "local-upload:Meeting Notes.md",
          uploader: "local",
          upload_session_id: daemon.uploadSessionId,
          uploaded_via: "local-explorer",
          visibility: "private",
          status: "queued",
        });
        await expectExplorerUploadProvenance(wikiDir, upload, "file");
        expect(rawOriginalResponse.status).toBe(404);
      } finally {
        await daemon.close();
      }
    });
  });

  it("reports a concrete reachable URL when localhost is requested", async () => {
    await withTempWorkspace("llm-wiki-daemon-localhost-url-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, host: "localhost", port: 0 });

      try {
        // Act
        const upload = await uploadForm(daemon, textUploadForm("Localhost Upload", "Localhost upload body.\n"));

        // Assert
        expect(daemon.host).toBe("localhost");
        expect(daemon.url).toMatch(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+$/);
        expect(upload.status).toBe(201);
        expect(upload.body.data).toMatchObject({
          status: "added",
          title: "Localhost Upload",
          source_kind: "text",
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it("handles loopback browser CORS preflight and exposes structured upload errors", async () => {
    await withTempWorkspace("llm-wiki-daemon-cors-loopback-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const origins = [
        "http://127.0.0.1:8080",
        "http://127.0.0.1:49152",
        "http://localhost:3000",
        "http://localhost:8080",
        "http://[::1]:43210",
        "http://[::1]:8080",
      ];
      const origin = origins[0] ?? "http://127.0.0.1:8080";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        const form = new FormData();
        form.set("title", "CORS Upload");
        form.set("text", "CORS upload body.\n");

        // Act
        const preflights = await Promise.all(origins.map(async (allowedOrigin) => ({
          origin: allowedOrigin,
          response: await fetch(`${daemon.url}/api/raw-upload`, {
            method: "OPTIONS",
            headers: {
              Origin: allowedOrigin,
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": UPLOAD_TOKEN_HEADER,
            },
          }),
        })));
        const rejectedUpload = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            Origin: origin,
            [UPLOAD_TOKEN_HEADER]: "invalid-token",
          },
          body: form,
        });
        const rejectedBody = await rejectedUpload.json() as UploadFailureEnvelope;

        // Assert
        for (const { origin: allowedOrigin, response } of preflights) {
          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
          expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
          const allowedHeaders = response.headers.get("access-control-allow-headers")
            ?.split(",")
            .map((header) => header.trim().toLowerCase()) ?? [];
          expect(allowedHeaders).toContain(UPLOAD_TOKEN_HEADER);
          expect(allowedHeaders).toContain("content-type");
          expect(response.headers.get("access-control-max-age")).toBe("600");
          expect(response.headers.get("vary")).toContain("Origin");
        }
        expect(rejectedUpload.status).toBe(403);
        expect(rejectedUpload.headers.get("access-control-allow-origin")).toBe(origin);
        expect(rejectedBody).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_AUTH_FAILED",
          },
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it("does not approve non-loopback browser origins", async () => {
    await withTempWorkspace("llm-wiki-daemon-cors-non-loopback-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        // Act
        const preflight = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "OPTIONS",
          headers: {
            Origin: "https://example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": UPLOAD_TOKEN_HEADER,
          },
        });
        const body = await preflight.json() as UploadFailureEnvelope;

        // Assert
        expect(preflight.status).toBe(403);
        expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
        expect(body).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_ORIGIN_NOT_ALLOWED",
          },
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it("rejects non-POST raw upload requests with a stable method error envelope", async () => {
    await withTempWorkspace("llm-wiki-daemon-method-not-allowed-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "GET",
          headers: {
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
        });
        const payload = await response.json() as UploadFailureEnvelope;
        const queueFiles = (await readdir(resolve(wikiDir, "raw/queue"))).filter((entry) => entry.endsWith(".json"));

        // Assert
        expect(response.status).toBe(405);
        expect(payload).toEqual({
          ok: false,
          error: {
            code: "UPLOAD_METHOD_NOT_ALLOWED",
            message: "Raw uploads must use POST.",
            hint: "Send a multipart/form-data POST request to /api/raw-upload.",
          },
          issues: [
            {
              severity: "error",
              code: "UPLOAD_METHOD_NOT_ALLOWED",
              message: "Raw uploads must use POST.",
              path: "/api/raw-upload",
              hint: "Send a multipart/form-data POST request to /api/raw-upload.",
            },
          ],
        });
        expect(queueFiles).toEqual([]);
      } finally {
        await daemon.close();
      }
    });
  });

  it("captures multipart text notes and reports duplicate uploads without writing new artifacts", async () => {
    await withTempWorkspace("llm-wiki-daemon-text-duplicate-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const text = "Private pasted upload note.\n";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        const form = new FormData();
        form.set("title", "Upload Note");
        form.set("text", text);

        // Act
        const firstUpload = await uploadForm(daemon, form);
        const beforeDuplicate = await readTreeSnapshot(wikiDir);
        const secondUpload = await uploadForm(daemon, form);
        const afterDuplicate = await readTreeSnapshot(wikiDir);
        const sourceCard = parseSourceCardFrontmatter(await readGeneratedFile(wikiDir, firstUpload.body.data.source_card_path));
        const queueItem = JSON.parse(await readGeneratedFile(wikiDir, firstUpload.body.data.queue_path));

        // Assert
        expect(firstUpload.status).toBe(201);
        expect(secondUpload.status).toBe(200);
        expect(firstUpload.body.data).not.toHaveProperty("auto_ingest");
        expect(secondUpload.body.data).not.toHaveProperty("auto_ingest");
        expect(firstUpload.body.data).toMatchObject({
          status: "added",
          title: "Upload Note",
          source_kind: "text",
          visibility: "private",
        });
        expect(secondUpload.body.data).toMatchObject({
          status: "duplicate",
          source_id: firstUpload.body.data.source_id,
          title: "Upload Note",
          source_kind: "text",
          visibility: "private",
          original_path: firstUpload.body.data.original_path,
          source_card_path: firstUpload.body.data.source_card_path,
          queue_path: firstUpload.body.data.queue_path,
        });
        expect(secondUpload.body.data.message).toBe("Raw source was already captured; no new artifacts were created.");
        expect(secondUpload.body.data.created_paths).toEqual([]);
        expect(sourceCard).toMatchObject({
          origin: "local-upload:text",
          uploader: "local",
          upload_session_id: daemon.uploadSessionId,
          uploaded_via: "local-explorer",
        });
        expect(queueItem).toMatchObject({
          origin: "local-upload:text",
          uploader: "local",
          upload_session_id: daemon.uploadSessionId,
          uploaded_via: "local-explorer",
        });
        expect(afterDuplicate).toEqual(beforeDuplicate);
        expect((await readGeneratedFile(wikiDir, firstUpload.body.data.original_path)).replaceAll("\r\n", "\n")).toBe(text);
        await expectExplorerUploadProvenance(wikiDir, firstUpload, "text");
      } finally {
        await daemon.close();
      }
    });
  });

  it("runs upload auto-ingest after raw commit for text, file, and URL captures without committing curated output", async () => {
    await withTempWorkspace("llm-wiki-daemon-auto-ingest-success-", async (workspaceDir) => {
      await withTextServer("Auto-ingest remote upload body.\n", async (url) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        const events: string[] = [];
        const commitUpload = vi.fn<UploadCommitter>(async (request) => {
          events.push(`commit:${request.source_id}`);

          return {
            attempted: true,
            ok: true,
            committed_paths: request.paths,
          };
        });
        const autoIngest = vi.fn(async (request: {
          repoRoot: string;
          source_id: string;
          capture: { status: "added" | "duplicate" };
          commit: { attempted: boolean; ok: boolean };
        }) => {
          events.push(`auto:${request.source_id}`);
          expect(request.repoRoot).toBe(wikiDir);
          expect(request.capture.status).toBe("added");
          expect(request.commit).toMatchObject({
            attempted: true,
            ok: true,
          });

          return successfulAutoIngestResult(wikiDir, request.source_id);
        });
        await initializeWiki(wikiDir);
        const daemon = await startUploadDaemon({
          repoRoot: wikiDir,
          port: 0,
          commitUploads: true,
          commitUpload,
          autoIngest: {
            enabled: true,
            run: autoIngest,
          },
        });

        try {
          const uploads = [
            () => uploadForm(daemon, textUploadForm("Auto Text", "Auto-ingest text upload body.\n")),
            () => uploadForm(daemon, fileUploadForm("auto-file.md", "# Auto File\n", "text/markdown")),
            () => uploadForm(daemon, urlUploadForm(url, "Auto URL")),
          ];

          // Act
          const results = [];
          for (const upload of uploads) {
            results.push(await upload());
          }

          // Assert
          expect(results).toHaveLength(3);
          expect(commitUpload).toHaveBeenCalledTimes(3);
          expect(autoIngest).toHaveBeenCalledTimes(3);
          expect(events).toEqual(results.flatMap((upload) => [
            `commit:${upload.body.data.source_id}`,
            `auto:${upload.body.data.source_id}`,
          ]));
          for (const upload of results) {
            expect(upload.status).toBe(201);
            expect(upload.body.data).toMatchObject({
              status: "added",
              queue_status: "ingested",
              commit: {
                attempted: true,
                ok: true,
              },
              auto_ingest: {
                source_id: upload.body.data.source_id,
                previous_status: "queued",
                final_status: "ingested",
                outcome: "ingested",
                attempted: true,
                agent: "test-agent",
                error: null,
              },
            });
            await expect(readQueueRecord(wikiDir, upload.body.data.queue_path)).resolves.toMatchObject({
              status: "ingested",
              auto_ingest: upload.body.data.auto_ingest?.auto_ingest,
            });
          }
          for (const call of commitUpload.mock.calls) {
            const request = call[0];
            expect(request.paths).toEqual(expect.arrayContaining(["curated/log.md"]));
            expect(request.paths).not.toContain("curated/index.md");
            expect(request.paths).not.toContain(`curated/sources/${request.source_id}.md`);
          }
        } finally {
          await daemon.close();
        }
      });
    });
  });

  it("runs upload auto-ingest through the configured default local agent and shared worker", async () => {
    await withTempWorkspace("llm-wiki-daemon-auto-ingest-default-agent-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const rawBody = "Auto-ingest with a configured default local agent.\n";
      await initializeWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "upload-success-agent", UPLOAD_SUCCESS_AGENT_SOURCE);
      await configureDefaultLocalAgent(wikiDir, executablePath);
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        autoIngest: {
          enabled: true,
          now: () => new Date(TEST_AUTO_INGEST_NOW),
        },
      });

      try {
        // Act
        const upload = await uploadForm(daemon, textUploadForm("Default Agent Upload", rawBody));
        const queueRecord = await readQueueRecord(wikiDir, upload.body.data.queue_path);
        const sourceCard = parseSourceCardFrontmatter<{
          source_id: string;
          status: QueueStatus;
          auto_ingest?: AutoIngestMetadata;
        }>(await readGeneratedFile(wikiDir, upload.body.data.source_card_path));
        const curatedSummary = await readGeneratedFile(
          wikiDir,
          `curated/sources/${upload.body.data.source_id}.md`,
        );
        const curatedIndex = await readGeneratedFile(wikiDir, "curated/index.md");
        const runtimeLog = await readGeneratedFile(wikiDir, "curated/log.md");
        const parsedLog = parseLogEntries({ path: "curated/log.md", content: runtimeLog });
        const sourceLogEntries = parsedLog.entries.filter((entry) => entry.affectedId === upload.body.data.source_id);

        // Assert
        expect(upload.status).toBe(201);
        expect(upload.body).toMatchObject({
          ok: true,
          data: {
            status: "added",
            queue_status: "ingested",
            auto_ingest: {
              source_id: upload.body.data.source_id,
              previous_status: "queued",
              final_status: "ingested",
              outcome: "ingested",
              attempted: true,
              agent: "codex",
              applied_paths: [
                "curated/index.md",
                "curated/log.md",
                `curated/sources/${upload.body.data.source_id}.md`,
              ],
              auto_ingest: {
                enabled: true,
                attempt_count: 1,
                last_attempt_at: TEST_AUTO_INGEST_NOW,
                last_result: "ingested",
                last_error_code: null,
                last_error_message: null,
              },
              error: null,
            },
          },
        });
        expect(queueRecord).toMatchObject({
          status: "ingested",
          auto_ingest: upload.body.data.auto_ingest?.auto_ingest,
        });
        expect(sourceCard).toMatchObject({
          source_id: upload.body.data.source_id,
          status: "ingested",
          auto_ingest: upload.body.data.auto_ingest?.auto_ingest,
        });
        expect(sourceCard.auto_ingest).toEqual(queueRecord.auto_ingest);
        expect(curatedSummary).toContain(`source_id: ${upload.body.data.source_id}`);
        expect(curatedSummary).toContain("The daemon upload exercised the real shared worker.");
        expect(curatedIndex).toContain(`sources/${upload.body.data.source_id}`);
        expect((await readGeneratedFile(wikiDir, upload.body.data.original_path)).replaceAll("\r\n", "\n")).toBe(rawBody);
        expect(parsedLog.issues).toEqual([]);
        expect(sourceLogEntries.map((entry) => entry.title)).toEqual([
          "Default Agent Upload",
          "Status changed to ingesting",
          "Agent ingest completed",
          "Status changed to ingested",
        ]);
        expect(sourceLogEntries.find((entry) => entry.title === "Status changed to ingesting")?.body).toContain(
          "- status: queued -> ingesting",
        );
        expect(sourceLogEntries.find((entry) => entry.title === "Status changed to ingested")?.body).toContain(
          "- status: ingesting -> ingested",
        );
      } finally {
        await daemon.close();
      }
    });
  });

  it("does not sweep stale auto-ingest log entries into later raw upload commits", async () => {
    await withTempWorkspace("llm-wiki-daemon-auto-ingest-stale-log-commit-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeGitWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "upload-stale-log-agent", UPLOAD_SUCCESS_AGENT_SOURCE);
      await configureDefaultLocalAgent(wikiDir, executablePath);
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        commitUploads: true,
        autoIngest: {
          enabled: true,
          now: () => new Date(TEST_AUTO_INGEST_NOW),
        },
      });

      try {
        // Act
        const firstUpload = await uploadForm(
          daemon,
          textUploadForm("First Auto Commit", "First auto-ingest commit body.\n"),
        );
        const firstCommitPaths = await gitCommitPaths(wikiDir, "HEAD");
        const firstCommittedLog = await gitShow(wikiDir, "HEAD:curated/log.md");
        const secondUpload = await uploadForm(
          daemon,
          textUploadForm("Second Auto Commit", "Second auto-ingest commit body.\n"),
        );
        const secondCommitPaths = await gitCommitPaths(wikiDir, "HEAD");
        const secondCommittedLog = await gitShow(wikiDir, "HEAD:curated/log.md");

        // Assert
        expect(firstUpload.status).toBe(201);
        expect(secondUpload.status).toBe(201);
        expect(firstCommitPaths).toContain("curated/log.md");
        expect(firstCommittedLog).toContain(firstUpload.body.data.source_id);
        expect(firstCommittedLog).not.toContain("Agent ingest completed");
        expect(secondCommitPaths).not.toContain("curated/log.md");
        expect(secondCommittedLog).toBe(firstCommittedLog);
        expect(secondCommittedLog).not.toContain("Agent ingest completed");
        expect(secondCommitPaths).toEqual(expect.arrayContaining([
          secondUpload.body.data.original_path,
          secondUpload.body.data.source_card_path,
          secondUpload.body.data.queue_path,
        ]));
      } finally {
        await daemon.close();
      }
    });
  });

  it("keeps raw upload commits isolated while a queue auto-ingest watcher observes the new source", async () => {
    await withTempWorkspace("llm-wiki-daemon-watch-race-raw-commit-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeGitWiki(wikiDir);
      const executablePath = await createExecutable(workspaceDir, "upload-watch-race-agent", UPLOAD_SUCCESS_AGENT_SOURCE);
      await configureDefaultLocalAgent(wikiDir, executablePath);

      let watchResult: AutoIngestSourceResult | null = null;
      const commitUpload = vi.fn<UploadCommitter>(async (request) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_000);

        try {
          const summary = await runAutoIngestWatch({
            repoRoot: request.repoRoot,
            command: "llm-wiki queue ingest --auto --watch",
            lock: {
              timeoutMs: 0,
              retryDelayMs: 0,
            },
            pollIntervalMs: 5,
            signal: controller.signal,
            onEvent: (event) => {
              if (event.event === "result") {
                watchResult = event.result;
                controller.abort();
              }
            },
          });

          expect(summary.counts.selected).toBe(1);
        } finally {
          clearTimeout(timeout);
        }

        return commitUploadWithGitForTest(request);
      });
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        commitUploads: true,
        commitUpload,
      });

      try {
        // Act
        const upload = await uploadForm(
          daemon,
          textUploadForm("Watcher Race Upload", "Watcher race raw upload body.\n"),
        );
        const commitPaths = await gitCommitPaths(wikiDir, "HEAD");
        const committedQueue = JSON.parse(await gitShow(wikiDir, `HEAD:${upload.body.data.queue_path}`)) as {
          status: QueueStatus;
          auto_ingest?: AutoIngestMetadata;
        };
        const committedSourceCard = parseSourceCardFrontmatter<{
          status: QueueStatus;
          auto_ingest?: AutoIngestMetadata;
        }>(await gitShow(wikiDir, `HEAD:${upload.body.data.source_card_path}`));
        const committedLog = await gitShow(wikiDir, "HEAD:curated/log.md");

        // Assert
        expect(upload.status).toBe(201);
        expect(upload.body.data).toMatchObject({
          status: "added",
          queue_status: "queued",
          commit: {
            attempted: true,
            ok: true,
          },
        });
        expect(commitUpload).toHaveBeenCalledTimes(1);
        expect(watchResult).toMatchObject({
          source_id: upload.body.data.source_id,
          previous_status: "queued",
          final_status: "queued",
          outcome: "deferred",
          attempted: false,
          error: {
            code: "INGEST_LOCK_BUSY",
          },
        });
        expect(commitPaths).toEqual(expect.arrayContaining([
          upload.body.data.original_path,
          upload.body.data.source_card_path,
          upload.body.data.queue_path,
          "curated/log.md",
        ]));
        expect(commitPaths).not.toContain("curated/index.md");
        expect(commitPaths).not.toContain(`curated/sources/${upload.body.data.source_id}.md`);
        expect(committedQueue).toMatchObject({ status: "queued" });
        expect(committedQueue).not.toHaveProperty("auto_ingest");
        expect(committedSourceCard).toMatchObject({ status: "queued" });
        expect(committedSourceCard).not.toHaveProperty("auto_ingest");
        expect(committedLog).toContain("Watcher Race Upload");
        expect(committedLog).not.toContain("Status changed to ingesting");
        expect(committedLog).not.toContain("Agent ingest completed");
      } finally {
        await daemon.close();
      }
    });
  });

  it("returns a safe skipped auto-ingest result when the default agent is missing after capture", async () => {
    await withTempWorkspace("llm-wiki-daemon-auto-ingest-missing-agent-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        autoIngest: {
          enabled: true,
        },
      });

      try {
        // Act
        const upload = await uploadForm(daemon, textUploadForm("Missing Agent", "Missing agent capture body.\n"));
        const queueRecord = await readQueueRecord(wikiDir, upload.body.data.queue_path);

        // Assert
        expect(upload.status).toBe(201);
        expect(upload.body).toMatchObject({
          ok: true,
          data: {
            status: "added",
            queue_status: "queued",
            auto_ingest: {
              source_id: upload.body.data.source_id,
              previous_status: "queued",
              final_status: "queued",
              outcome: "skipped",
              attempted: false,
              agent: null,
              applied_paths: [],
              auto_ingest: null,
              error: {
                code: "AGENT_CONFIG_MISSING",
                path: ".llm-wiki/config.yml:agents.generic",
              },
            },
          },
        });
        expect(queueRecord).toMatchObject({
          status: "queued",
        });
        expect(queueRecord).not.toHaveProperty("auto_ingest");
      } finally {
        await daemon.close();
      }
    });
  });

  it("re-reads queue status when upload auto-ingest throws after starting an attempt", async () => {
    await withTempWorkspace("llm-wiki-daemon-auto-ingest-thrown-after-start-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const autoIngest = vi.fn(async (request: { source_id: string }): Promise<AutoIngestSourceResult> => {
        const started = await transitionQueueStatus(wikiDir, request.source_id, "ingesting", {
          now: new Date("2999-06-30T12:00:00.000Z"),
          command: `auto-ingest test ${request.source_id}`,
          autoIngest: {
            enabled: true,
            result: "ingesting",
            errorCode: null,
            errorMessage: null,
          },
        });
        expect(started.ok).toBe(true);

        throw new Error("auto-ingest failed after start transition");
      });
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        autoIngest: {
          enabled: true,
          run: autoIngest,
        },
      });

      try {
        // Act
        const upload = await uploadForm(
          daemon,
          textUploadForm("Thrown After Start", "Auto-ingest throw after start body.\n"),
        );
        const queueRecord = await readQueueRecord(wikiDir, upload.body.data.queue_path);

        // Assert
        expect(upload.status).toBe(201);
        expect(upload.body).toMatchObject({
          ok: true,
          data: {
            status: "added",
            queue_status: "ingesting",
            auto_ingest: {
              source_id: upload.body.data.source_id,
              previous_status: "queued",
              final_status: "ingesting",
              outcome: "skipped",
              applied_paths: [],
              auto_ingest: queueRecord.auto_ingest,
              error: {
                code: "AUTO_INGEST_FAILED",
              },
            },
          },
        });
        expect(queueRecord).toMatchObject({
          status: "ingesting",
          auto_ingest: {
            enabled: true,
            attempt_count: 1,
            last_result: "ingesting",
            last_error_code: null,
            last_error_message: null,
          },
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it.each([
    {
      name: "agent failure",
      outcome: "blocked",
      finalStatus: "blocked",
      code: "AGENT_COMMAND_FAILED",
    },
    {
      name: "validation failure",
      outcome: "blocked",
      finalStatus: "blocked",
      code: "INGEST_VALIDATION_FAILED",
    },
    {
      name: "busy ingest lock",
      outcome: "deferred",
      finalStatus: "queued",
      code: "INGEST_LOCK_BUSY",
    },
  ] as const)("keeps upload success and raw capture artifacts when auto-ingest reports $name", async (scenario) => {
    await withTempWorkspace(`llm-wiki-daemon-auto-ingest-${scenario.code.toLowerCase()}-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const rawBody = `Auto-ingest ${scenario.name} raw body.\n`;
      await initializeWiki(wikiDir);
      const autoIngest = vi.fn(async (request: { source_id: string }): Promise<AutoIngestSourceResult> => {
        const error = {
          code: scenario.code,
          message: `${scenario.name} without raw rollback`,
          path: `raw/queue/${request.source_id}.json`,
          hint: "Review the auto-ingest failure and retry manually.",
        };
        const metadata = scenario.finalStatus === "blocked"
          ? await markAutoBlockedForTest(wikiDir, request.source_id, scenario.code, error.message)
          : null;

        return {
          source_id: request.source_id,
          previous_status: "queued",
          final_status: scenario.finalStatus,
          outcome: scenario.outcome,
          attempted: scenario.finalStatus === "blocked",
          agent: "test-agent",
          applied_paths: [],
          auto_ingest: metadata,
          error,
        };
      });
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        autoIngest: {
          enabled: true,
          run: autoIngest,
        },
      });

      try {
        // Act
        const upload = await uploadForm(daemon, textUploadForm(`Auto ${scenario.name}`, rawBody));
        const original = await readGeneratedFile(wikiDir, upload.body.data.original_path);
        const queueRecord = await readQueueRecord(wikiDir, upload.body.data.queue_path);

        // Assert
        expect(upload.status).toBe(201);
        expect(upload.body).toMatchObject({
          ok: true,
          data: {
            status: "added",
            queue_status: scenario.finalStatus,
            auto_ingest: {
              source_id: upload.body.data.source_id,
              previous_status: "queued",
              final_status: scenario.finalStatus,
              outcome: scenario.outcome,
              applied_paths: [],
              error: {
                code: scenario.code,
              },
            },
          },
        });
        expect(original.replaceAll("\r\n", "\n")).toBe(rawBody);
        expect(queueRecord.status).toBe(scenario.finalStatus);
        if (scenario.finalStatus === "queued") {
          expect(queueRecord).not.toHaveProperty("auto_ingest");
        } else {
          expect(queueRecord.auto_ingest).toMatchObject({
            attempt_count: 1,
            last_result: "blocked",
            last_error_code: scenario.code,
          });
        }
      } finally {
        await daemon.close();
      }
    });
  });

  it("auto-ingests an existing queued duplicate through the normal queued status transitions", async () => {
    await withTempWorkspace("llm-wiki-daemon-auto-ingest-queued-duplicate-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const text = "Queued duplicate auto-ingest body.\n";
      await initializeWiki(wikiDir);
      const captureDaemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });
      const firstUpload = await uploadForm(captureDaemon, textUploadForm("Queued Duplicate", text));
      await captureDaemon.close();
      const autoIngest = vi.fn(async (request: {
        source_id: string;
        capture: { status: "added" | "duplicate" };
      }) => {
        expect(request.capture.status).toBe("duplicate");

        return successfulAutoIngestResult(wikiDir, request.source_id);
      });
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        autoIngest: {
          enabled: true,
          run: autoIngest,
        },
      });

      try {
        // Act
        const duplicate = await uploadForm(daemon, textUploadForm("Queued Duplicate", text));
        const queueRecord = await readQueueRecord(wikiDir, firstUpload.body.data.queue_path);

        // Assert
        expect(duplicate.status).toBe(200);
        expect(duplicate.body.data).toMatchObject({
          status: "duplicate",
          source_id: firstUpload.body.data.source_id,
          queue_status: "ingested",
          created_paths: [],
          auto_ingest: {
            source_id: firstUpload.body.data.source_id,
            previous_status: "queued",
            final_status: "ingested",
            outcome: "ingested",
            attempted: true,
          },
        });
        expect(autoIngest).toHaveBeenCalledTimes(1);
        expect(queueRecord).toMatchObject({
          status: "ingested",
          auto_ingest: duplicate.body.data.auto_ingest?.auto_ingest,
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it.each([
    {
      status: "ingested",
      outcome: "skipped",
      expectedHint: "already ingested",
    },
    {
      status: "blocked",
      outcome: "skipped",
      expectedHint: "manual retry",
    },
    {
      status: "ingesting",
      outcome: "deferred",
      expectedHint: "already processing",
    },
  ] as const)("skips duplicate $status sources without starting a parallel auto-ingest attempt", async (scenario) => {
    await withTempWorkspace(`llm-wiki-daemon-auto-ingest-${scenario.status}-duplicate-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const text = `Duplicate ${scenario.status} body.\n`;
      await initializeWiki(wikiDir);
      const captureDaemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });
      const firstUpload = await uploadForm(captureDaemon, textUploadForm(`Duplicate ${scenario.status}`, text));
      await captureDaemon.close();
      await markDuplicateFixtureStatus(wikiDir, firstUpload.body.data.source_id, scenario.status);
      const beforeDuplicate = await readTreeSnapshot(wikiDir);
      const autoIngest = vi.fn(async () => successfulAutoIngestResult(wikiDir, firstUpload.body.data.source_id));
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        autoIngest: {
          enabled: true,
          run: autoIngest,
        },
      });

      try {
        // Act
        const duplicate = await uploadForm(daemon, textUploadForm(`Duplicate ${scenario.status}`, text));
        const afterDuplicate = await readTreeSnapshot(wikiDir);

        // Assert
        expect(duplicate.status).toBe(200);
        expect(duplicate.body.data).toMatchObject({
          status: "duplicate",
          source_id: firstUpload.body.data.source_id,
          queue_status: scenario.status,
          created_paths: [],
          auto_ingest: {
            source_id: firstUpload.body.data.source_id,
            previous_status: scenario.status,
            final_status: scenario.status,
            outcome: scenario.outcome,
            attempted: false,
            agent: null,
            applied_paths: [],
            error: {
              code: "AUTO_INGEST_SOURCE_NOT_ELIGIBLE",
            },
          },
        });
        expect(duplicate.body.data.auto_ingest?.error?.hint).toContain(scenario.expectedHint);
        expect(autoIngest).not.toHaveBeenCalled();
        expect(afterDuplicate).toEqual(beforeDuplicate);
      } finally {
        await daemon.close();
      }
    });
  });

  it("serializes concurrent duplicate text uploads so one source is created", async () => {
    await withTempWorkspace("llm-wiki-daemon-concurrent-duplicate-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const text = "Concurrent private upload note.\n";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        // Act
        const uploads = await Promise.all(
          Array.from({ length: 6 }, () => uploadForm(daemon, textUploadForm("Concurrent Upload", text))),
        );
        const addedUploads = uploads.filter((upload) => upload.status === 201);
        const duplicateUploads = uploads.filter((upload) => upload.status === 200);
        const queueFiles = (await readdir(resolve(wikiDir, "raw/queue"))).filter((entry) => entry.endsWith(".json"));

        // Assert
        expect(uploads.every((upload) => upload.body.ok)).toBe(true);
        expect(addedUploads).toHaveLength(1);
        expect(duplicateUploads).toHaveLength(5);
        expect(new Set(uploads.map((upload) => upload.body.data.source_id)).size).toBe(1);
        expect(addedUploads[0]?.body.data.created_paths).toHaveLength(3);
        expect(duplicateUploads.every((upload) => upload.body.data.created_paths.length === 0)).toBe(true);
        expect(queueFiles).toHaveLength(1);
      } finally {
        await daemon.close();
      }
    });
  });

  it("releases the per-repository upload queue after an interrupted multipart request", async () => {
    await withTempWorkspace("llm-wiki-daemon-aborted-upload-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        // Act
        await sendAbortedMultipartUpload(daemon);
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: textUploadForm("After Abort", "Upload after an interrupted request.\n"),
          signal: AbortSignal.timeout(2_000),
        });
        const payload = await response.json() as UploadSuccessEnvelope;

        // Assert
        expect(response.status).toBe(201);
        expect(payload).toMatchObject({
          ok: true,
          data: {
            status: "added",
            title: "After Abort",
            source_kind: "text",
          },
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it("does not hold the per-repository upload queue while a URL payload is fetched", async () => {
    await withTempWorkspace("llm-wiki-daemon-url-queue-", async (workspaceDir) => {
      await withDeferredTextServer("Slow remote upload body.\n", async ({ url, waitForRequest, release }) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });
        let slowUpload: Promise<{ status: number; body: UploadSuccessEnvelope | UploadFailureEnvelope }> | undefined;

        try {
          const slowForm = new FormData();
          slowForm.set("title", "Slow Remote Upload");
          slowForm.set("url", url);
          slowUpload = postUploadForm(daemon, slowForm);
          await waitForRequest;

          // Act
          const fastResponse = await fetch(`${daemon.url}/api/raw-upload`, {
            method: "POST",
            headers: {
              [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
            },
            body: textUploadForm("Fast Upload", "Fast upload body.\n"),
            signal: AbortSignal.timeout(1_000),
          });
          const fastPayload = await fastResponse.json() as UploadSuccessEnvelope;
          release();
          const slowPayload = await slowUpload;

          // Assert
          expect(fastResponse.status).toBe(201);
          expect(fastPayload).toMatchObject({
            ok: true,
            data: {
              status: "added",
              title: "Fast Upload",
              source_kind: "text",
            },
          });
          expect(slowPayload.status).toBe(201);
          expect(slowPayload.body).toMatchObject({
            ok: true,
            data: {
              status: "added",
              title: "Slow Remote Upload",
              source_kind: "url",
            },
          });
        } finally {
          release();
          await slowUpload?.catch(() => undefined);
          await daemon.close();
        }
      });
    });
  });

  it("captures multipart URL payloads through the shared URL capture behavior", async () => {
    await withTempWorkspace("llm-wiki-daemon-url-", async (workspaceDir) => {
      await withTextServer("Remote upload body.\n", async (url) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

        try {
          const form = new FormData();
          form.set("title", "Remote Upload");
          form.set("url", url);

          // Act
          const upload = await uploadForm(daemon, form);
          const queueItem = JSON.parse(await readGeneratedFile(wikiDir, upload.body.data.queue_path)) as {
            origin: string;
            origin_url: string;
            source_kind: string;
            uploader: string;
            upload_session_id: string;
            uploaded_via: string;
          };
          const sourceCard = parseSourceCardFrontmatter<{
            origin: string;
            origin_url: string;
            uploader: string;
            upload_session_id: string;
            uploaded_via: string;
          }>(await readGeneratedFile(wikiDir, upload.body.data.source_card_path));

          // Assert
          expect(upload.status).toBe(201);
          expect(upload.body.data).toMatchObject({
            status: "added",
            title: "Remote Upload",
            source_kind: "url",
            visibility: "private",
          });
          expect(queueItem).toMatchObject({
            source_kind: "url",
            origin: "local-upload:url",
            origin_url: url,
            uploader: "local",
            upload_session_id: daemon.uploadSessionId,
            uploaded_via: "local-explorer",
          });
          expect(sourceCard).toMatchObject({
            origin: "local-upload:url",
            origin_url: url,
            uploader: "local",
            upload_session_id: daemon.uploadSessionId,
            uploaded_via: "local-explorer",
          });
          expect(await readGeneratedFile(wikiDir, upload.body.data.original_path)).toBe("Remote upload body.\n");
          await expectExplorerUploadProvenance(wikiDir, upload, "url");
        } finally {
          await daemon.close();
        }
      });
    });
  });

  it("keeps daemon-created raw originals out of public Quartz profile output", async () => {
    await withTempWorkspace("llm-wiki-daemon-public-profile-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const privateText = "Private upload text that must not enter public Explorer output.\n";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        const form = new FormData();
        form.set("title", "Private Upload");
        form.set("text", privateText);
        const upload = await uploadForm(daemon, form);

        // Act
        await syncQuartzContent(wikiDir, "public");
        const manifest = await readFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.public.json"), "utf8");

        // Assert
        expect(upload.body.data.visibility).toBe("private");
        expect(JSON.stringify(manifest)).not.toContain(upload.body.data.original_path);
        expect(JSON.stringify(manifest)).not.toContain(upload.body.data.source_card_path);
        expect(JSON.stringify(manifest)).not.toContain(privateText);
        expect(await pathExists(resolve(wikiDir, `quartz/content/${upload.body.data.original_path}`))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `quartz/content/${upload.body.data.source_card_path}`))).toBe(false);
      } finally {
        await daemon.close();
      }
    });
  });

  it("does not commit uploads unless commitUploads is explicitly enabled", async () => {
    await withTempWorkspace("llm-wiki-daemon-commit-opt-in-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const commitUpload = vi.fn(async () => ({
        attempted: true,
        ok: true,
        committed_paths: ["raw/queue/example.json"],
      }));
      await initializeWiki(wikiDir);
      const defaultDaemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        commitUpload,
      });

      try {
        const defaultForm = new FormData();
        defaultForm.set("title", "Default Upload");
        defaultForm.set("text", "Default upload body.\n");

        // Act
        const defaultUpload = await uploadForm(defaultDaemon, defaultForm);

        // Assert
        expect(defaultUpload.body.data.commit).toEqual({
          attempted: false,
          ok: true,
        });
        expect(commitUpload).not.toHaveBeenCalled();
      } finally {
        await defaultDaemon.close();
      }

      const explicitDaemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        commitUploads: true,
        commitUpload,
      });

      try {
        const explicitForm = new FormData();
        explicitForm.set("title", "Explicit Upload");
        explicitForm.set("text", "Explicit upload body.\n");

        // Act
        const explicitUpload = await uploadForm(explicitDaemon, explicitForm);

        // Assert
        expect(explicitUpload.body.data.commit).toMatchObject({
          attempted: true,
          ok: true,
        });
        expect(commitUpload).toHaveBeenCalledTimes(1);
        expect(commitUpload).toHaveBeenCalledWith(expect.objectContaining({
          repoRoot: wikiDir,
          source_id: explicitUpload.body.data.source_id,
          paths: expect.arrayContaining([
            explicitUpload.body.data.original_path,
            explicitUpload.body.data.source_card_path,
            explicitUpload.body.data.queue_path,
            "curated/log.md",
          ]),
        }));
      } finally {
        await explicitDaemon.close();
      }
    });
  });

  it("retries pending upload commits when the same source is uploaded again as a duplicate", async () => {
    await withTempWorkspace("llm-wiki-daemon-commit-retry-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const text = "Commit retry upload body.\n";
      let commitAttempts = 0;
      const commitUpload = vi.fn<UploadCommitter>(async (request) => {
        commitAttempts += 1;
        if (commitAttempts === 1) {
          return {
            attempted: true,
            ok: false,
            committed_paths: request.paths,
            error: "missing git identity",
          };
        }

        return {
          attempted: true,
          ok: true,
          committed_paths: request.paths,
        };
      });
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        commitUploads: true,
        commitUpload,
      });

      try {
        // Act
        const firstUpload = await postUploadForm(daemon, textUploadForm("Commit Retry", text));
        const retryUpload = await uploadForm(daemon, textUploadForm("Commit Retry", text));
        const firstCommitRequest = commitUpload.mock.calls[0]?.[0];

        // Assert
        expect(firstUpload.status).toBe(500);
        expect(firstUpload.body).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_COMMIT_FAILED",
            message: "missing git identity",
          },
        });
        expect(firstCommitRequest).toBeDefined();
        expect(retryUpload.status).toBe(200);
        expect(retryUpload.body.data).toMatchObject({
          status: "duplicate",
          source_id: firstCommitRequest?.source_id,
          commit: {
            attempted: true,
            ok: true,
          },
        });
        expect(commitUpload).toHaveBeenCalledTimes(2);
        expect(commitUpload).toHaveBeenNthCalledWith(2, {
          repoRoot: wikiDir,
          source_id: firstCommitRequest?.source_id,
          paths: firstCommitRequest?.paths,
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it("rejects uploads without the per-run token before capture or commit", async () => {
    await withTempWorkspace("llm-wiki-daemon-csrf-token-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const commitUpload = vi.fn(async () => ({
        attempted: true,
        ok: true,
        committed_paths: ["raw/queue/example.json"],
      }));
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        commitUploads: true,
        commitUpload,
      });

      try {
        const form = new FormData();
        form.set("title", "Forged Upload");
        form.set("text", "This should not be captured.\n");

        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          body: form,
        });
        const payload = await response.json() as UploadFailureEnvelope;

        // Assert
        expect(response.status).toBe(403);
        expect(payload).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_AUTH_FAILED",
            message: "Upload authentication failed.",
            hint: "Refresh the local Explorer session and retry the upload.",
          },
        });
        expect(payload.issues[0]).toMatchObject({
          severity: "error",
          code: "UPLOAD_AUTH_FAILED",
          path: UPLOAD_TOKEN_HEADER,
        });
        expect(commitUpload).not.toHaveBeenCalled();
      } finally {
        await daemon.close();
      }
    });
  });

  it("keeps token rejection envelopes unchanged for loopback browser uploads", async () => {
    await withTempWorkspace("llm-wiki-daemon-cors-csrf-token-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const commitUpload = vi.fn(async () => ({
        attempted: true,
        ok: true,
        committed_paths: ["raw/queue/example.json"],
      }));
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        commitUploads: true,
        commitUpload,
      });

      try {
        const form = new FormData();
        form.set("title", "Forged Browser Upload");
        form.set("text", "This should not be captured.\n");

        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:8080",
            [UPLOAD_TOKEN_HEADER]: "not-the-daemon-token",
          },
          body: form,
        });
        const payload = await response.json() as UploadFailureEnvelope;

        // Assert
        expect(response.status).toBe(403);
        expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8080");
        expect(payload).toEqual({
          ok: false,
          error: {
            code: "UPLOAD_AUTH_FAILED",
            message: "Upload authentication failed.",
            hint: "Refresh the local Explorer session and retry the upload.",
          },
          issues: [
            {
              severity: "error",
              code: "UPLOAD_AUTH_FAILED",
              message: "Upload authentication failed.",
              path: UPLOAD_TOKEN_HEADER,
              hint: "Refresh the local Explorer session and retry the upload.",
            },
          ],
        });
        expect(commitUpload).not.toHaveBeenCalled();
      } finally {
        await daemon.close();
      }
    });
  });

  it("rejects invalid tokens without echoing tokens, bodies, secrets, or filesystem paths", async () => {
    await withTempWorkspace("llm-wiki-daemon-auth-safe-envelope-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const forgedToken = "forged-token-secret-value";
      const rawBodySecret = "raw-body-secret-value";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        const form = textUploadForm("Forged Safe Envelope", rawBodySecret);

        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            [UPLOAD_TOKEN_HEADER]: forgedToken,
          },
          body: form,
        });
        const payload = await response.json() as UploadFailureEnvelope;

        // Assert
        expect(response.status).toBe(403);
        expect(payload.error.code).toBe("UPLOAD_AUTH_FAILED");
        expectSafeFailureEnvelope(payload, [
          forgedToken,
          daemon.uploadToken,
          rawBodySecret,
          workspaceDir,
          wikiDir,
        ]);
      } finally {
        await daemon.close();
      }
    });
  });

  it("rejects multipart text fields that exceed the explicit 1 MiB field limit", async () => {
    await withTempWorkspace("llm-wiki-daemon-field-limit-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const commitUpload = vi.fn(async () => ({
        attempted: true,
        ok: true,
        committed_paths: ["raw/queue/example.json"],
      }));
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        commitUploads: true,
        commitUpload,
      });

      try {
        const form = new FormData();
        form.set("title", "Oversized Text");
        form.set("text", "x".repeat(ONE_MIB + 1));

        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: form,
        });
        const payload = await response.json() as UploadFailureEnvelope;

        // Assert
        expect(response.status).toBe(413);
        expect(payload).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_TOO_LARGE",
            message: "Multipart field \"text\" exceeds the 1048576 byte limit.",
          },
        });
        expect(payload.issues[0]).toMatchObject({
          severity: "error",
          code: "UPLOAD_TOO_LARGE",
          path: "text",
        });
        expect(commitUpload).not.toHaveBeenCalled();
      } finally {
        await daemon.close();
      }
    });
  });

  it("accepts text fields at the 1 MiB limit", async () => {
    await withTempWorkspace("llm-wiki-daemon-field-limit-boundary-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        const form = textUploadForm("Max Text", "x".repeat(ONE_MIB));

        // Act
        const upload = await uploadForm(daemon, form);

        // Assert
        expect(upload.status).toBe(201);
        expect(upload.body.data).toMatchObject({
          status: "added",
          title: "Max Text",
          source_kind: "text",
          message: "Raw source uploaded and queued for ingest.",
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it.each([
    ["title", (form: FormData) => form.set("title", "x".repeat(ONE_MIB + 1))],
    ["url", (form: FormData) => form.set("url", `http://127.0.0.1/${"x".repeat(ONE_MIB)}`)],
  ])("rejects %s fields that exceed the explicit 1 MiB field limit", async (fieldName, mutateForm) => {
    await withTempWorkspace(`llm-wiki-daemon-${fieldName}-limit-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        const form = fieldName === "title"
          ? textUploadForm("Allowed Title", "Body under the limit.")
          : urlUploadForm("http://127.0.0.1/source");
        mutateForm(form);

        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: form,
        });
        const payload = await response.json() as UploadFailureEnvelope;

        // Assert
        expect(response.status).toBe(413);
        expect(payload).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_TOO_LARGE",
            message: `Multipart field "${fieldName}" exceeds the 1048576 byte limit.`,
          },
        });
        expect(payload.issues[0]).toMatchObject({
          severity: "error",
          code: "UPLOAD_TOO_LARGE",
          path: fieldName,
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it("rejects multipart forms that exceed the non-file field count limit", async () => {
    await withTempWorkspace("llm-wiki-daemon-field-count-limit-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const commitUpload = vi.fn(async () => ({
        attempted: true,
        ok: true,
        committed_paths: ["raw/queue/example.json"],
      }));
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        commitUploads: true,
        commitUpload,
      });

      try {
        const form = new FormData();
        form.append("text", "Text payload that should not be captured.\n");
        for (let index = 0; index < 19; index += 1) {
          form.append(`metadata_${index}`, `value-${index}`);
        }
        form.append("url", "https://example.com/ignored-after-field-limit");

        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: form,
        });
        const payload = await response.json() as UploadFailureEnvelope;
        const queueFiles = (await readdir(resolve(wikiDir, "raw/queue"))).filter((entry) => entry.endsWith(".json"));

        // Assert
        expect(response.status).toBe(400);
        expect(payload).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_PAYLOAD_INVALID",
            message: "Raw upload payload may include at most 20 non-file fields.",
          },
        });
        expect(payload.issues[0]).toMatchObject({
          severity: "error",
          code: "UPLOAD_PAYLOAD_INVALID",
          path: "field",
        });
        expect(queueFiles).toEqual([]);
        expect(commitUpload).not.toHaveBeenCalled();
      } finally {
        await daemon.close();
      }
    });
  });

  it("rejects unexpected multipart file fields instead of discarding them", async () => {
    await withTempWorkspace("llm-wiki-daemon-unexpected-file-field-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const commitUpload = vi.fn(async () => ({
        attempted: true,
        ok: true,
        committed_paths: ["raw/queue/example.json"],
      }));
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({
        repoRoot: wikiDir,
        port: 0,
        commitUploads: true,
        commitUpload,
      });

      try {
        const form = new FormData();
        form.set("text", "Text payload that should not be captured.\n");
        form.set("attachment", new Blob(["Unexpected file payload.\n"], { type: "text/plain" }), "unexpected.txt");

        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: form,
        });
        const payload = await response.json() as UploadFailureEnvelope;
        const queueFiles = (await readdir(resolve(wikiDir, "raw/queue"))).filter((entry) => entry.endsWith(".json"));

        // Assert
        expect(response.status).toBe(400);
        expect(payload).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_PAYLOAD_INVALID",
            message: "Raw upload file parts must use the \"file\" field; received \"attachment\".",
          },
        });
        expect(payload.issues[0]).toMatchObject({
          severity: "error",
          code: "UPLOAD_PAYLOAD_INVALID",
          path: "attachment",
        });
        expect(queueFiles).toEqual([]);
        expect(commitUpload).not.toHaveBeenCalled();
      } finally {
        await daemon.close();
      }
    });
  });

  it("rejects malformed multipart bodies before capture", async () => {
    await withTempWorkspace("llm-wiki-daemon-malformed-multipart-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const rawBodySecret = "malformed-raw-body-secret";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            "content-type": "multipart/form-data; boundary=broken-boundary",
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: `--broken-boundary\r\nContent-Disposition: form-data; name="text"\r\n\r\n${rawBodySecret}`,
        });
        const payload = await response.json() as UploadFailureEnvelope;
        const queueFiles = (await readdir(resolve(wikiDir, "raw/queue"))).filter((entry) => entry.endsWith(".json"));

        // Assert
        expect(response.status).toBe(400);
        expect(payload).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_MULTIPART_INVALID",
          },
        });
        expectSafeFailureEnvelope(payload, [rawBodySecret, daemon.uploadToken, workspaceDir, wikiDir]);
        expect(queueFiles).toEqual([]);
      } finally {
        await daemon.close();
      }
    });
  });

  it.each([
    {
      name: "missing payload",
      form: () => {
        const form = new FormData();
        form.set("title", "Metadata Only");
        return form;
      },
      expectedMessage: "Raw upload payload must include exactly one file, text note, or URL.",
    },
    {
      name: "text plus url payload kinds",
      form: () => {
        const form = textUploadForm("Two Payloads", "Text body.\n");
        form.set("url", "https://example.com/source");
        return form;
      },
      expectedMessage: "Raw upload payload must include exactly one file, text note, or URL.",
    },
    {
      name: "file plus text payload kinds",
      form: () => {
        const form = fileUploadForm("mixed.md", "File body.\n", "text/markdown");
        form.set("title", "Mixed Payloads");
        form.set("text", "Text body.\n");
        return form;
      },
      expectedMessage: "Raw upload payload must include exactly one file, text note, or URL.",
    },
    {
      name: "file plus url payload kinds",
      form: () => {
        const form = fileUploadForm("mixed.md", "File body.\n", "text/markdown");
        form.set("url", "https://example.com/source");
        return form;
      },
      expectedMessage: "Raw upload payload must include exactly one file, text note, or URL.",
    },
    {
      name: "missing text title",
      form: () => {
        const form = new FormData();
        form.set("text", "Text body without required title.\n");
        return form;
      },
      expectedMessage: "Text uploads require a title.",
    },
  ])("rejects $name with the PRD payload error code", async (scenario) => {
    await withTempWorkspace(`llm-wiki-daemon-payload-${scenario.name.replaceAll(" ", "-")}-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: scenario.form(),
        });
        const payload = await response.json() as UploadFailureEnvelope;
        const queueFiles = (await readdir(resolve(wikiDir, "raw/queue"))).filter((entry) => entry.endsWith(".json"));

        // Assert
        expect(response.status).toBe(400);
        expect(payload).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_PAYLOAD_INVALID",
            message: scenario.expectedMessage,
          },
        });
        expect(payload.issues[0]).toMatchObject({
          severity: "error",
          code: "UPLOAD_PAYLOAD_INVALID",
        });
        expect(queueFiles).toEqual([]);
      } finally {
        await daemon.close();
      }
    });
  });

  it("rejects invalid URL payloads with the PRD URL error code", async () => {
    await withTempWorkspace("llm-wiki-daemon-invalid-url-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const unsafeUrl = "file:///etc/passwd";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: urlUploadForm(unsafeUrl),
        });
        const payload = await response.json() as UploadFailureEnvelope;

        // Assert
        expect(response.status).toBe(400);
        expect(payload).toMatchObject({
          ok: false,
          error: {
            code: "URL_INVALID",
            message: "URL capture requires a valid http(s) URL.",
          },
        });
        expect(payload.issues[0]).toMatchObject({
          severity: "error",
          code: "URL_INVALID",
          path: "url",
        });
        expectSafeFailureEnvelope(payload, [unsafeUrl, "/etc/passwd", daemon.uploadToken, workspaceDir, wikiDir]);
      } finally {
        await daemon.close();
      }
    });
  });

  it.each([
    ["notes.md", "text/markdown"],
    ["notes.md", "application/octet-stream"],
    ["notes.markdown", "text/markdown"],
    ["notes.markdown", "application/octet-stream"],
    ["notes.txt", "text/plain"],
    ["notes.pdf", "application/pdf"],
  ])("accepts allowed file type %s with MIME %s", async (fileName, mimeType) => {
    await withTempWorkspace(`llm-wiki-daemon-allowed-${fileName}-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const content = mimeType === "application/pdf"
        ? "%PDF-1.4\n% local test PDF body\n"
        : "Allowed file upload body.\n";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        // Act
        const upload = await uploadForm(daemon, fileUploadForm(fileName, content, mimeType));

        // Assert
        expect(upload.status).toBe(201);
        expect(upload.body.data).toMatchObject({
          status: "added",
          source_kind: "file",
          visibility: "private",
          message: "Raw source uploaded and queued for ingest.",
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it.each([
    {
      fileName: "notes.exe",
      mimeType: "text/plain",
      expectedMessage: "File uploads must use .md, .markdown, .txt, or .pdf extensions.",
    },
    {
      fileName: "notes.md",
      mimeType: "application/json",
      expectedMessage: "File uploads must use text/markdown, text/plain, or application/pdf MIME types.",
    },
    {
      fileName: "notes.txt",
      mimeType: "application/octet-stream",
      expectedMessage: "File uploads must use text/markdown, text/plain, or application/pdf MIME types.",
    },
  ])("rejects unsupported file type $fileName with MIME $mimeType", async (scenario) => {
    await withTempWorkspace(`llm-wiki-daemon-unsupported-${scenario.fileName}-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      const bodySecret = "unsupported-body-secret";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: fileUploadForm(scenario.fileName, bodySecret, scenario.mimeType),
        });
        const payload = await response.json() as UploadFailureEnvelope;
        const queueFiles = (await readdir(resolve(wikiDir, "raw/queue"))).filter((entry) => entry.endsWith(".json"));

        // Assert
        expect(response.status).toBe(415);
        expect(payload).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_TYPE_UNSUPPORTED",
            message: scenario.expectedMessage,
          },
        });
        expect(payload.issues[0]).toMatchObject({
          severity: "error",
          code: "UPLOAD_TYPE_UNSUPPORTED",
          path: "file",
        });
        expectSafeFailureEnvelope(payload, [bodySecret, workspaceDir, wikiDir]);
        expect(queueFiles).toEqual([]);
      } finally {
        await daemon.close();
      }
    });
  });

  it("accepts file uploads at the 25 MiB limit and rejects larger files", async () => {
    await withTempWorkspace("llm-wiki-daemon-file-size-limit-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        const maxFile = new Uint8Array(MAX_FILE_BYTES).fill(0x61);
        const oversizedFile = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x62);

        // Act
        const accepted = await uploadForm(daemon, fileUploadForm("max.txt", maxFile, "text/plain"));
        const rejectedResponse = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: fileUploadForm("too-large.txt", oversizedFile, "text/plain"),
        });
        const rejected = await rejectedResponse.json() as UploadFailureEnvelope;

        // Assert
        expect(accepted.status).toBe(201);
        expect(accepted.body.data).toMatchObject({
          status: "added",
          source_kind: "file",
        });
        expect(rejectedResponse.status).toBe(413);
        expect(rejected).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_TOO_LARGE",
            message: "Uploaded file exceeds the 26214400 byte limit.",
          },
        });
        expect(rejected.issues[0]).toMatchObject({
          severity: "error",
          code: "UPLOAD_TOO_LARGE",
          path: "file",
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it("returns a stable API error envelope for unsupported upload payloads", async () => {
    await withTempWorkspace("llm-wiki-daemon-api-error-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        // Act
        const response = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [UPLOAD_TOKEN_HEADER]: daemon.uploadToken,
          },
          body: "{}",
        });
        const payload = await response.json() as UploadFailureEnvelope;

        // Assert
        expect(response.status).toBe(415);
        expect(payload).toEqual({
          ok: false,
          error: {
            code: "UPLOAD_CONTENT_TYPE_UNSUPPORTED",
            message: "Raw upload payload must use multipart/form-data.",
            hint: "Send file, text, or url fields as multipart/form-data.",
          },
          issues: [
            {
              severity: "error",
              code: "UPLOAD_CONTENT_TYPE_UNSUPPORTED",
              message: "Raw upload payload must use multipart/form-data.",
              path: "content-type",
              hint: "Send file, text, or url fields as multipart/form-data.",
            },
          ],
        });
      } finally {
        await daemon.close();
      }
    });
  });

  it("removes the standalone daemon command from the public CLI", async () => {
    await withTempWorkspace("llm-wiki-daemon-command-removed-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "daemon",
        "--repo",
        wikiDir,
        "--host",
        "0.0.0.0",
        "--json",
      ]);

      // Assert
      expect(result.exitCode).toBeGreaterThan(0);
      expect(result.stdout).toEqual([]);
      expect(result.stderr.join("\n")).toContain("unknown command 'daemon'");
    });
  });
});
