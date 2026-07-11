import { isUtf8 } from "node:buffer";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { firstChangedFileTreePath, readFileTreeSnapshot } from "../agents/treeSnapshot.js";
import {
  loadPdfIngestionRuntimeConfig,
  resolvePdfExtractionSettings,
  type PdfCodexInvocation,
  type PdfExtractionSettingOverrides,
  type PdfExtractionSettings,
  type PdfIngestionRuntimeConfig,
} from "./config.js";
import {
  preflightLoadedPdfIngestion,
  type PdfPreflightSuccess,
  type PdfReadinessError,
} from "./readiness.js";
import {
  readPdfExtractionSourceState,
  synchronizePdfExtractionState,
  type PdfExtractionSourceState,
} from "./state.js";
import { isPdfOriginalPath, isPdfSignature, isSafeExtractionId, type PdfExtractionState } from "./stateSchema.js";
import {
  assertIngestLockLease,
  withIngestLock,
  type IngestLockLease,
} from "../runtime/ingestLock.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { validateReadFileInsideRoot } from "../utils/fs.js";

export type PdfExtractionMetadata = {
  schema_version: 1;
  source_id: string;
  extraction_id: string;
  status: "extracted";
  original_path: string;
  original_hash: string;
  artifact_path: string;
  artifact_hash: string;
  artifact_bytes: number;
  plugin: string;
  plugin_version: string | null;
  plugin_descriptor: string | null;
  model_selection: "explicit" | "inherited";
  requested_model: string | null;
  model_descriptor: string | null;
  observed_model: string | null;
  reasoning_effort: string;
  pdf_detail: "auto" | "low" | "high";
  codex_agent: string;
  codex_version: string | null;
  started_at: string;
  finished_at: string;
};

export type PdfExtractionResult = {
  outcome: "extracted" | "reused";
  source_id: string;
  extraction_id: string;
  artifact_path: string;
  metadata_path: string;
  recovered_interrupted: boolean;
  pdf_extraction: PdfExtractionState;
};

export type ValidatedPdfArtifact = {
  source: PdfExtractionSourceState;
  metadata: PdfExtractionMetadata;
  content: string;
};

export type ExtractPdfSourceInput = {
  repoRoot: string;
  sourceId: string;
  overrides?: PdfExtractionSettingOverrides;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  generateExtractionId?: () => string;
};

export type PreparedPdfExtractionOperation = {
  repoRoot: string;
  sourceId: string;
  source: ValidatedPdfSource;
  runtime: PdfIngestionRuntimeConfig;
  settings: PdfExtractionSettings;
  preflight: PdfPreflightSuccess;
  modelDescriptor: string | null;
  env?: NodeJS.ProcessEnv;
  now: () => Date;
  generateExtractionId: () => string;
};

type ValidatedPdfSource = PdfExtractionSourceState & {
  originalBytes: Buffer;
  originalHash: string;
};

type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderrTail: string;
};

type WorkspaceExtractionResult = {
  document: Buffer;
  startedAt: string;
  finishedAt: string;
};

class PdfPreflightRestartError extends Error {
  constructor() {
    super("PDF configuration changed while waiting for the ingest lock.");
    this.name = "PdfPreflightRestartError";
  }
}

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const STDERR_LIMIT = 4 * 1024;
const MAX_PREFLIGHT_RESTARTS = 4;

export function serializeTomlString(value: string): string {
  let serialized = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw invalidSetting("PDF reasoning effort contains an unpaired surrogate.", "--pdf-reasoning-effort");
      }
      serialized += value[index] + value[index + 1];
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalidSetting("PDF reasoning effort contains an unpaired surrogate.", "--pdf-reasoning-effort");
    }

    const char = value[index] ?? "";
    if (char === '"') serialized += '\\"';
    else if (char === "\\") serialized += "\\\\";
    else if (char === "\b") serialized += "\\b";
    else if (char === "\t") serialized += "\\t";
    else if (char === "\n") serialized += "\\n";
    else if (char === "\f") serialized += "\\f";
    else if (char === "\r") serialized += "\\r";
    else if (code <= 0x1f || code === 0x7f) serialized += `\\u${code.toString(16).padStart(4, "0")}`;
    else serialized += char;
  }
  return `${serialized}"`;
}

export function buildPdfCodexArgs(
  invocation: PdfCodexInvocation,
  settings: PdfExtractionSettings,
): string[] {
  return [
    ...invocation.globalPrefix,
    ...(settings.model === null ? [] : ["--model", settings.model]),
    "-c",
    `model_reasoning_effort=${serializeTomlString(settings.reasoningEffort)}`,
    "exec",
    ...invocation.execSuffix,
    "-",
  ];
}

export function buildPdfExtractionTask(input: {
  plugin: string;
  pdfDetail: "auto" | "low" | "high";
  inputPath: string;
  outputPath: string;
}): string {
  return [
    "Extract this PDF into one canonical Markdown document.",
    `Required plugin: ${input.plugin}`,
    `PDF input path: ${input.inputPath}`,
    `PDF detail: ${input.pdfDetail}`,
    `Permitted output path: ${input.outputPath}`,
    "Use the required PDF plugin with the requested detail and preserve the complete document content from every page.",
    "Represent the evidence faithfully as Markdown. Do not invent missing facts.",
    "Write exactly the permitted document.md. Do not write metadata or change any other file.",
    "Do not include credentials, process output, or commentary outside document.md.",
    "",
  ].join("\n");
}

