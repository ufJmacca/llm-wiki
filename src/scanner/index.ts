import { createHash } from "node:crypto";

import { LineCounter, parseDocument } from "yaml";

import { err, ok, type Result } from "../utils/result.js";

export type ScannerSeverity = "error" | "warning";

export type ScannerIssue = {
  severity: ScannerSeverity;
  code: string;
  message: string;
  path: string;
  line?: number;
  column?: number;
  hint: string;
};

export type ScannerInput = {
  path: string;
  content: string;
};

export type MarkdownHeading = {
  path: string;
  line: number;
  depth: number;
  text: string;
};

export type WikiLink = {
  path: string;
  line: number;
  column: number;
  raw: string;
  target: string;
  alias: string | null;
  embed: boolean;
};

export type MarkdownDocumentScan = {
  path: string;
  frontmatter?: Record<string, unknown>;
  body: string;
  headings: MarkdownHeading[];
  wikilinks: WikiLink[];
  issues: ScannerIssue[];
};

export type RuntimeLogOperation =
  | "init"
  | "add"
  | "ingest"
  | "query"
  | "lint"
  | "explore"
  | "deploy"
  | "upload";

export type RuntimeLogEntry = {
  path: string;
  line: number;
  timestamp: string;
  operation: RuntimeLogOperation;
  affectedId: string;
  title: string;
  body: string;
};

export type RuntimeLogScan = {
  entries: RuntimeLogEntry[];
  issues: ScannerIssue[];
};

export type ProfileScan = {
  profile?: Record<string, unknown>;
  issues: ScannerIssue[];
};

export type QueueItem = {
  source_id: string;
  title: string;
  kind: string;
  source_kind?: string;
  status: "queued" | "ingesting" | "ingested" | "blocked";
  path: string;
  [key: string]: unknown;
};

export type QueueItemScan = {
  item?: QueueItem;
  issues: ScannerIssue[];
};

export type SourceIdParts = {
  sourceId: string;
  year: string;
  month: string;
  day: string;
  slug: string;
  shortHash: string;
};

export type CacheMetadataScan = {
  metadata?: Record<string, unknown>;
  authoritative: false;
  issues: ScannerIssue[];
};

const SUPPORTED_LOG_OPERATIONS = new Set<RuntimeLogOperation>([
  "init",
  "add",
  "ingest",
  "query",
  "lint",
  "explore",
  "deploy",
  "upload",
]);

const QUEUE_STATUSES = new Set(["queued", "ingesting", "ingested", "blocked"]);
const SOURCE_ID_PATTERN = /^src_(\d{4})_(\d{2})_(\d{2})_([a-z0-9]+(?:[_-][a-z0-9]+)*)_([a-f0-9]{6,16})$/;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const LOG_HEADING_PATTERN = /^## \[([^\]]+)\] ([^|]+?) \| ([^|]+?) \| (.+)$/;
const LOG_TEMPLATE_HEADING = "## [operation-timestamp] operation | affected-id | title";

export function scanMarkdownDocument(input: ScannerInput): MarkdownDocumentScan {
  const frontmatterScan = parseFrontmatter(input);
  const issues = [
    ...frontmatterScan.issues,
    ...(frontmatterScan.frontmatter ? validateMarkdownFrontmatter(input.path, frontmatterScan.frontmatter) : []),
  ];
  const contentForBody = frontmatterScan.body ?? input.content;
  const lineOffset = frontmatterScan.bodyLineOffset ?? 0;

  return {
    path: input.path,
    frontmatter: frontmatterScan.frontmatter,
    body: contentForBody,
    headings: parseMarkdownHeadings({ path: input.path, content: contentForBody }, { lineOffset }),
    wikilinks: parseWikilinks({ path: input.path, content: contentForBody }, { lineOffset }),
    issues,
  };
}

