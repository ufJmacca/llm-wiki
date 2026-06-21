import { buildQueryContext, type QueryContextPage } from "../search/context.js";
import { scanMarkdownDocument } from "../scanner/index.js";
import { scanWikiRepository } from "../scanner/repo.js";
import { readTextFileInsideRoot, type BinaryWriteError } from "../utils/fs.js";
import { err, ok, type Result } from "../utils/result.js";
import { availableQuerySourceIds, normalizeQuerySavePath, validateQuerySavePath } from "../validation/query.js";

export type QueryTaskRelatedPage = {
  path: string;
  title: string;
  reason: "search" | "nav" | "source";
  source_ids: string[];
};

export type QueryTask = {
  mode: "task";
  question: string;
  save_path: string | null;
  context: {
    paths: string[];
    source_ids: string[];
    related_pages: QueryTaskRelatedPage[];
  };
  task: {
    artifact_path: string | null;
    required_outputs: string[];
    provenance_rules: string[];
    prompt: string;
  };
};

export type QueryTaskBuildError = {
  code: string;
  message: string;
  path: string;
  hint: string;
};

type QueryTaskInput = {
  repoRoot: string;
  question: string;
  savePath?: string | null;
};

const AGENTS_PATH = "AGENTS.md";
const INDEX_PATH = "curated/index.md";

export async function buildQueryTask(input: QueryTaskInput): Promise<Result<QueryTask, QueryTaskBuildError>> {
  const normalizedSavePath = input.savePath === undefined || input.savePath === null
    ? null
    : normalizeQuerySavePath(input.savePath);
  if (input.savePath !== undefined && input.savePath !== null) {
    const pathIssue = validateQuerySavePath(input.savePath);
    if (pathIssue !== null || normalizedSavePath === null) {
      return err({
        code: "QUERY_SAVE_PATH_INVALID",
        message: pathIssue?.message ?? `Query save path is invalid: ${input.savePath}.`,
        path: input.savePath,
        hint: pathIssue?.fix_hint ?? "Use --save curated/questions/<slug>.md.",
      });
    }
  }

  let agentsContent: string;
  let indexContent: string;
  let contextPages: QueryContextPage[];
  let sourceIds: string[];

  try {
    const [context, scan, readAgentsContent, readIndexContent] = await Promise.all([
      buildQueryContext(
        input.repoRoot,
        input.question,
        normalizedSavePath === null ? {} : { excludePaths: [normalizedSavePath] },
      ),
      scanWikiRepository(input.repoRoot, { mode: "liveMarkdown" }),
      readRepoText(input.repoRoot, AGENTS_PATH),
      readRepoText(input.repoRoot, INDEX_PATH),
    ]);
    sourceIds = availableQuerySourceIds(scan, context.source_ids);
    contextPages = filterContextPageSourceIds(context.pages, sourceIds);
    agentsContent = readAgentsContent;
    indexContent = readIndexContent;
  } catch (error) {
    if (error instanceof QueryTaskContextReadError) {
      return err(error.taskError);
    }

    throw error;
  }

  const contextPaths = [
    AGENTS_PATH,
    INDEX_PATH,
    ...contextPages.map((page) => page.path),
  ].filter((path, index, paths) => paths.indexOf(path) === index);
  const requiredOutputs = normalizedSavePath === null
    ? ["an agent answer with cited source IDs or open questions"]
    : [normalizedSavePath, "curated/index.md", "curated/log.md"];
  const provenanceRules = [
    "Use source_ids only for claims supported by loaded curated source summaries.",
    "Do not invent evidence or cite source IDs that are not present in the loaded context.",
    "Treat related pages without loaded source summaries as background context, not citable evidence.",
    "Represent missing provenance as open_questions instead of unsupported claims.",
    "When --save is used, write type: question, title, visibility, source_ids, and open_questions frontmatter.",
  ];

  return ok({
    mode: "task",
    question: input.question,
    save_path: normalizedSavePath,
    context: {
      paths: contextPaths,
      source_ids: sourceIds,
      related_pages: contextPages.map(({ content: _content, ...page }) => page),
    },
    task: {
      artifact_path: null,
      required_outputs: requiredOutputs,
      provenance_rules: provenanceRules,
      prompt: formatPrompt({
        question: input.question,
        savePath: normalizedSavePath,
        agentsContent,
        indexContent,
        contextPages,
        contextPaths,
        sourceIds,
        requiredOutputs,
        provenanceRules,
      }),
    },
  });
}