export async function preparePdfExtractionOperation(
  input: ExtractPdfSourceInput,
): Promise<PreparedPdfExtractionOperation> {
  const source = await readAndValidatePdfSource(input.repoRoot, input.sourceId, true);
  const runtime = await loadPdfIngestionRuntimeConfig(input.repoRoot);
  if (!runtime.ok) {
    throw readinessRuntimeError(runtime.error);
  }
  assertWorkspaceWriteSandbox(runtime.value);
  const settings = resolvePdfExtractionSettings(runtime.value.config, input.overrides ?? {});
  if (!settings.ok) {
    throw readinessRuntimeError(settings.error);
  }
  const preflight = await preflightLoadedPdfIngestion(input.repoRoot, runtime.value, { env: input.env });
  if (!preflight.ok) {
    throw readinessRuntimeError(preflight.error);
  }

  return {
    repoRoot: input.repoRoot,
    sourceId: input.sourceId,
    source,
    runtime: runtime.value,
    settings: settings.value,
    preflight: preflight.value,
    modelDescriptor: settings.value.model === null ? null : `explicit:${settings.value.model}`,
    env: input.env,
    now: input.now ?? (() => new Date()),
    generateExtractionId: input.generateExtractionId ?? generateExtractionId,
  };
}

export async function extractPdfSource(input: ExtractPdfSourceInput): Promise<PdfExtractionResult> {
  for (let attempt = 0; attempt < MAX_PREFLIGHT_RESTARTS; attempt += 1) {
    const prepared = await preparePdfExtractionOperation(input);
    try {
      return await withIngestLock(
        input.repoRoot,
        { label: `pdf-extraction:${input.sourceId}` },
        (lease) => ensurePreparedPdfArtifactUnderLock(prepared, lease),
      );
    } catch (error) {
      if (error instanceof PdfPreflightRestartError) {
        continue;
      }
      throw error;
    }
  }

  throw new RuntimeCommandError({
    code: "PDF_CONFIG_INVALID",
    message: "PDF configuration kept changing while extraction waited for the repository lock.",
    path: ".llm-wiki/config.yml",
    hint: "Stop editing PDF/agent configuration, then retry extraction.",
  });
}

export async function readValidatedPdfArtifact(
  repoRoot: string,
  sourceId: string,
): Promise<ValidatedPdfArtifact> {
  const source = await readAndValidatePdfSource(repoRoot, sourceId, false);
  if (source.state.status !== "extracted" || source.state.extraction_id === null || source.state.artifact_path === null) {
    throw new RuntimeCommandError({
      code: "PDF_ARTIFACT_REQUIRED",
      message: `PDF source ${sourceId} has no selected validated extraction artifact.`,
      path: sourceId,
      hint: `Run llm-wiki extract pdf ${sourceId} before curated ingest.`,
    });
  }
  let run: ValidatedRun;
  try {
    run = await validateRunDirectory(
      repoRoot,
      source.sourceDir,
      source.state.extraction_id,
      source.sourceId,
      source.originalPath,
      source.originalHash,
    );
  } catch (error) {
    throw new RuntimeCommandError({
      code: "PDF_ARTIFACT_INCONSISTENT",
      message: `Selected PDF artifact is inconsistent: ${error instanceof Error ? error.message : String(error)}.`,
      path: source.state.artifact_path,
      hint: `Repair the immutable run or run llm-wiki extract pdf ${sourceId} to create a valid selection.`,
    });
  }
  const metadata = run.metadata;
  if (
    source.state.artifact_path !== metadata.artifact_path
    || source.state.original_hash !== metadata.original_hash
    || source.state.plugin !== metadata.plugin
    || source.state.plugin_version !== metadata.plugin_version
    || source.state.plugin_descriptor !== metadata.plugin_descriptor
    || source.state.model_descriptor !== metadata.model_descriptor
    || source.state.reasoning_effort !== metadata.reasoning_effort
    || source.state.pdf_detail !== metadata.pdf_detail
    || source.state.started_at !== metadata.started_at
    || source.state.finished_at !== metadata.finished_at
  ) {
    throw new RuntimeCommandError({
      code: "PDF_ARTIFACT_INCONSISTENT",
      message: "Selected PDF state and immutable run metadata disagree.",
      path: source.state.artifact_path,
      hint: `Run llm-wiki extract pdf ${sourceId} to select a fully matching validated artifact.`,
    });
  }
  return {
    source,
    metadata,
    content: run.document.toString("utf8"),
  };
}

