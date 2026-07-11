import { setTimeout as sleep } from "node:timers/promises";

import {
  checkLocalAgentAvailability,
  LocalAgentExecutionError,
} from "../agents/index.js";
import {
  IngestValidationFailedError,
  runLocalAgentIngestCore,
} from "../ingest/localAgentCore.js";
import {
  ensurePreparedIngestArtifactUnderLock,
  prepareAutomatedIngestArtifact,
  readPdfIngestFailureResult,
  sourceRequiresPdfArtifact,
  type PdfIngestArtifactResult,
  type PreparedIngestArtifact,
} from "../ingest/artifact.js";
import type { PdfExtractionSettingOverrides } from "../pdf/config.js";
import { PdfPreflightRestartError } from "../pdf/extraction.js";
import {
  loadDefaultLocalAgentConfig,
  type LocalAgentConfig,
  type LocalAgentConfigError,
} from "../runtime/config.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { withIngestLock, type IngestLockOptions } from "../runtime/ingestLock.js";
import {
  listQueueRecordSummaries,
  showQueueSource,
  transitionQueueStatus,
  type AutoIngestMetadata,
  type QueueCommandError,
  type QueueStatus,
} from "../runtime/queue.js";

export type { AutoIngestMetadata } from "../runtime/queue.js";

export type AutoIngestOutcome = "ingested" | "blocked" | "skipped" | "deferred";
export type PdfAutoIngestResult = PdfIngestArtifactResult;

export type AutoIngestSafeIssue = {
  severity: "error";
  code: string;
  message: string;
  path: string;
  hint: string;
};

export type AutoIngestSafeError = {
  code: string;
  message: string;
  path: string;
  hint: string;
  issues?: AutoIngestSafeIssue[];
};

export type AutoIngestSourceResult = {
  source_id: string;
  previous_status: QueueStatus | null;
  final_status: QueueStatus | null;
  outcome: AutoIngestOutcome;
  attempted: boolean;
  agent: string | null;
  applied_paths: string[];
  auto_ingest: AutoIngestMetadata | null;
  error: AutoIngestSafeError | null;
  pdf?: PdfAutoIngestResult;
};

export type AutoIngestBatchResult = {
  agent: string;
  results: AutoIngestSourceResult[];
  counts: {
    selected: number;
    attempted: number;
    ingested: number;
    blocked: number;
    skipped: number;
    deferred: number;
  };
};

export type AutoIngestWatchSummary = {
  agent: string;
  counts: AutoIngestBatchResult["counts"];
  interrupted: boolean;
  failure_count: number;
  exit_code: 0 | 1;
};

export type AutoIngestWatchEvent =
  | {
    event: "result";
    agent: string;
    result: AutoIngestSourceResult;
    counts: AutoIngestBatchResult["counts"];
  }
  | {
    event: "summary";
    summary: AutoIngestWatchSummary;
  };

export type RunAutoIngestBatchInput = {
  repoRoot: string;
  limit?: number;
  now?: () => Date;
  lock?: Pick<IngestLockOptions, "timeoutMs" | "retryDelayMs">;
  command?: string;
  pdfOverrides?: PdfExtractionSettingOverrides;
};

export type RunAutoIngestSourceInput = {
  repoRoot: string;
  sourceId: string;
  now?: () => Date;
  lock?: Pick<IngestLockOptions, "timeoutMs" | "retryDelayMs">;
  command?: string;
  pdfOverrides?: PdfExtractionSettingOverrides;
  allowNonPdfPdfOptions?: boolean;
};

export type RunAutoIngestWatchInput = {
  repoRoot: string;
  now?: () => Date;
  lock?: Pick<IngestLockOptions, "timeoutMs" | "retryDelayMs">;
  command?: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onPreflightComplete?: (agent: LocalAgentConfig) => void | Promise<void>;
  onEvent?: (event: AutoIngestWatchEvent) => void | Promise<void>;
  pdfOverrides?: PdfExtractionSettingOverrides;
};