export function parseWikilinks(input: ScannerInput, options: { lineOffset?: number } = {}): WikiLink[] {
  const links: WikiLink[] = [];
  const lines = splitLines(input.content);
  const lineOffset = options.lineOffset ?? 0;
  let activeFenceMarker: MarkdownFenceMarker | null = null;
  let activeListContexts: MarkdownListContext[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const wasInsideFence = activeFenceMarker !== null;
    let listItem: MarkdownListContext | null = null;
    let isRecognizedListItem = false;

    if (!wasInsideFence) {
      activeListContexts = pruneMarkdownListContexts(activeListContexts, line);
      listItem = markdownListItemContext(line);
      if (listItem !== null) {
        const currentListItem = listItem;
        isRecognizedListItem =
          !isIndentedCodeLine(line) ||
          activeListContexts.some((context) => currentListItem.markerIndent > context.markerIndent);
      }
    }

    const fenceState = updateFenceState(
      lineForWikilinkFenceScan(line, activeListContexts, isRecognizedListItem ? listItem : null),
      activeFenceMarker,
    );
    if (fenceState.boundary) {
      activeFenceMarker = fenceState.marker;
      if (!wasInsideFence && isRecognizedListItem && listItem !== null) {
        activeListContexts = replaceMarkdownListContext(activeListContexts, listItem);
      }
      continue;
    }

    if (activeFenceMarker !== null) {
      continue;
    }

    const lineForCodeBlockScan = stripMarkdownBlockquoteMarkers(line);
    const isListContinuation = isMarkdownListContinuationLine(
      lineForCodeBlockScan,
      activeListContexts,
      isRecognizedListItem,
    );
    if (isIndentedCodeLine(lineForCodeBlockScan) && !isRecognizedListItem && !isListContinuation) {
      continue;
    }

    const scanLine = maskInlineCodeSpans(line);
    const linkPattern = /!?\[\[([^\]\n]+)\]\]/g;
    for (const match of scanLine.matchAll(linkPattern)) {
      if (match.index === undefined) {
        continue;
      }

      const raw = line.slice(match.index, match.index + match[0].length);
      const embed = raw.startsWith("!");
      const body = match[1] ?? "";
      const [target, alias] = splitWikilinkBody(body);

      links.push({
        path: input.path,
        line: lineIndex + 1 + lineOffset,
        column: match.index + 1,
        raw,
        target,
        alias,
        embed,
      });
    }

    if (isRecognizedListItem && listItem !== null) {
      activeListContexts = replaceMarkdownListContext(activeListContexts, listItem);
    }
  }

  return links;
}

export function parseLogEntries(input: ScannerInput): RuntimeLogScan {
  const lines = splitLines(input.content);
  const entries: RuntimeLogEntry[] = [];
  const issues: ScannerIssue[] = [];
  let activeFenceMarker: MarkdownFenceMarker | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const fenceState = updateFenceState(line, activeFenceMarker);
    if (fenceState.boundary) {
      activeFenceMarker = fenceState.marker;
      continue;
    }

    if (activeFenceMarker !== null || !line.startsWith("## [")) {
      continue;
    }

    if (line.trim() === LOG_TEMPLATE_HEADING) {
      continue;
    }

    const lineNumber = lineIndex + 1;
    const match = LOG_HEADING_PATTERN.exec(line);
    if (!match) {
      issues.push({
        severity: "error",
        code: "LOG_HEADING_MALFORMED",
        message: `Malformed runtime log heading in ${input.path}:${lineNumber}.`,
        path: input.path,
        line: lineNumber,
        hint: "Use `## [timestamp] operation | affected-id | title` with pipe separators.",
      });
      continue;
    }

    const [, timestamp = "", operationText = "", affectedId = "", title = ""] = match;
    const operation = operationText.trim();
    const trimmedAffectedId = affectedId.trim();
    const trimmedTitle = title.trim();

    if (!isIsoTimestamp(timestamp)) {
      issues.push({
        severity: "error",
        code: "LOG_TIMESTAMP_INVALID",
        message: `Runtime log heading has a non-ISO timestamp in ${input.path}:${lineNumber}.`,
        path: input.path,
        line: lineNumber,
        hint: "Use an ISO timestamp such as 2026-06-17T11:28:42.000Z or 2026-06-17T21:28:42+10:00.",
      });
      continue;
    }

    if (!isSupportedLogOperation(operation)) {
      issues.push({
        severity: "error",
        code: "LOG_OPERATION_UNSUPPORTED",
        message: `Unsupported runtime log operation "${operation}" in ${input.path}:${lineNumber}.`,
        path: input.path,
        line: lineNumber,
        hint: `Use a supported operation: ${[...SUPPORTED_LOG_OPERATIONS].join(", ")}.`,
      });
      continue;
    }

    if (trimmedAffectedId === "" || trimmedTitle === "") {
      issues.push({
        severity: "error",
        code: "LOG_HEADING_MALFORMED",
        message: `Runtime log heading is missing an affected ID or title in ${input.path}:${lineNumber}.`,
        path: input.path,
        line: lineNumber,
        hint: "Use non-empty affected-id and title fields in the runtime log heading.",
      });
      continue;
    }

    entries.push({
      path: input.path,
      line: lineNumber,
      timestamp,
      operation,
      affectedId: trimmedAffectedId,
      title: trimmedTitle,
      body: readLogEntryBody(lines, lineIndex + 1),
    });
  }

  return { entries, issues };
}

