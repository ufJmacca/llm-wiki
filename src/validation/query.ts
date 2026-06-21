import { posix } from "node:path";

import { createLinkResolutionIndex, resolveLinks } from "../lint/index.js";
import { parseSourceId, scanMarkdownDocument } from "../scanner/index.js";
import { scanWikiRepository, type RepoMarkdownFile, type RepoScan } from "../scanner/repo.js";
import { buildQueryContext } from "../search/context.js";

export type QueryValidationSeverity = "error";

export type QueryValidationIssue = {
  rule_id: string;
  severity: QueryValidationSeverity;
  path: string;
  message: string;
  fix_hint: string;
};

export type QueryValidationResult = {
  question: string;
  save_path: string;
  passed: boolean;
  issues: QueryValidationIssue[];
  checked_paths: string[];
  available_source_ids: string[];
};

const SUPPORTED_QUERY_VISIBILITIES = new Set(["private", "public"]);
const QUERY_SAVE_PREFIX = "curated/questions/";

export function validateQuerySavePath(savePath: string): QueryValidationIssue | null {
  const normalizedPath = normalizeSavePath(savePath);
  const normalizedBasename = normalizedPath === null ? "" : posix.basename(normalizedPath);
  if (
    normalizedPath === null ||
    !normalizedPath.startsWith(QUERY_SAVE_PREFIX) ||
    !normalizedPath.endsWith(".md") ||
    normalizedBasename === ".md" ||
    !isLogSafeQuestionPath(normalizedPath) ||
    !isLogSafeQuestionSlug(posix.basename(normalizedBasename, ".md"))
  ) {
    return {
      rule_id: "query_save_path_invalid",
      severity: "error",
      path: savePath,
      message: `Query save path must be a log-safe Markdown file under curated/questions/: ${savePath}.`,
      fix_hint: "Use --save curated/questions/<slug>.md with a slug that has no leading or trailing whitespace and does not contain pipe, query, fragment, or newline characters.",
    };
  }

  return null;
}

export function normalizeQuerySavePath(savePath: string): string | null {
  return normalizeSavePath(savePath);
}

export async function validateQuerySaveReadiness(
  repoRoot: string,
  question: string,
  savePath: string,
): Promise<QueryValidationResult> {
  const pathIssue = validateQuerySavePath(savePath);
  const normalizedPath = normalizeQuerySavePath(savePath) ?? savePath;
  if (pathIssue !== null) {
    return {
      question,
      save_path: savePath,
      passed: false,
      issues: [pathIssue],
      checked_paths: [savePath],
      available_source_ids: [],
    };
  }

  const [scan, context] = await Promise.all([
    scanWikiRepository(repoRoot, { mode: "liveMarkdown" }),
    buildQueryContext(repoRoot, question, { excludePaths: [normalizedPath] }),
  ]);
  const savePage = scan.curatedPages.find((page) => page.path === normalizedPath) ?? null;
  const citedSourceIds = savePage === null ? [] : sourceIdsForPage(savePage);
  const bodyCitedSourceIds = savePage === null ? [] : bodySourceSummaryIdsForPage(scan, savePage);
  const availableSourceIds = availableQuerySourceIds(scan, [...context.source_ids, ...citedSourceIds, ...bodyCitedSourceIds]);
  const issues: QueryValidationIssue[] = [];

  if (savePage === null) {
    issues.push({
      rule_id: "query_saved_question_missing",
      severity: "error",
      path: normalizedPath,
      message: `Saved query page is missing: ${normalizedPath}.`,
      fix_hint: "Have the agent create the saved question page before validating query output.",
    });
  } else {
    issues.push(...questionPageIssues(savePage, question, availableSourceIds, bodyCitedSourceIds));
  }

  const indexPage = scan.curatedPages.find((page) => page.path === "curated/index.md") ?? null;
  if (indexPage === null || !indexMentionsSavePath(scan, indexPage, normalizedPath)) {
    issues.push({
      rule_id: "query_index_missing",
      severity: "error",
      path: "curated/index.md",
      message: `curated/index.md does not reference saved query page ${normalizedPath}.`,
      fix_hint: "Update curated/index.md with a link to the saved question page.",
    });
  }

  const questionId = questionIdFromSavePath(normalizedPath);
  if (!hasQueryLogEntry(scan, questionId, question, normalizedPath)) {
    issues.push({
      rule_id: "query_log_entry_missing",
      severity: "error",
      path: "curated/log.md",
      message: `curated/log.md has no query entry for ${questionId} that references ${normalizedPath}.`,
      fix_hint: "Append a query log entry with the saved question path under created or updated paths.",
    });
  }

  const dedupedIssues = dedupeIssues(issues);

  return {
    question,
    save_path: normalizedPath,
    passed: dedupedIssues.length === 0,
    issues: dedupedIssues,
    checked_paths: checkedPaths(normalizedPath, dedupedIssues),
    available_source_ids: availableSourceIds,
  };
}