type QueueCandidate = {
  sourceId: string;
  status: QueueStatus;
  error?: QueueCommandError;
};

type RunQueuedSourceInput = {
  repoRoot: string;
  sourceId: string;
  agent: LocalAgentConfig;
  now?: () => Date;
  lock?: Pick<IngestLockOptions, "timeoutMs" | "retryDelayMs">;
  command?: string;
  pdfOverrides?: PdfExtractionSettingOverrides;
  includeNotApplicablePdfResult?: boolean;
  resume?: boolean;
};

type CurrentSourceState = {
  status: QueueStatus;
  autoIngest: AutoIngestMetadata | null;
};

const DEFAULT_WATCH_POLL_INTERVAL_MS = 250;

export async function runAutoIngestBatch(input: RunAutoIngestBatchInput): Promise<AutoIngestBatchResult> {
  const agent = await resolveAndPreflightDefaultLocalAgent(input.repoRoot);
  const selected = await selectQueuedCandidates(input.repoRoot, input.limit);
  const results: AutoIngestSourceResult[] = [];

  for (const candidate of selected) {
    if (candidate.error !== undefined) {
      results.push(skippedResult(
        candidate.sourceId,
        candidate.status,
        candidate.status,
        agent.name,
        queueErrorToSafeError(candidate.error),
      ));
      continue;
    }

    results.push(await runQueuedSourceWithAgent({
      repoRoot: input.repoRoot,
      sourceId: candidate.sourceId,
      agent,
      now: input.now,
      lock: input.lock,
      command: input.command,
      pdfOverrides: input.pdfOverrides,
      includeNotApplicablePdfResult: true,
    }));
  }

  return {
    agent: agent.name,
    results,
    counts: countResults(selected.length, results),
  };
}

export async function runAutoIngestSource(input: RunAutoIngestSourceInput): Promise<AutoIngestSourceResult> {
  const current = await readCurrentSourceState(input.repoRoot, input.sourceId);
  if (!current.ok) {
    return skippedResult(input.sourceId, null, null, null, queueErrorToSafeError(current.error));
  }

  if (current.value.status !== "queued") {
    return statusNotEligibleResult(input.sourceId, current.value.status, current.value.autoIngest);
  }

  const agent = await resolveAndPreflightDefaultLocalAgent(input.repoRoot);

  return runQueuedSourceWithAgent({
    repoRoot: input.repoRoot,
    sourceId: input.sourceId,
    agent,
    now: input.now,
    lock: input.lock,
    command: input.command,
    pdfOverrides: input.pdfOverrides,
    includeNotApplicablePdfResult: input.allowNonPdfPdfOptions === true,
  });
}

export async function resumeAutoIngestSource(input: RunAutoIngestSourceInput): Promise<AutoIngestSourceResult> {
  const current = await readCurrentSourceState(input.repoRoot, input.sourceId);
  if (!current.ok) {
    return skippedResult(input.sourceId, null, null, null, queueErrorToSafeError(current.error));
  }

  if (current.value.status !== "ingesting") {
    return resumeNotEligibleResult(input.sourceId, current.value.status, current.value.autoIngest);
  }

  const agent = await resolveAndPreflightDefaultLocalAgent(input.repoRoot);

  return runIngestingSourceWithAgent({
    repoRoot: input.repoRoot,
    sourceId: input.sourceId,
    agent,
    now: input.now,
    lock: input.lock,
    command: input.command,
    pdfOverrides: input.pdfOverrides,
    includeNotApplicablePdfResult: input.allowNonPdfPdfOptions === true,
    resume: true,
  });
}