export function parseProfile(input: ScannerInput): ProfileScan {
  const parsed = parseYamlObject(input, {
    code: "PROFILE_YAML_INVALID",
    rootCode: "PROFILE_SCHEMA_INVALID",
    hint: "Fix the profile YAML so it is a mapping with profile fields.",
  });

  if (!parsed.data) {
    return { issues: parsed.issues };
  }

  const issues = [...parsed.issues, ...validateProfile(input.path, parsed.data)];
  if (issues.some((issue) => issue.severity === "error")) {
    return { issues };
  }

  return {
    profile: parsed.data,
    issues,
  };
}

export function parseQueueItem(input: ScannerInput): QueueItemScan {
  const parsed = parseJsonObject(input, {
    code: "QUEUE_JSON_INVALID",
    rootCode: "QUEUE_SCHEMA_INVALID",
    hint: "Fix the queue JSON so it is a single object with source_id, title, kind, status, and path.",
  });

  if (!parsed.data) {
    return { issues: parsed.issues };
  }

  const issues = [...parsed.issues, ...validateQueueItem(input.path, parsed.data)];
  if (issues.some((issue) => issue.severity === "error")) {
    return { issues };
  }

  return {
    item: parsed.data as QueueItem,
    issues,
  };
}

export function parseSourceId(sourceId: string): Result<SourceIdParts, ScannerIssue> {
  const match = SOURCE_ID_PATTERN.exec(sourceId);
  if (!match) {
    return err({
      severity: "error",
      code: "SOURCE_ID_INVALID",
      message: `Invalid source ID: ${sourceId}`,
      path: sourceId,
      hint: "Use source IDs shaped like src_yyyy_mm_dd_slug_shorthex.",
    });
  }

  const [, year = "", month = "", day = "", slug = "", shortHash = ""] = match;
  const numericYear = Number.parseInt(year, 10);
  const numericMonth = Number.parseInt(month, 10);
  const numericDay = Number.parseInt(day, 10);
  if (numericMonth < 1 || numericMonth > 12 || numericDay < 1 || numericDay > daysInMonth(numericYear, numericMonth)) {
    return err({
      severity: "error",
      code: "SOURCE_ID_INVALID",
      message: `Invalid source ID calendar date: ${sourceId}`,
      path: sourceId,
      hint: "Use a real calendar date in source IDs shaped like src_yyyy_mm_dd_slug_shorthex.",
    });
  }

  return ok({ sourceId, year, month, day, slug, shortHash });
}