function questionPageIssues(
  page: RepoMarkdownFile,
  question: string,
  availableSourceIds: string[],
  bodyCitedSourceIds: string[],
): QueryValidationIssue[] {
  const issues: QueryValidationIssue[] = [];
  const frontmatter = page.scan.frontmatter;

  if (frontmatter === undefined) {
    return [
      {
        rule_id: "query_question_frontmatter_missing",
        severity: "error",
        path: page.path,
        message: `Saved query page is missing frontmatter: ${page.path}.`,
        fix_hint: "Add frontmatter with type: question, title, visibility, source_ids, and open_questions.",
      },
    ];
  }

  if (frontmatter.type !== "question") {
    issues.push({
      rule_id: "query_question_type_invalid",
      severity: "error",
      path: page.path,
      message: `Saved query page must use type: question: ${page.path}.`,
      fix_hint: "Set type: question in the saved page frontmatter.",
    });
  }

  if (typeof frontmatter.title !== "string" || frontmatter.title.trim() === "") {
    issues.push({
      rule_id: "query_question_title_missing",
      severity: "error",
      path: page.path,
      message: `Saved query page is missing a title: ${page.path}.`,
      fix_hint: "Set title to the answered question.",
    });
  } else if (frontmatter.title.trim() !== question.trim()) {
    issues.push({
      rule_id: "query_question_title_mismatch",
      severity: "error",
      path: page.path,
      message: `Saved query page title does not match the requested question: ${page.path}.`,
      fix_hint: `Set title to ${JSON.stringify(question)}.`,
    });
  }

  if (typeof frontmatter.visibility !== "string" || frontmatter.visibility.trim() === "") {
    issues.push({
      rule_id: "query_question_visibility_missing",
      severity: "error",
      path: page.path,
      message: `Saved query page is missing visibility: ${page.path}.`,
      fix_hint: "Set visibility: private until the answer is explicitly reviewed for public release.",
    });
  } else if (!SUPPORTED_QUERY_VISIBILITIES.has(frontmatter.visibility)) {
    issues.push({
      rule_id: "query_question_visibility_invalid",
      severity: "error",
      path: page.path,
      message: `Saved query page visibility must be private or public: ${page.path}.`,
      fix_hint: "Use visibility: private or visibility: public.",
    });
  }

  const sourceIdsValue = frontmatter.source_ids;
  const sourceIds = sourceIdsForPage(page);
  const hasSourceIdsField = Object.hasOwn(frontmatter, "source_ids");
  const hasSourceIdsArray = Array.isArray(sourceIdsValue);
  const availableBodyCitedSourceIds = bodyCitedSourceIds.filter((sourceId) => availableSourceIds.includes(sourceId));
  const unavailableBodyCitedSourceIds = bodyCitedSourceIds.filter((sourceId) => !availableSourceIds.includes(sourceId));

  if (!hasSourceIdsField) {
    issues.push({
      rule_id: "query_source_ids_missing",
      severity: "error",
      path: page.path,
      message: `Saved query page is missing source_ids frontmatter: ${page.path}.`,
      fix_hint: "Add source_ids: [] when no curated evidence is available, or list the source IDs used by the answer.",
    });
  } else if (!hasSourceIdsArray) {
    issues.push({
      rule_id: "query_source_ids_invalid",
      severity: "error",
      path: page.path,
      message: `Saved query page source_ids frontmatter must be an array: ${page.path}.`,
      fix_hint: "Set source_ids to a YAML array, for example source_ids: [] or source_ids: [src_yyyy_mm_dd_slug_shorthex].",
    });
  }

  if (hasSourceIdsArray) {
    for (const [index, sourceId] of sourceIdsValue.entries()) {
      if (typeof sourceId !== "string" || sourceId.trim() === "") {
        issues.push({
          rule_id: "query_source_ids_invalid",
          severity: "error",
          path: page.path,
          message: `Saved query page has an invalid source_ids entry at index ${index}.`,
          fix_hint: "Use non-empty source ID strings shaped like src_yyyy_mm_dd_slug_shorthex.",
        });
      }
    }
  }

  const hasOpenQuestions = hasOpenQuestionMarker(page);
  if (hasSourceIdsArray && availableSourceIds.length > 0 && sourceIds.length === 0 && !hasOpenQuestions) {
    issues.push({
      rule_id: "query_source_ids_missing",
      severity: "error",
      path: page.path,
      message: `Saved query page does not cite available source IDs: ${page.path}.`,
      fix_hint: "Add source_ids for evidence used by the answer, or move unsupported claims into open_questions.",
    });
  }

  const missingBodyCitationSourceIds = availableBodyCitedSourceIds.filter((sourceId) => !sourceIds.includes(sourceId));
  if (hasSourceIdsArray && missingBodyCitationSourceIds.length > 0) {
    issues.push({
      rule_id: "query_source_ids_missing",
      severity: "error",
      path: page.path,
      message: `Saved query page cites source summaries in the body but omits matching source_ids frontmatter: ${missingBodyCitationSourceIds.join(", ")}.`,
      fix_hint: "Add every cited curated source summary ID to source_ids, or remove unsupported source-summary citations and record missing evidence in open_questions.",
    });
  }

  let hasInvalidOrUnavailableSourceIds = unavailableBodyCitedSourceIds.length > 0;
  for (const sourceId of unavailableBodyCitedSourceIds) {
    issues.push(unavailableSourceIdIssue(page.path, sourceId, availableSourceIds));
  }

  for (const sourceId of sourceIds) {
    const parsedSourceId = parseSourceId(sourceId);
    if (!parsedSourceId.ok) {
      hasInvalidOrUnavailableSourceIds = true;
      issues.push({
        rule_id: "query_source_ids_invalid",
        severity: "error",
        path: page.path,
        message: `Saved query page has an invalid source_id: ${sourceId}.`,
        fix_hint: "Use source IDs shaped like src_yyyy_mm_dd_slug_shorthex.",
      });
      continue;
    }

    if (!availableSourceIds.includes(sourceId)) {
      hasInvalidOrUnavailableSourceIds = true;
      issues.push(unavailableSourceIdIssue(page.path, sourceId, availableSourceIds));
    }
  }

  const requiresOpenQuestionMarker = sourceIds.length === 0 || hasInvalidOrUnavailableSourceIds;
  if (requiresOpenQuestionMarker && !hasOpenQuestions) {
    issues.push({
      rule_id: "query_open_questions_missing",
      severity: "error",
      path: page.path,
      message: `Saved query page does not represent missing provenance as open questions: ${page.path}.`,
      fix_hint: "Add non-empty open_questions frontmatter or an Open Questions section for unsupported or unknown claims.",
    });
  }

  return issues;
}

