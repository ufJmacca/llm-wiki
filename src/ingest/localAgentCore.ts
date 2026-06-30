import { runLocalAgentInTemporaryWorkspace } from "../agents/index.js";
import { buildIngestTask } from "../agentTasks/ingest.js";
import {
  applyProposalsWithValidation,
  createIngestProposalPolicy,
  normalizeFileProposals,
  validateProposalsOnTemporaryRepo,
} from "../proposals/index.js";
import type { LocalAgentConfig } from "../runtime/config.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { validateIngestReadiness, type IngestValidationIssue } from "../validation/ingest.js";
import { listGitChangedFiles } from "../utils/git.js";

export type RunLocalAgentIngestCoreInput<Completion = void> = {
  repoRoot: string;
  sourceId: string;
  agent: LocalAgentConfig;
  completeAppliedIngest?: () => Promise<Completion>;
};

export type LocalAgentIngestCoreResult<Completion = void> = {
  agent: string;
  appliedPaths: string[];
  validation: {
    passed: true;
    issues: [];
  };
  completion: Completion;
};

const AGENT_INGEST_PROPOSAL_POLICY = createIngestProposalPolicy({
  rejectionCode: "AGENT_PROPOSAL_REJECTED",
  writeFailedCode: "AGENT_PROPOSAL_WRITE_FAILED",
  rejectedPathHint: "Agent proposals may only write Markdown files under curated/.",
  duplicatePathHint: "Return one file proposal per path.",
  writeRejectedHint: "Agent file proposals must target safe Markdown files inside curated/.",
  writeFailedHint: "Fix filesystem permissions or unsafe proposal paths, then rerun local agent mode.",
  pathRejectedMessage: (path) => `Agent proposal path is not allowed: ${path}.`,
  duplicatePathMessage: (path) => `Agent proposed the same path more than once: ${path}.`,
});

export async function runLocalAgentIngestCore<Completion = void>(
  input: RunLocalAgentIngestCoreInput<Completion>,
): Promise<LocalAgentIngestCoreResult<Completion>> {
  const task = await buildIngestTask({
    repoRoot: input.repoRoot,
    sourceId: input.sourceId,
    promptMode: "local-agent",
  });
  if (!task.ok) {
    throw new RuntimeCommandError({
      code: task.error.code,
      message: task.error.message,
      hint: task.error.hint,
      path: task.error.path,
    });
  }

  const result = await runLocalAgentInTemporaryWorkspace({
    repoRoot: input.repoRoot,
    agent: input.agent,
    taskPrompt: task.value.task.prompt,
    policy: AGENT_INGEST_PROPOSAL_POLICY,
  });

  const currentAttemptPaths = normalizeFileProposals(result.proposals, AGENT_INGEST_PROPOSAL_POLICY)
    .map((proposal) => proposal.path);
  await validateProposalsOnTemporaryRepo(
    input.repoRoot,
    result.proposals,
    AGENT_INGEST_PROPOSAL_POLICY,
    async (tempRepoRoot) => {
      await assertIngestReadiness(tempRepoRoot, input.sourceId, {
        currentAttemptPaths,
      });
    },
  );

  const changedFilesBaseline = await listGitChangedFiles(input.repoRoot, ["curated"]);
  const { appliedPaths, validation: completion } = await applyProposalsWithValidation(
    input.repoRoot,
    result.proposals,
    AGENT_INGEST_PROPOSAL_POLICY,
    async () => {
      await assertIngestReadiness(input.repoRoot, input.sourceId, {
        changedFilesBaseline,
        currentAttemptPaths,
      });

      return input.completeAppliedIngest === undefined
        ? (undefined as Completion)
        : await input.completeAppliedIngest();
    },
  );

  return {
    agent: input.agent.name,
    appliedPaths,
    validation: {
      passed: true,
      issues: [],
    },
    completion,
  };
}

async function assertIngestReadiness(
  repoRoot: string,
  sourceId: string,
  options: Parameters<typeof validateIngestReadiness>[2] = {},
): Promise<void> {
  const validation = await validateIngestReadiness(repoRoot, sourceId, options);
  if (!validation.passed) {
    throw new IngestValidationFailedError(validation.issues);
  }
}

export class IngestValidationFailedError extends Error {
  readonly issues: IngestValidationIssue[];

  constructor(issues: IngestValidationIssue[]) {
    super("Ingest validation failed.");
    this.name = "IngestValidationFailedError";
    this.issues = issues;
  }
}