export function computeContentHash(content: string | Buffer | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function parseCacheMetadata(input: ScannerInput): CacheMetadataScan {
  const parsed = parseJsonObject(input, {
    code: "CACHE_JSON_INVALID",
    rootCode: "CACHE_SCHEMA_INVALID",
    hint: "Regenerate the cache metadata from Markdown instead of hand-editing the cache file.",
  });

  return {
    metadata: parsed.data,
    authoritative: false,
    issues: parsed.issues,
  };
}

function parseFrontmatter(input: ScannerInput): {
  frontmatter?: Record<string, unknown>;
  body?: string;
  bodyLineOffset?: number;
  issues: ScannerIssue[];
} {
  const lines = splitLines(input.content);
  if (!isFrontmatterDelimiter(lines[0] ?? "")) {
    return { body: input.content, bodyLineOffset: 0, issues: [] };
  }

  const closingLineIndex = lines.findIndex((line, index) => index > 0 && isFrontmatterDelimiter(line));
  if (closingLineIndex === -1) {
    return {
      body: "",
      issues: [
        {
          severity: "error",
          code: "FRONTMATTER_UNCLOSED",
          message: `Markdown frontmatter is missing a closing delimiter in ${input.path}.`,
          path: input.path,
          line: 1,
          hint: "Close the YAML frontmatter with a line containing only `---`.",
        },
      ],
    };
  }

  const yamlSource = lines.slice(1, closingLineIndex).join("\n");
  const bodyStartIndex = isBlankLine(lines[closingLineIndex + 1]) ? closingLineIndex + 2 : closingLineIndex + 1;
  const parsed = parseYamlObject(
    { path: input.path, content: yamlSource },
    {
      code: "FRONTMATTER_YAML_INVALID",
      rootCode: "FRONTMATTER_SCHEMA_INVALID",
      hint: "Fix the YAML frontmatter so it is a mapping.",
      lineOffset: 1,
    },
  );

  return {
    frontmatter: parsed.data,
    body: lines.slice(bodyStartIndex).join("\n"),
    bodyLineOffset: bodyStartIndex,
    issues: parsed.issues,
  };
}

function parseMarkdownHeadings(input: ScannerInput, options: { lineOffset?: number } = {}): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = splitLines(input.content);
  const lineOffset = options.lineOffset ?? 0;
  let activeFenceMarker: MarkdownFenceMarker | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const fenceState = updateFenceState(line, activeFenceMarker);
    if (fenceState.boundary) {
      activeFenceMarker = fenceState.marker;
      continue;
    }

    if (activeFenceMarker !== null) {
      continue;
    }

    const match = /^( {0,3})(#{1,6})(?!#)(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (!match) {
      continue;
    }

    const rawText = (match[3] ?? "").trim();
    const text = rawText.replace(/(?:^|[ \t]+)#{1,}$/, "").trim();

    headings.push({
      path: input.path,
      line: lineIndex + 1 + lineOffset,
      depth: match[2]?.length ?? 0,
      text,
    });
  }

  return headings;
}