function sourceIdsForPage(page: RepoMarkdownFile): string[] {
  const sourceIds = page.scan.frontmatter?.source_ids;
  if (!Array.isArray(sourceIds)) {
    return [];
  }

  return sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string" && sourceId.trim() !== "");
}

function bodySourceSummaryIdsForPage(scan: RepoScan, page: RepoMarkdownFile): string[] {
  const sourceIds = resolveLinks(scan, page)
    .flatMap((link) => {
      const sourceId =
        link.resolved_path === null
          ? sourceSummarySourceIdFromLinkTarget(page, link.link.target)
          : sourceSummarySourceIdFromPath(link.resolved_path);
      return sourceId === null ? [] : [sourceId];
    });

  return [...new Set(sourceIds)].sort();
}

function unavailableSourceIdIssue(path: string, sourceId: string, availableSourceIds: string[]): QueryValidationIssue {
  return {
    rule_id: "query_source_ids_unavailable",
    severity: "error",
    path,
    message: `Saved query page cites a source_id that is not available in this wiki: ${sourceId}.`,
    fix_hint:
      availableSourceIds.length === 0
        ? "Remove the unavailable source ID and represent unsupported claims as open_questions until an available source exists."
        : `Replace ${sourceId} with an available source ID (${availableSourceIds.join(", ")}), or move unsupported claims into open_questions.`,
  };
}

export function availableQuerySourceIds(scan: RepoScan, contextSourceIds: string[]): string[] {
  const backedSourceIds = curatedSourceSummaryIds(scan);

  return [...new Set(contextSourceIds.filter((sourceId) => backedSourceIds.has(sourceId)))].sort();
}

