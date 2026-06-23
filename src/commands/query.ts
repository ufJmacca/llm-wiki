import { CommanderError, type Command } from "commander";

import type { CliIo } from "../cli.js";
import { buildQueryTask, type QueryTask } from "../agentTasks/query.js";
import {
  applyProviderProposalsWithValidation,
  createProviderQueryProposalPolicy,
  normalizeProviderProposalsForPolicy,
  requestProviderFileProposals,
  validateProposalsOnTemporaryRepo,
} from "../providers/index.js";
import { loadProviderConfig, type HttpProviderConfig, type ProviderConfigError } from "../runtime/config.js";
import { addRuntimeOptions, type RawRuntimeCommandOptions, type RuntimeCommandOptions } from "../runtime/command.js";
import { buildRuntimeFailureEnvelope, buildRuntimeSuccessEnvelope, type RuntimeIssue } from "../runtime/envelope.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { resolveWikiRoot } from "../runtime/repo.js";
import { validateQuerySavePath, validateQuerySaveReadiness, type QueryValidationIssue } from "../validation/query.js";

type RawQueryOptions = RawRuntimeCommandOptions & {
  save?: unknown;
  validate?: unknown;
  provider?: unknown;
};

type QueryValidationData = {
  mode: "validate";
  question: string;
  save_path: string;
  validation: {
    passed: true;
    issues: [];
  };
};

type QueryProviderData = {
  mode: "provider";
  provider: {
    name: string;
    model: string | null;
  };
  question: string;
  save_path: string;
  proposals: {
    applied_paths: string[];
  };
  validation: {
    passed: true;
    issues: [];
  };
};

type QueryData = QueryTask | QueryValidationData | QueryProviderData;

export function registerQueryCommand(program: Command, io: CliIo): void {
  addRuntimeOptions(
    program
      .command("query")
      .description("Generate an agent query task and validate durable saved answers")
      .argument("<question>", "question to answer from local wiki context")
      .option("--save <path>", "required durable question page path, for example curated/questions/<slug>.md")
      .option("--validate", "validate a completed saved question page", false)
      .option("--provider <name>", "execute an explicitly configured provider and apply validated file proposals"),
  ).action(async (question: string, rawOptions: RawQueryOptions) => {
    await runQueryCommand(question, rawOptions, io);
  });
}