export async function ensurePreparedPdfArtifactUnderLock(
  prepared: PreparedPdfExtractionOperation,
  lease: IngestLockLease,
): Promise<PdfExtractionResult> {
  assertIngestLockLease(lease, prepared.repoRoot);
  const runtime = await loadPdfIngestionRuntimeConfig(prepared.repoRoot);
  if (!runtime.ok || runtime.value.fingerprint !== prepared.runtime.fingerprint) {
    throw new PdfPreflightRestartError();
  }

  let source = await readAndValidatePdfSource(prepared.repoRoot, prepared.sourceId, true);
  if (
    source.contentHash !== prepared.source.contentHash
    || source.originalPath !== prepared.source.originalPath
    || source.originalHash !== prepared.source.originalHash
  ) {
    throw originalChanged(source.originalPath, "PDF source changed while extraction waited for the repository lock.");
  }

  let recoveredInterrupted = false;
  let interruptedId: string | null = null;
  if (source.state.status === "running") {
    interruptedId = source.state.extraction_id;
    const recoveredAt = prepared.now().toISOString();
    const interrupted = failedState(
      source.state,
      "PDF_EXTRACTION_INTERRUPTED",
      "The previous lock-owning PDF extraction ended before completion. Retry started a new attempt.",
      recoveredAt,
    );
    source = await synchronizePdfExtractionState(prepared.repoRoot, source, interrupted)
      .then((next) => ({ ...source, ...next, originalBytes: source.originalBytes, originalHash: source.originalHash }));
    await removeInterruptedRun(prepared.repoRoot, source.sourceDir, interruptedId);
    recoveredInterrupted = true;
  }

  if (!prepared.settings.force) {
    const reusable = await selectReusableRun(prepared, source, interruptedId);
    if (reusable !== null) {
      const selectedState = extractedStateFromMetadata(reusable.metadata, prepared.now().toISOString());
      const synchronized = await synchronizePdfExtractionState(prepared.repoRoot, source, selectedState);
      return extractionResult("reused", prepared.sourceId, synchronized.state, recoveredInterrupted);
    }
  }

  const extractionId = await allocateExtractionId(prepared, source.sourceDir);
  const artifactPath = `${source.sourceDir}/extracted/pdf/${extractionId}/document.md`;
  const metadataPath = `${source.sourceDir}/extracted/pdf/${extractionId}/metadata.json`;
  const startedAt = prepared.now().toISOString();
  const running: PdfExtractionState = {
    required: true,
    status: "running",
    extraction_id: extractionId,
    artifact_path: null,
    original_hash: source.originalHash,
    plugin: prepared.preflight.plugin.id as typeof source.state.plugin,
    plugin_version: prepared.preflight.plugin.version,
    plugin_descriptor: prepared.preflight.plugin.descriptor,
    model_descriptor: prepared.modelDescriptor,
    reasoning_effort: prepared.settings.reasoningEffort,
    pdf_detail: prepared.settings.pdfDetail,
    started_at: startedAt,
    finished_at: null,
    updated_at: startedAt,
    last_error_code: null,
    last_error_message: null,
  };
  source = await synchronizePdfExtractionState(prepared.repoRoot, source, running)
    .then((next) => ({ ...source, ...next, originalBytes: source.originalBytes, originalHash: source.originalHash }));

  let createdRunPath: string | null = null;
  try {
    const workspace = await runExtractionWorkspace(prepared, source, extractionId, artifactPath, startedAt);
    await assertRealOriginalHash(prepared.repoRoot, source, "immediately before artifact application");
    const metadata = createMetadata(
      prepared,
      source,
      extractionId,
      artifactPath,
      workspace.document,
      workspace.startedAt,
      workspace.finishedAt,
    );
    createdRunPath = await applyImmutableRun(
      prepared.repoRoot,
      source.sourceDir,
      extractionId,
      workspace.document,
      metadata,
    );
    const extracted = extractedStateFromMetadata(metadata, metadata.finished_at);
    const synchronized = await synchronizePdfExtractionState(prepared.repoRoot, source, extracted);
    await assertRealOriginalHash(prepared.repoRoot, source, "after artifact application");
    return extractionResult("extracted", prepared.sourceId, synchronized.state, recoveredInterrupted);
  } catch (error) {
    if (createdRunPath !== null) {
      await removeCreatedRun(prepared.repoRoot, createdRunPath);
    }
    const runtimeError = asPdfRuntimeError(error, prepared.sourceId);
    try {
      const current = await readPdfExtractionSourceState(prepared.repoRoot, prepared.sourceId);
      if (
        (current.state.status === "running" || current.state.status === "extracted")
        && current.state.extraction_id === extractionId
      ) {
        await synchronizePdfExtractionState(
          prepared.repoRoot,
          current,
          failedState(current.state, runtimeError.code, runtimeError.message, prepared.now().toISOString()),
        );
      }
    } catch (stateError) {
      if (stateError instanceof RuntimeCommandError && stateError.code === "PDF_STATE_WRITE_FAILED") {
        throw stateError;
      }
    }
    throw runtimeError;
  }
}

async function readAndValidatePdfSource(
  repoRoot: string,
  sourceId: string,
  requireQueued: boolean,
): Promise<ValidatedPdfSource> {
  const source = await readPdfExtractionSourceState(repoRoot, sourceId);
  if (requireQueued && source.queueStatus !== "queued") {
    throw invalidSourceStatus(sourceId, source.queueStatus);
  }
  if (
    source.sourceKind !== "file"
    || !isPdfOriginalPath(source.originalPath)
    || !isSafePdfSourcePath(source.originalPath, source.sourceDir)
  ) {
    throw new RuntimeCommandError({
      code: "PDF_SOURCE_NOT_PDF",
      message: `Source ${sourceId} is not an eligible file-backed PDF.`,
      path: source.originalPath,
      hint: "Select a file source whose safe original path ends in .pdf.",
    });
  }
  if (!HASH_PATTERN.test(source.contentHash)) {
    throw originalChanged(source.originalPath, "PDF source content_hash is not canonical SHA-256.");
  }

  const originalBytes = await readOriginalBytes(repoRoot, source.originalPath);
  if (!isPdfSignature(originalBytes)) {
    throw new RuntimeCommandError({
      code: "PDF_SOURCE_NOT_PDF",
      message: `Source original does not begin with a valid PDF signature: ${source.originalPath}.`,
      path: source.originalPath,
      hint: "Capture a valid PDF whose bytes begin with %PDF-.",
    });
  }
  const originalHash = sha256(originalBytes);
  if (originalHash !== source.contentHash || source.state.original_hash !== source.contentHash) {
    throw originalChanged(source.originalPath, "PDF bytes, source hashes, and extraction state do not agree.");
  }
  return { ...source, originalBytes, originalHash };
}

