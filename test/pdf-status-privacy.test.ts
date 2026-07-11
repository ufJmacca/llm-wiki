import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { runCliBuffered, withTempWorkspace } from "./helpers/init.js";
import { lintWiki } from "../src/lint/index.js";
import {
  readPdfRepositoryStatuses,
  readPdfSourceStatus,
  type PdfSourceStatus,
} from "../src/pdf/status.js";
import {
  readPdfExtractionSourceState,
  synchronizePdfExtractionState,
  type PdfExtractionState,
} from "../src/pdf/state.js";
import { readWikiProfile } from "../src/profiles/index.js";
import { buildReviewDataModel, filterReviewScanForProfile } from "../src/quartz/reviewData.js";
import { initializeQuartzRuntime, syncQuartzContent } from "../src/quartz/index.js";
import { scanWikiRepository } from "../src/scanner/repo.js";
import { scanStaticOutputLeaks } from "../src/scanner/staticLeaks.js";
import { createWiki } from "../src/scaffold/createWiki.js";
import { captureUploadedFileSource } from "../src/sourceCapture/index.js";

const PDF_BYTES = Buffer.from("%PDF-1.7\nphase four evidence\n%%EOF\n", "utf8");
const DOCUMENT_CONTENT = "# Private extracted evidence\n\nPHASE4_PRIVATE_DOCUMENT_SENTINEL\n";
const STARTED_AT = "2026-07-11T10:00:00.000Z";
const FINISHED_AT = "2026-07-11T10:01:00.000Z";
const PLUGIN = "pdf@openai-primary-runtime";

type Fixture = {
  repoRoot: string;
  sourceId: string;
  sourceDir: string;
  sourceCardPath: string;
  queuePath: string;
  originalPath: string;
  originalHash: string;
};

async function createFixture(workspaceDir: string): Promise<Fixture> {
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
  await appendPdfConfig(repoRoot);
  const captured = await captureUploadedFileSource({
    repoRoot,
    fileName: "Privacy.pdf",
    title: "Private PDF",
    content: PDF_BYTES,
    now: new Date("2026-07-11T09:00:00.000Z"),
  });
  expect(captured.ok).toBe(true);
  if (!captured.ok) throw new Error(captured.error.message);
  const source = captured.value.source;
  return {
    repoRoot,
    sourceId: source.source_id,
    sourceDir: source.source_card_path.replace(/\/_source\.md$/u, ""),
    sourceCardPath: source.source_card_path,
    queuePath: source.queue_path,
    originalPath: source.original_path,
    originalHash: `sha256:${createHash("sha256").update(PDF_BYTES).digest("hex")}`,
  };
}

async function appendPdfConfig(repoRoot: string): Promise<void> {
  const path = resolve(repoRoot, ".llm-wiki/config.yml");
  await writeFile(path, `${(await readFile(path, "utf8")).trimEnd()}\npdf_ingestion:\n  codex_agent: codex\n  required_plugin: ${PLUGIN}\n  model: gpt-phase4\n  reasoning_effort: high\n  pdf_detail: high\n  timeout_seconds: 900\n  require_artifact_before_ingest: true\n`, "utf8");
}

function runState(fixture: Fixture, status: "running" | "failed"): PdfExtractionState {
  return {
    required: true,
    status,
    extraction_id: "pdfext_phase4_run_0001",
    artifact_path: null,
    original_hash: fixture.originalHash,
    plugin: PLUGIN,
    plugin_version: "1.2.3",
    plugin_descriptor: `${PLUGIN}#version:1.2.3`,
    model_descriptor: "explicit:gpt-phase4",
    reasoning_effort: "high",
    pdf_detail: "high",
    started_at: STARTED_AT,
    finished_at: status === "failed" ? FINISHED_AT : null,
    updated_at: status === "failed" ? FINISHED_AT : STARTED_AT,
    last_error_code: status === "failed" ? "PDF_CODEX_EXTRACTION_FAILED" : null,
    last_error_message: status === "failed" ? "safe failure summary" : null,
  };
}

