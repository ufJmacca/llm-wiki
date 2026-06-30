import { posix } from "node:path";

import { CommanderError, type Command } from "commander";

import {
  checkLocalAgentAvailability,
  LocalAgentExecutionError,
} from "../agents/index.js";
import { runAutoIngestSource, type AutoIngestSourceResult } from "../autoIngest/index.js";
import type { CliIo } from "../cli.js";
import { buildIngestTask, type IngestTask } from "../agentTasks/ingest.js";
import { IngestValidationFailedError, runLocalAgentIngestCore } from "../ingest/localAgentCore.js";
import {
  applyProviderProposalsWithValidation,
  requestProviderFileProposals,
  validateProposalsOnTemporaryRepo as validateProviderProposalsOnTemporaryRepo,
} from "../providers/index.js";
import {
  loadDefaultLocalAgentConfig,
  loadLocalAgentConfig,
  loadProviderConfig,
  type HttpProviderConfig,
  type LocalAgentConfig,
  type LocalAgentConfigError,
  type ProviderConfigError,
} from "../runtime/config.js";
import { addRuntimeOptions, type RawRuntimeCommandOptions, type RuntimeCommandOptions } from "../runtime/command.js";
import { buildRuntimeFailureEnvelope, buildRuntimeSuccessEnvelope, type RuntimeIssue } from "../runtime/envelope.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { resolveWikiRoot } from "../runtime/repo.js";
import { setQueueStatus, showQueueSource, type QueueStatus } from "../runtime/queue.js";
import { validateIngestReadiness, type IngestValidationIssue } from "../validation/ingest.js";
import { prepareIngestBranch } from "../utils/git.js";
import { readTextFileInsideRoot, validateTextFileWriteInsideRoot, writeTextFileInsideRoot } from "../utils/fs.js";

type RawIngestOptions = RawRuntimeCommandOptions & {
  validate?: unknown;
  taskOut?: unknown;
  createBranch?: unknown;
  provider?: unknown;
  agent?: unknown;
  auto?: unknown;
};

type IngestGitData = {
  enabled: boolean;
  branch_name: string;
  recommended_command: string | null;
  created: boolean;
};

type IngestQueueTransitionData = {
  previous_status: QueueStatus | null;
  status: QueueStatus;
};

type IngestTaskData = IngestTask & {
  git: IngestGitData;
};

type IngestValidationData = {
  mode: "validate";
  source: {
    source_id: string;
    status: "ingested";
  };
  validation: {
    passed: true;
    issues: [];
  };
  queue: {
    previous_status: QueueStatus;
    status: "ingested";
  };
};

type IngestProviderData = {
  mode: "provider";
  provider: {
    name: string;
    model: string | null;
  };
  source: {
    source_id: string;
    status: "ingested";
  };
  proposals: {
    applied_paths: string[];
  };
  validation: {
    passed: true;
    issues: [];
  };
  queue: {
    previous_status: QueueStatus;
    status: "ingested";
  };
};

type IngestAgentData = {
  mode: "agent";
  agent: string;
  source: {
    source_id: string;
    status: "ingested";
  };
  applied_paths: string[];
  validation: {
    passed: true;
    issues: [];
  };
  queue: {
    previous_status: QueueStatus;
    status: "ingested";
  };
};

type IngestData = IngestTaskData | IngestValidationData | IngestProviderData | IngestAgentData;

type IngestStateSnapshot = {
  sourceCardPath: string;
  sourceCardContent: string;
  queuePath: string;
  queueContent: string;
  logContent: string;
};

export function registerIngestCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("ingest")
      .description("Generate a manual prompt, execute local agents/providers, or validate completed curated edits")
      .argument("<source_id>", "source ID to ingest")
      .option("--validate", "validate completed ingest output and mark source ingested", false)
      .option("--task-out <path>", "write the manual prompt to a repository-relative path")
      .option("--create-branch", "create the recommended ingest branch when Git is enabled", false)
      .option("--agent <name>", "run local agent execution with a configured agent such as codex")
      .option("--auto", "run local agent execution with the configured default local agent", false)
      .option("--provider <name>", "run HTTP provider mode with an explicitly configured provider"),
  ).action(async (sourceId: string, rawOptions: RawIngestOptions) => {
    await runIngestCommand(sourceId, rawOptions, io);
  });
}