async function readOriginalBytes(repoRoot: string, relativePath: string): Promise<Buffer> {
  const safe = await validateReadFileInsideRoot(repoRoot, relativePath);
  if (!safe.ok) {
    throw new RuntimeCommandError({
      code: "PDF_SOURCE_NOT_PDF",
      message: safe.error.message,
      path: relativePath,
      hint: "Restore the selected PDF as a regular non-symlink file inside the repository.",
    });
  }

  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stat = await lstat(safe.value.absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("PDF original is not a regular file.");
    }
    file = await open(safe.value.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await file.readFile();
  } catch (error) {
    throw new RuntimeCommandError({
      code: "PDF_SOURCE_NOT_PDF",
      message: error instanceof Error ? error.message : String(error),
      path: relativePath,
      hint: "Restore the selected PDF as a readable regular non-symlink file.",
    });
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function runExtractionWorkspace(
  prepared: PreparedPdfExtractionOperation,
  source: ValidatedPdfSource,
  extractionId: string,
  artifactPath: string,
  startedAt: string,
): Promise<WorkspaceExtractionResult> {
  const tempParent = await mkdtemp(resolve(tmpdir(), "llm-wiki-pdf-extraction-"));
  const workspaceRoot = resolve(tempParent, "workspace");
  const inputAbsolute = resolveWorkspacePath(workspaceRoot, source.originalPath);
  const outputAbsolute = resolveWorkspacePath(workspaceRoot, artifactPath);

  try {
    await mkdir(dirname(inputAbsolute), { recursive: true });
    await mkdir(dirname(outputAbsolute), { recursive: true });
    await writeFile(inputAbsolute, source.originalBytes, { flag: "wx", mode: 0o444 });
    await chmod(inputAbsolute, 0o444);
    const before = await readFileTreeSnapshot(workspaceRoot);
    const task = buildPdfExtractionTask({
      plugin: prepared.preflight.plugin.id,
      pdfDetail: prepared.settings.pdfDetail,
      inputPath: source.originalPath,
      outputPath: artifactPath,
    });
    const args = buildPdfCodexArgs(prepared.runtime.invocation, prepared.settings);
    const processResult = await runPdfProcess({
      executablePath: prepared.preflight.executablePath,
      args,
      cwd: workspaceRoot,
      task,
      env: prepared.env,
      timeoutMs: prepared.runtime.config.timeoutSeconds * 1000,
    });
    const after = await readFileTreeSnapshot(workspaceRoot);

    const inputAfter = after.get(source.originalPath);
    if (
      inputAfter?.kind !== "file"
      || inputAfter.hash !== source.originalHash
      || inputAfter.bytes !== source.originalBytes.length
    ) {
      throw originalChanged(source.originalPath, "The temporary PDF copy changed during Codex extraction.");
    }

    const disallowed = firstChangedFileTreePath(before, after, new Set([artifactPath]));
    if (disallowed !== null) {
      throw new RuntimeCommandError({
        code: "PDF_WORKSPACE_MUTATION_REJECTED",
        message: `Codex changed an out-of-policy workspace path: ${disallowed}.`,
        path: disallowed,
        hint: `PDF extraction may create only ${artifactPath}; every other workspace path is immutable.`,
        executable: prepared.preflight.executablePath,
        exitCode: processResult.exitCode,
        stderrTail: processResult.stderrTail,
        timedOut: processResult.timedOut,
        workspaceMutationsObserved: true,
      });
    }

    if (processResult.timedOut) {
      throw processError(
        "PDF_EXTRACTION_TIMEOUT",
        `Codex PDF extraction timed out after ${prepared.runtime.config.timeoutSeconds} second(s).`,
        prepared,
        processResult,
      );
    }
    if (processResult.exitCode !== 0 || processResult.signal !== null) {
      throw processError(
        "PDF_CODEX_EXTRACTION_FAILED",
        "Codex PDF extraction exited unsuccessfully.",
        prepared,
        processResult,
      );
    }

    const outputEntry = after.get(artifactPath);
    if (outputEntry?.kind !== "file") {
      throw invalidDocument(artifactPath, "Codex did not create document.md as a regular file.");
    }
    const document = await readFile(outputAbsolute);
    validateDocument(document, artifactPath);
    return {
      document,
      startedAt,
      finishedAt: prepared.now().toISOString(),
    };
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
}

async function runPdfProcess(input: {
  executablePath: string;
  args: string[];
  cwd: string;
  task: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<ProcessResult> {
  return new Promise((resolveRun, rejectRun) => {
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const settle = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolveRun(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.executablePath, input.args, {
        cwd: input.cwd,
        env: { ...(input.env ?? process.env), PWD: input.cwd },
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      rejectRun(new RuntimeCommandError({
        code: "PDF_CODEX_EXTRACTION_FAILED",
        message: `Codex PDF extraction could not start: ${error instanceof Error ? error.message : String(error)}.`,
        path: input.executablePath,
        hint: "Fix the configured Codex executable and retry without changing extraction settings.",
        executable: input.executablePath,
        exitCode: null,
        stderrTail: "",
        timedOut: false,
        workspaceMutationsObserved: false,
      }));
      return;
    }

    child.stdin?.once("error", () => undefined);
    child.stdin?.end(input.task);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = Buffer.concat([stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]).subarray(-STDERR_LIMIT);
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        if (timer !== null) clearTimeout(timer);
        rejectRun(new RuntimeCommandError({
          code: "PDF_CODEX_EXTRACTION_FAILED",
          message: `Codex PDF extraction could not start: ${error.message}.`,
          path: input.executablePath,
          hint: "Fix the configured Codex executable and retry without changing extraction settings.",
          executable: input.executablePath,
          exitCode: null,
          stderrTail: "",
          timedOut: false,
          workspaceMutationsObserved: false,
        }));
      }
    });
    child.once("close", (exitCode, signal) => {
      settle({
        exitCode,
        signal,
        timedOut,
        stderrTail: sanitizeProcessText(stderr.toString("utf8")),
      });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 100).unref();
    }, Math.max(1, input.timeoutMs));
    timer.unref();
  });
}

function validateDocument(document: Buffer, path: string): void {
  if (!isUtf8(document) || document.includes(0)) {
    throw invalidDocument(path, "document.md must be readable UTF-8 without NUL bytes.");
  }
  if (document.toString("utf8").trim() === "") {
    throw invalidDocument(path, "document.md must contain non-whitespace Markdown content.");
  }
}

function createMetadata(
  prepared: PreparedPdfExtractionOperation,
  source: ValidatedPdfSource,
  extractionId: string,
  artifactPath: string,
  document: Buffer,
  startedAt: string,
  finishedAt: string,
): PdfExtractionMetadata {
  return {
    schema_version: 1,
    source_id: source.sourceId,
    extraction_id: extractionId,
    status: "extracted",
    original_path: source.originalPath,
    original_hash: source.originalHash,
    artifact_path: artifactPath,
    artifact_hash: sha256(document),
    artifact_bytes: document.length,
    plugin: prepared.preflight.plugin.id,
    plugin_version: prepared.preflight.plugin.version,
    plugin_descriptor: prepared.preflight.plugin.descriptor,
    model_selection: prepared.settings.model === null ? "inherited" : "explicit",
    requested_model: prepared.settings.model,
    model_descriptor: prepared.modelDescriptor,
    observed_model: null,
    reasoning_effort: prepared.settings.reasoningEffort,
    pdf_detail: prepared.settings.pdfDetail,
    codex_agent: prepared.runtime.config.codexAgent,
    codex_version: null,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

async function applyImmutableRun(
  repoRoot: string,
  sourceDir: string,
  extractionId: string,
  document: Buffer,
  metadata: PdfExtractionMetadata,
): Promise<string> {
  const runsRoot = `${sourceDir}/extracted/pdf`;
  const runPath = `${runsRoot}/${extractionId}`;
  const absoluteRun = resolveContained(repoRoot, runPath);
  try {
    await ensureSafeRunsRoot(repoRoot, sourceDir);
    await mkdir(absoluteRun);
  } catch (error) {
    throw new RuntimeCommandError({
      code: "PDF_APPLY_FAILED",
      message: `Could not create immutable PDF run ${extractionId}: ${error instanceof Error ? error.message : String(error)}.`,
      path: runPath,
      hint: "Preserve existing runs and retry with a new extraction ID after repairing the run directory.",
    });
  }

  try {
    await writeExclusiveRegularFile(resolve(absoluteRun, "document.md"), document);
    await writeExclusiveRegularFile(
      resolve(absoluteRun, "metadata.json"),
      Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    );
    await validateRunDirectory(
      repoRoot,
      sourceDir,
      extractionId,
      metadata.source_id,
      metadata.original_path,
      metadata.original_hash,
    );
    return runPath;
  } catch (error) {
    await rm(absoluteRun, { recursive: true, force: true });
    if (error instanceof RuntimeCommandError) throw error;
    throw new RuntimeCommandError({
      code: "PDF_APPLY_FAILED",
      message: `Could not write immutable PDF run ${extractionId}: ${error instanceof Error ? error.message : String(error)}.`,
      path: runPath,
      hint: "Repair the private extraction destination and retry; existing successful runs were preserved.",
    });
  }
}

async function writeExclusiveRegularFile(path: string, content: Buffer): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
  try {
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}

type ValidatedRun = { metadata: PdfExtractionMetadata; document: Buffer };

async function selectReusableRun(
  prepared: PreparedPdfExtractionOperation,
  source: ValidatedPdfSource,
  excludedId: string | null,
): Promise<ValidatedRun | null> {
  if (prepared.preflight.plugin.descriptor === null || prepared.modelDescriptor === null) return null;
  const root = resolve(prepared.repoRoot, source.sourceDir, "extracted/pdf");
  let names: string[];
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    await assertSafeDirectoryChain(prepared.repoRoot, `${source.sourceDir}/extracted/pdf`);
    names = await readdir(root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }

  const matches: ValidatedRun[] = [];
  for (const name of names.sort()) {
    if (name === excludedId || !isSafeExtractionId(name)) continue;
    const run = await validateRunDirectory(
      prepared.repoRoot,
      source.sourceDir,
      name,
      source.sourceId,
      source.originalPath,
      source.originalHash,
    )
      .catch(() => null);
    if (run === null) continue;
    const metadata = run.metadata;
    if (
      metadata.plugin === prepared.preflight.plugin.id
      && metadata.plugin_descriptor === prepared.preflight.plugin.descriptor
      && metadata.model_descriptor === prepared.modelDescriptor
      && metadata.reasoning_effort === prepared.settings.reasoningEffort
      && metadata.pdf_detail === prepared.settings.pdfDetail
    ) matches.push(run);
  }
  matches.sort((left, right) => {
    const time = Date.parse(right.metadata.finished_at) - Date.parse(left.metadata.finished_at);
    return time !== 0 ? time : right.metadata.extraction_id.localeCompare(left.metadata.extraction_id);
  });
  return matches[0] ?? null;
}

async function validateRunDirectory(
  repoRoot: string,
  sourceDir: string,
  extractionId: string,
  sourceId: string,
  originalPath: string,
  originalHash: string,
): Promise<ValidatedRun> {
  const relativeRun = `${sourceDir}/extracted/pdf/${extractionId}`;
  const absoluteRun = resolveContained(repoRoot, relativeRun);
  await assertSafeDirectoryChain(repoRoot, relativeRun);
  const stat = await lstat(absoluteRun);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("run is not a safe directory");
  const names = (await readdir(absoluteRun)).sort();
  if (names.length !== 2 || names[0] !== "document.md" || names[1] !== "metadata.json") {
    throw new Error("run must contain exactly document.md and metadata.json");
  }
  const document = await readSafeRegularFile(resolve(absoluteRun, "document.md"));
  validateDocument(document, `${relativeRun}/document.md`);
  const metadataBytes = await readSafeRegularFile(resolve(absoluteRun, "metadata.json"));
  let metadata: PdfExtractionMetadata;
  try {
    metadata = JSON.parse(metadataBytes.toString("utf8")) as PdfExtractionMetadata;
  } catch {
    throw new Error("metadata is malformed JSON");
  }
  const artifactPath = `${relativeRun}/document.md`;
  if (
    !isMetadataShape(metadata)
    || metadata.source_id !== sourceId
    || metadata.extraction_id !== extractionId
    || metadata.status !== "extracted"
    || metadata.original_hash !== originalHash
    || metadata.original_path !== originalPath
    || metadata.artifact_path !== artifactPath
    || metadata.artifact_hash !== sha256(document)
    || metadata.artifact_bytes !== document.length
    || metadata.plugin.trim() === ""
    || (metadata.plugin_version !== null && metadata.plugin_descriptor !== `${metadata.plugin}#version:${metadata.plugin_version}`)
    || (metadata.plugin_version === null && metadata.plugin_descriptor !== null)
    || (metadata.model_selection === "explicit" && metadata.model_descriptor !== `explicit:${metadata.requested_model}`)
    || (metadata.model_selection === "inherited" && metadata.requested_model !== null)
    || !Number.isFinite(Date.parse(metadata.started_at))
    || !Number.isFinite(Date.parse(metadata.finished_at))
  ) throw new Error("metadata provenance is inconsistent");
  if (sourceDir.split("/").at(-1) !== sourceId) throw new Error("metadata source paths are inconsistent");
  return { metadata, document };
}

function isMetadataShape(value: unknown): value is PdfExtractionMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const metadata = value as Partial<PdfExtractionMetadata>;
  return metadata.schema_version === 1
    && typeof metadata.source_id === "string"
    && typeof metadata.extraction_id === "string"
    && metadata.status === "extracted"
    && typeof metadata.original_path === "string"
    && typeof metadata.original_hash === "string"
    && typeof metadata.artifact_path === "string"
    && typeof metadata.artifact_hash === "string"
    && typeof metadata.artifact_bytes === "number"
    && Number.isSafeInteger(metadata.artifact_bytes)
    && metadata.artifact_bytes >= 0
    && typeof metadata.plugin === "string"
    && (metadata.plugin_version === null || typeof metadata.plugin_version === "string")
    && (metadata.plugin_descriptor === null || typeof metadata.plugin_descriptor === "string")
    && (metadata.model_selection === "explicit" || metadata.model_selection === "inherited")
    && (metadata.requested_model === null || typeof metadata.requested_model === "string")
    && (metadata.model_descriptor === null || typeof metadata.model_descriptor === "string")
    && (metadata.observed_model === null || typeof metadata.observed_model === "string")
    && typeof metadata.reasoning_effort === "string"
    && (metadata.pdf_detail === "auto" || metadata.pdf_detail === "low" || metadata.pdf_detail === "high")
    && typeof metadata.codex_agent === "string"
    && (metadata.codex_version === null || typeof metadata.codex_version === "string")
    && typeof metadata.started_at === "string"
    && typeof metadata.finished_at === "string";
}

async function readSafeRegularFile(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("run file is not regular");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await file.readFile();
  } finally {
    await file.close();
  }
}

function extractedStateFromMetadata(metadata: PdfExtractionMetadata, updatedAt: string): PdfExtractionState {
  return {
    required: true,
    status: "extracted",
    extraction_id: metadata.extraction_id,
    artifact_path: metadata.artifact_path,
    original_hash: metadata.original_hash,
    plugin: metadata.plugin as PdfExtractionState["plugin"],
    plugin_version: metadata.plugin_version,
    plugin_descriptor: metadata.plugin_descriptor,
    model_descriptor: metadata.model_descriptor,
    reasoning_effort: metadata.reasoning_effort,
    pdf_detail: metadata.pdf_detail,
    started_at: metadata.started_at,
    finished_at: metadata.finished_at,
    updated_at: updatedAt,
    last_error_code: null,
    last_error_message: null,
  };
}

function failedState(state: PdfExtractionState, code: string, message: string, finishedAt: string): PdfExtractionState {
  return {
    ...state,
    status: "failed",
    artifact_path: null,
    finished_at: finishedAt,
    updated_at: finishedAt,
    last_error_code: sanitizeProcessText(code) || "PDF_CODEX_EXTRACTION_FAILED",
    last_error_message: sanitizeProcessText(message) || "PDF extraction failed.",
  };
}

async function assertRealOriginalHash(repoRoot: string, source: ValidatedPdfSource, moment: string): Promise<void> {
  const bytes = await readOriginalBytes(repoRoot, source.originalPath);
  if (sha256(bytes) !== source.originalHash) {
    throw originalChanged(source.originalPath, `The real PDF original changed ${moment}.`);
  }
}

async function removeInterruptedRun(repoRoot: string, sourceDir: string, extractionId: string | null): Promise<void> {
  if (extractionId === null) return;
  const relativeRun = `${sourceDir}/extracted/pdf/${extractionId}`;
  const absolute = resolveContained(repoRoot, relativeRun);
  try {
    await assertSafeDirectoryChain(repoRoot, `${sourceDir}/extracted/pdf`);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RuntimeCommandError({
        code: "PDF_ARTIFACT_INCONSISTENT",
        message: "Interrupted PDF run path is not a safe directory.",
        path: relativeRun,
        hint: "Quarantine the unsafe interrupted run before retrying extraction.",
      });
    }
    await rm(absolute, { recursive: true, force: false });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function removeCreatedRun(repoRoot: string, relativeRun: string): Promise<void> {
  const absolute = resolveContained(repoRoot, relativeRun);
  try {
    const stat = await lstat(absolute);
    if (!stat.isSymbolicLink() && stat.isDirectory()) await rm(absolute, { recursive: true, force: true });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function extractionResult(
  outcome: "extracted" | "reused",
  sourceId: string,
  state: PdfExtractionState,
  recoveredInterrupted: boolean,
): PdfExtractionResult {
  if (state.extraction_id === null || state.artifact_path === null) {
    throw new Error("Extracted state is missing its run selection.");
  }
  return {
    outcome,
    source_id: sourceId,
    extraction_id: state.extraction_id,
    artifact_path: state.artifact_path,
    metadata_path: state.artifact_path.replace(/\/document\.md$/u, "/metadata.json"),
    recovered_interrupted: recoveredInterrupted,
    pdf_extraction: state,
  };
}

function resolveWorkspacePath(root: string, relativePath: string): string {
  return resolveContained(root, relativePath);
}

function resolveContained(root: string, relativePath: string): string {
  if (
    relativePath.trim() === ""
    || relativePath.includes("\0")
    || relativePath.includes("\\")
    || isAbsolute(relativePath)
    || relativePath.split("/").includes("..")
  ) throw new Error(`Unsafe contained path: ${relativePath}`);
  const absolute = resolve(root, relativePath);
  const relativeToRoot = relative(resolve(root), absolute);
  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error(`Unsafe contained path: ${relativePath}`);
  }
  return absolute;
}

async function assertSafeDirectoryChain(repoRoot: string, relativePath: string): Promise<void> {
  const rootReal = await realpath(repoRoot);
  let current = resolve(repoRoot);
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory: ${segment}`);
    const currentReal = await realpath(current);
    const relativeReal = relative(rootReal, currentReal);
    if (relativeReal.startsWith("..") || isAbsolute(relativeReal)) throw new Error("Directory escaped repository.");
  }
}

async function ensureSafeRunsRoot(repoRoot: string, sourceDir: string): Promise<void> {
  await assertSafeDirectoryChain(repoRoot, sourceDir);
  let current = resolveContained(repoRoot, sourceDir);
  for (const segment of ["extracted", "pdf"]) {
    current = resolve(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe extraction directory: ${segment}`);
    const rootReal = await realpath(repoRoot);
    const currentReal = await realpath(current);
    const relativeReal = relative(rootReal, currentReal);
    if (relativeReal.startsWith("..") || isAbsolute(relativeReal)) throw new Error("Extraction directory escaped repository.");
  }
}

function invalidSourceStatus(sourceId: string, status: string): RuntimeCommandError {
  const hint = status === "blocked"
    ? `Run llm-wiki queue set-status ${sourceId} queued before explicit PDF extraction.`
    : status === "ingesting"
      ? "Let the active ingest/resume worker finish; explicit extraction cannot take over an ingesting source."
      : "Re-extraction of an ingested source is outside this experiment's queue lifecycle.";
  return new RuntimeCommandError({
    code: "PDF_SOURCE_STATUS_INVALID",
    message: `Explicit PDF extraction requires queue status queued; ${sourceId} is ${status}.`,
    path: sourceId,
    hint,
  });
}

function isSafePdfSourcePath(path: string, sourceDir: string): boolean {
  if (
    path.includes("\0")
    || /[\u0000-\u001F\u007F]/u.test(path)
    || path.includes("\\")
    || isAbsolute(path)
    || path.split("/").includes("..")
    || !path.startsWith(`${sourceDir}/`)
  ) return false;
  const remainder = path.slice(sourceDir.length + 1);
  return remainder !== "" && !remainder.includes("/");
}

function originalChanged(path: string, message: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "PDF_ORIGINAL_CHANGED",
    message,
    path,
    hint: "Restore the immutable PDF so its SHA-256 matches the source card and queue record.",
  });
}

