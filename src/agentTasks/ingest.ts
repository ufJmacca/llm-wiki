import { extname } from "node:path";

import type { CanonicalIngestArtifact } from "../ingest/artifact.js";
import { getGraph } from "../nav/index.js";
import { showQueueSource, type QueueStatus } from "../runtime/queue.js";
import { searchWiki } from "../search/index.js";
import { scanWikiRepository } from "../scanner/repo.js";
import { readTextFileInsideRoot, type BinaryWriteError } from "../utils/fs.js";
import { err, ok, type Result } from "../utils/result.js";

export type IngestRelatedPage = {
  path: string;
  title: string;
  reason: "search" | "nav";
};

export type IngestTaskContext = {
  paths: string[];
  related_pages: IngestRelatedPage[];
};

export type IngestTaskSource = {
  source_id: string;
  title: string;
  status: QueueStatus;
  source_card_path: string;
  original_path: string;
  queue_path: string;
  canonical_artifact?: {
    kind: "pdf";
    original_path: string;
    artifact_path: string;
    metadata_path: string;
    extraction_id: string;
  };
};

export type IngestTask = {
  mode: "task";
  source: IngestTaskSource;
  queue: {
    status: QueueStatus;
    previous_status: QueueStatus | null;
  };
  context: IngestTaskContext;
  task: {
    artifact_path: string | null;
    required_outputs: string[];
    raw_immutability_rules: string[];
    prompt: string;
  };
};

export type IngestTaskBuildError = {
  code: string;
  message: string;
  path: string;
  hint: string;
};

type IngestTaskInput = {
  repoRoot: string;
  sourceId: string;
  artifactPath?: string | null;
  canonicalArtifact?: CanonicalIngestArtifact | null;
  previousStatus?: QueueStatus | null;
  promptMode?: "manual" | "local-agent";
};

type IngestRelatedPageContent = IngestRelatedPage & {
  content: string;
};

type RawPromptContent =
  | {
      mode: "inline";
      content: string;
    }
  | {
      mode: "path_only";
      reason: string;
    }
  | {
      mode: "canonical_pdf";
      content: string;
      artifact: CanonicalIngestArtifact;
    };

const AGENTS_PATH = "AGENTS.md";
const INDEX_PATH = "curated/index.md";
const INLINE_TEXT_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cc",
  ".cfg",
  ".cjs",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".fish",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".log",
  ".mjs",
  ".md",
  ".mdown",
  ".markdown",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".rtf",
  ".sh",
  ".sql",
  ".text",
  ".toml",
  ".ts",
  ".tsv",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