async function runIngestCommand(sourceId: string, rawOptions: RawIngestOptions, io: CliIo): Promise<void> {
  const options = normalizeRuntimeOptions(rawOptions);
  const resolvedRepo = await resolveWikiRoot({ repoPath: options.repo });

  if (!resolvedRepo.ok) {
    const envelope = buildRuntimeFailureEnvelope("ingest", resolvedRepo.error);
    if (options.json) {
      io.stdout(JSON.stringify(envelope));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.ingest", envelope.error.message);
  }

  try {
    validateIngestModeOptions(rawOptions);
    const data = rawOptions.validate === true
      ? await validateAndCompleteIngest(resolvedRepo.value.rootDir, sourceId)
      : typeof rawOptions.provider === "string"
        ? await executeProviderIngest(resolvedRepo.value.rootDir, sourceId, rawOptions.provider)
        : isAgentModeRequested(rawOptions)
          ? await executeAgentIngest(resolvedRepo.value.rootDir, sourceId, rawOptions)
        : await createIngestTask(resolvedRepo.value.rootDir, sourceId, rawOptions);
    const envelope = buildRuntimeSuccessEnvelope("ingest", resolvedRepo.value.rootDir, data, []);

    if (options.json) {
      io.stdout(JSON.stringify(envelope));
      return;
    }

    if (!options.quiet) {
      io.stdout(formatHumanIngest(data));
    }
  } catch (error) {
    if (error instanceof IngestValidationFailedError) {
      throwValidationFailure(io, resolvedRepo.value.rootDir, error.issues, options);
    }

    const commandError = error instanceof RuntimeCommandError
      ? error
      : new RuntimeCommandError({
          code: "INGEST_FAILED",
          message: error instanceof Error ? error.message : String(error),
          hint: "Fix the source queue or repository files, then rerun llm-wiki ingest.",
          path: sourceId,
        });
    const envelope = {
      ok: false as const,
      command: "ingest" as const,
      repo: resolvedRepo.value.rootDir,
      error: {
        code: commandError.code,
        message: commandError.message,
        hint: commandError.hint,
      },
      issues: [
        {
          severity: "error" as const,
          code: commandError.code,
          message: commandError.message,
          path: commandError.path,
          hint: commandError.hint,
        },
      ],
    };

    if (options.json) {
      io.stdout(JSON.stringify(envelope));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.ingest", envelope.error.message);
  }
}

function validateIngestModeOptions(rawOptions: RawIngestOptions): void {
  const executionModes = [
    typeof rawOptions.agent === "string",
    rawOptions.auto === true,
    typeof rawOptions.provider === "string",
  ].filter(Boolean).length;

  if (executionModes > 1) {
    throw new RuntimeCommandError({
      code: "INGEST_MODE_CONFLICT",
      message: "Choose only one ingest execution mode.",
      hint: "Use exactly one of --agent <name>, --auto, or --provider <name>; omit all three to generate the manual prompt.",
      path: "ingest",
    });
  }

  if (rawOptions.validate === true && executionModes > 0) {
    throw new RuntimeCommandError({
      code: "INGEST_MODE_CONFLICT",
      message: "Ingest validation cannot be combined with execution mode.",
      hint: "Use --validate by itself to check completed curated edits, or use exactly one of --agent <name>, --auto, or --provider <name> to execute.",
      path: "--validate",
    });
  }

  if (rawOptions.createBranch === true && (rawOptions.auto === true || typeof rawOptions.agent === "string")) {
    throw new RuntimeCommandError({
      code: "INGEST_MODE_CONFLICT",
      message: "Local agent ingest cannot be combined with --create-branch.",
      hint: "Create or switch to the ingest branch first, then rerun with --agent <name> or --auto.",
      path: "--create-branch",
    });
  }
}

function isAgentModeRequested(rawOptions: RawIngestOptions): boolean {
  return rawOptions.auto === true || typeof rawOptions.agent === "string";
}

async function executeAgentIngest(
  repoRoot: string,
  sourceId: string,
  rawOptions: RawIngestOptions,
): Promise<IngestAgentData> {
  if (rawOptions.auto === true) {
    return executeDefaultAutoIngest(repoRoot, sourceId);
  }

  const agent = await resolveLocalAgentConfig(repoRoot, rawOptions);
  const preflightTask = await buildIngestTask({
    repoRoot,
    sourceId,
  });
  if (!preflightTask.ok) {
    throw new RuntimeCommandError({
      code: preflightTask.error.code,
      message: preflightTask.error.message,
      hint: preflightTask.error.hint,
      path: preflightTask.error.path,
    });
  }

  ensureIngestTaskCanStart(preflightTask.value);
  await assertLocalAgentCommandAvailable(agent, repoRoot);
  await ensureIngesting(repoRoot, sourceId, agentIngestCommand(sourceId, agent.name, rawOptions));

  try {
    const result = await runLocalAgentIngestCore({
      repoRoot,
      sourceId,
      agent,
      completeAppliedIngest: async () => {
        return markIngested(repoRoot, sourceId);
      },
    });

    return {
      mode: "agent",
      agent: agent.name,
      source: {
        source_id: sourceId,
        status: "ingested",
      },
      applied_paths: result.appliedPaths,
      validation: {
        passed: true,
        issues: [],
      },
      queue: result.completion,
    };
  } catch (error) {
    await markBlockedIfIngesting(repoRoot, sourceId, agentIngestCommand(sourceId, agent.name, rawOptions));
    if (error instanceof LocalAgentExecutionError) {
      throw localAgentExecutionRuntimeError(error);
    }

    throw error;
  }
}

async function executeDefaultAutoIngest(repoRoot: string, sourceId: string): Promise<IngestAgentData> {
  const result = await runAutoIngestSource({
    repoRoot,
    sourceId,
    command: `llm-wiki ingest ${sourceId} --auto`,
  });

  if (result.outcome !== "ingested") {
    throw autoIngestRuntimeError(result);
  }

  return {
    mode: "agent",
    agent: result.agent ?? "default",
    source: {
      source_id: sourceId,
      status: "ingested",
    },
    applied_paths: result.applied_paths,
    validation: {
      passed: true,
      issues: [],
    },
    queue: {
      previous_status: "ingesting",
      status: "ingested",
    },
  };
}

async function executeProviderIngest(
  repoRoot: string,
  sourceId: string,
  providerName: string,
): Promise<IngestProviderData> {
  const task = await buildIngestTask({
    repoRoot,
    sourceId,
  });
  if (!task.ok) {
    throw new RuntimeCommandError({
      code: task.error.code,
      message: task.error.message,
      hint: task.error.hint,
      path: task.error.path,
    });
  }

  ensureIngestTaskCanStart(task.value);
  const provider = await resolveProviderConfig(repoRoot, providerName);
  const proposals = await requestProviderFileProposals({
    kind: "ingest",
    provider,
    task: task.value,
  });

  await validateProviderProposalsOnTemporaryRepo(repoRoot, proposals, async (tempRepoRoot) => {
    const validation = await validateIngestReadiness(tempRepoRoot, sourceId);
    if (!validation.passed) {
      throw new IngestValidationFailedError(validation.issues);
    }
  });

  const { appliedPaths, validation: completed } = await applyProviderProposalsWithValidation(
    repoRoot,
    proposals,
    async () => validateAndCompleteIngest(repoRoot, sourceId),
  );

  return {
    mode: "provider",
    provider: publicProviderData(provider),
    source: {
      source_id: sourceId,
      status: "ingested",
    },
    proposals: {
      applied_paths: appliedPaths,
    },
    validation: {
      passed: true,
      issues: [],
    },
    queue: completed.queue,
  };
}

async function createIngestTask(
  repoRoot: string,
  sourceId: string,
  rawOptions: RawIngestOptions,
): Promise<IngestTaskData> {
  const artifactPath = typeof rawOptions.taskOut === "string" ? rawOptions.taskOut : null;
  const preflightTask = await buildIngestTask({
    repoRoot,
    sourceId,
    artifactPath,
  });
  if (!preflightTask.ok) {
    throw new RuntimeCommandError({
      code: preflightTask.error.code,
      message: preflightTask.error.message,
      hint: preflightTask.error.hint,
      path: preflightTask.error.path,
    });
  }

  ensureIngestTaskCanStart(preflightTask.value);

  if (artifactPath !== null) {
    await validateTaskArtifactWriteTarget(repoRoot, artifactPath);
  }

  const git = await prepareIngestBranch(repoRoot, sourceId, { create: rawOptions.createBranch === true });
  if (git.error !== null) {
    throw new RuntimeCommandError({
      code: "INGEST_BRANCH_CREATE_FAILED",
      message: git.error,
      hint: "Check Git status or create the ingest branch manually before rerunning.",
      path: ".git",
    });
  }

  const rollbackSnapshot = await snapshotIngestState(repoRoot, preflightTask.value);
  const queue = await ensureIngesting(repoRoot, sourceId);

  try {
    const task = await buildIngestTask({
      repoRoot,
      sourceId,
      artifactPath,
      previousStatus: queue.previous_status,
    });
    if (!task.ok) {
      throw new RuntimeCommandError({
        code: task.error.code,
        message: task.error.message,
        hint: task.error.hint,
        path: task.error.path,
      });
    }

    if (artifactPath !== null) {
      await writeTaskArtifact(repoRoot, artifactPath, task.value.task.prompt);
    }

    return {
      ...task.value,
      source: {
        ...task.value.source,
        status: queue.status,
      },
      queue,
      git: {
        enabled: git.enabled,
        branch_name: git.branchName,
        recommended_command: git.recommendedCommand,
        created: git.created,
      },
    };
  } catch (error) {
    if (rollbackSnapshot !== null && queue.previous_status !== null) {
      await restoreIngestState(repoRoot, rollbackSnapshot);
    }

    throw error;
  }
}

async function validateTaskArtifactWriteTarget(repoRoot: string, artifactPath: string): Promise<void> {
  assertTaskArtifactPathAllowed(artifactPath);

  const writeTarget = await validateTextFileWriteInsideRoot(repoRoot, artifactPath);
  if (!writeTarget.ok) {
    throw new RuntimeCommandError({
      code: "INGEST_TASK_WRITE_FAILED",
      message: writeTarget.error.message,
      hint: writeTarget.error.hint,
      path: writeTarget.error.path,
    });
  }
}

async function writeTaskArtifact(repoRoot: string, artifactPath: string, prompt: string): Promise<void> {
  assertTaskArtifactPathAllowed(artifactPath);

  const write = await writeTextFileInsideRoot(repoRoot, artifactPath, prompt);
  if (!write.ok) {
    throw new RuntimeCommandError({
      code: "INGEST_TASK_WRITE_FAILED",
      message: write.error.message,
      hint: write.error.hint,
      path: write.error.path,
    });
  }
}

async function snapshotIngestState(repoRoot: string, task: IngestTask): Promise<IngestStateSnapshot> {
  const [sourceCardContent, queueContent, logContent] = await Promise.all([
    readRollbackFile(repoRoot, task.source.source_card_path),
    readRollbackFile(repoRoot, task.source.queue_path),
    readRollbackFile(repoRoot, "curated/log.md"),
  ]);

  return {
    sourceCardPath: task.source.source_card_path,
    sourceCardContent,
    queuePath: task.source.queue_path,
    queueContent,
    logContent,
  };
}

async function readRollbackFile(repoRoot: string, path: string): Promise<string> {
  const read = await readTextFileInsideRoot(repoRoot, path);
  if (!read.ok) {
    throw new RuntimeCommandError({
      code: "QUEUE_WRITE_FAILED",
      message: read.error.message,
      hint: "Restore the queue, source card, and runtime log files before rerunning ingest.",
      path: read.error.path,
    });
  }

  return read.value;
}

async function restoreIngestState(repoRoot: string, snapshot: IngestStateSnapshot): Promise<void> {
  const restores = [
    { path: snapshot.queuePath, content: snapshot.queueContent },
    { path: snapshot.sourceCardPath, content: snapshot.sourceCardContent },
    { path: "curated/log.md", content: snapshot.logContent },
  ];

  for (const restore of restores) {
    const write = await writeTextFileInsideRoot(repoRoot, restore.path, restore.content);
    if (!write.ok) {
      throw new RuntimeCommandError({
        code: "QUEUE_WRITE_FAILED",
        message: write.error.message,
        hint: "Ingest failed and rollback could not restore queue state; restore the queue, source card, and log manually.",
        path: write.error.path,
      });
    }
  }
}

function assertTaskArtifactPathAllowed(artifactPath: string): void {
  const normalizedPath = posix.normalize(artifactPath).replace(/\/+$/, "");

  if (
    isPathInOrBelow(normalizedPath, ".git") ||
    isPathInOrBelow(normalizedPath, "raw/inputs") ||
    isPathInOrBelow(normalizedPath, "raw/queue") ||
    posix.basename(normalizedPath) === "_source.md"
  ) {
    throw new RuntimeCommandError({
      code: "INGEST_TASK_WRITE_FAILED",
      message: `Task artifact path cannot target Git metadata or raw runtime state: ${normalizedPath}.`,
      hint: "Choose a task artifact path outside .git, raw/inputs, raw/queue, and source card files.",
      path: normalizedPath,
    });
  }

  if (isPathInOrBelow(normalizedPath, "curated") || isPathInOrBelow(normalizedPath, ".llm-wiki")) {
    throw new RuntimeCommandError({
      code: "INGEST_TASK_WRITE_FAILED",
      message: `Task artifact path cannot target wiki curated or control state: ${normalizedPath}.`,
      hint: "Choose a task artifact path outside curated/ and .llm-wiki/.",
      path: normalizedPath,
    });
  }
}

function isPathInOrBelow(path: string, parentPath: string): boolean {
  return path === parentPath || path.startsWith(`${parentPath}/`);
}

function ensureIngestTaskCanStart(task: IngestTask): void {
  if (task.source.status === "queued" || task.source.status === "ingesting") {
    return;
  }

  throw new RuntimeCommandError({
    code: "INGEST_STATUS_INVALID",
    message: `Cannot start ingest from queue status ${task.source.status}.`,
    hint:
      task.source.status === "ingested"
        ? "Already ingested sources cannot generate a new task; use --validate to re-check completed output."
        : "Move blocked sources back to queued before generating an ingest task.",
    path: task.source.queue_path,
  });
}

async function validateAndCompleteIngest(repoRoot: string, sourceId: string): Promise<IngestValidationData> {
  const validation = await validateIngestReadiness(repoRoot, sourceId);
  if (!validation.passed) {
    throw new IngestValidationFailedError(validation.issues);
  }

  const queue = await markIngested(repoRoot, sourceId);

  return {
    mode: "validate",
    source: {
      source_id: sourceId,
      status: "ingested",
    },
    validation: {
      passed: true,
      issues: [],
    },
    queue: {
      previous_status: queue.previous_status,
      status: "ingested",
    },
  };
}

async function ensureIngesting(
  repoRoot: string,
  sourceId: string,
  command = `llm-wiki ingest ${sourceId}`,
): Promise<IngestQueueTransitionData> {
  const shown = await showQueueSource(repoRoot, sourceId);
  if (!shown.ok) {
    throw queueRuntimeError(shown.error.code, shown.error.message, shown.error.hint, shown.error.path);
  }

  const currentStatus = shown.value.queue_record.status;
  if (currentStatus === "ingesting") {
    return {
      previous_status: null,
      status: currentStatus,
    };
  }

  if (currentStatus === "ingested") {
    throw new RuntimeCommandError({
      code: "INGEST_STATUS_INVALID",
      message: `Cannot start ingest from queue status ${currentStatus}.`,
      hint: "Already ingested sources cannot generate a new task; use --validate to re-check completed output.",
      path: shown.value.queue_record.queue_path,
    });
  }

  if (currentStatus !== "queued") {
    throw new RuntimeCommandError({
      code: "INGEST_STATUS_INVALID",
      message: `Cannot start ingest from queue status ${currentStatus}.`,
      hint: "Move blocked sources back to queued before generating an ingest task.",
      path: shown.value.queue_record.queue_path,
    });
  }

  const updated = await setQueueStatus(repoRoot, sourceId, "ingesting", {
    command,
  });
  if (!updated.ok) {
    throw queueRuntimeError(updated.error.code, updated.error.message, updated.error.hint, updated.error.path);
  }

  return {
    previous_status: updated.value.previous_status,
    status: updated.value.status,
  };
}

async function markBlockedIfIngesting(repoRoot: string, sourceId: string, command: string): Promise<void> {
  const shown = await showQueueSource(repoRoot, sourceId);
  if (!shown.ok) {
    throw queueRuntimeError(shown.error.code, shown.error.message, shown.error.hint, shown.error.path);
  }

  if (shown.value.queue_record.status !== "ingesting") {
    return;
  }

  const blocked = await setQueueStatus(repoRoot, sourceId, "blocked", { command });
  if (!blocked.ok) {
    throw queueRuntimeError(blocked.error.code, blocked.error.message, blocked.error.hint, blocked.error.path);
  }
}

async function markIngested(repoRoot: string, sourceId: string): Promise<{ previous_status: QueueStatus; status: "ingested" }> {
  const shown = await showQueueSource(repoRoot, sourceId);
  if (!shown.ok) {
    throw queueRuntimeError(shown.error.code, shown.error.message, shown.error.hint, shown.error.path);
  }

  if (shown.value.queue_record.status === "ingested") {
    return {
      previous_status: "ingested",
      status: "ingested",
    };
  }

  if (shown.value.queue_record.status === "queued") {
    const started = await setQueueStatus(repoRoot, sourceId, "ingesting", {
      command: `llm-wiki ingest ${sourceId} --validate`,
    });
    if (!started.ok) {
      throw queueRuntimeError(started.error.code, started.error.message, started.error.hint, started.error.path);
    }
  } else if (shown.value.queue_record.status !== "ingesting") {
    throw new RuntimeCommandError({
      code: "INGEST_STATUS_INVALID",
      message: `Cannot complete ingest from queue status ${shown.value.queue_record.status}.`,
      hint: "Only queued or ingesting sources can be validated into ingested status.",
      path: shown.value.queue_record.queue_path,
    });
  }

  const completed = await setQueueStatus(repoRoot, sourceId, "ingested", {
    command: `llm-wiki ingest ${sourceId} --validate`,
  });
  if (!completed.ok) {
    throw queueRuntimeError(completed.error.code, completed.error.message, completed.error.hint, completed.error.path);
  }

  return {
    previous_status: completed.value.previous_status,
    status: "ingested",
  };
}

function normalizeRuntimeOptions(rawOptions: RawIngestOptions): RuntimeCommandOptions {
  return {
    repo: typeof rawOptions.repo === "string" ? rawOptions.repo : undefined,
    json: rawOptions.json === true,
    quiet: rawOptions.quiet === true,
  };
}

function queueRuntimeError(code: string, message: string, hint: string, path: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code,
    message,
    hint,
    path,
  });
}

