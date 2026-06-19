import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix, relative, resolve } from "node:path";

import type { HttpProviderConfig } from "../runtime/config.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import {
  readTextFileInsideRoot,
  validateTextFileWriteInsideRoot,
  writeTextFileInsideRoot,
} from "../utils/fs.js";

export type ProviderRequestInput = {
  kind: "ingest" | "query";
  provider: HttpProviderConfig;
  task: unknown;
};

export type ProviderFileProposal = {
  path: string;
  content: string;
};

export type ProviderProposalSet = {
  files: ProviderFileProposal[];
};

type ProposalSnapshot = {
  path: string;
  content: string | null;
};

const RUNTIME_LOG_PATH = "curated/log.md";

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
): Promise<void> {
  const tempParent = await mkdtemp(resolve(tmpdir(), "llm-wiki-provider-proposals-"));
  const tempRepoRoot = resolve(tempParent, "repo");

  try {
    await cp(repoRoot, tempRepoRoot, {
      filter: (source) => !isRootGitMetadataPath(repoRoot, source),
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    await applyProviderProposals(tempRepoRoot, proposals);
    await validate(tempRepoRoot);
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
}

function isRootGitMetadataPath(repoRoot: string, sourcePath: string): boolean {
  const path = relative(repoRoot, sourcePath).replaceAll("\\", "/");
  return path === ".git" || path.startsWith(".git/");
}

export async function applyProviderProposals(repoRoot: string, proposals: ProviderProposalSet): Promise<string[]> {
  const result = await applyProviderProposalsWithValidation(repoRoot, proposals, async () => undefined);

  return result.appliedPaths;
}

export async function applyProviderProposalsWithValidation<ValidationResult>(
  repoRoot: string,
  proposals: ProviderProposalSet,
  validate: () => Promise<ValidationResult>,
): Promise<{ appliedPaths: string[]; validation: ValidationResult }> {
  const normalizedProposals = normalizeProposalPaths(proposals);
  const snapshots: ProposalSnapshot[] = [];

  for (const proposal of normalizedProposals) {
    const writeTarget = await validateTextFileWriteInsideRoot(repoRoot, proposal.path);
    if (!writeTarget.ok) {
      throw new RuntimeCommandError({
        code: "PROVIDER_PROPOSAL_REJECTED",
        message: writeTarget.error.message,
        hint: "Provider file proposals must target safe Markdown files inside curated/.",
        path: writeTarget.error.path,
      });
    }
  }

  for (const proposal of normalizedProposals) {
    const existing = await readTextFileInsideRoot(repoRoot, proposal.path);
    snapshots.push({
      path: proposal.path,
      content: existing.ok ? existing.value : null,
    });
  }

  const writtenPaths: string[] = [];
  try {
    const snapshotByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot.content]));
    for (const proposal of normalizedProposals) {
      const write = await writeTextFileInsideRoot(
        repoRoot,
        proposal.path,
        providerProposalWriteContent(proposal, snapshotByPath.get(proposal.path) ?? null),
      );
      if (!write.ok) {
        throw new RuntimeCommandError({
          code: "PROVIDER_PROPOSAL_WRITE_FAILED",
          message: write.error.message,
          hint: "Fix filesystem permissions or unsafe proposal paths, then rerun provider mode.",
          path: write.error.path,
        });
      }

      writtenPaths.push(proposal.path);
    }

    const validation = await validate();

    return {
      appliedPaths: writtenPaths.sort(),
      validation,
    };
  } catch (error) {
    await rollbackProviderProposalWrites(repoRoot, snapshots);
    throw error;
  }
}

function providerProposalWriteContent(proposal: ProviderFileProposal, existingContent: string | null): string {
  if (proposal.path !== RUNTIME_LOG_PATH || existingContent === null) {
    return proposal.content;
  }

  return appendProviderLogProposal(existingContent, proposal.content);
}

function appendProviderLogProposal(existingContent: string, proposedContent: string): string {
  const normalizedExisting = normalizeMarkdownNewlines(existingContent).trim();
  const normalizedProposed = normalizeMarkdownNewlines(proposedContent).trim();
  if (normalizedExisting !== "" && normalizedProposed.startsWith(normalizedExisting)) {
    return proposedContent;
  }

  const proposedAppend = stripProviderLogTitle(proposedContent).trimStart();
  if (proposedAppend === "") {
    return existingContent;
  }

  const existingWithNewline = existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
  const separator = existingWithNewline.endsWith("\n\n") ? "" : "\n";

  return `${existingWithNewline}${separator}${proposedAppend}`;
}

function stripProviderLogTitle(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/^# Log[ \t]*\n+/, "");
}

function normalizeMarkdownNewlines(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
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

  return {
    files: normalizeProposalPaths({ files: proposals }),
  };
}

function normalizeProposalPaths(proposals: ProviderProposalSet): ProviderFileProposal[] {
  const seen = new Set<string>();
  const normalized: ProviderFileProposal[] = [];

  for (const proposal of proposals.files) {
    const path = normalizeProviderPath(proposal.path);
    if (path === null || !isAllowedProviderProposalPath(path)) {
      throw new RuntimeCommandError({
        code: "PROVIDER_PROPOSAL_REJECTED",
        message: `Provider proposal path is not allowed: ${proposal.path}.`,
        hint: "Provider proposals may only write Markdown files under curated/.",
        path: proposal.path,
      });
    }

    if (seen.has(path)) {
      throw new RuntimeCommandError({
        code: "PROVIDER_PROPOSAL_REJECTED",
        message: `Provider proposed the same path more than once: ${path}.`,
        hint: "Return one file proposal per path.",
        path,
      });
    }

    seen.add(path);
    normalized.push({ path, content: proposal.content });
  }

  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeProviderPath(path: string): string | null {
  if (path.trim() === "" || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    return null;
  }

  const segments = path.split("/");
  if (segments.includes("..")) {
    return null;
  }

  return posix.normalize(path).replace(/\/+$/, "");
}

function isAllowedProviderProposalPath(path: string): boolean {
  return path.startsWith("curated/") && path.endsWith(".md") && !path.split("/").includes(".git");
}

async function rollbackProviderProposalWrites(repoRoot: string, snapshots: ProposalSnapshot[]): Promise<void> {
  for (const snapshot of snapshots.reverse()) {
    if (snapshot.content === null) {
      await rm(resolve(repoRoot, snapshot.path), { force: true }).catch(() => undefined);
      continue;
    }

    await writeTextFileInsideRoot(repoRoot, snapshot.path, snapshot.content);
  }
}

function providerOutputInvalid(message: string, path: string): RuntimeCommandError {
  return new RuntimeCommandError({
    code: "PROVIDER_OUTPUT_INVALID",
    message,
    hint: "Return JSON shaped as { files: [{ path, content }] } with Markdown files under curated/.",
    path,
  });
}