export async function runAutoIngestWatch(input: RunAutoIngestWatchInput): Promise<AutoIngestWatchSummary> {
  const agent = await resolveAndPreflightDefaultLocalAgent(input.repoRoot);
  const counts = emptyAutoIngestCounts();
  const command = input.command ?? "llm-wiki queue ingest --auto --watch";
  let failureCount = 0;
  let interrupted = signalIsAborted(input.signal);
  const selectedSourceIds = new Set<string>();

  await input.onPreflightComplete?.(agent);

  while (!interrupted) {
    const candidates = (await selectQueuedCandidates(input.repoRoot))
      .filter((candidate) => !selectedSourceIds.has(candidate.sourceId));

    for (const candidate of candidates) {
      selectedSourceIds.add(candidate.sourceId);
      if (signalIsAborted(input.signal)) {
        interrupted = true;
        break;
      }

      const result = candidate.error === undefined
        ? await runQueuedSourceWithAgent({
            repoRoot: input.repoRoot,
            sourceId: candidate.sourceId,
            agent,
            now: input.now,
            lock: input.lock,
            command,
            pdfOverrides: input.pdfOverrides,
            includeNotApplicablePdfResult: true,
          })
        : skippedResult(
            candidate.sourceId,
            candidate.status,
            candidate.status,
            agent.name,
            queueErrorToSafeError(candidate.error),
          );

      addSourceResultToCounts(counts, result);
      if (watchResultIsSessionFailure(result)) {
        failureCount += 1;
      }

      await input.onEvent?.({
        event: "result",
        agent: agent.name,
        result,
        counts: { ...counts },
      });

      if (signalIsAborted(input.signal)) {
        interrupted = true;
        break;
      }
    }

    if (interrupted || signalIsAborted(input.signal)) {
      interrupted = true;
      break;
    }

    await sleepForWatchPoll(input.pollIntervalMs, input.signal);
    interrupted = signalIsAborted(input.signal);
  }

  const summary: AutoIngestWatchSummary = {
    agent: agent.name,
    counts: { ...counts },
    interrupted,
    failure_count: failureCount,
    exit_code: failureCount === 0 ? 0 : 1,
  };

  await input.onEvent?.({
    event: "summary",
    summary,
  });

  return summary;
}

async function runQueuedSourceWithAgent(input: RunQueuedSourceInput): Promise<AutoIngestSourceResult> {
  return runSourceWithPreparedArtifact(input);
}

async function runIngestingSourceWithAgent(input: RunQueuedSourceInput): Promise<AutoIngestSourceResult> {
  return runSourceWithPreparedArtifact({ ...input, resume: true });
}

async function runSourceWithPreparedArtifact(input: RunQueuedSourceInput): Promise<AutoIngestSourceResult> {
  const command = input.command ?? `llm-wiki ingest ${input.sourceId} --auto`;
  const expectedStatus: QueueStatus = input.resume === true ? "ingesting" : "queued";

  for (let preflightAttempt = 0; preflightAttempt < 4; preflightAttempt += 1) {
    const prepared = await prepareSourceArtifactOrResult(input, expectedStatus);
    if (!("kind" in prepared)) return prepared;

    try {
      return await withIngestLock(
        input.repoRoot,
        {
          label: `auto-ingest:${input.sourceId}`,
          timeoutMs: input.lock?.timeoutMs,
          retryDelayMs: input.lock?.retryDelayMs,
          now: input.now,
        },
        (lease) => runPreparedSourceUnderLock(input, prepared, lease, expectedStatus, command),
      );
    } catch (error) {
      if (error instanceof PdfPreflightRestartError) continue;
      if (error instanceof RuntimeCommandError && error.code === "INGEST_LOCK_BUSY") {
        return deferredForBusyLock(input, error);
      }
      throw error;
    }
  }

  const error = new RuntimeCommandError({
    code: "PDF_CONFIG_INVALID",
    message: "PDF configuration kept changing while auto-ingest waited for the repository lock.",
    path: ".llm-wiki/config.yml",
    hint: "Stop editing PDF/agent configuration, then retry auto-ingest.",
  });
  return readinessRejectedResult(input, expectedStatus, error);
}