function autoIngestRuntimeError(result: AutoIngestSourceResult): RuntimeCommandError {
  const error = result.error;

  return new RuntimeCommandError({
    code: error?.code ?? "AUTO_INGEST_FAILED",
    message: error?.message ?? `Auto-ingest ${result.outcome} for ${result.source_id}.`,
    hint: error?.hint ?? "Review the source queue status and rerun auto-ingest when it is queued.",
    path: error?.path ?? `raw/queue/${result.source_id}.json`,
  });
}

async function resolveLocalAgentConfig(repoRoot: string, rawOptions: RawIngestOptions): Promise<LocalAgentConfig> {
  const result = rawOptions.auto === true
    ? await loadDefaultLocalAgentConfig(repoRoot)
    : await loadLocalAgentConfig(repoRoot, String(rawOptions.agent));
  if (!result.ok) {
    throw agentConfigRuntimeError(result.error);
  }

  return result.value;
}

async function assertLocalAgentCommandAvailable(agent: LocalAgentConfig, repoRoot: string): Promise<void> {
  const availability = await checkLocalAgentAvailability(agent, { cwd: repoRoot });
  if (!availability.ok) {
    throw new RuntimeCommandError({
      code: availability.error.code,
      message: availability.error.message,
      hint: availability.error.hint,
      path: availability.error.executablePath,
    });
  }
}

