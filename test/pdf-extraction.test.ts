import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";

import {
  buildPdfCodexArgs,
  buildPdfExtractionTask,
  ensurePreparedPdfArtifactUnderLock,
  extractPdfSource,
  preparePdfExtractionOperation,
  readValidatedPdfArtifact,
  serializeTomlString,
} from "../src/pdf/extraction.js";
import {
  createPdfExtractionProposalPolicy,
  readPdfExtractionSourceState,
  synchronizePdfExtractionState,
  type PdfExtractionState,
} from "../src/pdf/state.js";
import { normalizeFileProposals } from "../src/proposals/index.js";
import { withIngestLock } from "../src/runtime/ingestLock.js";
import { transitionQueueStatus } from "../src/runtime/queue.js";
import { createWiki } from "../src/scaffold/createWiki.js";
import { captureFileSource, captureUploadedFileSource } from "../src/sourceCapture/index.js";
import { pathExists, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "utf8");
const PLUGIN = "pdf@openai-primary-runtime";
const supportsPermissionFailure = process.platform !== "win32"
  && typeof process.getuid === "function"
  && process.getuid() !== 0;

type Fixture = {
  repoRoot: string;
  sourceId: string;
  sourceDir: string;
  originalPath: string;
  queuePath: string;
  sourceCardPath: string;
  fakeLogPath: string;
  executablePath: string;
};

type FakeInvocation = {
  args: string[];
  cwd: string;
  task: string;
};

async function createFakeCodex(workspaceDir: string): Promise<{ executablePath: string; logPath: string }> {
  const binDir = resolve(workspaceDir, "bin");
  const executablePath = resolve(binDir, "codex");
  const logPath = resolve(workspaceDir, "fake-codex.jsonl");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    executablePath,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "const task = fs.readFileSync(0, 'utf8');",
      "fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({args,cwd:process.cwd(),task}) + '\\n');",
      "if (args.includes('plugin')) {",
      "  const version = process.env.FAKE_PLUGIN_VERSION === 'null' ? null : (process.env.FAKE_PLUGIN_VERSION || '1.2.3');",
      `  process.stdout.write(JSON.stringify({installed:[{pluginId:${JSON.stringify(PLUGIN)},installed:true,enabled:true,version}],available:[]}));`,
      "  process.exit(0);",
      "}",
      "const input = task.match(/^PDF input path: (.+)$/m)?.[1];",
      "const output = task.match(/^Permitted output path: (.+)$/m)?.[1];",
      "if (!input || !output) { console.error('missing task paths'); process.exit(2); }",
      "const mode = process.env.FAKE_CODEX_MODE || 'success';",
      "if (mode === 'fail') { console.error('unsupported model or effort from fake Codex'); process.exit(23); }",
      "if (mode === 'timeout') { setTimeout(() => {}, 10000); return; }",
      "if (mode === 'mutate-pdf') {",
      "  const bytes = fs.readFileSync(input);",
      "  bytes[bytes.length - 2] = bytes[bytes.length - 2] === 65 ? 66 : 65;",
      "  fs.chmodSync(input, 0o644);",
      "  fs.writeFileSync(input, bytes);",
      "}",
      "if (mode === 'delete-pdf') fs.unlinkSync(input);",
      "fs.mkdirSync(path.dirname(output), { recursive: true });",
      "if (mode === 'symlink-document') fs.symlinkSync(input, output);",
      "else if (mode === 'directory-document') fs.mkdirSync(output);",
      "else if (mode === 'binary') fs.writeFileSync(output, Buffer.from([0xff, 0xfe]));",
      "else if (mode === 'nul') fs.writeFileSync(output, Buffer.from('# Bad\\n\\0hidden'));",
      "else fs.writeFileSync(output, mode === 'empty' ? '  \\n' : '# Extracted PDF\\n\\nComplete evidence from every page.\\n', 'utf8');",
      "if (mode === 'sibling') fs.writeFileSync(path.join(path.dirname(output), 'metadata.json'), '{}', 'utf8');",
      "if (mode === 'sibling-symlink') fs.symlinkSync(input, path.join(path.dirname(output), 'other.md'));",
      "if (mode === 'extra-directory') fs.mkdirSync(path.join(path.dirname(output), 'pages'));",
      "if (mode === 'rename') { fs.renameSync(output, output + '.moved'); }",
      "if (mode === 'delete-unrelated') { fs.unlinkSync(input); }",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(executablePath, 0o755);
  return { executablePath, logPath };
}

