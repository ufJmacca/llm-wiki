import {
  checkLocalAgentAvailability,
  LocalAgentExecutionError,
} from "../agents/index.js";
import {
  IngestValidationFailedError,
  runLocalAgentIngestCore,
} from "../ingest/localAgentCore.js";
import {
  loadDefaultLocalAgentConfig,
  type LocalAgentConfig,
  type LocalAgentConfigError,
} from "../runtime/config.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { withIngestLock, type IngestLockOptions } from "../runtime/ingestLock.js";
import {
  listQueue,
  showQueueSource,
  transitionQueueStatus,
  type AutoIngestMetadata,
  type QueueCommandError,
  type QueueStatus,
} from "../runtime/queue.js";

export type { AutoIngestMetadata } from "../runtime/queue.js";

export type AutoIngestOutcome = "ingested" | "blocked" | "skipped" | "deferred";

export type AutoIngestSafeError = {
  code: string;
  message: string;
  path: string;
  hint: string;
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

export type RunAutoIngestBatchInput = {
  repoRoot: string;
  limit?: number;
  now?: () => Date;
  lock?: Pick<IngestLockOptions, "timeoutMs" | "retryDelayMs">;
  command?: string;
};

export type RunAutoIngestSourceInput = {
  repoRoot: string;
  sourceId: string;
  now?: () => Date;
  lock?: Pick<IngestLockOptions, "timeoutMs" | "retryDelayMs">;
  command?: string;
};

type QueueCandidate = {
  sourceId: string;
  capturedAt: string;
};

type RunQueuedSourceInput = {
  repoRoot: string;
  sourceId: string;
  agent: LocalAgentConfig;
  now?: () => Date;
  lock?: Pick<IngestLockOptions, "timeoutMs" | "retryDelayMs">;
  command?: string;
};

type CurrentSourceState = {
  status: QueueStatus;
  autoIngest: AutoIngestMetadata | null;
};

export async function runAutoIngestBatch(input: RunAutoIngestBatchInput): Promise<AutoIngestBatchResult> {
  const agent = await resolveAndPreflightDefaultLocalAgent(input.repoRoot);
  const candidates = await selectQueuedCandidates(input.repoRoot);
  const selected = candidates.slice(0, normalizeLimit(input.limit, candidates.length));
  const results: AutoIngestSourceResult[] = [];

  for (const candidate of selected) {
    results.push(await runQueuedSourceWithAgent({
      repoRoot: input.repoRoot,
      sourceId: candidate.sourceId,
      agent,
      now: input.now,
      lock: input.lock,
      command: input.command,
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
  });
}

async function runQueuedSourceWithAgent(input: RunQueuedSourceInput): Promise<AutoIngestSourceResult> {
  const command = input.command ?? `llm-wiki ingest ${input.sourceId} --auto`;

  try {
    return await withIngestLock(
      input.repoRoot,
      {
        label: `auto-ingest:${input.sourceId}`,
        timeoutMs: input.lock?.timeoutMs,
        retryDelayMs: input.lock?.retryDelayMs,
        now: input.now,
      },
      async () => {
        const current = await readCurrentSourceState(input.repoRoot, input.sourceId);
        if (!current.ok) {
          return skippedResult(input.sourceId, null, null, input.agent.name, queueErrorToSafeError(current.error));
        }

        if (current.value.status !== "queued") {
          return statusNotEligibleResult(input.sourceId, current.value.status, current.value.autoIngest, input.agent.name);
        }

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
        if (!started.ok) {
          throw queueRuntimeError(started.error);
        }

        try {
          const coreResult = await runLocalAgentIngestCore({
            repoRoot: input.repoRoot,
            sourceId: input.sourceId,
            agent: input.agent,
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
              if (!completed.ok) {
                throw queueRuntimeError(completed.error);
              }

              return completed.value;
            },
          });
          const finalState = await readCurrentSourceStateOrThrow(input.repoRoot, input.sourceId);

          return {
            source_id: input.sourceId,
            previous_status: started.value.previous_status,
            final_status: "ingested",
            outcome: "ingested",
            attempted: true,
            agent: input.agent.name,
            applied_paths: coreResult.appliedPaths,
            auto_ingest: finalState.autoIngest,
            error: null,
          };
        } catch (error) {
          const safeError = errorToSafeAutoIngestError(error, input.sourceId);
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
          if (!blocked.ok) {
            throw queueRuntimeError(blocked.error);
          }

          const finalState = await readCurrentSourceStateOrThrow(input.repoRoot, input.sourceId);

          return {
            source_id: input.sourceId,
            previous_status: started.value.previous_status,
            final_status: "blocked",
            outcome: "blocked",
            attempted: true,
            agent: input.agent.name,
            applied_paths: [],
            auto_ingest: finalState.autoIngest,
            error: safeError,
          };
        }
      },
    );
  } catch (error) {
    if (error instanceof RuntimeCommandError && error.code === "INGEST_LOCK_BUSY") {
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

    throw error;
  }
}

async function selectQueuedCandidates(repoRoot: string): Promise<QueueCandidate[]> {
  const listed = await listQueue(repoRoot);
  if (!listed.ok) {
    throw queueRuntimeError(listed.error);
  }

  const candidates: QueueCandidate[] = [];
  for (const item of listed.value.items) {
    if (item.status !== "queued") {
      continue;
    }

    const shown = await showQueueSource(repoRoot, item.source_id);
    if (!shown.ok) {
      throw queueRuntimeError(shown.error);
    }

    candidates.push({
      sourceId: shown.value.queue_record.source_id,
      capturedAt: shown.value.queue_record.captured_at,
    });
  }

  return candidates.sort((left, right) => {
    const capturedAtOrder = left.capturedAt.localeCompare(right.capturedAt);

    return capturedAtOrder === 0 ? left.sourceId.localeCompare(right.sourceId) : capturedAtOrder;
  });
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

function skippedResult(
  sourceId: string,
  previousStatus: QueueStatus | null,
  finalStatus: QueueStatus | null,
  agent: string | null,
  error: AutoIngestSafeError,
): AutoIngestSourceResult {
  return {
    source_id: sourceId,
    previous_status: previousStatus,
    final_status: finalStatus,
    outcome: "skipped",
    attempted: false,
    agent,
    applied_paths: [],
    auto_ingest: null,
    error,
  };
}

function countResults(selected: number, results: readonly AutoIngestSourceResult[]): AutoIngestBatchResult["counts"] {
  const counts: AutoIngestBatchResult["counts"] = {
    selected,
    attempted: 0,
    ingested: 0,
    blocked: 0,
    skipped: 0,
    deferred: 0,
  };

  for (const result of results) {
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

  return counts;
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

function safeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}