function agentConfigRuntimeError(error: LocalAgentConfigError): RuntimeCommandError {
  return new RuntimeCommandError({
    code: error.code,
    message: error.message,
    hint: error.hint,
    path: error.path,
  });
}

function localAgentExecutionRuntimeError(error: LocalAgentExecutionError): RuntimeCommandError {
  const exitCode = error.exitCode === null ? "null" : String(error.exitCode);
  const signal = error.signal === null ? "null" : error.signal;
  const stderrTail = error.stderrTail.trim() === "" ? "(empty)" : error.stderrTail.trim();

  return new RuntimeCommandError({
    code: error.code,
    message: [
      error.message,
      `Executable: ${error.executablePath}.`,
      `exit code ${exitCode}; signal ${signal}; timed out: ${error.timedOut}; changes observed: ${error.changesObserved}.`,
      `Stderr tail: ${stderrTail}`,
    ].join(" "),
    hint: error.hint,
    path: error.executablePath,
  });
}

function agentIngestCommand(sourceId: string, agentName: string, rawOptions: RawIngestOptions): string {
  return rawOptions.auto === true
    ? `llm-wiki ingest ${sourceId} --auto`
    : `llm-wiki ingest ${sourceId} --agent ${agentName}`;
}

async function resolveProviderConfig(repoRoot: string, providerName: string): Promise<HttpProviderConfig> {
  const provider = await loadProviderConfig(repoRoot, providerName);
  if (!provider.ok) {
    throw providerConfigRuntimeError(provider.error);
  }

  return provider.value;
}