async function createFixture(
  workspaceDir: string,
  input: { model?: string | null; pluginVersion?: string | null; timeoutSeconds?: number } = {},
): Promise<Fixture> {
  const repoRoot = resolve(workspaceDir, "wiki");
  const initialized = await createWiki(repoRoot, {
    agent: "codex",
    obsidian: false,
    dataview: false,
    git: false,
    quartzReady: false,
    force: false,
  });
  expect(initialized.ok).toBe(true);

  const fake = await createFakeCodex(workspaceDir);
  const configPath = resolve(repoRoot, ".llm-wiki/config.yml");
  let config = await readFile(configPath, "utf8");
  config = config.replace("    command: codex", `    command: ${JSON.stringify(fake.executablePath)}`);
  if (input.model !== undefined && input.model !== null) {
    config = config.replace("  reasoning_effort: high", `  model: ${JSON.stringify(input.model)}\n  reasoning_effort: high`);
  }
  if (input.timeoutSeconds !== undefined) {
    config = config.replace(
      "  timeout_seconds: 900\n  require_artifact_before_ingest: true",
      `  timeout_seconds: ${input.timeoutSeconds}\n  require_artifact_before_ingest: true`,
    );
  }
  await writeFile(configPath, config, "utf8");

  const captured = await captureUploadedFileSource({
    repoRoot,
    fileName: "Evidence.PDF",
    title: "PDF Evidence",
    content: PDF_BYTES,
    now: new Date("2026-07-11T01:00:00.000Z"),
  });
  expect(captured.ok).toBe(true);
  if (!captured.ok) {
    throw new Error(captured.error.message);
  }

  const source = captured.value.source;
  return {
    repoRoot,
    sourceId: source.source_id,
    sourceDir: source.source_card_path.replace(/\/_source\.md$/u, ""),
    originalPath: source.original_path,
    queuePath: source.queue_path,
    sourceCardPath: source.source_card_path,
    fakeLogPath: fake.logPath,
    executablePath: fake.executablePath,
  };
}

function extractionEnv(fixture: Fixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FAKE_CODEX_LOG: fixture.fakeLogPath,
    ...extra,
  };
}

async function readInvocations(fixture: Fixture): Promise<FakeInvocation[]> {
  const source = await readFile(fixture.fakeLogPath, "utf8");
  return source.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeInvocation);
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await pathExists(path)) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function readMirroredState(fixture: Fixture): Promise<{
  queue: PdfExtractionState;
  source: PdfExtractionState;
}> {
  const queue = JSON.parse(await readFile(resolve(fixture.repoRoot, fixture.queuePath), "utf8")) as {
    pdf_extraction: PdfExtractionState;
  };
  const sourceCard = await readFile(resolve(fixture.repoRoot, fixture.sourceCardPath), "utf8");
  const frontmatterSource = sourceCard.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
  const frontmatter = parse(frontmatterSource) as { pdf_extraction: PdfExtractionState };
  return { queue: queue.pdf_extraction, source: frontmatter.pdf_extraction };
}

async function removePersistedPdfState(fixture: Fixture, target: "both" | "queue"): Promise<void> {
  const queue = JSON.parse(await readFile(resolve(fixture.repoRoot, fixture.queuePath), "utf8")) as Record<string, unknown>;
  delete queue.pdf_extraction;
  await writeFile(resolve(fixture.repoRoot, fixture.queuePath), `${JSON.stringify(queue, null, 2)}\n`, "utf8");
  if (target === "queue") return;

  const sourcePath = resolve(fixture.repoRoot, fixture.sourceCardPath);
  const source = await readFile(sourcePath, "utf8");
  const match = source.match(/^---\n([\s\S]*?)\n---([\s\S]*)$/u);
  if (match === null) throw new Error("invalid source-card fixture");
  const frontmatter = parse(match[1] ?? "") as Record<string, unknown>;
  delete frontmatter.pdf_extraction;
  await writeFile(sourcePath, `---\n${stringify(frontmatter).trimEnd()}\n---${match[2] ?? ""}`, "utf8");
}