function parseYamlObject(
  input: ScannerInput,
  options: { code: string; rootCode: string; hint: string; lineOffset?: number },
): { data?: Record<string, unknown>; issues: ScannerIssue[] } {
  const lineCounter = new LineCounter();
  const document = parseDocument(input.content, { lineCounter, prettyErrors: false });
  if (document.errors.length > 0) {
    const firstError = document.errors[0];
    const position = firstError?.linePos?.[0];

    return {
      issues: [
        {
          severity: "error",
          code: options.code,
          message: firstError?.message ?? `Invalid YAML in ${input.path}.`,
          path: input.path,
          line: addLineOffset(position?.line ?? 1, options.lineOffset),
          column: position?.col,
          hint: options.hint,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = document.toJS() as unknown;
  } catch (error) {
    const position = yamlErrorPosition(error);

    return {
      issues: [
        {
          severity: "error",
          code: options.code,
          message: error instanceof Error ? error.message : `Invalid YAML in ${input.path}.`,
          path: input.path,
          line: addLineOffset(position?.line ?? 1, options.lineOffset),
          column: position?.col,
          hint: options.hint,
        },
      ],
    };
  }

  if (parsed === null) {
    return { data: {}, issues: [] };
  }

  if (!isRecord(parsed)) {
    return {
      issues: [
        {
          severity: "error",
          code: options.rootCode,
          message: `Expected YAML mapping in ${input.path}.`,
          path: input.path,
          line: addLineOffset(1, options.lineOffset),
          hint: options.hint,
        },
      ],
    };
  }

  return { data: parsed, issues: [] };
}

function parseJsonObject(
  input: ScannerInput,
  options: { code: string; rootCode: string; hint: string },
): { data?: Record<string, unknown>; issues: ScannerIssue[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content) as unknown;
  } catch (error) {
    const position = jsonErrorPosition(error);
    const issue: ScannerIssue = {
      severity: "error",
      code: options.code,
      message: error instanceof Error ? error.message : `Invalid JSON in ${input.path}.`,
      path: input.path,
      hint: options.hint,
    };

    if (position !== undefined) {
      const linePosition = offsetToLineColumn(input.content, position);
      issue.line = linePosition.line;
      issue.column = linePosition.column;
    }

    return {
      issues: [issue],
    };
  }

  if (!isRecord(parsed)) {
    return {
      issues: [
        {
          severity: "error",
          code: options.rootCode,
          message: `Expected JSON object in ${input.path}.`,
          path: input.path,
          line: 1,
          hint: options.hint,
        },
      ],
    };
  }

  return { data: parsed, issues: [] };
}

function validateProfile(path: string, data: Record<string, unknown>): ScannerIssue[] {
  const issues: ScannerIssue[] = [];

  if (typeof data.name !== "string" || data.name.trim() === "") {
    issues.push({
      severity: "error",
      code: "PROFILE_FIELD_MISSING",
      message: `Profile is missing required string field "name" in ${path}.`,
      path,
      hint: 'Add a non-empty "name" value to the profile YAML.',
    });
  }

  if (typeof data.mode !== "string" || data.mode.trim() === "") {
    issues.push({
      severity: "error",
      code: "PROFILE_FIELD_MISSING",
      message: `Profile is missing required string field "mode" in ${path}.`,
      path,
      hint: 'Add a non-empty "mode" value to the profile YAML.',
    });
  }

  if (!isStringArray(data.include)) {
    issues.push({
      severity: "error",
      code: "PROFILE_INCLUDE_INVALID",
      message: `Profile include must be an array of glob strings in ${path}.`,
      path,
      hint: "Use an array of glob strings under include.",
    });
  }

  if (data.exclude !== undefined && !isStringArray(data.exclude)) {
    issues.push({
      severity: "error",
      code: "PROFILE_EXCLUDE_INVALID",
      message: `Profile exclude must be an array of glob strings in ${path}.`,
      path,
      hint: "Use an array of glob strings under exclude.",
    });
  }

  if (data.visibility !== undefined) {
    if (!isRecord(data.visibility)) {
      issues.push({
        severity: "error",
        code: "PROFILE_VISIBILITY_INVALID",
        message: `Profile visibility must be a mapping in ${path}.`,
        path,
        hint: "Use visibility.include_private and optional visibility.required_value fields.",
      });
    } else if (
      data.visibility.include_private !== undefined &&
      typeof data.visibility.include_private !== "boolean"
    ) {
      issues.push({
        severity: "error",
        code: "PROFILE_VISIBILITY_INVALID",
        message: `Profile visibility.include_private must be a boolean in ${path}.`,
        path,
        hint: "Use a boolean visibility.include_private value.",
      });
    }

    if (
      isRecord(data.visibility) &&
      data.visibility.required_value !== undefined &&
      typeof data.visibility.required_value !== "string"
    ) {
      issues.push({
        severity: "error",
        code: "PROFILE_VISIBILITY_INVALID",
        message: `Profile visibility.required_value must be a string in ${path}.`,
        path,
        hint: "Use a string visibility.required_value such as public.",
      });
    }
  }

  return issues;
}

function validateQueueItem(path: string, data: Record<string, unknown>): ScannerIssue[] {
  const issues: ScannerIssue[] = [];
  const requiredStrings = ["source_id", "title", "kind", "status", "path"];

  for (const field of requiredStrings) {
    if (typeof data[field] !== "string" || data[field].trim() === "") {
      issues.push({
        severity: "error",
        code: "QUEUE_FIELD_MISSING",
        message: `Queue item is missing required string field "${field}" in ${path}.`,
        path,
        hint: `Add a non-empty "${field}" value to the queue JSON.`,
      });
    }
  }

  if (typeof data.source_id === "string") {
    const sourceId = parseSourceId(data.source_id);
    if (!sourceId.ok) {
      issues.push({ ...sourceId.error, path });
    }
  }

  if (typeof data.status === "string" && !QUEUE_STATUSES.has(data.status)) {
    issues.push({
      severity: "error",
      code: "QUEUE_STATUS_INVALID",
      message: `Queue item has unsupported status "${data.status}" in ${path}.`,
      path,
      hint: "Use one of queued, ingesting, ingested, or blocked.",
    });
  }

  return issues;
}

function validateMarkdownFrontmatter(path: string, data: Record<string, unknown>): ScannerIssue[] {
  if (data.type !== "raw_source" || typeof data.source_id !== "string" || data.source_id.trim() === "") {
    return [];
  }

  const sourceId = parseSourceId(data.source_id);
  if (sourceId.ok) {
    return [];
  }

  return [{ ...sourceId.error, path }];
}

function readLogEntryBody(lines: string[], startLineIndex: number): string {
  const bodyLines: string[] = [];
  let activeFenceMarker: MarkdownFenceMarker | null = null;

  for (let lineIndex = startLineIndex; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const fenceState = updateFenceState(line, activeFenceMarker);
    activeFenceMarker = fenceState.marker;

    if (activeFenceMarker === null && !fenceState.boundary && line.startsWith("## ")) {
      break;
    }

    bodyLines.push(line);
  }

  return bodyLines.join("\n").trimEnd();
}

function splitWikilinkBody(body: string): [target: string, alias: string | null] {
  const separatorIndex = body.indexOf("|");
  if (separatorIndex === -1) {
    return [body.trim(), null];
  }

  return [body.slice(0, separatorIndex).trim(), body.slice(separatorIndex + 1).trim()];
}

function isIndentedCodeLine(line: string): boolean {
  return /^(?: {4,}|\t)/.test(line);
}

function isMarkdownListContinuationLine(
  line: string,
  activeListContexts: MarkdownListContext[],
  isRecognizedListItem: boolean,
): boolean {
  if (activeListContexts.length === 0 || isRecognizedListItem || isBlankLine(line)) {
    return false;
  }

  const lineIndent = markdownLineIndent(line);
  const containingList = containingMarkdownListContext(activeListContexts, lineIndent);
  return containingList !== undefined && lineIndent < containingList.contentIndent + 4;
}

type MarkdownListContext = {
  markerIndent: number;
  contentIndent: number;
  contentStartIndex: number;
};

function markdownListItemContext(line: string): MarkdownListContext | null {
  const match = /^([ \t]*)((?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$))/.exec(line);
  if (!match) {
    return null;
  }

  return {
    markerIndent: countMarkdownIndent(match[1] ?? ""),
    contentIndent: countMarkdownIndent(match[0]),
    contentStartIndex: match[0].length,
  };
}

function pruneMarkdownListContexts(activeListContexts: MarkdownListContext[], line: string): MarkdownListContext[] {
  if (isBlankLine(line)) {
    return activeListContexts;
  }

  const lineIndent = markdownLineIndent(line);
  const listItem = markdownListItemContext(line);
  return activeListContexts.filter(
    (context) => lineIndent > context.markerIndent || listItem?.markerIndent === context.markerIndent,
  );
}

function replaceMarkdownListContext(
  activeListContexts: MarkdownListContext[],
  listItem: MarkdownListContext,
): MarkdownListContext[] {
  return [...activeListContexts.filter((context) => context.markerIndent < listItem.markerIndent), listItem];
}

function lineForWikilinkFenceScan(
  line: string,
  activeListContexts: MarkdownListContext[],
  listItem: MarkdownListContext | null,
): string {
  if (listItem !== null) {
    return stripMarkdownBlockquoteMarkers(line.slice(listItem.contentStartIndex));
  }

  const lineIndent = markdownLineIndent(line);
  const containingList = containingMarkdownListContext(activeListContexts, lineIndent);

  if (
    containingList !== undefined &&
    lineIndent >= containingList.contentIndent &&
    lineIndent <= containingList.contentIndent + 3
  ) {
    return stripMarkdownBlockquoteMarkers(sliceLineAfterMarkdownIndent(line, containingList.contentIndent));
  }

  return stripMarkdownBlockquoteMarkers(line);
}

function containingMarkdownListContext(
  activeListContexts: MarkdownListContext[],
  lineIndent: number,
): MarkdownListContext | undefined {
  return [...activeListContexts].reverse().find((context) => lineIndent > context.markerIndent);
}

function stripMarkdownBlockquoteMarkers(line: string): string {
  let remaining = line;

  while (true) {
    const match = /^ {0,3}>[ \t]?/.exec(remaining);
    if (match === null) {
      return remaining;
    }

    remaining = remaining.slice(match[0].length);
  }
}

function sliceLineAfterMarkdownIndent(line: string, targetIndent: number): string {
  let indent = 0;
  let index = 0;

  while (index < line.length && indent < targetIndent) {
    const character = line[index];
    if (character !== " " && character !== "\t") {
      break;
    }

    indent += character === "\t" ? 4 : 1;
    index += 1;
  }

  return line.slice(index);
}

function countMarkdownIndent(indent: string): number {
  let count = 0;
  for (const character of indent) {
    count += character === "\t" ? 4 : 1;
  }

  return count;
}

function markdownLineIndent(line: string): number {
  return countMarkdownIndent(/^([ \t]*)/.exec(line)?.[1] ?? "");
}

function isFrontmatterDelimiter(line: string): boolean {
  return /^---[ \t]*$/.test(line);
}

function maskInlineCodeSpans(line: string): string {
  const masked = line.split("");
  let searchIndex = 0;

  while (searchIndex < line.length) {
    const openerMatch = /`+/.exec(line.slice(searchIndex));
    if (!openerMatch?.[0] || openerMatch.index === undefined) {
      break;
    }

    const opener = openerMatch[0];
    const openerStart = searchIndex + openerMatch.index;
    const closeStart = findClosingBacktickRun(line, opener, openerStart + opener.length);
    if (closeStart === -1) {
      searchIndex = openerStart + opener.length;
      continue;
    }

    for (let index = openerStart; index < closeStart + opener.length; index += 1) {
      masked[index] = " ";
    }
    searchIndex = closeStart + opener.length;
  }

  return masked.join("");
}

function findClosingBacktickRun(line: string, opener: string, startIndex: number): number {
  for (let index = startIndex; index < line.length; index += 1) {
    if (line[index] !== "`") {
      continue;
    }

    const runStart = index;
    while (index < line.length && line[index] === "`") {
      index += 1;
    }

    if (index - runStart === opener.length) {
      return runStart;
    }
  }

  return -1;
}

function isSupportedLogOperation(operation: string): operation is RuntimeLogOperation {
  return SUPPORTED_LOG_OPERATIONS.has(operation as RuntimeLogOperation);
}

function isIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  const hour = Number.parseInt(match[4] ?? "", 10);
  const minute = Number.parseInt(match[5] ?? "", 10);
  const second = Number.parseInt(match[6] ?? "", 10);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return false;
  }

  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  if (match[8] !== "Z") {
    const offsetHour = Number.parseInt(match[10] ?? "", 10);
    const offsetMinute = Number.parseInt(match[11] ?? "", 10);
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }

  return !Number.isNaN(Date.parse(value));
}