function invalidDocument(path: string, message: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "PDF_DOCUMENT_INVALID",
    message,
    path,
    hint: "Retry extraction and require one non-empty regular UTF-8 document.md with no NUL bytes.",
  });
}

function processError(
  code: "PDF_CODEX_EXTRACTION_FAILED" | "PDF_EXTRACTION_TIMEOUT",
  message: string,
  prepared: PreparedPdfExtractionOperation,
  result: ProcessResult,
): RuntimeCommandError {
  return new RuntimeCommandError({
    code,
    message: result.stderrTail === "" ? message : `${message} ${result.stderrTail}`,
    path: prepared.preflight.executablePath,
    hint: "Fix the reported Codex model, effort, authentication, plugin, or runtime failure and retry without fallback.",
    executable: prepared.preflight.executablePath,
    exitCode: result.exitCode,
    stderrTail: result.stderrTail,
    timedOut: result.timedOut,
    workspaceMutationsObserved: false,
  });
}

function readinessRuntimeError(error: PdfReadinessError): RuntimeCommandError {
  return new RuntimeCommandError({
    code: error.code,
    message: error.message,
    path: error.path,
    hint: error.hint,
    ...(error.executablePath === undefined
      ? {}
      : {
          executable: error.executablePath,
          exitCode: error.exitCode ?? null,
          stderrTail: error.stderrTail ?? "",
          timedOut: error.timedOut ?? false,
          workspaceMutationsObserved: false,
        }),
  });
}