async function prepareSourceArtifactOrResult(
  input: RunQueuedSourceInput,
  expectedStatus: QueueStatus,
): Promise<PreparedIngestArtifact | AutoIngestSourceResult> {
  try {
    return await prepareAutomatedIngestArtifact({
      repoRoot: input.repoRoot,
      sourceId: input.sourceId,
      agent: input.agent,
      overrides: input.pdfOverrides,
      includeNotApplicableResult: input.includeNotApplicablePdfResult,
    });
  } catch (error) {
    return readinessRejectedResult(input, expectedStatus, error);
  }
}

async function runPreparedSourceUnderLock(
  input: RunQueuedSourceInput,
  prepared: PreparedIngestArtifact,
  lease: Parameters<typeof ensurePreparedIngestArtifactUnderLock>[1],
  expectedStatus: QueueStatus,
  command: string,
): Promise<AutoIngestSourceResult> {
  const current = await readCurrentSourceState(input.repoRoot, input.sourceId);
  if (!current.ok) {
    return skippedResult(input.sourceId, null, null, input.agent.name, queueErrorToSafeError(current.error));
  }
  if (current.value.status !== expectedStatus) {
    return input.resume === true
      ? resumeNotEligibleResult(input.sourceId, current.value.status, current.value.autoIngest, input.agent.name)
      : statusNotEligibleResult(input.sourceId, current.value.status, current.value.autoIngest, input.agent.name);
  }

  let attempted = false;
  let previousStatus: QueueStatus = current.value.status;
  let pdf: PdfAutoIngestResult | null = null;
  try {
    const ensured = await ensurePreparedIngestArtifactUnderLock(prepared, lease, {
      onReady: async () => {
        if (expectedStatus === "queued") {
          const started = await transitionQueueStatus(input.repoRoot, input.sourceId, "ingesting", {
            now: currentDate(input.now),
            command,
            autoIngest: {
              enabled: true,
              result: "ingesting",
              errorCode: null,
              errorMessage: null,
            },
          });
          if (!started.ok) throw queueRuntimeError(started.error);
          previousStatus = started.value.previous_status;
        }
        attempted = true;
      },
    });
    pdf = ensured.pdf;
    const coreResult = await runLocalAgentIngestCore({
      repoRoot: input.repoRoot,
      sourceId: input.sourceId,
      agent: input.agent,
      canonicalArtifact: ensured.artifact,
      completeAppliedIngest: async () => {
        const completed = await transitionQueueStatus(input.repoRoot, input.sourceId, "ingested", {
          now: currentDate(input.now),
          command,
          autoIngest: {
            enabled: true,
            result: "ingested",
            errorCode: null,
            errorMessage: null,
          },
        });
        if (!completed.ok) throw queueRuntimeError(completed.error);
        return completed.value;
      },
    });
    const finalState = await readCurrentSourceStateOrThrow(input.repoRoot, input.sourceId);
    return {
      source_id: input.sourceId,
      previous_status: previousStatus,
      final_status: "ingested",
      outcome: "ingested",
      attempted: true,
      agent: input.agent.name,
      applied_paths: coreResult.appliedPaths,
      auto_ingest: finalState.autoIngest,
      error: null,
      ...optionalPdfResult(pdf),
    };
  } catch (error) {
    if (!attempted) throw error;
    const safeError = errorToSafeAutoIngestError(error, input.sourceId);
    if (pdf === null && await sourceRequiresPdfArtifact(input.repoRoot, input.sourceId)) {
      pdf = await readPdfIngestFailureResult(input.repoRoot, input.sourceId, "failed");
    }
    const blocked = await transitionQueueStatus(input.repoRoot, input.sourceId, "blocked", {
      now: currentDate(input.now),
      command,
      autoIngest: {
        enabled: true,
        result: "blocked",
        errorCode: safeError.code,
        errorMessage: safeError.message,
      },
    });
    if (!blocked.ok) throw queueRuntimeError(blocked.error);
    const finalState = await readCurrentSourceStateOrThrow(input.repoRoot, input.sourceId);
    return {
      source_id: input.sourceId,
      previous_status: previousStatus,
      final_status: "blocked",
      outcome: "blocked",
      attempted: true,
      agent: input.agent.name,
      applied_paths: [],
      auto_ingest: finalState.autoIngest,
      error: safeError,
      ...optionalPdfResult(pdf),
    };
  }
}

