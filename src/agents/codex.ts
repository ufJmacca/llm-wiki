import { runLocalAgentInTemporaryWorkspace, type LocalAgentWorkspaceResult } from "./workspace.js";
import {
  createQueryProposalPolicy,
  type ProposalPolicy,
} from "../proposals/index.js";
import type { LocalAgentConfig } from "../runtime/config.js";

export type RunCodexQueryAgentInput = {
  repoRoot: string;
  agent: LocalAgentConfig;
  taskPrompt: string;
  savePath: string;
};

export type CodexQueryAgentResult = LocalAgentWorkspaceResult & {
  policy: ProposalPolicy;
};

export async function runCodexQueryAgent(input: RunCodexQueryAgentInput): Promise<CodexQueryAgentResult> {
  const policy = createCodexQueryProposalPolicy(input.savePath);
  const result = await runLocalAgentInTemporaryWorkspace({
    repoRoot: input.repoRoot,
    agent: input.agent,
    taskPrompt: input.taskPrompt,
    policy,
  });

  return {
    ...result,
    policy,
  };
}

export function createCodexQueryProposalPolicy(savePath: string): ProposalPolicy {
  return createQueryProposalPolicy(savePath, {
    rejectionCode: "AGENT_PROPOSAL_REJECTED",
    writeFailedCode: "AGENT_PROPOSAL_WRITE_FAILED",
    rejectedPathHint: "Agent proposals may only write Markdown files under curated/.",
    duplicatePathHint: "Return one file proposal per path.",
    writeRejectedHint: "Agent file proposals must target safe Markdown files inside curated/.",
    writeFailedHint: "Fix filesystem permissions or unsafe proposal paths, then rerun agent mode.",
    pathRejectedMessage: (path) => `Agent proposal path is not allowed: ${path}.`,
    duplicatePathMessage: (path) => `Agent proposed the same path more than once: ${path}.`,
    sourceSummaryRejectedMessage: (path) => `Query agent proposals cannot create or modify source summaries: ${path}.`,
    sourceSummaryRejectedHint: "Query agent mode may cite only source summaries that existed before the agent proposal.",
    unexpectedPathRejectedMessage: (path) => `Query agent proposal path is not an expected saved-query output: ${path}.`,
    unexpectedPathRejectedHint: (savePathValue) =>
      `Query agent mode may only write ${savePathValue}, curated/index.md, and curated/log.md.`,
  });
}