export async function buildIngestTask(input: IngestTaskInput): Promise<Result<IngestTask, IngestTaskBuildError>> {
  const queueSource = await showQueueSource(input.repoRoot, input.sourceId);
  if (!queueSource.ok) {
    return err({
      code: queueSource.error.code,
      message: queueSource.error.message,
      path: queueSource.error.path,
      hint: queueSource.error.hint,
    });
  }

  const canonicalArtifact = input.canonicalArtifact ?? null;
  const source = {
    source_id: queueSource.value.queue_record.source_id,
    title: queueSource.value.queue_record.title,
    status: queueSource.value.queue_record.status,
    source_card_path: queueSource.value.source_card.path,
    original_path: queueSource.value.queue_record.original_path,
    queue_path: queueSource.value.queue_record.queue_path,
    ...(canonicalArtifact === null
      ? {}
      : { canonical_artifact: {
          kind: canonicalArtifact.kind,
          original_path: canonicalArtifact.original_path,
          artifact_path: canonicalArtifact.artifact_path,
          metadata_path: canonicalArtifact.metadata_path,
          extraction_id: canonicalArtifact.extraction_id,
        } }),
  };
  if (canonicalArtifact !== null && canonicalArtifact.original_path !== source.original_path) {
    return err({
      code: "PDF_ARTIFACT_INCONSISTENT",
      message: "Canonical PDF artifact original path does not match the queued source.",
      path: canonicalArtifact.artifact_path,
      hint: `Run llm-wiki extract pdf ${source.source_id} to create a matching artifact.`,
    });
  }
  let sourceCardContent: string;
  let rawPromptContent: RawPromptContent;
  let agentsContent: string;
  let indexContent: string;
  let relatedPages: IngestRelatedPageContent[];

  try {
    [sourceCardContent, rawPromptContent, agentsContent, indexContent, relatedPages] = await Promise.all([
      readRepoText(input.repoRoot, source.source_card_path),
      canonicalArtifact === null
        ? readRawPromptContent(input.repoRoot, source.original_path, queueSource.value.queue_record.source_kind)
        : Promise.resolve({
            mode: "canonical_pdf" as const,
            content: canonicalArtifact.content,
            artifact: canonicalArtifact,
          }),
      readRepoText(input.repoRoot, AGENTS_PATH),
      readRepoText(input.repoRoot, INDEX_PATH),
      findRelatedPages(input.repoRoot, source.source_id, source.title),
    ]);
  } catch (error) {
    if (error instanceof IngestTaskContextReadError) {
      return err(error.taskError);
    }

    throw error;
  }
  const contextPaths = [
    source.source_card_path,
    source.original_path,
    source.queue_path,
    ...(canonicalArtifact === null
      ? []
      : [canonicalArtifact.artifact_path, canonicalArtifact.metadata_path]),
    AGENTS_PATH,
    INDEX_PATH,
    ...relatedPages.map((page) => page.path),
  ].filter((path, index, paths) => paths.indexOf(path) === index);
  const requiredOutputs = [
    `curated/sources/${source.source_id}.md`,
    "relevant curated entity/concept/topic/question/comparison pages",
    "curated/index.md",
    "curated/log.md",
  ];
  const rawImmutabilityRules = [
    "Do not edit raw/inputs/**/original.*.",
    "Do not overwrite captured raw source cards or queue JSON except through llm-wiki commands.",
    "Keep raw source hashes unchanged; validation fails on drift.",
  ];

  return ok({
    mode: "task",
    source,
    queue: {
      status: source.status,
      previous_status: input.previousStatus ?? null,
    },
    context: {
      paths: contextPaths,
      related_pages: relatedPages.map(({ content: _content, ...page }) => page),
    },
    task: {
      artifact_path: input.artifactPath ?? null,
      required_outputs: requiredOutputs,
      raw_immutability_rules: rawImmutabilityRules,
      prompt: formatPrompt({
        source,
        sourceCardContent,
        rawPromptContent,
        agentsContent,
        indexContent,
        relatedPages,
        requiredOutputs,
        rawImmutabilityRules,
        contextPaths,
        promptMode: input.promptMode ?? "manual",
      }),
    },
  });
}

async function readRepoText(repoRoot: string, path: string): Promise<string> {
  const read = await readTextFileInsideRoot(repoRoot, path);
  if (!read.ok) {
    throw new IngestTaskContextReadError(readErrorToIngestTaskError(read.error, path));
  }

  return read.value;
}

function readErrorToIngestTaskError(error: BinaryWriteError, path: string): IngestTaskBuildError {
  return {
    code: "INGEST_CONTEXT_READ_FAILED",
    message: error.message,
    path: error.path || path,
    hint: "Restore the ingest context path as a regular file inside the wiki repository without symlinks.",
  };
}

class IngestTaskContextReadError extends Error {
  readonly taskError: IngestTaskBuildError;

  constructor(taskError: IngestTaskBuildError) {
    super(taskError.message);
    this.name = "IngestTaskContextReadError";
    this.taskError = taskError;
  }
}

async function readRawPromptContent(repoRoot: string, path: string, sourceKind: string): Promise<RawPromptContent> {
  if (shouldInlineRawOriginal(path, sourceKind)) {
    return {
      mode: "inline",
      content: await readRepoText(repoRoot, path),
    };
  }

  return {
    mode: "path_only",
    reason: `${path} is a ${sourceKind} source original and is not a recognized text or extracted-text file.`,
  };
}