function asPdfRuntimeError(error: unknown, sourceId: string): RuntimeCommandError {
  if (error instanceof RuntimeCommandError) return error;
  return new RuntimeCommandError({
    code: "PDF_APPLY_FAILED",
    message: error instanceof Error ? error.message : String(error),
    path: sourceId,
    hint: "Repair the private extraction workspace or artifact destination and retry.",
  });
}

function invalidSetting(message: string, path: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "PDF_CONFIG_INVALID",
    message,
    path,
    hint: "Pass a valid non-empty PDF extraction setting.",
  });
}

function assertWorkspaceWriteSandbox(runtime: PdfIngestionRuntimeConfig): void {
  const args = runtime.invocation.globalPrefix;
  let sandbox: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--dangerously-bypass-approvals-and-sandbox") {
      throw invalidSetting("PDF extraction cannot bypass the Codex sandbox.", `.llm-wiki/config.yml:agents.${runtime.agent.name}.args`);
    }
    if (arg === "--sandbox" || arg === "-s") {
      sandbox = args[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--sandbox=")) {
      sandbox = arg.slice("--sandbox=".length);
    }
  }
  if (sandbox !== "workspace-write") {
    throw invalidSetting(
      "PDF extraction requires the Codex workspace-write sandbox in its minimal temporary workspace.",
      `.llm-wiki/config.yml:agents.${runtime.agent.name}.sandbox_mode`,
    );
  }
}