function curatedSourceSummaryIds(scan: RepoScan): Set<string> {
  const sourceIds = new Set<string>();

  for (const page of scan.curatedPages) {
    if (page.scan.frontmatter?.type !== "source_summary") {
      continue;
    }

    const pathSourceId = sourceSummarySourceIdFromPath(page.path);
    if (pathSourceId === null || !sourceSummaryCarriesSourceId(page, pathSourceId)) {
      continue;
    }

    sourceIds.add(pathSourceId);
  }

  return sourceIds;
}

function sourceSummarySourceIdFromPath(path: string): string | null {
  const match = /^curated\/sources\/([^/]+)\.md$/.exec(path);
  const sourceId = match?.[1];
  if (sourceId === undefined) {
    return null;
  }

  return parseSourceId(sourceId).ok ? sourceId : null;
}

function sourceSummarySourceIdFromLinkTarget(page: RepoMarkdownFile, rawTarget: string): string | null {
  const target = normalizedLocalLinkTarget(rawTarget);
  if (target === null) {
    return null;
  }

  if (parseSourceId(target).ok) {
    return target;
  }

  for (const candidate of linkPathCandidates(page.path, target)) {
    const sourceId = sourceSummarySourceIdFromPath(candidate);
    if (sourceId !== null) {
      return sourceId;
    }
  }

  return null;
}

function normalizedLocalLinkTarget(rawTarget: string): string | null {
  const withDecodedSeparators = normalizeIndexReferenceTarget(rawTarget).replace(/%2f/gi, "/").replace(/%5c/gi, "\\");
  let target: string;

  try {
    target = decodeURI(withDecodedSeparators);
  } catch {
    target = withDecodedSeparators;
  }

  target = target.replaceAll("\\", "/").replace(/^\/+/, "");
  if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
    return null;
  }

  return target;
}

function linkPathCandidates(fromPath: string, target: string): string[] {
  const candidates = new Set<string>();
  const hasMarkdownExtension = /\.md$/i.test(target);
  const add = (path: string) => {
    const normalized = posix.normalize(path).replace(/^\/+/, "");
    candidates.add(normalized);
    if (!hasMarkdownExtension) {
      candidates.add(`${normalized}.md`);
    }
  };

  add(`${posix.dirname(fromPath)}/${target}`);
  add(target);
  if (!target.startsWith("curated/") && !target.startsWith("raw/")) {
    add(`curated/${target}`);
  }

  return [...candidates];
}

function sourceSummaryCarriesSourceId(page: RepoMarkdownFile, sourceId: string): boolean {
  return page.scan.frontmatter?.source_id === sourceId || sourceIdsForPage(page).includes(sourceId);
}

function hasOpenQuestionMarker(page: RepoMarkdownFile): boolean {
  const openQuestions = page.scan.frontmatter?.open_questions;
  if (Array.isArray(openQuestions) && openQuestions.some((entry) => typeof entry === "string" && entry.trim() !== "")) {
    return true;
  }

  return hasOpenQuestionSectionContent(page);
}

function hasOpenQuestionSectionContent(page: RepoMarkdownFile): boolean {
  const lines = page.scan.body.split(/\r?\n/);
  let openQuestionDepth: number | null = null;

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (headingMatch !== null) {
      const depth = headingMatch[1]?.length ?? 0;
      const headingText = headingMatch[2]?.trim() ?? "";

      if (openQuestionDepth !== null && depth <= openQuestionDepth) {
        openQuestionDepth = null;
      }

      if (/^open questions?$/i.test(headingText)) {
        openQuestionDepth = depth;
      }

      continue;
    }

    if (openQuestionDepth !== null && line.trim() !== "") {
      return true;
    }
  }

  return false;
}

function indexMentionsSavePath(scan: RepoScan, page: RepoMarkdownFile, savePath: string): boolean {
  const targets = indexReferenceTargets(savePath);
  const linkIndex = createLinkResolutionIndex(scan);

  return (
    resolveLinks(scan, page, linkIndex).some((link) => link.resolved_path === savePath) ||
    page.scan.wikilinks.some((link) => targets.has(normalizeIndexReferenceTarget(link.target))) ||
    page.scan.markdownLinks.some((link) => targets.has(normalizeIndexReferenceTarget(link.target))) ||
    [...targets].some((target) => hasExactPathToken(page.content, target))
  );
}