async function runQueryCommand(question: string, rawOptions: RawQueryOptions, io: CliIo): Promise<void> {
  const options = normalizeRuntimeOptions(rawOptions);
  const resolvedRepo = await resolveWikiRoot({ repoPath: options.repo });

  if (!resolvedRepo.ok) {
    const envelope = buildRuntimeFailureEnvelope("query", resolvedRepo.error);
    if (options.json) {
      io.stdout(JSON.stringify(envelope));
    } else {
      io.stderr(`Error: ${envelope.error.message}`);
    }

    throw new CommanderError(1, "llm-wiki.query", envelope.error.message);
  }

  try {
    const savePath = typeof rawOptions.save === "string" ? rawOptions.save : null;
    if (rawOptions.validate === true && savePath === null) {
      throw new RuntimeCommandError({
        code: "QUERY_SAVE_REQUIRED",
        message: "Query validation requires --save <path>.",
        hint: "Run llm-wiki query \"<question>\" --save curated/questions/<slug>.md --validate.",
        path: "--save",
      });
    }

    if (savePath !== null) {
      const pathIssue = validateQuerySavePath(savePath);
      if (pathIssue !== null) {
        throw new RuntimeCommandError({
          code: "QUERY_SAVE_PATH_INVALID",
          message: pathIssue.message,
          hint: pathIssue.fix_hint,
          path: pathIssue.path,
        });
      }
    }

    const data = rawOptions.validate === true
      ? await validateCompletedQuery(resolvedRepo.value.rootDir, question, savePath ?? "")
      : typeof rawOptions.provider === "string"
        ? await executeProviderQuery(resolvedRepo.value.rootDir, question, savePath, rawOptions.provider)
        : await createQueryTask(resolvedRepo.value.rootDir, question, savePath);
    const envelope = buildRuntimeSuccessEnvelope("query", resolvedRepo.value.rootDir, data, []);

    if (options.json) {
      io.stdout(JSON.stringify(envelope));
      return;
    }

    if (!options.quiet) {
      io.stdout(formatHumanQuery(data));
    }
  } catch (error) {
    if (error instanceof QueryValidationFailedError) {
      throwValidationFailure(io, resolvedRepo.value.rootDir, error.issues, options);
    }

    const commandError = error instanceof RuntimeCommandError
      ? error
      : new RuntimeCommandError({
          code: "QUERY_FAILED",
          message: error instanceof Error ? error.message : String(error),
          hint: "Fix the query input or repository files, then rerun llm-wiki query.",
          path: ".",
        });
    const envelope = {
      ok: false as const,
      command: "query" as const,
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

    throw new CommanderError(1, "llm-wiki.query", envelope.error.message);
  }
}

async function executeProviderQuery(
  repoRoot: string,
  question: string,
  savePath: string | null,
  providerName: string,
): Promise<QueryProviderData> {
  if (savePath === null) {
    throw new RuntimeCommandError({
      code: "QUERY_SAVE_REQUIRED",
      message: "Provider query mode requires --save <path>.",
      hint: "Run llm-wiki query \"<question>\" --save curated/questions/<slug>.md --provider <name>.",
      path: "--save",
    });
  }

  const task = await createQueryTask(repoRoot, question, savePath);
  const provider = await resolveProviderConfig(repoRoot, providerName);
  const proposals = await requestProviderFileProposals({
    kind: "query",
    provider,
    task,
  });
  const proposalPolicy = createProviderQueryProposalPolicy(task.save_path ?? savePath);
  const queryProposals = normalizeProviderProposalsForPolicy(proposals, proposalPolicy);

  await validateProposalsOnTemporaryRepo(repoRoot, queryProposals, async (tempRepoRoot) => {
    const validation = await validateQuerySaveReadiness(tempRepoRoot, question, savePath);
    if (!validation.passed) {
      throw new QueryValidationFailedError(validation.issues);
    }
  }, proposalPolicy);

  const { appliedPaths, validation } = await applyProviderProposalsWithValidation(
    repoRoot,
    queryProposals,
    async () => validateCompletedQuery(repoRoot, question, savePath),
    proposalPolicy,
  );

  return {
    mode: "provider",
    provider: publicProviderData(provider),
    question,
    save_path: validation.save_path,
    proposals: {
      applied_paths: appliedPaths,
    },
    validation: {
      passed: true,
      issues: [],
    },
  };
}

async function createQueryTask(repoRoot: string, question: string, savePath: string | null): Promise<QueryTask> {
  const task = await buildQueryTask({
    repoRoot,
    question,
    savePath,
  });
  if (!task.ok) {
    throw new RuntimeCommandError({
      code: task.error.code,
      message: task.error.message,
      hint: task.error.hint,
      path: task.error.path,
    });
  }

  return task.value;
}

async function validateCompletedQuery(
  repoRoot: string,
  question: string,
  savePath: string,
): Promise<QueryValidationData> {
  const validation = await validateQuerySaveReadiness(repoRoot, question, savePath);
  if (!validation.passed) {
    throw new QueryValidationFailedError(validation.issues);
  }

  return {
    mode: "validate",
    question,
    save_path: validation.save_path,
    validation: {
      passed: true,
      issues: [],
    },
  };
}

function normalizeRuntimeOptions(rawOptions: RawRuntimeCommandOptions): RuntimeCommandOptions {
  return {
    repo: typeof rawOptions.repo === "string" ? rawOptions.repo : undefined,
    json: rawOptions.json === true,
    quiet: rawOptions.quiet === true,
  };
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

function publicProviderData(provider: HttpProviderConfig): QueryProviderData["provider"] {
  return {
    name: provider.name,
    model: provider.model,
  };
}

class QueryValidationFailedError extends Error {
  readonly issues: QueryValidationIssue[];

  constructor(issues: QueryValidationIssue[]) {
    super("Query validation failed.");
    this.name = "QueryValidationFailedError";
    this.issues = issues;
  }
}

function throwValidationFailure(
  io: CliIo,
  repoRoot: string,
  issues: QueryValidationIssue[],
  options: RuntimeCommandOptions,
): never {
  const runtimeIssues = issues.map(validationIssueToRuntimeIssue);
  const envelope = {
    ok: false as const,
    command: "query" as const,
    repo: repoRoot,
    error: {
      code: "QUERY_VALIDATION_FAILED",
      message: `Query validation found ${issues.length} blocking issue${issues.length === 1 ? "" : "s"}.`,
      hint: "Complete the saved question frontmatter, provenance, open questions, index update, and log entry.",
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

  throw new CommanderError(1, "llm-wiki.query", envelope.error.message);
}

function validationIssueToRuntimeIssue(issue: QueryValidationIssue): RuntimeIssue {
  return {
    severity: issue.severity,
    code: issue.rule_id,
    message: issue.message,
    path: issue.path,
    hint: issue.fix_hint,
  };
}

function formatHumanQuery(data: QueryData): string {
  if (data.mode === "validate") {
    return [
      "Query validation passed",
      `Question: ${data.question}`,
      `Saved page: ${data.save_path}`,
    ].join("\n");
  }

  if (data.mode === "provider") {
    return [
      `Provider query applied: ${data.provider.name}`,
      `Question: ${data.question}`,
      `Saved page: ${data.save_path}`,
      "Applied paths:",
      ...data.proposals.applied_paths.map((path) => `- ${path}`),
    ].join("\n");
  }

  return data.task.prompt;
}

function formatHumanValidationIssues(issues: RuntimeIssue[]): string {
  return [
    `Query validation issues: ${issues.length}`,
    ...issues.flatMap((issue) => [
      "",
      `ERROR ${issue.code}`,
      `Path: ${issue.path}`,
      issue.message,
      `Fix: ${issue.hint}`,
    ]),
  ].join("\n");
}