async function selectQueuedCandidates(repoRoot: string, limit?: number): Promise<QueueCandidate[]> {
  const listed = await listQueueRecordSummaries(repoRoot);
  if (!listed.ok) {
    throw queueRuntimeError(listed.error);
  }

  const queued = listed.value.filter((item) => item.status === "queued");
  const selected = queued
    .sort((left, right) => {
      const capturedAtOrder = left.captured_at.localeCompare(right.captured_at);

      return capturedAtOrder === 0
        ? left.source_id.localeCompare(right.source_id)
        : capturedAtOrder;
    })
    .slice(0, normalizeLimit(limit, queued.length));

  const candidates: QueueCandidate[] = [];
  for (const item of selected) {
    const shown = await showQueueSource(repoRoot, item.source_id);
    if (!shown.ok) {
      candidates.push({
        sourceId: item.source_id,
        status: item.status,
        error: shown.error,
      });
      continue;
    }

    candidates.push({
      sourceId: shown.value.queue_record.source_id,
      status: shown.value.queue_record.status,
    });
  }

  return candidates;
}

async function resolveAndPreflightDefaultLocalAgent(repoRoot: string): Promise<LocalAgentConfig> {
  const agent = await loadDefaultLocalAgentConfig(repoRoot);
  if (!agent.ok) {
    throw agentConfigRuntimeError(agent.error);
  }

  const availability = await checkLocalAgentAvailability(agent.value, { cwd: repoRoot });
  if (!availability.ok) {
    throw new RuntimeCommandError({
      code: availability.error.code,
      message: availability.error.message,
      hint: availability.error.hint,
      path: availability.error.executablePath,
    });
  }

  return agent.value;
}

async function readCurrentSourceState(
  repoRoot: string,
  sourceId: string,
): Promise<{ ok: true; value: CurrentSourceState } | { ok: false; error: QueueCommandError }> {
  const shown = await showQueueSource(repoRoot, sourceId);
  if (!shown.ok) {
    return shown;
  }

  return {
    ok: true,
    value: {
      status: shown.value.queue_record.status,
      autoIngest: shown.value.queue_record.auto_ingest ?? null,
    },
  };
}

async function readCurrentSourceStateOrThrow(repoRoot: string, sourceId: string): Promise<CurrentSourceState> {
  const current = await readCurrentSourceState(repoRoot, sourceId);
  if (!current.ok) {
    throw queueRuntimeError(current.error);
  }

  return current.value;
}

function statusNotEligibleResult(
  sourceId: string,
  status: QueueStatus,
  autoIngest: AutoIngestMetadata | null,
  agent: string | null = null,
): AutoIngestSourceResult {
  const outcome: AutoIngestOutcome = status === "ingesting" ? "deferred" : "skipped";

  return {
    source_id: sourceId,
    previous_status: status,
    final_status: status,
    outcome,
    attempted: false,
    agent,
    applied_paths: [],
    auto_ingest: autoIngest,
    error: {
      code: "AUTO_INGEST_SOURCE_NOT_ELIGIBLE",
      message: `Auto-ingest only processes queued sources; current status is ${status}.`,
      path: `raw/queue/${sourceId}.json`,
      hint: status === "ingesting"
        ? "Another ingest is already processing this source."
        : "Only queued sources are eligible for auto-ingest.",
    },
  };
}