function sanitizeProcessText(value: string): string {
  return value.replaceAll(/[\u0000-\u001F\u007F]/gu, " ").replaceAll(/\s+/gu, " ").trim().slice(-4096);
}

function sha256(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function generateExtractionId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/gu, "");
  return `pdfext_${timestamp}_${randomBytes(4).toString("hex")}`;
}

async function allocateExtractionId(
  prepared: PreparedPdfExtractionOperation,
  sourceDir: string,
): Promise<string> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const extractionId = prepared.generateExtractionId();
    if (!isSafeExtractionId(extractionId)) {
      throw new RuntimeCommandError({
        code: "PDF_APPLY_FAILED",
        message: `Generated PDF extraction ID is unsafe: ${extractionId}.`,
        path: extractionId,
        hint: "Retry so the CLI can generate a new filesystem-safe extraction ID.",
      });
    }
    const runPath = resolveContained(prepared.repoRoot, `${sourceDir}/extracted/pdf/${extractionId}`);
    try {
      await lstat(runPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return extractionId;
      throw error;
    }
  }

  throw new RuntimeCommandError({
    code: "PDF_APPLY_FAILED",
    message: "Could not allocate a unique PDF extraction ID.",
    path: `${sourceDir}/extracted/pdf`,
    hint: "Inspect unexpected run-ID collisions and retry without overwriting historical runs.",
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