function hash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("PDF extraction primitives", () => {
  it("builds exact shell-free argv, TOML reasoning values, and plugin tasks", () => {
    expect(serializeTomlString('hi"\\\n\t')).toBe('"hi\\"\\\\\\n\\t"');
    expect(buildPdfCodexArgs(
      { globalPrefix: ["--profile", "wiki"], execSuffix: ["--ephemeral"] },
      { model: "gpt-5.2", reasoningEffort: 'high"\\\n', pdfDetail: "low", force: false },
    )).toEqual([
      "--profile",
      "wiki",
      "--model",
      "gpt-5.2",
      "-c",
      'model_reasoning_effort="high\\"\\\\\\n"',
      "exec",
      "--ephemeral",
      "-",
    ]);
    expect(buildPdfCodexArgs(
      { globalPrefix: [], execSuffix: [] },
      { model: null, reasoningEffort: "high", pdfDetail: "high", force: false },
    )).toEqual(["-c", 'model_reasoning_effort="high"', "exec", "-"]);

    const task = buildPdfExtractionTask({
      plugin: PLUGIN,
      pdfDetail: "high",
      inputPath: "raw/inputs/2026/07/src_safe/original.pdf",
      outputPath: "raw/inputs/2026/07/src_safe/extracted/pdf/pdfext_safe/document.md",
    });
    expect(task).toContain(`Required plugin: ${PLUGIN}`);
    expect(task).toContain("PDF detail: high");
    expect(task).toContain("PDF input path: raw/inputs/2026/07/src_safe/original.pdf");
    expect(task).toContain("Permitted output path: raw/inputs/2026/07/src_safe/extracted/pdf/pdfext_safe/document.md");
    expect(task).toContain("complete document content");
    expect(task).toContain("Do not invent missing facts");
    expect(task).toContain("Do not write metadata");
  });

  it("enforces an exact-one-path PDF proposal policy", () => {
    const allowed = "raw/inputs/2026/07/src_safe/extracted/pdf/pdfext_safe/document.md";
    const policy = createPdfExtractionProposalPolicy(allowed);
    expect(normalizeFileProposals({ files: [{ path: allowed, content: "# Good\n" }] }, policy)).toEqual([
      { path: allowed, content: "# Good\n" },
    ]);
    for (const path of [
      "raw/inputs/2026/07/src_safe/original.pdf",
      "raw/inputs/2026/07/src_safe/_source.md",
      "raw/queue/src_safe.json",
      "curated/index.md",
      `${allowed}/../metadata.json`,
    ]) {
      expect(() => normalizeFileProposals({ files: [{ path, content: "bad" }] }, policy)).toThrowError(
        expect.objectContaining({ code: "PDF_WORKSPACE_MUTATION_REJECTED" }),
      );
    }
  });
});