function hasQueryLogEntry(scan: RepoScan, questionId: string, question: string, savePath: string): boolean {
  return (
    scan.log?.scan.entries.some(
      (entry) =>
        entry.operation === "query" &&
        entry.affectedId === questionId &&
        (entry.title === question || entry.body.includes(question)) &&
        logEntryListsSavePath(entry.body, savePath),
    ) ?? false
  );
}

function logEntryListsSavePath(body: string, savePath: string): boolean {
  return logEntryCreatedOrUpdatedPaths(body).some((path) => logPathMatchesSavePath(path, savePath));
}

function logEntryCreatedOrUpdatedPaths(body: string): string[] {
  const paths: string[] = [];
  let activePathList = false;

  for (const line of body.split(/\r?\n/)) {
    const fieldMatch = /^-\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (fieldMatch !== null) {
      const [, field = "", inlineValue = ""] = fieldMatch;
      activePathList = field === "created" || field === "updated";
      if (activePathList && inlineValue.trim() !== "") {
        paths.push(inlineValue.trim());
      }
      continue;
    }

    if (!activePathList) {
      continue;
    }

    const itemMatch = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (itemMatch !== null && (itemMatch[1] ?? "").trim() !== "") {
      paths.push((itemMatch[1] ?? "").trim());
    }
  }

  return paths;
}

function logPathMatchesSavePath(logPath: string, savePath: string): boolean {
  const targets = indexReferenceTargets(savePath);
  const bodyScan = scanMarkdownDocument({ path: "curated/log.md", content: logPath });

  return (
    bodyScan.wikilinks.some((link) => targets.has(normalizeIndexReferenceTarget(link.target))) ||
    bodyScan.markdownLinks.some((link) => targets.has(normalizeIndexReferenceTarget(link.target))) ||
    targets.has(normalizeIndexReferenceTarget(logPath))
  );
}

function questionIdFromSavePath(savePath: string): string {
  return posix.basename(savePath, ".md");
}

function isLogSafeQuestionSlug(slug: string): boolean {
  return slug !== "" && slug === slug.trim() && !/[|?#\r\n]/.test(slug);
}

function isLogSafeQuestionPath(savePath: string): boolean {
  const questionPath = savePath.slice(QUERY_SAVE_PREFIX.length);
  const segments = questionPath.split("/");

  return segments.length > 0 && segments.every((segment) => isLogSafeQuestionSlug(segment));
}

function normalizeSavePath(savePath: string): string | null {
  if (savePath.trim() === "" || savePath.includes("\0") || savePath.includes("\\")) {
    return null;
  }

  if (posix.isAbsolute(savePath) || savePath.split("/").includes("..")) {
    return null;
  }

  return posix.normalize(savePath).replace(/\/+$/, "");
}

function indexReferenceTargets(savePath: string): Set<string> {
  const curatedStem = savePath.replace(/\.md$/, "");
  const relativePath = savePath.replace(/^curated\//, "");
  const relativeStem = relativePath.replace(/\.md$/, "");

  return new Set([savePath, curatedStem, relativePath, relativeStem]);
}

function normalizeIndexReferenceTarget(target: string): string {
  const trimmed = target.trim();
  const queryIndex = trimmed.indexOf("?");
  const fragmentIndex = trimmed.indexOf("#");
  const cutoff = [queryIndex, fragmentIndex].filter((index) => index >= 0).sort((left, right) => left - right)[0];
  const withoutQueryOrFragment = cutoff === undefined ? trimmed : trimmed.slice(0, cutoff);

  return withoutQueryOrFragment.replace(/^\.?\//, "");
}

function hasExactPathToken(content: string, token: string): boolean {
  const escapedToken = escapeRegExp(token);
  const pattern = new RegExp(`(^|[^A-Za-z0-9_./-])${escapedToken}($|[^A-Za-z0-9_./-])`);

  return pattern.test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkedPaths(savePath: string, issues: QueryValidationIssue[]): string[] {
  return [...new Set([savePath, "curated/index.md", "curated/log.md", ...issues.map((issue) => issue.path)])].sort();
}

function dedupeIssues(issues: QueryValidationIssue[]): QueryValidationIssue[] {
  const seen = new Set<string>();
  const deduped: QueryValidationIssue[] = [];

  for (const issue of issues) {
    const key = `${issue.rule_id}\0${issue.path}\0${issue.message}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(issue);
  }

  return deduped.sort((left, right) => left.path.localeCompare(right.path) || left.rule_id.localeCompare(right.rule_id));
}