function resumeNotEligibleResult(
  sourceId: string,
  status: QueueStatus,
  autoIngest: AutoIngestMetadata | null,
  agent: string | null = null,
): AutoIngestSourceResult {
  const outcome: AutoIngestOutcome = status === "ingesting" ? "deferred" : "skipped";

  return {
    source_id: sourceId,
    previous_status: status,
    final_status: status,
    outcome,
    attempted: false,
    agent,
    applied_paths: [],
    auto_ingest: autoIngest,
    error: {
      code: "AUTO_INGEST_SOURCE_NOT_ELIGIBLE",
      message: `Auto-ingest resume only processes ingesting sources; current status is ${status}.`,
      path: `raw/queue/${sourceId}.json`,
      hint: "Resume only a source that is already marked ingesting, or run normal auto-ingest for queued sources.",
    },
  };
}

function skippedResult(
  sourceId: string,
  previousStatus: QueueStatus | null,
  finalStatus: QueueStatus | null,
  agent: string | null,
  error: AutoIngestSafeError,
  pdf: PdfAutoIngestResult | null = null,
  autoIngest: AutoIngestMetadata | null = null,
): AutoIngestSourceResult {
  return {
    source_id: sourceId,
    previous_status: previousStatus,
    final_status: finalStatus,
    outcome: "skipped",
    attempted: false,
    agent,
    applied_paths: [],
    auto_ingest: autoIngest,
    error,
    ...optionalPdfResult(pdf),
  };
}

async function readinessRejectedResult(
  input: RunQueuedSourceInput,
  expectedStatus: QueueStatus,
  error: unknown,
): Promise<AutoIngestSourceResult> {
  const safeError = errorToSafeAutoIngestError(error, input.sourceId);
  const current = await readCurrentSourceState(input.repoRoot, input.sourceId);
  const status = current.ok ? current.value.status : expectedStatus;
  let pdf: PdfAutoIngestResult | null = null;
  try {
    if (await sourceRequiresPdfArtifact(input.repoRoot, input.sourceId)) {
      pdf = await readPdfIngestFailureResult(input.repoRoot, input.sourceId, "readiness_rejected");
    }
  } catch {
    pdf = null;
  }
  return skippedResult(
    input.sourceId,
    status,
    status,
    input.agent.name,
    safeError,
    pdf,
    current.ok ? current.value.autoIngest : null,
  );
}

async function deferredForBusyLock(
  input: RunQueuedSourceInput,
  error: RuntimeCommandError,
): Promise<AutoIngestSourceResult> {
  const current = await readCurrentSourceState(input.repoRoot, input.sourceId);
  const currentStatus = current.ok ? current.value.status : null;
  const currentMetadata = current.ok ? current.value.autoIngest : null;
  return {
    source_id: input.sourceId,
    previous_status: currentStatus,
    final_status: currentStatus,
    outcome: "deferred",
    attempted: false,
    agent: input.agent.name,
    applied_paths: [],
    auto_ingest: currentMetadata,
    error: runtimeErrorToSafeError(error),
  };
}

function optionalPdfResult(pdf: PdfAutoIngestResult | null): { pdf?: PdfAutoIngestResult } {
  return pdf === null ? {} : { pdf };
}

function countResults(selected: number, results: readonly AutoIngestSourceResult[]): AutoIngestBatchResult["counts"] {
  const counts = emptyAutoIngestCounts();

  for (const result of results) {
    addSourceResultToCounts(counts, result);
  }

  counts.selected = selected;

  return counts;
}

function emptyAutoIngestCounts(): AutoIngestBatchResult["counts"] {
  return {
    selected: 0,
    attempted: 0,
    ingested: 0,
    blocked: 0,
    skipped: 0,
    deferred: 0,
  };
}