function shouldInlineRawOriginal(path: string, sourceKind: string): boolean {
  if (sourceKind === "text" || sourceKind === "url") {
    return true;
  }

  return INLINE_TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

async function findRelatedPages(repoRoot: string, sourceId: string, title: string): Promise<IngestRelatedPageContent[]> {
  const [searchResults, graph, scan] = await Promise.all([
    searchWiki(repoRoot, title, { scope: "curated" }),
    getGraph(repoRoot),
    scanWikiRepository(repoRoot, { mode: "liveMarkdown" }),
  ]);
  const pages = new Map<string, IngestRelatedPageContent>();
  const markdownByPath = new Map(scan.markdown.map((page) => [page.path, page]));
  const titleByPath = new Map(scan.markdown.map((page) => [page.path, pageTitle(page.path, page.scan.frontmatter?.title)]));

  for (const result of searchResults.results) {
    if (isRelatedCuratedPage(result.path)) {
      const page = markdownByPath.get(result.path);
      pages.set(result.path, {
        path: result.path,
        title: result.title,
        reason: "search",
        content: page?.content ?? "",
      });
    }
  }

  for (const node of graph.nodes) {
    if (!isRelatedCuratedPage(node.path) || !node.source_ids.includes(sourceId) || pages.has(node.path)) {
      continue;
    }

    pages.set(node.path, {
      path: node.path,
      title: titleByPath.get(node.path) ?? node.title,
      reason: "nav",
      content: markdownByPath.get(node.path)?.content ?? "",
    });
  }

  return [...pages.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function isRelatedCuratedPage(path: string): boolean {
  return path.startsWith("curated/") && path !== "curated/index.md" && path !== "curated/log.md";
}

function pageTitle(path: string, title: unknown): string {
  return typeof title === "string" && title.trim() !== "" ? title : path.split("/").pop()?.replace(/\.md$/, "") ?? path;
}

function formatPrompt(input: {
  source: IngestTaskSource;
  sourceCardContent: string;
  rawPromptContent: RawPromptContent;
  agentsContent: string;
  indexContent: string;
  relatedPages: IngestRelatedPageContent[];
  requiredOutputs: string[];
  rawImmutabilityRules: string[];
  contextPaths: string[];
  promptMode: "manual" | "local-agent";
}): string {
  return [
    `# Ingest task: ${input.source.title}`,
    "",
    `Source ID: ${input.source.source_id}`,
    `Queue status: ${input.source.status}`,
    "",
    "## Context paths loaded",
    ...input.contextPaths.map((path) => `- ${path}`),
    "",
    "## Required outputs",
    `- Create or update curated/sources/${input.source.source_id}.md`,
    "- Update relevant curated entity/concept/topic/question/comparison pages",
    "- Add source_ids to every curated page you edit",
    "- Update curated/index.md",
    "- Append an ingest entry to curated/log.md",
    "- Flag contradictions and open questions",
    "",
    "## Raw immutability rules",
    ...input.rawImmutabilityRules.map((rule) => `- ${rule}`),
    "",
    "## Related pages from search/nav",
    ...(input.relatedPages.length === 0
      ? ["- None found"]
      : input.relatedPages.flatMap((page) => [
          `### ${page.path} (${page.reason}): ${page.title}`,
          codeFence(snippet(page.content, 4000), "markdown"),
        ])),
    "",
    "## AGENTS.md",
    codeFence(snippet(input.agentsContent, 4000), "markdown"),
    "",
    "## Source card",
    codeFence(snippet(input.sourceCardContent, 4000), "markdown"),
    "",
    "## Raw content",
    ...formatRawPromptSection(input.source.original_path, input.rawPromptContent),
    "",
    "## Current curated/index.md",
    codeFence(snippet(input.indexContent, 4000), "markdown"),
    "",
    ...formatValidationInstruction(input),
    "",
  ].join("\n");
}

function formatValidationInstruction(input: {
  source: IngestTaskSource;
  promptMode: "manual" | "local-agent";
}): string[] {
  if (input.promptMode === "local-agent") {
    return [
      "## Validation boundary",
      "Do not run llm-wiki validation or queue commands in this workspace.",
      "Only make the requested curated Markdown edits; the orchestrator validates proposals and updates queue state after extraction.",
    ];
  }

  return [
    "## Validation command",
    `Run llm-wiki ingest ${input.source.source_id} --validate after making curated edits.`,
  ];
}

function formatRawPromptSection(path: string, rawPromptContent: RawPromptContent): string[] {
  if (rawPromptContent.mode === "canonical_pdf") {
    return [
      `Original PDF path: ${rawPromptContent.artifact.original_path}`,
      `Canonical PDF artifact path: ${rawPromptContent.artifact.artifact_path}`,
      `PDF extraction metadata path: ${rawPromptContent.artifact.metadata_path}`,
      `PDF extraction ID: ${rawPromptContent.artifact.extraction_id}`,
      "Use the complete validated canonical Markdown below as the source evidence. The binary original is provenance only.",
      codeFence(rawPromptContent.content, "markdown"),
    ];
  }

  if (rawPromptContent.mode === "inline") {
    return [codeFence(snippet(rawPromptContent.content, 8000), "markdown")];
  }

  return [
    `Raw original path: ${path}`,
    `Content not inlined: ${rawPromptContent.reason}`,
    "Use appropriate extraction or OCR tooling if the original contains evidence needed for curated pages.",
    "Do not edit, rewrite, or overwrite the raw original; preserve provenance by citing the source ID in curated frontmatter.",
  ];
}

function snippet(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength).trimEnd()}\n\n[truncated]`;
}

function codeFence(content: string, language: string): string {
  const longestRun = Math.max(0, ...(content.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}${language}`, content, fence].join("\n");
}
