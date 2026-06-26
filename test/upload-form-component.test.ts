// @vitest-environment happy-dom

import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { startUploadDaemon, UPLOAD_TOKEN_HEADER } from "../src/daemon/index.js";
import { syncQuartzContent, writeLocalDaemonRuntimeMetadata } from "../src/quartz/index.js";
import { parseLogEntries, type RuntimeLogEntry } from "../src/scanner/index.js";
import { parseInitJson, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

type DaemonMetadata = {
  enabled: true;
  url: string;
  upload_path: string;
  token_header: string;
  upload_token: string;
  commit_uploads: boolean;
  auto_ingest_available: boolean;
};

type DisabledMetadata = {
  enabled: false;
};

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

const metadataPath = "/_llm-wiki/runtime/local-daemon.json";
const disabledCommandHint = "Run llm-wiki explore serve --profile local --with-daemon";

let uploadFormScriptPromise: Promise<string> | undefined;
let uploadFormComponentPromise: Promise<string> | undefined;

beforeEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/_llm-wiki/upload");
  vi.unstubAllGlobals();
});

describe("generated LlmWikiUploadForm component", () => {
  it("keeps the generated markup wired to the upload client script", async () => {
    // Arrange
    const requiredMarkup = [
      'data-llm-wiki-upload-form="true"',
      '<form encType="multipart/form-data" noValidate>',
      '<input type="radio" name="mode" value="file" checked disabled />',
      '<input type="radio" name="mode" value="text" disabled />',
      '<input type="radio" name="mode" value="url" disabled />',
      '<input name="title" type="text" autoComplete="off" disabled />',
      '<input name="file" type="file" disabled />',
      '<textarea name="text" rows={8} disabled />',
      '<input name="url" type="url" inputMode="url" disabled />',
      '<button type="submit" disabled>Upload</button>',
      'data-upload-status=""',
      'data-upload-details=""',
    ];

    // Act
    const component = await generatedUploadFormComponent();
    const markup = extractGeneratedUploadFormMarkup(component);

    // Assert
    for (const required of requiredMarkup) {
      expect(markup).toContain(required);
    }
    expect(component).toContain("LlmWikiUploadForm.afterDOMLoaded = uploadFormScript");
  });

  it.each([
    ["missing metadata", null],
    ["disabled metadata", { enabled: false } satisfies DisabledMetadata],
  ])("fetches daemon metadata and shows the exact disabled command hint for %s", async (_caseName, metadata) => {
    // Arrange
    const fetchMock = stubFetch(async (input) => {
      expect(String(input)).toBe(metadataPath);
      return metadata === null ? textResponse("not found", 404) : jsonResponse(metadata);
    });
    const form = renderUploadForm();

    // Act
    await executeGeneratedUploadFormScript();

    // Assert
    await waitFor(() => expect(form.status.textContent).toBe("Local upload daemon is disabled."));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(form.enabledControls()).toHaveLength(0);
    expect(detailValue(form.details, "Hint")).toBe(disabledCommandHint);
  });

  it("fetches daemon metadata from a configured Quartz base path", async () => {
    // Arrange
    window.history.replaceState(null, "", "/wiki/_llm-wiki/upload");
    const fetchMock = stubFetch(async (input) => {
      expect(String(input)).toBe("/wiki/_llm-wiki/runtime/local-daemon.json");
      return jsonResponse(enabledMetadata());
    });
    const form = renderUploadForm();

    // Act
    await executeGeneratedUploadFormScript();

    // Assert
    await waitFor(() => expect(form.status.textContent).toBe("Local upload daemon is ready."));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(form.enabledControls().length).toBeGreaterThan(0);
    expect(detailValue(form.details, "Token header")).toBe("x-test-upload-token");
  });

  it.each([
    {
      mode: "file",
      fill: (form: RenderedUploadForm) => {
        const file = new File(["Quarterly notes.\n"], "notes.md", { type: "text/markdown" });
        Object.defineProperty(form.fileInput, "files", {
          configurable: true,
          value: [file],
        });
      },
      expected: {
        file: "notes.md",
      },
    },
    {
      mode: "text",
      fill: (form: RenderedUploadForm) => {
        form.titleInput.value = "Pasted Notes";
        form.textInput.value = "Pasted body.";
      },
      expected: {
        title: "Pasted Notes",
        text: "Pasted body.",
      },
    },
    {
      mode: "url",
      fill: (form: RenderedUploadForm) => {
        form.urlInput.value = "https://example.com/source";
      },
      expected: {
        url: "https://example.com/source",
      },
    },
  ])("submits $mode uploads as multipart form data to the configured daemon endpoint", async (scenario) => {
    // Arrange
    const metadata = enabledMetadata();
    const uploadCalls: Array<{ input: string; init: RequestInit }> = [];
    stubFetch(async (input, init) => {
      if (String(input) === metadataPath) {
        return jsonResponse(metadata);
      }

      uploadCalls.push({ input: String(input), init: init ?? {} });
      return uploadSuccessResponse();
    });
    const form = renderUploadForm();
    await executeGeneratedUploadFormScript();
    await waitFor(() => expect(form.status.textContent).toBe("Local upload daemon is ready."));
    selectMode(form, scenario.mode);
    scenario.fill(form);

    // Act
    submit(form);

    // Assert
    await waitFor(() => expect(uploadCalls).toHaveLength(1));
    expect(uploadCalls[0]?.input).toBe("http://127.0.0.1:32123/api/raw-upload");
    expect(uploadCalls[0]?.init.method).toBe("POST");
    expect(uploadCalls[0]?.init.headers).toEqual({ "x-test-upload-token": "secret-token" });
    expect(uploadCalls[0]?.init.body).toBeInstanceOf(FormData);
    const body = uploadCalls[0]?.init.body as FormData;
    for (const [field, value] of Object.entries(scenario.expected)) {
      const submitted = body.get(field);
      if (field === "file") {
        expect(submitted).toBeInstanceOf(File);
        expect((submitted as File).name).toBe(value);
      } else {
        expect(submitted).toBe(value);
      }
    }
  });

  it.each([
    {
      mode: "file",
      fill: (form: RenderedUploadForm) => {
        const file = new File(["Quarterly notes.\n"], "notes.md", { type: "text/markdown" });
        Object.defineProperty(form.fileInput, "files", {
          configurable: true,
          value: [file],
        });
      },
      expectedField: "file",
    },
    {
      mode: "text",
      fill: (form: RenderedUploadForm) => {
        form.titleInput.value = "Pasted Notes";
        form.textInput.value = "Pasted body.";
      },
      expectedField: "text",
    },
  ])("keeps an invalid inactive URL field from blocking $mode uploads", async (scenario) => {
    // Arrange
    const metadata = enabledMetadata();
    const uploadCalls: Array<{ input: string; init: RequestInit }> = [];
    stubFetch(async (input, init) => {
      if (String(input) === metadataPath) {
        return jsonResponse(metadata);
      }

      uploadCalls.push({ input: String(input), init: init ?? {} });
      return uploadSuccessResponse();
    });
    const form = renderUploadForm();
    await executeGeneratedUploadFormScript();
    await waitFor(() => expect(form.status.textContent).toBe("Local upload daemon is ready."));
    selectMode(form, "url");
    form.urlInput.value = "not a url";
    expect(form.form.checkValidity()).toBe(false);
    selectMode(form, scenario.mode);
    scenario.fill(form);

    // Act
    form.form.requestSubmit();

    // Assert
    await waitFor(() => expect(uploadCalls).toHaveLength(1));
    const body = uploadCalls[0]?.init.body as FormData;
    expect(body.get(scenario.expectedField)).not.toBeNull();
  });

  it("requires a title before submitting pasted text uploads", async () => {
    // Arrange
    const fetchMock = stubFetch(async (input) => {
      if (String(input) === metadataPath) {
        return jsonResponse(enabledMetadata());
      }

      throw new Error(`Unexpected upload request to ${String(input)}`);
    });
    const form = renderUploadForm();
    await executeGeneratedUploadFormScript();
    await waitFor(() => expect(form.status.textContent).toBe("Local upload daemon is ready."));
    selectMode(form, "text");
    form.textInput.value = "Untitled body.\n";

    // Act
    submit(form);

    // Assert
    await waitFor(() => expect(form.status.textContent).toBe("Title is required for pasted text uploads."));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(detailValue(form.details, "Code")).toBe("UPLOAD_FORM_INVALID");
  });

  it.each([
    {
      autoIngestAvailable: true,
      expectedAutoCommand: "llm-wiki ingest src_2026_06_24_upload_abcdef123456 --auto",
    },
    {
      autoIngestAvailable: false,
      expectedAutoCommand: null,
    },
  ])("renders upload success details and gates the auto ingest command on metadata", async (scenario) => {
    // Arrange
    const metadata = enabledMetadata({ auto_ingest_available: scenario.autoIngestAvailable });
    stubFetch(async (input) => String(input) === metadataPath ? jsonResponse(metadata) : uploadSuccessResponse());
    const form = renderUploadForm();
    await executeGeneratedUploadFormScript();
    await waitFor(() => expect(form.status.textContent).toBe("Local upload daemon is ready."));
    selectMode(form, "text");
    form.titleInput.value = "Uploaded Research";
    form.textInput.value = "Research body.\n";

    // Act
    submit(form);

    // Assert
    await waitFor(() => expect(form.status.textContent).toBe("Upload queued."));
    expect(detailValue(form.details, "Upload status")).toBe("added");
    expect(detailValue(form.details, "Title")).toBe("Uploaded Research");
    expect(detailValue(form.details, "Source ID")).toBe("src_2026_06_24_upload_abcdef123456");
    expect(detailValue(form.details, "Source kind")).toBe("text");
    expect(detailValue(form.details, "Queue status")).toBe("queued");
    expect(detailValue(form.details, "Source card")).toBe("raw/inputs/2026/06/upload/_source.md");
    expect(detailValue(form.details, "Original")).toBe("raw/inputs/2026/06/upload/original.md");
    expect(detailValue(form.details, "Ingest")).toBe("llm-wiki ingest src_2026_06_24_upload_abcdef123456");
    expect(detailValue(form.details, "Auto ingest")).toBe(scenario.expectedAutoCommand);
  });

  it("posts file, text, and URL uploads through generated metadata and refreshes review queue pages", async () => {
    await withTempWorkspace("llm-wiki-upload-form-live-daemon-", async (workspaceDir) => {
      await withTextServer("Remote browser upload body.\n", async (remoteUrl) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        const daemon = await startUploadDaemon({ repoRoot: wikiDir, port: 0 });
        const uploadRequests: BrowserUploadRequest[] = [];

        try {
          await writeLocalDaemonRuntimeMetadata(wikiDir, {
            enabled: true,
            url: daemon.url,
            upload_path: daemon.uploadPath,
            token_header: UPLOAD_TOKEN_HEADER,
            upload_token: daemon.uploadToken,
            commit_uploads: daemon.commitUploads,
            auto_ingest_available: false,
            updated_at: "2026-06-24T00:00:00.000Z",
          });
          const runtimeMetadata = JSON.parse(
            await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
          ) as DaemonMetadata;
          const nativeFetch = globalThis.fetch.bind(globalThis);
          stubFetch(async (input, init) => {
            if (String(input) === metadataPath) {
              return jsonResponse(runtimeMetadata);
            }
            if (String(input) === remoteUrl) {
              return nativeFetch(input, init);
            }

            uploadRequests.push(captureBrowserUploadRequest(String(input), init));
            return postBrowserFormData(nativeFetch, input, init);
          });
          const form = renderUploadForm();
          await executeGeneratedUploadFormScript();
          await waitFor(() => expect(form.status.textContent).toBe("Local upload daemon is ready."));

          // Act
          const fileUpload = await submitLiveUpload(form, "file", () => {
            form.titleInput.value = "";
            form.textInput.value = "";
            form.urlInput.value = "";
            Object.defineProperty(form.fileInput, "files", {
              configurable: true,
              value: [new File(["# Browser File\n\nPrivate file body.\n"], "Browser File.md")],
            });
          });
          const textUpload = await submitLiveUpload(form, "text", () => {
            form.titleInput.value = "Browser Pasted Text";
            form.textInput.value = "Private pasted browser body.\n";
            form.urlInput.value = "";
          });
          const urlUpload = await submitLiveUpload(form, "url", () => {
            form.titleInput.value = "";
            form.textInput.value = "";
            form.urlInput.value = remoteUrl;
          });
          const log = await readGeneratedFile(wikiDir, "curated/log.md");
          const parsedLog = parseLogEntries({ path: "curated/log.md", content: log });
          await syncQuartzContent(wikiDir, "local");
          const sourceQueue = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/source-queue.md");
          const status = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/status.md");
          const overview = await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/overview.md");

          // Assert
          expect(uploadRequests).toEqual([
            {
              url: `${daemon.url}/api/raw-upload`,
              method: "POST",
              token: daemon.uploadToken,
              fields: ["file"],
            },
            {
              url: `${daemon.url}/api/raw-upload`,
              method: "POST",
              token: daemon.uploadToken,
              fields: ["title", "text"],
            },
            {
              url: `${daemon.url}/api/raw-upload`,
              method: "POST",
              token: daemon.uploadToken,
              fields: ["url"],
            },
          ]);
          expect(fileUpload).toMatchObject({
            title: "Browser File",
            sourceKind: "file",
            queueStatus: "queued",
          });
          expect(textUpload).toMatchObject({
            title: "Browser Pasted Text",
            sourceKind: "text",
            queueStatus: "queued",
          });
          expect(urlUpload).toMatchObject({
            title: "source",
            sourceKind: "url",
            queueStatus: "queued",
          });
          expect(parsedLog.issues).toEqual([]);
          expect(parsedLog.entries).toHaveLength(3);
          expectUploadLogEntry(parsedLog.entries, fileUpload);
          expectUploadLogEntry(parsedLog.entries, textUpload);
          expectUploadLogEntry(parsedLog.entries, urlUpload);
          await expect(readGeneratedFile(wikiDir, fileUpload.originalPath)).resolves.toBe(
            "# Browser File\n\nPrivate file body.\n",
          );
          await expect(readGeneratedFile(wikiDir, textUpload.originalPath)).resolves.toBe("Private pasted browser body.");
          await expect(readGeneratedFile(wikiDir, urlUpload.originalPath)).resolves.toBe(
            "Remote browser upload body.\n",
          );
          for (const upload of [fileUpload, textUpload, urlUpload]) {
            await expect(readGeneratedFile(wikiDir, upload.sourceCardPath)).resolves.toContain(upload.sourceId);
            await expect(readGeneratedFile(wikiDir, upload.queuePath)).resolves.toContain("\"status\": \"queued\"");
            expect(sourceQueue).toContain(upload.sourceId);
            expect(sourceQueue).toContain(upload.title);
            expect(sourceQueue).toContain(upload.sourceCardPath);
            expect(sourceQueue).toContain(upload.queuePath);
          }
          expect(status).toContain("| Queued | 3 |");
          expect(overview).toContain("| Source queue | 3 |");
        } finally {
          await daemon.close();
        }
      });
    });
  });

  it("renders duplicate upload success without reporting a newly queued upload", async () => {
    // Arrange
    const metadata = enabledMetadata();
    stubFetch(async (input) => (String(input) === metadataPath ? jsonResponse(metadata) : uploadDuplicateResponse()));
    const form = renderUploadForm();
    await executeGeneratedUploadFormScript();
    await waitFor(() => expect(form.status.textContent).toBe("Local upload daemon is ready."));
    selectMode(form, "url");
    form.urlInput.value = "https://example.com/already-captured";

    // Act
    submit(form);

    // Assert
    await waitFor(() => expect(form.status.textContent).toBe("Source already captured and ingested."));
    expect(form.status.textContent).not.toBe("Upload queued.");
    expect(detailValue(form.details, "Upload status")).toBe("duplicate");
    expect(detailValue(form.details, "Title")).toBe("Already Captured Research");
    expect(detailValue(form.details, "Source ID")).toBe("src_2026_06_24_upload_existing");
    expect(detailValue(form.details, "Source kind")).toBe("url");
    expect(detailValue(form.details, "Queue status")).toBe("ingested");
    expect(detailValue(form.details, "Source card")).toBe("raw/inputs/2026/06/existing/_source.md");
    expect(detailValue(form.details, "Original")).toBe("raw/inputs/2026/06/existing/original.url");
    expect(detailValue(form.details, "Ingest")).toBe("llm-wiki ingest src_2026_06_24_upload_existing");
  });

  it("renders structured daemon API failures with path and browser token guidance", async () => {
    // Arrange
    stubFetch(async (input) => {
      if (String(input) === metadataPath) {
        return jsonResponse(enabledMetadata());
      }

      return jsonResponse({
        ok: false,
        error: {
          code: "UPLOAD_AUTH_FAILED",
          message: "Upload authentication failed.",
          hint: "Set the upload token header from runtime metadata.",
        },
        issues: [
          {
            severity: "error",
            code: "UPLOAD_AUTH_FAILED",
            message: "Upload authentication failed.",
            path: "x-llm-wiki-upload-token",
            hint: "Set the upload token header from runtime metadata.",
          },
        ],
      }, 403);
    });
    const form = renderUploadForm();
    await executeGeneratedUploadFormScript();
    await waitFor(() => expect(form.status.textContent).toBe("Local upload daemon is ready."));
    selectMode(form, "text");
    form.titleInput.value = "Rejected Upload";
    form.textInput.value = "Rejected body.\n";

    // Act
    submit(form);

    // Assert
    await waitFor(() => expect(form.status.textContent).toBe("Upload authentication failed."));
    expect(detailValue(form.details, "Code")).toBe("UPLOAD_AUTH_FAILED");
    expect(detailValue(form.details, "Message")).toBe("Upload authentication failed.");
    expect(detailValue(form.details, "Hint")).toBe("Set the upload token header from runtime metadata.");
    expect(detailValue(form.details, "Path")).toBe("x-llm-wiki-upload-token");
    expect(detailValue(form.details, "Browser guidance")).toBe(
      "Check that the local daemon is still running, then refresh this page to load the current upload token.",
    );
  });

  it("renders network failures with daemon guidance when the browser cannot reach the upload endpoint", async () => {
    // Arrange
    stubFetch(async (input) => {
      if (String(input) === metadataPath) {
        return jsonResponse(enabledMetadata());
      }

      throw new TypeError("Failed to fetch");
    });
    const form = renderUploadForm();
    await executeGeneratedUploadFormScript();
    await waitFor(() => expect(form.status.textContent).toBe("Local upload daemon is ready."));
    selectMode(form, "url");
    form.urlInput.value = "https://example.com/source";

    // Act
    submit(form);

    // Assert
    await waitFor(() => expect(form.status.textContent).toBe("Failed to fetch"));
    expect(detailValue(form.details, "Code")).toBe("DAEMON_UNAVAILABLE");
    expect(detailValue(form.details, "Hint")).toBe(
      "Run llm-wiki explore serve --profile local --with-daemon and keep the daemon running.",
    );
    expect(detailValue(form.details, "Browser guidance")).toBe(
      "Check that the local daemon is still running, then refresh this page to load the current upload token.",
    );
  });
});