async function readRepoText(repoRoot: string, path: string): Promise<string> {
  const read = await readTextFileInsideRoot(repoRoot, path);
  if (!read.ok) {
    throw new QueryTaskContextReadError(readErrorToQueryTaskError(read.error, path));
  }

  return read.value;
}

function readErrorToQueryTaskError(error: BinaryWriteError, path: string): QueryTaskBuildError {
  return {
    code: "QUERY_CONTEXT_READ_FAILED",
    message: error.message,
    path: error.path || path,
    hint: "Restore the query context path as a regular file inside the wiki repository without symlinks.",
  };
}

class QueryTaskContextReadError extends Error {
  readonly taskError: QueryTaskBuildError;

  constructor(taskError: QueryTaskBuildError) {
    super(taskError.message);
    this.name = "QueryTaskContextReadError";
    this.taskError = taskError;
  }
}

function filterContextPageSourceIds(pages: QueryContextPage[], availableSourceIds: string[]): QueryContextPage[] {
  const available = new Set(availableSourceIds);

  return pages.map((page) => ({
    ...page,
    source_ids: page.source_ids.filter((sourceId) => available.has(sourceId)),
    content: scanMarkdownDocument({ path: page.path, content: page.content }).body,
  }));
}

function formatPrompt(input: {
  question: string;
  savePath: string | null;
  agentsContent: string;
  indexContent: string;
  contextPages: QueryContextPage[];
  contextPaths: string[];
  sourceIds: string[];
  requiredOutputs: string[];
  provenanceRules: string[];
}): string {
  return [
    `# Query task: ${input.question}`,
    "",
    "Generate an evidence-bound answer from the local wiki context. Do not call an external provider from the CLI; this is an agent task prompt.",
    "",
    "## Context paths loaded",
    ...input.contextPaths.map((path) => `- ${path}`),
    "",
    "## Available source IDs",
    ...(input.sourceIds.length === 0 ? ["- None available"] : input.sourceIds.map((sourceId) => `- ${sourceId}`)),
    "",
    "## Required outputs",
    ...input.requiredOutputs.map((output) => `- ${output}`),
    ...(input.savePath === null
      ? []
      : [
          "- Update curated/index.md",
          "- Append a query entry to curated/log.md",
          "- The saved page frontmatter must include:",
          codeFence(savedQuestionFrontmatterExample(input.question, input.sourceIds), "yaml"),
        ]),
    "",
    "## Provenance rules",
    ...input.provenanceRules.map((rule) => `- ${rule}`),
    "",
    "## Related curated context",
    ...(input.contextPages.length === 0
      ? ["- None found"]
      : input.contextPages.flatMap((page) => [
          `### ${page.path} (${page.reason}): ${page.title}`,
          `Source IDs: ${page.source_ids.length === 0 ? "none" : page.source_ids.join(", ")}`,
          codeFence(snippet(page.content, 5000), "markdown"),
        ])),
    "",
    "## AGENTS.md",
    codeFence(snippet(input.agentsContent, 4000), "markdown"),
    "",
    "## Current curated/index.md",
    codeFence(snippet(input.indexContent, 4000), "markdown"),
    "",
    "## Validation command",
    ...(input.savePath === null
      ? ["No durable save path was requested; answer with source IDs and open questions in the agent response."]
      : [
          `Run llm-wiki query ${shellQuote(input.question)} --save ${shellQuote(
            input.savePath,
          )} --validate after writing the saved page.`,
        ]),
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function savedQuestionFrontmatterExample(question: string, sourceIds: string[]): string {
  const sourceLines = sourceIds.length === 0 ? ["source_ids: []"] : ["source_ids:", ...sourceIds.map((sourceId) => `  - ${sourceId}`)];

  return [
    "type: question",
    `title: ${JSON.stringify(question)}`,
    "visibility: private",
    ...sourceLines,
    "open_questions:",
    "  - Add unsupported or unknown claims here instead of inventing evidence.",
  ].join("\n");
}

function snippet(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength).trimEnd()}\n\n[truncated]`;
}

function codeFence(content: string, language: string): string {
  return ["```" + language, content.replaceAll("```", "``\\`"), "```"].join("\n");
}