function providerConfigRuntimeError(error: ProviderConfigError): RuntimeCommandError {
  return new RuntimeCommandError({
    code: error.code,
    message: error.message,
    hint: error.hint,
    path: error.path,
  });
}

function publicProviderData(provider: HttpProviderConfig): IngestProviderData["provider"] {
  return {
    name: provider.name,
    model: provider.model,
  };
}

function throwValidationFailure(
  io: CliIo,
  repoRoot: string,
  issues: IngestValidationIssue[],
  options: RuntimeCommandOptions,
): never {
  const runtimeIssues = issues.map(validationIssueToRuntimeIssue);
  const envelope = {
    ok: false as const,
    command: "ingest" as const,
    repo: repoRoot,
    error: {
      code: "INGEST_VALIDATION_FAILED",
      message: `Ingest validation found ${issues.length} blocking issue${issues.length === 1 ? "" : "s"}.`,
      hint: "Complete the required curated summary, index, log, source_ids, and raw immutability fixes.",
    },
    issues: runtimeIssues,
  };

  if (options.json) {
    io.stdout(JSON.stringify(envelope));
  } else {
    io.stderr(`Error: ${envelope.error.message}`);
    if (!options.quiet) {
      io.stdout(formatHumanValidationIssues(runtimeIssues));
    }
  }

  throw new CommanderError(1, "llm-wiki.ingest", envelope.error.message);
}