function addSourceResultToCounts(
  counts: AutoIngestBatchResult["counts"],
  result: AutoIngestSourceResult,
): void {
  counts.selected += 1;

  if (result.attempted) {
    counts.attempted += 1;
  }

  if (result.outcome === "ingested") {
    counts.ingested += 1;
  } else if (result.outcome === "blocked") {
    counts.blocked += 1;
  } else if (result.outcome === "skipped") {
    counts.skipped += 1;
  } else {
    counts.deferred += 1;
  }
}

function watchResultIsSessionFailure(result: AutoIngestSourceResult): boolean {
  return result.outcome === "blocked" || result.outcome === "deferred" || result.outcome === "skipped";
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) {
    return fallback;
  }

  if (!Number.isFinite(limit)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(limit));
}

async function sleepForWatchPoll(pollIntervalMs: number | undefined, signal: AbortSignal | undefined): Promise<void> {
  const intervalMs = normalizeDuration(pollIntervalMs, DEFAULT_WATCH_POLL_INTERVAL_MS);
  if (intervalMs === 0) {
    return;
  }

  try {
    await sleep(intervalMs, undefined, signal === undefined ? undefined : { signal });
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) {
      return;
    }

    throw error;
  }
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

function currentDate(now: (() => Date) | undefined): Date {
  return now?.() ?? new Date();
}

function agentConfigRuntimeError(error: LocalAgentConfigError): RuntimeCommandError {
  return new RuntimeCommandError({
    code: error.code,
    message: error.message,
    hint: error.hint,
    path: error.path,
  });
}

function queueRuntimeError(error: QueueCommandError): RuntimeCommandError {
  return new RuntimeCommandError({
    code: error.code,
    message: error.message,
    hint: error.hint,
    path: error.path,
  });
}

function queueErrorToSafeError(error: QueueCommandError): AutoIngestSafeError {
  return {
    code: error.code,
    message: safeMessage(error.message),
    path: error.path,
    hint: safeMessage(error.hint),
  };
}

function runtimeErrorToSafeError(error: RuntimeCommandError): AutoIngestSafeError {
  return {
    code: error.code,
    message: safeMessage(error.message),
    path: error.path,
    hint: safeMessage(error.hint),
  };
}

function errorToSafeAutoIngestError(error: unknown, sourceId: string): AutoIngestSafeError {
  if (error instanceof LocalAgentExecutionError) {
    const exitCode = error.exitCode === null ? "null" : String(error.exitCode);
    const signal = error.signal === null ? "null" : error.signal;

    return {
      code: error.code,
      message: safeMessage([
        `Agent command failed for ${error.agentName}.`,
        `exit code ${exitCode}; signal ${signal}; timed out: ${error.timedOut}; changes observed: ${error.changesObserved}.`,
      ].join(" ")),
      path: error.executablePath,
      hint: safeMessage(error.hint),
    };
  }

  if (error instanceof IngestValidationFailedError) {
    const firstIssue = error.issues[0];

    return {
      code: "INGEST_VALIDATION_FAILED",
      message: `Ingest validation found ${error.issues.length} blocking issue${error.issues.length === 1 ? "" : "s"}.`,
      path: firstIssue?.path ?? `curated/sources/${sourceId}.md`,
      hint: "Complete the required curated summary, index, log, source_ids, and raw immutability fixes.",
      issues: error.issues.map(validationIssueToSafeIssue),
    };
  }

  if (error instanceof RuntimeCommandError) {
    return runtimeErrorToSafeError(error);
  }

  return {
    code: "AUTO_INGEST_FAILED",
    message: error instanceof Error ? safeMessage(error.message) : safeMessage(String(error)),
    path: sourceId,
    hint: "Fix the local agent or repository state, then rerun auto-ingest.",
  };
}

function validationIssueToSafeIssue(
  issue: IngestValidationFailedError["issues"][number],
): AutoIngestSafeIssue {
  return {
    severity: issue.severity,
    code: issue.rule_id,
    message: safeMessage(issue.message),
    path: issue.path,
    hint: safeMessage(issue.fix_hint),
  };
}

function safeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