describe("PDF extraction lifecycle", () => {
  it("executes the public extract pdf command with stable JSON and structured process errors", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-cli-", async (workspaceDir) => {
      const success = await createFixture(workspaceDir, { model: "gpt-5.2" });
      const previousLog = process.env.FAKE_CODEX_LOG;
      const previousMode = process.env.FAKE_CODEX_MODE;
      try {
        process.env.FAKE_CODEX_LOG = success.fakeLogPath;
        delete process.env.FAKE_CODEX_MODE;
        const result = await runCliBuffered([
          "extract",
          "pdf",
          success.sourceId,
          "--pdf-detail",
          "low",
          "--repo",
          success.repoRoot,
          "--json",
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(JSON.parse(result.stdout[0]) as Record<string, unknown>).toMatchObject({
          ok: true,
          command: "extract pdf",
          data: {
            outcome: "extracted",
            source_id: success.sourceId,
            pdf_extraction: { status: "extracted", pdf_detail: "low" },
          },
        });

        const failure = await createFixture(resolve(workspaceDir, "failure"), { model: "gpt-5.2" });
        process.env.FAKE_CODEX_LOG = failure.fakeLogPath;
        process.env.FAKE_CODEX_MODE = "fail";
        const failed = await runCliBuffered([
          "extract",
          "pdf",
          failure.sourceId,
          "--repo",
          failure.repoRoot,
          "--json",
        ]);
        expect(failed.exitCode).toBe(1);
        expect(JSON.parse(failed.stdout[0]) as Record<string, unknown>).toMatchObject({
          ok: false,
          command: "extract pdf",
          error: {
            code: "PDF_CODEX_EXTRACTION_FAILED",
            executable: failure.executablePath,
            exit_code: 23,
            stderr_tail: expect.stringContaining("unsupported model or effort"),
            timed_out: false,
            workspace_mutations_observed: false,
          },
        });
      } finally {
        if (previousLog === undefined) delete process.env.FAKE_CODEX_LOG;
        else process.env.FAKE_CODEX_LOG = previousLog;
        if (previousMode === undefined) delete process.env.FAKE_CODEX_MODE;
        else process.env.FAKE_CODEX_MODE = previousMode;
      }
    });
  });

  it("initializes mirrored pending state and creates one immutable validated run", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-success-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir, { model: "gpt-5.2" });
      const pending = await readMirroredState(fixture);
      expect(pending.queue).toEqual(pending.source);
      expect(pending.queue).toMatchObject({
        required: true,
        status: "pending",
        extraction_id: null,
        artifact_path: null,
        original_hash: hash(PDF_BYTES),
      });

      const originalBefore = await readFile(resolve(fixture.repoRoot, fixture.originalPath));
      const result = await extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        env: extractionEnv(fixture),
        now: (() => {
          const values = [
            new Date("2026-07-11T02:00:00.000Z"),
            new Date("2026-07-11T02:00:01.000Z"),
          ];
          return () => values.shift() ?? new Date("2026-07-11T02:00:01.000Z");
        })(),
        generateExtractionId: () => "pdfext_20260711T020000000Z_a1b2c3d4",
      });

      expect(result).toMatchObject({
        outcome: "extracted",
        source_id: fixture.sourceId,
        extraction_id: "pdfext_20260711T020000000Z_a1b2c3d4",
        recovered_interrupted: false,
      });
      const runDir = resolve(fixture.repoRoot, fixture.sourceDir, "extracted/pdf", result.extraction_id);
      expect((await readdir(runDir)).sort()).toEqual(["document.md", "metadata.json"]);
      const document = await readFile(resolve(runDir, "document.md"), "utf8");
      const metadataSource = await readFile(resolve(runDir, "metadata.json"), "utf8");
      const metadata = JSON.parse(metadataSource) as Record<string, unknown>;
      expect(document).toContain("Complete evidence from every page");
      expect(metadata).toMatchObject({
        schema_version: 1,
        source_id: fixture.sourceId,
        extraction_id: result.extraction_id,
        status: "extracted",
        original_path: fixture.originalPath,
        original_hash: hash(PDF_BYTES),
        artifact_path: `${fixture.sourceDir}/extracted/pdf/${result.extraction_id}/document.md`,
        artifact_hash: hash(Buffer.from(document)),
        artifact_bytes: Buffer.byteLength(document),
        plugin: PLUGIN,
        plugin_version: "1.2.3",
        plugin_descriptor: `${PLUGIN}#version:1.2.3`,
        model_selection: "explicit",
        requested_model: "gpt-5.2",
        model_descriptor: "explicit:gpt-5.2",
        observed_model: null,
        reasoning_effort: "high",
        pdf_detail: "high",
        codex_agent: "codex",
        codex_version: null,
        started_at: "2026-07-11T02:00:00.000Z",
        finished_at: "2026-07-11T02:00:01.000Z",
      });
      expect(metadataSource.endsWith("\n")).toBe(true);
      expect(await readFile(resolve(fixture.repoRoot, fixture.originalPath))).toEqual(originalBefore);

      const state = await readMirroredState(fixture);
      expect(state.queue).toEqual(state.source);
      expect(state.queue).toMatchObject({
        status: "extracted",
        extraction_id: result.extraction_id,
        artifact_path: metadata.artifact_path,
        last_error_code: null,
        last_error_message: null,
      });
      const queue = JSON.parse(await readFile(resolve(fixture.repoRoot, fixture.queuePath), "utf8")) as {
        status: string;
      };
      expect(queue.status).toBe("queued");
      expect(await pathExists(resolve(fixture.repoRoot, ".llm-wiki/cache/locks/ingest.lock"))).toBe(false);
      await expect(readValidatedPdfArtifact(fixture.repoRoot, fixture.sourceId)).resolves.toMatchObject({
        metadata: { extraction_id: result.extraction_id },
        content: expect.stringContaining("Complete evidence"),
      });

      const invocations = await readInvocations(fixture);
      expect(invocations).toHaveLength(2);
      expect(invocations[0]?.args).toContain("plugin");
      expect(invocations[1]?.args).toEqual([
        "--ask-for-approval",
        "never",
        "--sandbox",
        "workspace-write",
        "--model",
        "gpt-5.2",
        "-c",
        'model_reasoning_effort="high"',
        "exec",
        "-",
      ]);
      expect(invocations[1]?.cwd).not.toBe(fixture.repoRoot);
      expect(invocations[1]?.task).toContain("PDF detail: high");
    });
  });

  it("derives legacy pending state read-only and rejects one-sided mirrored state", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-legacy-state-", async (workspaceDir) => {
      const legacy = await createFixture(workspaceDir, { model: "gpt-5.2" });
      await removePersistedPdfState(legacy, "both");
      const queueBefore = await readFile(resolve(legacy.repoRoot, legacy.queuePath), "utf8");
      const sourceBefore = await readFile(resolve(legacy.repoRoot, legacy.sourceCardPath), "utf8");
      const derived = await readPdfExtractionSourceState(legacy.repoRoot, legacy.sourceId);
      expect(derived).toMatchObject({ statePersisted: false, state: { status: "pending" } });
      expect(await readFile(resolve(legacy.repoRoot, legacy.queuePath), "utf8")).toBe(queueBefore);
      expect(await readFile(resolve(legacy.repoRoot, legacy.sourceCardPath), "utf8")).toBe(sourceBefore);

      const inconsistent = await createFixture(resolve(workspaceDir, "one-sided"), { model: "gpt-5.2" });
      await removePersistedPdfState(inconsistent, "queue");
      await expect(readPdfExtractionSourceState(inconsistent.repoRoot, inconsistent.sourceId)).rejects.toMatchObject({
        code: "PDF_ARTIFACT_INCONSISTENT",
      });
      expect(await pathExists(inconsistent.fakeLogPath)).toBe(false);
    });
  });

  it.skipIf(!supportsPermissionFailure)("rolls back both mirrors when the second state write fails", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-state-rollback-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir, { model: "gpt-5.2" });
      const source = await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId);
      const queueAbsolute = resolve(fixture.repoRoot, fixture.queuePath);
      const queueBefore = await readFile(queueAbsolute, "utf8");
      const sourceBefore = await readFile(resolve(fixture.repoRoot, fixture.sourceCardPath), "utf8");
      const running: PdfExtractionState = {
        ...source.state,
        status: "running",
        extraction_id: "pdfext_20260711T025500000Z_rollback",
        reasoning_effort: "high",
        pdf_detail: "high",
        started_at: "2026-07-11T02:55:00.000Z",
        updated_at: "2026-07-11T02:55:00.000Z",
      };
      await chmod(queueAbsolute, 0o444);
      try {
        await expect(synchronizePdfExtractionState(fixture.repoRoot, source, running)).rejects.toMatchObject({
          code: "PDF_STATE_WRITE_FAILED",
        });
      } finally {
        await chmod(queueAbsolute, 0o644);
      }
      expect(await readFile(queueAbsolute, "utf8")).toBe(queueBefore);
      expect(await readFile(resolve(fixture.repoRoot, fixture.sourceCardPath), "utf8")).toBe(sourceBefore);
    });
  });

  it.each([
    ["sibling", "PDF_WORKSPACE_MUTATION_REJECTED"],
    ["rename", "PDF_WORKSPACE_MUTATION_REJECTED"],
    ["mutate-pdf", "PDF_ORIGINAL_CHANGED"],
    ["delete-pdf", "PDF_ORIGINAL_CHANGED"],
    ["symlink-document", "PDF_DOCUMENT_INVALID"],
    ["directory-document", "PDF_DOCUMENT_INVALID"],
    ["binary", "PDF_DOCUMENT_INVALID"],
    ["nul", "PDF_DOCUMENT_INVALID"],
    ["empty", "PDF_DOCUMENT_INVALID"],
    ["sibling-symlink", "PDF_WORKSPACE_MUTATION_REJECTED"],
    ["extra-directory", "PDF_WORKSPACE_MUTATION_REJECTED"],
    ["fail", "PDF_CODEX_EXTRACTION_FAILED"],
  ])("rejects %s extraction attempts and commits only failed mirrored state", async (mode, code) => {
    await withTempWorkspace("llm-wiki-pdf-extraction-rejected-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir, { model: "gpt-5.2" });
      const originalBefore = await readFile(resolve(fixture.repoRoot, fixture.originalPath));

      await expect(extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        env: extractionEnv(fixture, { FAKE_CODEX_MODE: mode }),
        generateExtractionId: () => `pdfext_20260711T030000000Z_${mode.replaceAll("-", "").slice(0, 8)}`,
      })).rejects.toMatchObject({ code });

      const state = await readMirroredState(fixture);
      expect(state.queue).toEqual(state.source);
      expect(state.queue).toMatchObject({
        status: "failed",
        artifact_path: null,
        last_error_code: code,
      });
      expect(await readFile(resolve(fixture.repoRoot, fixture.originalPath))).toEqual(originalBefore);
      const runsRoot = resolve(fixture.repoRoot, fixture.sourceDir, "extracted/pdf");
      if (await pathExists(runsRoot)) {
        expect(await readdir(runsRoot)).toEqual([]);
      }
      expect((JSON.parse(await readFile(resolve(fixture.repoRoot, fixture.queuePath), "utf8")) as { status: string }).status)
        .toBe("queued");
    });
  });

  it("terminates extraction at the configured timeout without fallback", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-timeout-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir, { model: "gpt-5.2", timeoutSeconds: 1 });
      await expect(extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        env: extractionEnv(fixture, { FAKE_CODEX_MODE: "timeout" }),
        generateExtractionId: () => "pdfext_20260711T035959000Z_timeout1",
      })).rejects.toMatchObject({
        code: "PDF_EXTRACTION_TIMEOUT",
        executable: fixture.executablePath,
        timedOut: true,
      });
      expect((await readMirroredState(fixture)).queue).toMatchObject({
        status: "failed",
        last_error_code: "PDF_EXTRACTION_TIMEOUT",
      });
    });
  });

  it("reuses only stable matching runs and force or changed settings create unique runs", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-reuse-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir, { model: "gpt-5.2" });
      const ids = [
        "pdfext_20260711T040000000Z_11111111",
        "pdfext_20260711T040001000Z_22222222",
        "pdfext_20260711T040002000Z_33333333",
      ];
      const run = (overrides: { pdfDetail?: "auto" | "low" | "high"; force?: boolean } = {}) => extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        overrides,
        env: extractionEnv(fixture),
        generateExtractionId: () => ids.shift() ?? "pdfext_unexpected",
      });

      const first = await run();
      const reused = await run();
      const changed = await run({ pdfDetail: "low" });
      const forced = await run({ pdfDetail: "low", force: true });

      expect(first.outcome).toBe("extracted");
      expect(reused).toMatchObject({ outcome: "reused", extraction_id: first.extraction_id });
      expect(changed).toMatchObject({ outcome: "extracted", extraction_id: "pdfext_20260711T040001000Z_22222222" });
      expect(forced).toMatchObject({ outcome: "extracted", extraction_id: "pdfext_20260711T040002000Z_33333333" });
      const invocations = await readInvocations(fixture);
      expect(invocations.filter((call) => call.args.includes("exec"))).toHaveLength(3);
      const runs = await readdir(resolve(fixture.repoRoot, fixture.sourceDir, "extracted/pdf"));
      expect(runs.sort()).toEqual([
        first.extraction_id,
        changed.extraction_id,
        forced.extraction_id,
      ].sort());
    });
  });

  it("preserves historical runs after a forced failure and later reselects a matching success", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-force-failure-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir, { model: "gpt-5.2" });
      const first = await extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        env: extractionEnv(fixture),
        generateExtractionId: () => "pdfext_20260711T041000000Z_aaaaaaaa",
      });
      const historicalMetadataPath = resolve(
        fixture.repoRoot,
        fixture.sourceDir,
        "extracted/pdf",
        first.extraction_id,
        "metadata.json",
      );
      const historicalBefore = await readFile(historicalMetadataPath, "utf8");

      await expect(extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        overrides: { force: true },
        env: extractionEnv(fixture, { FAKE_CODEX_MODE: "fail" }),
        generateExtractionId: () => "pdfext_20260711T041001000Z_bbbbbbbb",
      })).rejects.toMatchObject({ code: "PDF_CODEX_EXTRACTION_FAILED" });
      expect((await readMirroredState(fixture)).queue).toMatchObject({ status: "failed", artifact_path: null });
      expect(await readFile(historicalMetadataPath, "utf8")).toBe(historicalBefore);

      const reselected = await extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        env: extractionEnv(fixture),
      });
      expect(reselected).toMatchObject({ outcome: "reused", extraction_id: first.extraction_id });
      expect(await readFile(historicalMetadataPath, "utf8")).toBe(historicalBefore);
    });
  });

  it.each([
    ["inherited model", {}, {}],
    ["versionless plugin", { model: "gpt-5.2" }, { FAKE_PLUGIN_VERSION: "null" }],
  ])("conservatively avoids future reuse for $name", async (_name, configInput, envExtra) => {
    await withTempWorkspace("llm-wiki-pdf-extraction-non-reusable-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir, configInput as { model?: string });
      const ids = ["pdfext_20260711T050000000Z_11111111", "pdfext_20260711T050001000Z_22222222"];
      const input = {
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        env: extractionEnv(fixture, envExtra as Record<string, string>),
        generateExtractionId: () => ids.shift() ?? "pdfext_unexpected",
      };
      const first = await extractPdfSource(input);
      const second = await extractPdfSource(input);
      expect(first.outcome).toBe("extracted");
      expect(second).toMatchObject({ outcome: "extracted" });
      expect(second.extraction_id).not.toBe(first.extraction_id);
    });
  });

  it.each(["blocked", "ingesting", "ingested"] as const)(
    "rejects %s explicit extraction before Codex or repository mutation",
    async (status) => {
      await withTempWorkspace("llm-wiki-pdf-extraction-status-", async (workspaceDir) => {
        const fixture = await createFixture(workspaceDir, { model: "gpt-5.2" });
        expect((await transitionQueueStatus(fixture.repoRoot, fixture.sourceId, "ingesting")).ok).toBe(true);
        if (status !== "ingesting") {
          expect((await transitionQueueStatus(fixture.repoRoot, fixture.sourceId, status)).ok).toBe(true);
        }
        const queueBefore = await readFile(resolve(fixture.repoRoot, fixture.queuePath), "utf8");
        const sourceBefore = await readFile(resolve(fixture.repoRoot, fixture.sourceCardPath), "utf8");

        await expect(extractPdfSource({
          repoRoot: fixture.repoRoot,
          sourceId: fixture.sourceId,
          env: extractionEnv(fixture),
        })).rejects.toMatchObject({
          code: "PDF_SOURCE_STATUS_INVALID",
          hint: status === "blocked"
            ? expect.stringContaining(`queue set-status ${fixture.sourceId} queued`)
            : expect.any(String),
        });
        expect(await readFile(resolve(fixture.repoRoot, fixture.queuePath), "utf8")).toBe(queueBefore);
        expect(await readFile(resolve(fixture.repoRoot, fixture.sourceCardPath), "utf8")).toBe(sourceBefore);
        expect(await pathExists(fixture.fakeLogPath)).toBe(false);
      });
    },
  );

  it("initializes pending state for direct file capture and omits it for non-PDF files", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-file-capture-", async (workspaceDir) => {
      const repoRoot = resolve(workspaceDir, "wiki");
      const initialized = await createWiki(repoRoot, {
        agent: "generic",
        obsidian: false,
        dataview: false,
        git: false,
        quartzReady: false,
        force: false,
      });
      expect(initialized.ok).toBe(true);
      const pdfPath = resolve(workspaceDir, "direct.PdF");
      const textPath = resolve(workspaceDir, "notes.txt");
      await writeFile(pdfPath, PDF_BYTES);
      await writeFile(textPath, "not a pdf", "utf8");

      const pdf = await captureFileSource({ repoRoot, sourcePath: pdfPath, now: new Date("2026-07-11T08:00:00.000Z") });
      const text = await captureFileSource({ repoRoot, sourcePath: textPath, now: new Date("2026-07-11T08:01:00.000Z") });
      expect(pdf).toMatchObject({ ok: true, value: { source: { pdf_extraction: { status: "pending" } } } });
      expect(text).toMatchObject({ ok: true, value: { source: { source_kind: "file" } } });
      if (text.ok) expect(text.value.source.pdf_extraction).toBeUndefined();
    });
  });

  it("recovers interrupted running state under the lock and supports caller-owned lock leases", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-lock-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir, { model: "gpt-5.2" });
      const source = await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId);
      const interrupted: PdfExtractionState = {
        ...source.state,
        status: "running",
        extraction_id: "pdfext_interrupted_11111111",
        artifact_path: null,
        model_descriptor: "explicit:gpt-5.2",
        reasoning_effort: "high",
        pdf_detail: "high",
        started_at: "2026-07-11T06:00:00.000Z",
        finished_at: null,
        updated_at: "2026-07-11T06:00:00.000Z",
      };
      await synchronizePdfExtractionState(fixture.repoRoot, source, interrupted);

      const result = await extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        env: extractionEnv(fixture),
        generateExtractionId: () => "pdfext_20260711T060001000Z_22222222",
      });
      expect(result).toMatchObject({ outcome: "extracted", recovered_interrupted: true });

      const secondFixture = await createFixture(resolve(workspaceDir, "caller"), { model: "gpt-5.2" });
      const prepared = await preparePdfExtractionOperation({
        repoRoot: secondFixture.repoRoot,
        sourceId: secondFixture.sourceId,
        env: extractionEnv(secondFixture),
        generateExtractionId: () => "pdfext_20260711T060002000Z_33333333",
      });
      const callerOwned = await withIngestLock(
        secondFixture.repoRoot,
        { label: "test-caller-owned" },
        (lease) => ensurePreparedPdfArtifactUnderLock(prepared, lease),
      );
      expect(callerOwned.outcome).toBe("extracted");
    });
  });

  it("releases the lock and repeats read-only preflight when PDF configuration changes", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-config-race-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir, { model: "gpt-5.2" });
      let releaseHolder: (() => void) | undefined;
      let holderAcquired: (() => void) | undefined;
      const release = new Promise<void>((resolveRelease) => {
        releaseHolder = resolveRelease;
      });
      const acquired = new Promise<void>((resolveAcquired) => {
        holderAcquired = resolveAcquired;
      });
      const holder = withIngestLock(fixture.repoRoot, { label: "config-race-holder" }, async () => {
        holderAcquired?.();
        await release;
      });
      await acquired;

      const extraction = extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        env: extractionEnv(fixture),
        generateExtractionId: () => "pdfext_20260711T065000000Z_55555555",
      });
      await waitForPath(fixture.fakeLogPath);
      const configPath = resolve(fixture.repoRoot, ".llm-wiki/config.yml");
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8")).replace("  reasoning_effort: high", "  reasoning_effort: medium"),
        "utf8",
      );
      releaseHolder?.();
      await holder;
      const result = await extraction;

      expect(result.outcome).toBe("extracted");
      const invocations = await readInvocations(fixture);
      expect(invocations.filter((call) => call.args.includes("plugin"))).toHaveLength(2);
      expect(invocations.filter((call) => call.args.includes("exec"))).toHaveLength(1);
      expect(invocations.find((call) => call.args.includes("exec"))?.args).toContain(
        'model_reasoning_effort="medium"',
      );
    });
  });

  it("preserves a successful extraction state and immutable run on duplicate capture", async () => {
    await withTempWorkspace("llm-wiki-pdf-extraction-duplicate-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir, { model: "gpt-5.2" });
      const extracted = await extractPdfSource({
        repoRoot: fixture.repoRoot,
        sourceId: fixture.sourceId,
        env: extractionEnv(fixture),
        generateExtractionId: () => "pdfext_20260711T070000000Z_44444444",
      });
      const queueBefore = await readFile(resolve(fixture.repoRoot, fixture.queuePath), "utf8");
      const sourceBefore = await readFile(resolve(fixture.repoRoot, fixture.sourceCardPath), "utf8");
      const runBefore = await readFile(resolve(
        fixture.repoRoot,
        fixture.sourceDir,
        "extracted/pdf",
        extracted.extraction_id,
        "metadata.json",
      ), "utf8");

      const duplicate = await captureUploadedFileSource({
        repoRoot: fixture.repoRoot,
        fileName: "duplicate.pdf",
        title: "Different title",
        content: PDF_BYTES,
        now: new Date("2026-07-12T00:00:00.000Z"),
      });
      expect(duplicate).toMatchObject({ ok: true, value: { status: "duplicate" } });
      expect(await readFile(resolve(fixture.repoRoot, fixture.queuePath), "utf8")).toBe(queueBefore);
      expect(await readFile(resolve(fixture.repoRoot, fixture.sourceCardPath), "utf8")).toBe(sourceBefore);
      expect(await readFile(resolve(
        fixture.repoRoot,
        fixture.sourceDir,
        "extracted/pdf",
        extracted.extraction_id,
        "metadata.json",
      ), "utf8")).toBe(runBefore);
    });
  });
});