type RenderedUploadForm = ReturnType<typeof renderUploadForm>;

type BrowserUploadRequest = {
  url: string;
  method: string | undefined;
  token: string | null;
  fields: string[];
};

type LiveUploadDetails = {
  title: string;
  sourceId: string;
  sourceKind: string;
  queueStatus: string;
  sourceCardPath: string;
  originalPath: string;
  queuePath: string;
};

function expectUploadLogEntry(entries: RuntimeLogEntry[], upload: LiveUploadDetails): void {
  const entry = entries.find((candidate) => candidate.affectedId === upload.sourceId);

  expect(entry).toEqual(expect.objectContaining({
    operation: "add",
    affectedId: upload.sourceId,
    title: upload.title,
  }));
  expect(entry?.body).toContain(`- raw_source: ${upload.sourceCardPath}`);
  expect(entry?.body).toContain(`  - ${upload.sourceCardPath}`);
}

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function withTextServer(body: string, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "content-type": "text/plain; charset=utf-8",
    });
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

async function executeGeneratedUploadFormScript(): Promise<void> {
  const script = await generatedUploadFormScript();
  new Function(script)();
}

async function generatedUploadFormScript(): Promise<string> {
  uploadFormScriptPromise ??= generatedUploadFormComponent().then((component) => {
    const match = component.match(/const uploadFormScript = ("(?:\\\\|\\"|[^"])*")/);
    expect(match?.[1]).toEqual(expect.any(String));

    return JSON.parse(match?.[1] ?? "\"\"");
  });

  return uploadFormScriptPromise;
}

async function generatedUploadFormComponent(): Promise<string> {
  uploadFormComponentPromise ??= withTempWorkspace("llm-wiki-upload-form-component-", async (workspaceDir) => {
    const wikiDir = resolve(workspaceDir, "wiki");
    const initResult = await runCliBuffered(["init", wikiDir, "--no-git", "--json"]);
    expect(initResult.exitCode).toBe(0);
    parseInitJson(initResult.stdout);

    const exploreInitResult = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
    expect(exploreInitResult.exitCode).toBe(0);

    return readGeneratedFile(wikiDir, "quartz/components/LlmWikiUploadForm.tsx");
  });

  return uploadFormComponentPromise;
}

function extractGeneratedUploadFormMarkup(component: string): string {
  const markupStart = component.indexOf('<section class="llm-wiki-upload-form"');
  const markupEnd = component.indexOf("LlmWikiUploadForm.afterDOMLoaded = uploadFormScript");
  expect(markupStart).toBeGreaterThanOrEqual(0);
  expect(markupEnd).toBeGreaterThan(markupStart);

  return component.slice(markupStart, markupEnd);
}

function renderUploadForm() {
  document.body.innerHTML = `
    <section class="llm-wiki-upload-form" data-llm-wiki-upload-form="true">
      <form enctype="multipart/form-data" novalidate>
        <fieldset>
          <legend>Source type</legend>
          <label><input type="radio" name="mode" value="file" checked disabled /> File</label>
          <label><input type="radio" name="mode" value="text" disabled /> Text</label>
          <label><input type="radio" name="mode" value="url" disabled /> URL</label>
        </fieldset>
        <label>
          Title
          <input name="title" type="text" autocomplete="off" disabled />
        </label>
        <label>
          File
          <input name="file" type="file" disabled />
        </label>
        <label>
          Text
          <textarea name="text" rows="8" disabled></textarea>
        </label>
        <label>
          URL
          <input name="url" type="url" inputmode="url" disabled />
        </label>
        <button type="submit" disabled>Upload</button>
      </form>
      <p data-upload-status="">Checking local upload daemon...</p>
      <dl data-upload-details=""></dl>
    </section>
  `;

  const root = requireElement("[data-llm-wiki-upload-form]", HTMLElement);
  const form = requireElement("form", HTMLFormElement);
  const status = requireElement("[data-upload-status]", HTMLElement);
  const details = requireElement("[data-upload-details]", HTMLDListElement);
  const titleInput = requireElement<HTMLInputElement>('input[name="title"]', HTMLInputElement);
  const fileInput = requireElement<HTMLInputElement>('input[name="file"]', HTMLInputElement);
  const textInput = requireElement<HTMLTextAreaElement>('textarea[name="text"]', HTMLTextAreaElement);
  const urlInput = requireElement<HTMLInputElement>('input[name="url"]', HTMLInputElement);

  return {
    root,
    form,
    status,
    details,
    titleInput,
    fileInput,
    textInput,
    urlInput,
    enabledControls: () =>
      Array.from(form.elements)
        .filter((element): element is HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement => "disabled" in element)
        .filter((element) => !element.disabled),
  };
}

function selectMode(form: RenderedUploadForm, mode: string): void {
  const radio = requireElement<HTMLInputElement>(`input[name="mode"][value="${mode}"]`, HTMLInputElement);
  radio.checked = true;
  form.form.dispatchEvent(new Event("change", { bubbles: true }));
}

function submit(form: RenderedUploadForm): void {
  form.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

async function submitLiveUpload(
  form: RenderedUploadForm,
  mode: "file" | "text" | "url",
  fill: () => void,
): Promise<LiveUploadDetails> {
  selectMode(form, mode);
  fill();
  submit(form);
  await waitFor(() => expect(form.status.textContent).toBe("Upload queued."));

  const sourceId = detailValue(form.details, "Source ID");
  const sourceCardPath = detailValue(form.details, "Source card");
  const originalPath = detailValue(form.details, "Original");
  expect(sourceId).toEqual(expect.any(String));
  expect(sourceCardPath).toEqual(expect.any(String));
  expect(originalPath).toEqual(expect.any(String));

  return {
    title: detailValue(form.details, "Title") ?? "",
    sourceId: sourceId ?? "",
    sourceKind: detailValue(form.details, "Source kind") ?? "",
    queueStatus: detailValue(form.details, "Queue status") ?? "",
    sourceCardPath: sourceCardPath ?? "",
    originalPath: originalPath ?? "",
    queuePath: `raw/queue/${sourceId}.json`,
  };
}

function captureBrowserUploadRequest(input: string, init: RequestInit | undefined): BrowserUploadRequest {
  const headers = new Headers(init?.headers);

  return {
    url: input,
    method: init?.method,
    token: headers.get(UPLOAD_TOKEN_HEADER),
    fields: init?.body instanceof FormData ? Array.from(init.body.keys()) : [],
  };
}

async function postBrowserFormData(
  nativeFetch: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!(init?.body instanceof FormData)) {
    return nativeFetch(input, init);
  }

  const multipart = await encodeBrowserFormData(init.body);
  const headers = new Headers(init.headers);
  headers.set("content-type", multipart.contentType);

  return nativeFetch(input, {
    ...init,
    headers,
    body: multipart.body,
  });
}

async function encodeBrowserFormData(formData: FormData): Promise<{ body: Blob; contentType: string }> {
  const boundary = `----llm-wiki-browser-upload-${crypto.randomUUID()}`;
  const chunks: Array<string | Blob> = [];

  for (const [name, value] of formData.entries()) {
    chunks.push(`--${boundary}\r\n`);
    if (value instanceof Blob) {
      const fileName = "name" in value && typeof value.name === "string" ? value.name : "blob";
      const contentType = value.type || "application/octet-stream";
      chunks.push(
        `Content-Disposition: form-data; name="${escapeMultipartValue(name)}"; filename="${escapeMultipartValue(fileName)}"\r\n`,
        `Content-Type: ${contentType}\r\n\r\n`,
        value,
        "\r\n",
      );
    } else {
      chunks.push(
        `Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n`,
        `${String(value)}\r\n`,
      );
    }
  }
  chunks.push(`--${boundary}--\r\n`);

  return {
    body: new Blob(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function escapeMultipartValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function detailValue(details: HTMLDListElement, label: string): string | null {
  const terms = Array.from(details.querySelectorAll("dt"));
  const term = terms.find((candidate) => candidate.textContent === label);
  const value = term?.nextElementSibling;
  return value instanceof HTMLElement ? value.textContent : null;
}

function enabledMetadata(overrides: Partial<DaemonMetadata> = {}): DaemonMetadata {
  return {
    enabled: true,
    url: "http://127.0.0.1:32123/",
    upload_path: "/api/raw-upload",
    token_header: "x-test-upload-token",
    upload_token: "secret-token",
    commit_uploads: false,
    auto_ingest_available: false,
    ...overrides,
  };
}

function uploadSuccessResponse(): Response {
  return jsonResponse({
    ok: true,
    data: {
      status: "added",
      title: "Uploaded Research",
      source_id: "src_2026_06_24_upload_abcdef123456",
      source_kind: "text",
      visibility: "private",
      queue_status: "queued",
      queue_path: "raw/queue/src_2026_06_24_upload_abcdef123456.json",
      source_card_path: "raw/inputs/2026/06/upload/_source.md",
      original_path: "raw/inputs/2026/06/upload/original.md",
      created_paths: [
        "raw/inputs/2026/06/upload/original.md",
        "raw/inputs/2026/06/upload/_source.md",
        "raw/queue/src_2026_06_24_upload_abcdef123456.json",
      ],
      commit: {
        attempted: false,
        ok: true,
      },
    },
  }, 201);
}

function uploadDuplicateResponse(): Response {
  return jsonResponse({
    ok: true,
    data: {
      status: "duplicate",
      title: "Already Captured Research",
      source_id: "src_2026_06_24_upload_existing",
      source_kind: "url",
      visibility: "private",
      queue_status: "ingested",
      queue_path: "raw/queue/src_2026_06_24_upload_existing.json",
      source_card_path: "raw/inputs/2026/06/existing/_source.md",
      original_path: "raw/inputs/2026/06/existing/original.url",
      created_paths: [],
      commit: {
        attempted: false,
        ok: true,
      },
    },
  });
}

function stubFetch(implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): FetchMock {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain",
    },
  });
}

function requireElement<T extends Element>(
  selector: string,
  constructor: { new (...args: never[]): T; [Symbol.hasInstance](value: unknown): boolean },
): T {
  const element = document.querySelector(selector);
  expect(element).toBeInstanceOf(constructor);
  return element as T;
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }

  throw lastError;
}
