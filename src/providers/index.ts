import type { HttpProviderConfig } from "../runtime/config.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import {
  applyProposals,
  applyProposalsWithValidation,
  createIngestProposalPolicy,
  createQueryProposalPolicy,
  normalizeFileProposals,
  validateProposalsOnTemporaryRepo as validateCoreProposalsOnTemporaryRepo,
  type FileProposal,
  type ProposalPolicy,
  type ProposalSet,
} from "../proposals/index.js";

export type ProviderRequestInput = {
  kind: "ingest" | "query";
  provider: HttpProviderConfig;
  task: unknown;
};

export type ProviderFileProposal = FileProposal;

export type ProviderProposalSet = ProposalSet;

const PROVIDER_PROPOSAL_POLICY = createIngestProposalPolicy({
  rejectionCode: "PROVIDER_PROPOSAL_REJECTED",
  writeFailedCode: "PROVIDER_PROPOSAL_WRITE_FAILED",
  rejectedPathHint: "Provider proposals may only write Markdown files under curated/.",
  duplicatePathHint: "Return one file proposal per path.",
  writeRejectedHint: "Provider file proposals must target safe Markdown files inside curated/.",
  writeFailedHint: "Fix filesystem permissions or unsafe proposal paths, then rerun provider mode.",
  pathRejectedMessage: (path) => `Provider proposal path is not allowed: ${path}.`,
  duplicatePathMessage: (path) => `Provider proposed the same path more than once: ${path}.`,
});

export async function requestProviderFileProposals(input: ProviderRequestInput): Promise<ProviderProposalSet> {
  let response: Response;
  try {
    response = await fetch(input.provider.endpoint, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${input.provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: input.kind,
        provider: {
          name: input.provider.name,
          model: input.provider.model,
        },
        task: input.task,
      }),
    });
  } catch {
    throw new RuntimeCommandError({
      code: "PROVIDER_REQUEST_FAILED",
      message: "Provider request failed before a structured response was received.",
      hint: "Check the configured provider endpoint and network access, then rerun provider mode.",
      path: input.provider.name,
    });
  }

  if (!response.ok) {
    throw new RuntimeCommandError({
      code: "PROVIDER_REQUEST_FAILED",
      message: `Provider request failed with HTTP ${response.status}.`,
      hint: "Check the provider service logs and rerun after it returns a structured proposal response.",
      path: input.provider.name,
    });
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    throw new RuntimeCommandError({
      code: "PROVIDER_REQUEST_FAILED",
      message: "Provider response could not be read.",
      hint: "Rerun provider mode after the provider returns a readable response body.",
      path: input.provider.name,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw providerOutputInvalid("Provider output must be valid JSON.", input.provider.name);
  }

  return normalizeProviderProposalSet(parsed, input.provider.name);
}

export async function validateProposalsOnTemporaryRepo(
  repoRoot: string,
  proposals: ProviderProposalSet,
  validate: (tempRepoRoot: string) => Promise<void>,
  policy: ProposalPolicy = PROVIDER_PROPOSAL_POLICY,
): Promise<void> {
  await validateCoreProposalsOnTemporaryRepo(repoRoot, proposals, policy, validate);
}

export async function applyProviderProposals(
  repoRoot: string,
  proposals: ProviderProposalSet,
  policy: ProposalPolicy = PROVIDER_PROPOSAL_POLICY,
): Promise<string[]> {
  return applyProposals(repoRoot, proposals, policy);
}

export async function applyProviderProposalsWithValidation<ValidationResult>(
  repoRoot: string,
  proposals: ProviderProposalSet,
  validate: () => Promise<ValidationResult>,
  policy: ProposalPolicy = PROVIDER_PROPOSAL_POLICY,
): Promise<{ appliedPaths: string[]; validation: ValidationResult }> {
  return applyProposalsWithValidation(repoRoot, proposals, policy, validate);
}

export function createProviderQueryProposalPolicy(savePath: string): ProposalPolicy {
  return createQueryProposalPolicy(savePath, {
    rejectionCode: "PROVIDER_PROPOSAL_REJECTED",
    writeFailedCode: "PROVIDER_PROPOSAL_WRITE_FAILED",
    rejectedPathHint: "Provider proposals may only write Markdown files under curated/.",
    duplicatePathHint: "Return one file proposal per path.",
    writeRejectedHint: "Provider file proposals must target safe Markdown files inside curated/.",
    writeFailedHint: "Fix filesystem permissions or unsafe proposal paths, then rerun provider mode.",
    pathRejectedMessage: (path) => `Provider proposal path is not allowed: ${path}.`,
    duplicatePathMessage: (path) => `Provider proposed the same path more than once: ${path}.`,
    sourceSummaryRejectedMessage: (path) => `Query provider proposals cannot create or modify source summaries: ${path}.`,
    sourceSummaryRejectedHint: "Query provider mode may cite only source summaries that existed before the provider proposal.",
    unexpectedPathRejectedMessage: (path) => `Query provider proposal path is not an expected saved-query output: ${path}.`,
    unexpectedPathRejectedHint: (savePathValue) =>
      `Query provider mode may only write ${savePathValue}, curated/index.md, and curated/log.md.`,
  });
}

export function normalizeProviderProposalsForPolicy(
  proposals: ProviderProposalSet,
  policy: ProposalPolicy = PROVIDER_PROPOSAL_POLICY,
): ProviderProposalSet {
  return {
    files: normalizeFileProposals(proposals, policy),
  };
}

function normalizeProviderProposalSet(value: unknown, providerName: string): ProviderProposalSet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw providerOutputInvalid("Provider output must be a JSON object.", providerName);
  }

  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) {
    throw providerOutputInvalid("Provider output must include a non-empty files array.", providerName);
  }

  const proposals = files.map((file, index) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      throw providerOutputInvalid(`Provider file proposal at index ${index} must be an object.`, providerName);
    }

    const path = (file as { path?: unknown }).path;
    const content = (file as { content?: unknown }).content;
    if (typeof path !== "string" || typeof content !== "string") {
      throw providerOutputInvalid(`Provider file proposal at index ${index} must include path and content strings.`, providerName);
    }

    return { path, content };
  });

  return normalizeProviderProposalsForPolicy({ files: proposals });
}

function providerOutputInvalid(message: string, path: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "PROVIDER_OUTPUT_INVALID",
    message,
    hint: "Return JSON shaped as { files: [{ path, content }] } with Markdown files under curated/.",
    path,
  });
}