function validationIssueToRuntimeIssue(issue: IngestValidationIssue): RuntimeIssue {
  return {
    severity: issue.severity,
    code: issue.rule_id,
    message: issue.message,
    path: issue.path,
    hint: issue.fix_hint,
  };
}

function formatHumanIngest(data: IngestData): string {
  if (data.mode === "validate") {
    return [
      "Ingest validation passed",
      `Source ID: ${data.source.source_id}`,
      `Status: ${data.queue.previous_status} -> ${data.queue.status}`,
    ].join("\n");
  }

  if (data.mode === "provider") {
    return [
      `Provider ingest applied: ${data.provider.name}`,
      `Source ID: ${data.source.source_id}`,
      `Status: ${data.queue.previous_status} -> ${data.queue.status}`,
      "Applied paths:",
      ...data.proposals.applied_paths.map((path) => `- ${path}`),
    ].join("\n");
  }

  if (data.mode === "agent") {
    return [
      `Agent ingest applied: ${data.agent}`,
      `Source ID: ${data.source.source_id}`,
      `Status: ${data.queue.previous_status} -> ${data.queue.status}`,
      "Applied paths:",
      ...data.applied_paths.map((path) => `- ${path}`),
    ].join("\n");
  }

  const branchLine = data.git.recommended_command === null ? [] : [`Recommended branch: ${data.git.recommended_command}`];
  const artifactLine = data.task.artifact_path === null ? [] : [`Task artifact: ${data.task.artifact_path}`];

  return [...branchLine, ...artifactLine, data.task.prompt].join("\n");
}

function formatHumanValidationIssues(issues: RuntimeIssue[]): string {
  return [
    `Ingest validation issues: ${issues.length}`,
    ...issues.flatMap((issue) => [
      "",
      `ERROR ${issue.code}`,
      `Path: ${issue.path}`,
      issue.message,
      `Fix: ${issue.hint}`,
    ]),
  ].join("\n");
}