type MarkdownFenceMarker = {
  character: "`" | "~";
  length: number;
};

function updateFenceState(
  line: string,
  activeFenceMarker: MarkdownFenceMarker | null,
): { marker: MarkdownFenceMarker | null; boundary: boolean } {
  if (activeFenceMarker === null) {
    const fenceMarker = getOpeningFenceMarker(line);
    return { marker: fenceMarker, boundary: fenceMarker !== null };
  }

  const fenceMarker = getClosingFenceMarker(line);
  if (
    fenceMarker !== null &&
    fenceMarker.character === activeFenceMarker.character &&
    fenceMarker.length >= activeFenceMarker.length
  ) {
    return { marker: null, boundary: true };
  }

  return { marker: activeFenceMarker, boundary: false };
}

function getOpeningFenceMarker(line: string): MarkdownFenceMarker | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return markerFromMatch(match);
}

function getClosingFenceMarker(line: string): MarkdownFenceMarker | null {
  const match = /^ {0,3}(`{3,}|~{3,}) *$/.exec(line);
  return markerFromMatch(match);
}

function markerFromMatch(match: RegExpExecArray | null): MarkdownFenceMarker | null {
  const marker = match?.[1];
  if (marker === undefined) {
    return null;
  }

  const character = marker[0];
  if (character !== "`" && character !== "~") {
    return null;
  }

  return { character, length: marker.length };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function splitLines(content: string): string[] {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "");
}