async function selectExtractedRun(fixture: Fixture): Promise<{ state: PdfExtractionState; metadataPath: string }> {
  const extractionId = "pdfext_phase4_run_0001";
  const artifactPath = `${fixture.sourceDir}/extracted/pdf/${extractionId}/document.md`;
  const metadataPath = `${fixture.sourceDir}/extracted/pdf/${extractionId}/metadata.json`;
  const document = Buffer.from(DOCUMENT_CONTENT, "utf8");
  const metadata = {
    schema_version: 1,
    source_id: fixture.sourceId,
    extraction_id: extractionId,
    status: "extracted",
    original_path: fixture.originalPath,
    original_hash: fixture.originalHash,
    artifact_path: artifactPath,
    artifact_hash: `sha256:${createHash("sha256").update(document).digest("hex")}`,
    artifact_bytes: document.byteLength,
    plugin: PLUGIN,
    plugin_version: "1.2.3",
    plugin_descriptor: `${PLUGIN}#version:1.2.3`,
    model_selection: "explicit",
    requested_model: "gpt-phase4",
    model_descriptor: "explicit:gpt-phase4",
    observed_model: null,
    reasoning_effort: "high",
    pdf_detail: "high",
    codex_agent: "codex",
    codex_version: "0.1.0",
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
  };
  await mkdir(resolve(fixture.repoRoot, `${fixture.sourceDir}/extracted/pdf/${extractionId}`), { recursive: true });
  await writeFile(resolve(fixture.repoRoot, artifactPath), document);
  await writeFile(resolve(fixture.repoRoot, metadataPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const state: PdfExtractionState = {
    required: true,
    status: "extracted",
    extraction_id: extractionId,
    artifact_path: artifactPath,
    original_hash: fixture.originalHash,
    plugin: PLUGIN,
    plugin_version: "1.2.3",
    plugin_descriptor: `${PLUGIN}#version:1.2.3`,
    model_descriptor: "explicit:gpt-phase4",
    reasoning_effort: "high",
    pdf_detail: "high",
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    updated_at: FINISHED_AT,
    last_error_code: null,
    last_error_message: null,
  };
  const source = await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId);
  await synchronizePdfExtractionState(fixture.repoRoot, source, state);
  return { state, metadataPath };
}

async function setMirroredState(fixture: Fixture, state: PdfExtractionState): Promise<void> {
  const source = await readPdfExtractionSourceState(fixture.repoRoot, fixture.sourceId);
  await synchronizePdfExtractionState(fixture.repoRoot, source, state);
}

async function mutateQueuePdfState(fixture: Fixture, mutate: (state: Record<string, unknown>) => void): Promise<void> {
  const path = resolve(fixture.repoRoot, fixture.queuePath);
  const queue = JSON.parse(await readFile(path, "utf8")) as { pdf_extraction: Record<string, unknown> };
  mutate(queue.pdf_extraction);
  await writeFile(path, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
}

async function mutateBothPdfStates(fixture: Fixture, mutate: (state: Record<string, unknown>) => void): Promise<void> {
  await mutateQueuePdfState(fixture, mutate);
  const path = resolve(fixture.repoRoot, fixture.sourceCardPath);
  const source = await readFile(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---([\s\S]*)$/u.exec(source);
  if (match === null) throw new Error("invalid source fixture");
  const frontmatter = parse(match[1] ?? "") as { pdf_extraction: Record<string, unknown> };
  mutate(frontmatter.pdf_extraction);
  await writeFile(path, `---\n${stringify(frontmatter).trimEnd()}\n---${match[2] ?? ""}`, "utf8");
}

function expectContentFree(status: PdfSourceStatus): void {
  expect(JSON.stringify(status)).not.toContain("PHASE4_PRIVATE_DOCUMENT_SENTINEL");
  expect(status.retry_command).toBe(`llm-wiki extract pdf ${status.source_id}`);
}

describe("normalized PDF status", () => {
  it("reports pending, running, failed, and extracted independently from queue status", async () => {
    await withTempWorkspace("llm-wiki-pdf-status-states-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const pending = await readPdfSourceStatus(fixture.repoRoot, fixture.sourceId);
      expect(pending).toMatchObject({ extraction_status: "pending", artifact_health: "missing" });

      await setMirroredState(fixture, runState(fixture, "running"));
      const running = await readPdfSourceStatus(fixture.repoRoot, fixture.sourceId);
      expect(running).toMatchObject({ queue_status: "queued", extraction_status: "running", artifact_health: "missing" });

      const failedState = runState(fixture, "failed");
      failedState.last_error_code = "PHASE4_PRIVATE_DOCUMENT_SENTINEL";
      failedState.last_error_message = "PHASE4_PRIVATE_DOCUMENT_SENTINEL";
      await setMirroredState(fixture, failedState);
      const failed = await readPdfSourceStatus(fixture.repoRoot, fixture.sourceId);
      expect(failed).toMatchObject({
        extraction_status: "failed",
        artifact_health: "missing",
        last_error_code: "PDF_CODEX_EXTRACTION_FAILED",
        last_error_message: "PDF extraction failed; use the error code and retry guidance to inspect it locally.",
      });

      await selectExtractedRun(fixture);
      const extracted = await readPdfSourceStatus(fixture.repoRoot, fixture.sourceId);
      expect(extracted).toMatchObject({
        extraction_status: "extracted",
        artifact_health: "valid",
        extraction_id: "pdfext_phase4_run_0001",
        plugin: PLUGIN,
        plugin_version: "1.2.3",
        model_selection: "explicit",
        requested_model: "gpt-phase4",
        model_descriptor: "explicit:gpt-phase4",
        observed_model: null,
        reasoning_effort: "high",
        pdf_detail: "high",
        codex_agent: "codex",
        codex_version: "0.1.0",
        reusable: true,
      });
      expect(await readPdfSourceStatus(fixture.repoRoot, fixture.sourceId, {
        checkCurrentPluginDescriptor: true,
        currentPluginDescriptor: `${PLUGIN}#version:2.0.0`,
      })).toMatchObject({ artifact_health: "stale", reusable: false });
      expect(await readPdfSourceStatus(fixture.repoRoot, fixture.sourceId, {
        checkCurrentPluginDescriptor: true,
        currentPluginDescriptor: null,
      })).toMatchObject({ artifact_health: "valid", reusable: false });
      for (const status of [pending, running, failed, extracted]) {
        expect(status).not.toBeNull();
        if (status !== null) expectContentFree(status);
      }
    });
  });

  it("distinguishes missing, stale, malformed, unsafe, and inconsistent selections", async () => {
    await withTempWorkspace("llm-wiki-pdf-status-diagnosis-", async (workspaceDir) => {
      const missingFixture = await createFixture(resolve(workspaceDir, "missing"));
      const missingState = runState(missingFixture, "running");
      missingState.status = "extracted";
      missingState.artifact_path = `${missingFixture.sourceDir}/extracted/pdf/${missingState.extraction_id}/document.md`;
      missingState.finished_at = FINISHED_AT;
      await setMirroredState(missingFixture, missingState);
      expect(await readPdfSourceStatus(missingFixture.repoRoot, missingFixture.sourceId)).toMatchObject({ artifact_health: "missing" });

      const staleFixture = await createFixture(resolve(workspaceDir, "stale"));
      await selectExtractedRun(staleFixture);
      const staleConfigPath = resolve(staleFixture.repoRoot, ".llm-wiki/config.yml");
      await writeFile(staleConfigPath, (await readFile(staleConfigPath, "utf8")).replace("reasoning_effort: high", "reasoning_effort: medium"), "utf8");
      expect(await readPdfSourceStatus(staleFixture.repoRoot, staleFixture.sourceId)).toMatchObject({ artifact_health: "stale", diagnosis_code: "PDF_ARTIFACT_STALE" });

      const malformedFixture = await createFixture(resolve(workspaceDir, "malformed"));
      await mutateQueuePdfState(malformedFixture, (state) => { state.status = "unknown"; });
      expect(await readPdfSourceStatus(malformedFixture.repoRoot, malformedFixture.sourceId)).toMatchObject({ artifact_health: "inconsistent", diagnosis_code: "PDF_ARTIFACT_INCONSISTENT" });

      const disagreementFixture = await createFixture(resolve(workspaceDir, "disagreement"));
      await setMirroredState(disagreementFixture, runState(disagreementFixture, "running"));
      await mutateQueuePdfState(disagreementFixture, (state) => {
        state.status = "failed";
        state.finished_at = FINISHED_AT;
        state.updated_at = FINISHED_AT;
        state.last_error_code = "PDF_CODEX_EXTRACTION_FAILED";
        state.last_error_message = "safe failure summary";
      });
      expect(await readPdfSourceStatus(disagreementFixture.repoRoot, disagreementFixture.sourceId)).toMatchObject({
        extraction_status: null,
        artifact_health: "inconsistent",
        diagnosis_code: "PDF_ARTIFACT_INCONSISTENT",
        extraction_id: null,
        artifact_path: null,
      });

      const unsafeFixture = await createFixture(resolve(workspaceDir, "unsafe"));
      await selectExtractedRun(unsafeFixture);
      await mutateBothPdfStates(unsafeFixture, (state) => { state.artifact_path = "../../outside/document.md"; });
      expect(await readPdfSourceStatus(unsafeFixture.repoRoot, unsafeFixture.sourceId)).toMatchObject({ artifact_health: "inconsistent", diagnosis_code: "PDF_ARTIFACT_INCONSISTENT" });

      const inconsistentFixture = await createFixture(resolve(workspaceDir, "inconsistent"));
      const selected = await selectExtractedRun(inconsistentFixture);
      const metadata = JSON.parse(await readFile(resolve(inconsistentFixture.repoRoot, selected.metadataPath), "utf8")) as Record<string, unknown>;
      metadata.artifact_hash = `sha256:${"0".repeat(64)}`;
      await writeFile(resolve(inconsistentFixture.repoRoot, selected.metadataPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      expect(await readPdfSourceStatus(inconsistentFixture.repoRoot, inconsistentFixture.sourceId)).toMatchObject({ artifact_health: "inconsistent", diagnosis_code: "PDF_ARTIFACT_INCONSISTENT" });

      const changedOriginalFixture = await createFixture(resolve(workspaceDir, "changed-original"));
      await writeFile(resolve(changedOriginalFixture.repoRoot, changedOriginalFixture.originalPath), Buffer.from("%PDF-1.7\nchanged\n", "utf8"));
      expect(await readPdfSourceStatus(changedOriginalFixture.repoRoot, changedOriginalFixture.sourceId)).toMatchObject({
        artifact_health: "inconsistent",
        diagnosis_scope: "artifact",
      });

      const missingCardFixture = await createFixture(resolve(workspaceDir, "missing-card"));
      await rm(resolve(missingCardFixture.repoRoot, missingCardFixture.sourceCardPath));
      expect(await readPdfSourceStatus(missingCardFixture.repoRoot, missingCardFixture.sourceId)).toMatchObject({
        extraction_status: null,
        artifact_health: "inconsistent",
        diagnosis_scope: "state",
      });
    });
  });

  it("exposes normalized status in queue and repository status JSON", async () => {
    await withTempWorkspace("llm-wiki-pdf-status-cli-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const queue = await runCliBuffered(["queue", "show", fixture.sourceId, "--repo", fixture.repoRoot, "--json"]);
      const status = await runCliBuffered(["status", "--repo", fixture.repoRoot, "--json"]);
      const queueHuman = await runCliBuffered(["queue", "show", fixture.sourceId, "--repo", fixture.repoRoot]);
      const statusHuman = await runCliBuffered(["status", "--repo", fixture.repoRoot]);
      const queuePayload = JSON.parse(queue.stdout[0] ?? "{}") as { data?: { pdf_extraction?: PdfSourceStatus } };
      const statusPayload = JSON.parse(status.stdout[0] ?? "{}") as { data?: { queue?: { items?: Array<{ pdf_extraction?: PdfSourceStatus }> } } };

      expect(queue.exitCode).toBe(0);
      expect(queuePayload.data?.pdf_extraction).toMatchObject({ extraction_status: "pending", artifact_health: "missing" });
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data?.queue?.items?.[0]?.pdf_extraction).toMatchObject({ extraction_status: "pending" });
      expect(queueHuman.stdout.join("\n")).toContain("Queue status: queued");
      expect(queueHuman.stdout.join("\n")).toContain("PDF extraction status: pending");
      expect(queueHuman.stdout.join("\n")).toContain("PDF model selection: unknown");
      expect(statusHuman.stdout.join("\n")).toContain(`PDF source: ${fixture.sourceId}`);
      expect(statusHuman.stdout.join("\n")).toContain("Queue status: queued");
      expect(statusHuman.stdout.join("\n")).toContain("PDF extraction status: pending");
    });
  });
});

describe("PDF lint, review, and privacy", () => {
  it("emits deterministic PDF config, state, path, hash, and metadata lint issues", async () => {
    await withTempWorkspace("llm-wiki-pdf-lint-", async (workspaceDir) => {
      const configFixture = await createFixture(resolve(workspaceDir, "config"));
      const configPath = resolve(configFixture.repoRoot, ".llm-wiki/config.yml");
      await writeFile(configPath, (await readFile(configPath, "utf8")).replace("pdf_detail: high", "pdf_detail: impossible"), "utf8");
      expect((await lintWiki(configFixture.repoRoot)).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule_id: "pdf_config_invalid" }),
      ]));

      const malformedConfigFixture = await createFixture(resolve(workspaceDir, "malformed-config"));
      await writeFile(
        resolve(malformedConfigFixture.repoRoot, ".llm-wiki/config.yml"),
        "pdf_ingestion: [\n",
        "utf8",
      );
      expect((await lintWiki(malformedConfigFixture.repoRoot)).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule_id: "pdf_config_invalid" }),
      ]));

      const stateFixture = await createFixture(resolve(workspaceDir, "state"));
      await mutateQueuePdfState(stateFixture, (state) => { state.status = "invalid"; });
      expect((await lintWiki(stateFixture.repoRoot)).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule_id: "pdf_state_inconsistent" }),
      ]));

      const artifactFixture = await createFixture(resolve(workspaceDir, "artifact"));
      const selected = await selectExtractedRun(artifactFixture);
      const metadata = JSON.parse(await readFile(resolve(artifactFixture.repoRoot, selected.metadataPath), "utf8")) as Record<string, unknown>;
      metadata.original_hash = `sha256:${"f".repeat(64)}`;
      await writeFile(resolve(artifactFixture.repoRoot, selected.metadataPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      expect((await lintWiki(artifactFixture.repoRoot)).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule_id: "pdf_artifact_inconsistent" }),
      ]));

      const missingFixture = await createFixture(resolve(workspaceDir, "missing"));
      const missingState = runState(missingFixture, "running");
      missingState.status = "extracted";
      missingState.artifact_path = `${missingFixture.sourceDir}/extracted/pdf/${missingState.extraction_id}/document.md`;
      missingState.finished_at = FINISHED_AT;
      await setMirroredState(missingFixture, missingState);
      expect((await lintWiki(missingFixture.repoRoot)).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule_id: "pdf_artifact_missing" }),
      ]));

      const pendingFixture = await createFixture(resolve(workspaceDir, "pending"));
      expect((await lintWiki(pendingFixture.repoRoot, { profile: "public", strict: true })).issues)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ rule_id: "pdf_artifact_missing" })]));
    });
  });

  it("adds content-free PDF badges to local/review data and omits operational data publicly", async () => {
    await withTempWorkspace("llm-wiki-pdf-review-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const selected = await selectExtractedRun(fixture);
      const scan = await scanWikiRepository(fixture.repoRoot);
      const statuses = await readPdfRepositoryStatuses(fixture.repoRoot);
      const local = await readWikiProfile(fixture.repoRoot, "local");
      const review = await readWikiProfile(fixture.repoRoot, "review");
      const publicProfile = await readWikiProfile(fixture.repoRoot, "public");
      expect(local.ok && review.ok && publicProfile.ok).toBe(true);
      if (!local.ok || !review.ok || !publicProfile.ok) return;

      const localData = buildReviewDataModel(scan, { profile: local.value, pdfStatuses: statuses });
      const reviewData = buildReviewDataModel(scan, { profile: review.value, pdfStatuses: statuses });
      const publicScan = filterReviewScanForProfile(scan, publicProfile.value);
      const publicData = buildReviewDataModel(publicScan, { profile: publicProfile.value, pdfStatuses: statuses });

      expect(localData.queue.items[0]?.pdf_extraction).toMatchObject({ extraction_status: "extracted", artifact_health: "valid" });
      expect(reviewData.queue.items[0]?.pdf_extraction).toMatchObject({ retry_command: `llm-wiki extract pdf ${fixture.sourceId}` });
      expect(JSON.stringify(reviewData)).not.toContain("PHASE4_PRIVATE_DOCUMENT_SENTINEL");
      expect(publicData.queue.items).toEqual([]);
      expect(JSON.stringify(publicData)).not.toContain(fixture.originalPath);

      await initializeQuartzRuntime(fixture.repoRoot, { install: false });
      await syncQuartzContent(fixture.repoRoot, "review");
      const queuePage = await readFile(
        resolve(fixture.repoRoot, "quartz/content/_llm-wiki/review/source-queue.md"),
        "utf8",
      );
      const sourcePage = await readFile(resolve(fixture.repoRoot, `quartz/content/${fixture.sourceCardPath}`), "utf8");
      expect(queuePage).toContain("PDF extraction ID");
      expect(queuePage).toContain("pdfext_phase4_run_0001");
      expect(queuePage).toContain("PDF artifact path");
      expect(sourcePage).toContain("pdf_extraction_status:");
      expect(sourcePage).toContain("artifact_health: valid");
      expect(`${queuePage}\n${sourcePage}`).not.toContain("PHASE4_PRIVATE_DOCUMENT_SENTINEL");

      const maliciousModel = "gpt\n<script>alert(1)</script> [click](javascript:alert(1)) | ```";
      const configPath = resolve(fixture.repoRoot, ".llm-wiki/config.yml");
      const configDocument = parse(await readFile(configPath, "utf8")) as {
        pdf_ingestion: Record<string, unknown>;
      };
      configDocument.pdf_ingestion.model = maliciousModel;
      await writeFile(configPath, stringify(configDocument), "utf8");
      await mutateBothPdfStates(fixture, (state) => {
        state.model_descriptor = `explicit:${maliciousModel}`;
      });
      const metadata = JSON.parse(await readFile(resolve(fixture.repoRoot, selected.metadataPath), "utf8")) as Record<string, unknown>;
      metadata.requested_model = maliciousModel;
      metadata.model_descriptor = `explicit:${maliciousModel}`;
      await writeFile(resolve(fixture.repoRoot, selected.metadataPath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      const sanitizedStatus = await readPdfSourceStatus(fixture.repoRoot, fixture.sourceId);
      expect(sanitizedStatus?.model_descriptor).not.toContain("\n");
      await syncQuartzContent(fixture.repoRoot, "review");
      const escapedQueuePage = await readFile(
        resolve(fixture.repoRoot, "quartz/content/_llm-wiki/review/source-queue.md"),
        "utf8",
      );
      const renderedTable = escapedQueuePage
        .slice(escapedQueuePage.indexOf("# Source Queue"))
        .split("## Source Badge Data")[0] ?? "";
      expect(renderedTable).not.toContain("<script>");
      expect(renderedTable).not.toContain("[click](javascript:alert(1))");
      expect(renderedTable).toContain("&lt;script&gt;");
      expect(escapedQueuePage).toContain("````json");
    });
  });

  it("rejects PDF originals, runs, metadata, queue, and review data selected by a public profile", async () => {
    await withTempWorkspace("llm-wiki-pdf-public-profile-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      await selectExtractedRun(fixture);
      const profilePath = resolve(fixture.repoRoot, ".llm-wiki/profiles/public.yml");
      const profile = await readFile(profilePath, "utf8");
      await writeFile(
        profilePath,
        profile
          .replace("  - curated/**", "  - curated/**\n  - raw/**\n  - _llm-wiki/review/**")
          .replace("exclude:\n  - raw/**", "exclude:")
          .replace("  - raw/queue/**\n", ""),
        "utf8",
      );
      const lint = await lintWiki(fixture.repoRoot, { profile: "public", strict: true });
      const rules = lint.issues.map((issue) => issue.rule_id);

      expect(rules).toContain("public_pdf_original_selected");
      expect(rules).toContain("public_pdf_artifact_selected");
      expect(rules).toContain("public_pdf_metadata_selected");
      expect(rules).toContain("public_pdf_queue_state_selected");
      expect(rules).toContain("public_raw_file_selected");
      expect(rules).toContain("public_quartz_review_page_selected");
    });
  });

  it("finds copied PDF, document, metadata, queue, and review leaks in built static output", async () => {
    await withTempWorkspace("llm-wiki-pdf-static-leaks-", async (workspaceDir) => {
      const fixture = await createFixture(workspaceDir);
      const selected = await selectExtractedRun(fixture);
      const { repoRoot } = fixture;
      await mkdir(resolve(repoRoot, "quartz/public/assets"), { recursive: true });
      await mkdir(resolve(repoRoot, "quartz/public/_llm-wiki/review"), { recursive: true });
      await writeFile(resolve(repoRoot, "quartz/public/assets/renamed.bin"), PDF_BYTES);
      await writeFile(resolve(repoRoot, "quartz/public/assets/renamed-document.txt"), DOCUMENT_CONTENT, "utf8");
      await writeFile(
        resolve(repoRoot, "quartz/public/assets/renamed-metadata.txt"),
        await readFile(resolve(repoRoot, selected.metadataPath)),
      );
      await writeFile(resolve(repoRoot, "quartz/public/assets/state.json"), JSON.stringify({ pdf_extraction: selected.state }), "utf8");
      await writeFile(resolve(repoRoot, "quartz/public/assets/queue.json"), JSON.stringify({ source_id: "src_private", status: "queued", original_path: "private.pdf" }), "utf8");
      await writeFile(resolve(repoRoot, "quartz/public/_llm-wiki/review/status.html"), "private review data", "utf8");

      const leaks = await scanStaticOutputLeaks(repoRoot);
      const codes = leaks.findings.map((finding) => finding.code);
      expect(codes).toContain("STATIC_PDF_ORIGINAL_LEAK");
      expect(codes).toContain("STATIC_PDF_DOCUMENT_LEAK");
      expect(codes).toContain("STATIC_PDF_METADATA_LEAK");
      expect(codes).toContain("STATIC_PDF_STATE_LEAK");
      expect(codes).toContain("STATIC_RAW_QUEUE_LEAK");
      expect(codes).toContain("STATIC_REVIEW_PAGE_LEAK");
    });
  });
});
