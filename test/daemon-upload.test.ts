import { createServer, type Server } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { startUploadDaemon, UPLOAD_TOKEN_HEADER, type UploadCommitter, type UploadDaemon } from "../src/daemon/index.js";
import { syncQuartzContent } from "../src/quartz/index.js";
import { parseInitJson, pathExists, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

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
    commit: {
      attempted: boolean;
      ok: boolean;
    };
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

type DaemonFailureEnvelope = {
  ok: false;
  command: "daemon";
  repo: string;
  error: {
    code: string;
    message: string;
    hint: string;
  };
  issues: Array<{
    severity: "error";
    code: string;
    path: string;
    hint: string;
  }>;
};

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
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

function parseSourceCardFrontmatter<T>(content: string): T {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  expect(frontmatter).not.toBeNull();

  return parse(frontmatter?.[1] ?? "") as T;
}

function parseDaemonFailure(stdout: string[]): DaemonFailureEnvelope {
  expect(stdout).toHaveLength(1);

  return JSON.parse(stdout[0]) as DaemonFailureEnvelope;
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
          visibility: "private",
          status: "queued",
          path: upload.body.data.source_card_path,
          original_path: upload.body.data.original_path,
        });
        expect(parseSourceCardFrontmatter(await readGeneratedFile(wikiDir, upload.body.data.source_card_path))).toMatchObject({
          source_id: upload.body.data.source_id,
          title: "Meeting Notes",
          source_kind: "file",
          visibility: "private",
          status: "queued",
        });
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
      const origin = "http://127.0.0.1:8080";
      await initializeWiki(wikiDir);
      const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });

      try {
        const form = new FormData();
        form.set("title", "CORS Upload");
        form.set("text", "CORS upload body.\n");

        // Act
        const preflight = await fetch(`${daemon.url}/api/raw-upload`, {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": UPLOAD_TOKEN_HEADER,
          },
        });
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
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
        expect(preflight.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
        expect(preflight.headers.get("access-control-allow-headers")).toContain(UPLOAD_TOKEN_HEADER);
        expect(rejectedUpload.status).toBe(403);
        expect(rejectedUpload.headers.get("access-control-allow-origin")).toBe(origin);
        expect(rejectedBody).toMatchObject({
          ok: false,
          error: {
            code: "UPLOAD_CSRF_TOKEN_INVALID",
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
        const secondUpload = await uploadForm(daemon, form);

        // Assert
        expect(firstUpload.status).toBe(201);
        expect(secondUpload.status).toBe(200);
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
        expect(secondUpload.body.data.created_paths).toEqual([]);
        expect((await readGeneratedFile(wikiDir, firstUpload.body.data.original_path)).replaceAll("\r\n", "\n")).toBe(text);
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
            origin_url: string;
            source_kind: string;
          };

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
            origin_url: url,
          });
          expect(await readGeneratedFile(wikiDir, upload.body.data.original_path)).toBe("Remote upload body.\n");
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
            code: "UPLOAD_CSRF_TOKEN_INVALID",
            message: "Raw upload requests must include a valid upload token.",
            hint: `Set the ${UPLOAD_TOKEN_HEADER} header to the daemon upload_token value from readiness output.`,
          },
        });
        expect(payload.issues[0]).toMatchObject({
          severity: "error",
          code: "UPLOAD_CSRF_TOKEN_INVALID",
          path: UPLOAD_TOKEN_HEADER,
        });
        expect(commitUpload).not.toHaveBeenCalled();
      } finally {
        await daemon.close();
      }
    });
  });

  it("rejects multipart text fields that exceed the explicit field limit", async () => {
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
        form.set("text", "x".repeat((25 * 1024 * 1024) + 1));

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
            message: "Multipart field \"text\" exceeds the 26214400 byte limit.",
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

  it("refuses non-local host values for the MVP daemon command", async () => {
    await withTempWorkspace("llm-wiki-daemon-host-refusal-", async (workspaceDir) => {
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
      const payload = parseDaemonFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "daemon",
        repo: wikiDir,
        error: {
          code: "DAEMON_HOST_NOT_LOCAL",
          hint: "Use 127.0.0.1, localhost, or ::1 for the MVP local upload daemon.",
        },
      });
      expect(payload.issues[0]).toMatchObject({
        severity: "error",
        code: "DAEMON_HOST_NOT_LOCAL",
        path: "--host",
      });
    });
  });
});