function isBlankLine(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "";
}

function addLineOffset(line: number, lineOffset = 0): number {
  return line + lineOffset;
}

function jsonErrorPosition(error: unknown): number | undefined {
  if (!(error instanceof SyntaxError)) {
    return undefined;
  }

  const match = /position (\d+)/.exec(error.message);
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1] ?? "", 10);
}

function yamlErrorPosition(error: unknown): { line: number; col?: number } | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const linePos = (error as { linePos?: unknown }).linePos;
  if (!Array.isArray(linePos)) {
    return undefined;
  }

  const firstPosition = linePos[0];
  if (typeof firstPosition !== "object" || firstPosition === null) {
    return undefined;
  }

  const line = (firstPosition as { line?: unknown }).line;
  const col = (firstPosition as { col?: unknown }).col;
  if (typeof line !== "number") {
    return undefined;
  }

  return {
    line,
    col: typeof col === "number" ? col : undefined,
  };
}

function offsetToLineColumn(content: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const boundedOffset = Math.max(0, Math.min(offset, content.length));

  for (let index = 0; index < boundedOffset; index += 1) {
    if (content[index] === "\r") {
      if (content[index + 1] === "\n" && index + 1 < boundedOffset) {
        index += 1;
      }

      line += 1;
      column = 1;
    } else if (content[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}
