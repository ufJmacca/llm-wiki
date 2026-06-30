import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type StaticLeakSeverity = "error";

export type StaticLeakCode =
  | "STATIC_UPLOAD_COMPONENT_LEAK"
  | "STATIC_UPLOAD_FORM_LEAK"
  | "STATIC_UPLOAD_ENDPOINT_LEAK"
  | "STATIC_UPLOAD_TOKEN_LEAK"
  | "STATIC_DAEMON_METADATA_LEAK"
  | "STATIC_UPLOAD_ENDPOINT_CONFIG_LEAK"
  | "STATIC_UPLOAD_AUTH_LEAK"
  | "STATIC_RAW_INPUTS_LEAK"
  | "STATIC_RAW_QUEUE_LEAK"
  | "STATIC_PRIVATE_SOURCE_CARD_LEAK"
  | "STATIC_REVIEW_PAGE_LEAK"
  | "STATIC_SECRET_MARKER_LEAK"
  | "STATIC_SCAN_TARGET_UNSAFE";

export type StaticLeakFinding = {
  severity: StaticLeakSeverity;
  code: StaticLeakCode;
  path: string;
  line?: number;
  message: string;
  hint: string;
};

export type StaticOutputLeakScan = {
  ok: boolean;
  scanned_roots: string[];
  findings: StaticLeakFinding[];
};

export type ScanStaticOutputLeaksOptions = {
  roots?: readonly string[];
};

type MarkerMatch = {
  code: Exclude<StaticLeakCode, "STATIC_SCAN_TARGET_UNSAFE">;
  line: number;
};

type MarkerRule = {
  code: Exclude<StaticLeakCode, "STATIC_SCAN_TARGET_UNSAFE">;
  pattern: RegExp;
};

const DEFAULT_STATIC_SCAN_ROOTS = ["quartz/content", "quartz/public"] as const;
const PUBLICATION_HINT =
  "Remove upload, runtime, review, queue, raw, and secret data from committed GitHub Pages static output.";

const MARKER_RULES: readonly MarkerRule[] = [
  {
    code: "STATIC_UPLOAD_COMPONENT_LEAK",
    pattern: /\bLlmWikiUploadForm\b/u,
  },
  {
    code: "STATIC_UPLOAD_FORM_LEAK",
    pattern: /\bdata-llm-wiki-upload-form\b|\bllm_wiki_upload\s*[:=]\s*true\b/iu,
  },
  {
    code: "STATIC_UPLOAD_TOKEN_LEAK",
    pattern: /\bx-llm-wiki-upload-token\b|\bupload_token\b|\bllm_wiki_upload_token\b/iu,
  },
  {
    code: "STATIC_UPLOAD_AUTH_LEAK",
    pattern: /\bx-llm-wiki-upload-signature\b|\bllm_wiki_upload_signature\b|\bupload_signature\b|\bupload_hmac\b|\bllm_wiki_upload_auth\b/iu,
  },
  {
    code: "STATIC_RAW_INPUTS_LEAK",
    pattern: /\braw\/inputs\/[^\s"'`)<]+/iu,
  },
  {
    code: "STATIC_RAW_QUEUE_LEAK",
    pattern: /\braw\/queue\/[^\s"'`)<]+|\bqueue_path\b|\boriginal_path\b/iu,
  },
  {
    code: "STATIC_PRIVATE_SOURCE_CARD_LEAK",
    pattern: /^type:\s*raw_source\b|^\s*"type"\s*:\s*"raw_source"\b/imu,
  },
  {
    code: "STATIC_REVIEW_PAGE_LEAK",
    pattern: /\bLlmWikiReviewPanel\b|\bllm_wiki_review\b|\bsource queue\b|\breview-only\b/iu,
  },
  {
    code: "STATIC_SECRET_MARKER_LEAK",
    pattern:
      /\bGITHUB_TOKEN\b|\bGH_TOKEN\b|\bOPENAI_API_KEY\b|\bAWS_SECRET_ACCESS_KEY\b|\bPRIVATE_KEY\b|BEGIN [A-Z ]*PRIVATE KEY|\bgithub_pat_[A-Za-z0-9_]+|\bgh[ps]_[A-Za-z0-9_]+/u,
  },
];

const UPLOAD_ENDPOINT_CONFIG_PATTERN =
  /\bllm_wiki_upload_endpoint\b|\bupload_endpoint\b|\bupload_base_url\b|\bremote_upload_endpoint\b|\bendpoint_config\b/iu;
const UPLOAD_ENDPOINT_PATTERN = /\/api\/raw-upload\b/iu;
const DAEMON_METADATA_PATTERN = /\bllm_wiki_daemon\b|\blocal_daemon\b|\bdaemon_url\b|\blocal-daemon\b/iu;

export async function scanStaticOutputLeaks(
  repoRoot: string,
  options: ScanStaticOutputLeaksOptions = {},
): Promise<StaticOutputLeakScan> {
  const roots = options.roots ?? DEFAULT_STATIC_SCAN_ROOTS;
  const scannedRoots: string[] = [];
  const findings: StaticLeakFinding[] = [];

  for (const root of roots) {
    const targetSafety = await staticScanTargetSafety(repoRoot, root);
    if (targetSafety === "missing") {
      continue;
    }

    if (targetSafety === "unsafe") {
      findings.push(unsafeTargetFinding(root));
      continue;
    }

    const rootState = await safeLstat(repoRoot, root);
    if (rootState === null) {
      continue;
    }

    if (rootState.isSymbolicLink() || !rootState.isDirectory()) {
      findings.push(unsafeTargetFinding(root));
      continue;
    }

    scannedRoots.push(root);
    await visitStaticOutputPath(repoRoot, root, findings);
  }

  const sortedFindings = sortFindings(findings);
  return {
    ok: sortedFindings.length === 0,
    scanned_roots: scannedRoots.sort(),
    findings: sortedFindings,
  };
}

async function visitStaticOutputPath(repoRoot: string, path: string, findings: StaticLeakFinding[]): Promise<void> {
  const entries = await readdir(resolve(repoRoot, path));
  for (const entry of entries.sort()) {
    const childPath = `${path}/${entry}`;
    const childState = await safeLstat(repoRoot, childPath);
    if (childState === null) {
      continue;
    }

    if (childState.isSymbolicLink()) {
      findings.push(unsafeTargetFinding(childPath));
      continue;
    }

    if (childState.isDirectory()) {
      await visitStaticOutputPath(repoRoot, childPath, findings);
      continue;
    }

    if (!childState.isFile()) {
      findings.push(unsafeTargetFinding(childPath));
      continue;
    }

    findings.push(...scanStaticFile(pathFromRoot(repoRoot, resolve(repoRoot, childPath)), await readFile(resolve(repoRoot, childPath))));
  }
}

function scanStaticFile(path: string, content: Buffer): StaticLeakFinding[] {
  const text = content.toString("utf8");
  const matches: MarkerMatch[] = [];

  if (isDaemonMetadataPath(path)) {
    return [finding("STATIC_DAEMON_METADATA_LEAK", path, 1)];
  }

  if (isUploadPagePath(path)) {
    matches.push({ code: "STATIC_UPLOAD_FORM_LEAK", line: 1 });
  }

  if (isReviewPagePath(path)) {
    matches.push({ code: "STATIC_REVIEW_PAGE_LEAK", line: 1 });
  }

  if (isRawInputsPath(path)) {
    matches.push({ code: "STATIC_RAW_INPUTS_LEAK", line: 1 });
  }

  if (isRawQueuePath(path)) {
    matches.push({ code: "STATIC_RAW_QUEUE_LEAK", line: 1 });
  }

  const endpointConfigLine = firstMatchLine(text, UPLOAD_ENDPOINT_CONFIG_PATTERN);
  if (endpointConfigLine !== null) {
    matches.push({ code: "STATIC_UPLOAD_ENDPOINT_CONFIG_LEAK", line: endpointConfigLine });
  } else {
    const endpointLine = firstMatchLine(text, UPLOAD_ENDPOINT_PATTERN);
    if (endpointLine !== null) {
      matches.push({ code: "STATIC_UPLOAD_ENDPOINT_LEAK", line: endpointLine });
    }
  }

  const daemonMetadataLine = firstMatchLine(text, DAEMON_METADATA_PATTERN);
  if (daemonMetadataLine !== null) {
    matches.push({ code: "STATIC_DAEMON_METADATA_LEAK", line: daemonMetadataLine });
  }

  for (const rule of MARKER_RULES) {
    const line = firstMatchLine(text, rule.pattern);
    if (line !== null) {
      matches.push({ code: rule.code, line });
    }
  }

  return uniqueMatches(matches).map((match) => finding(match.code, path, match.line));
}

function isDaemonMetadataPath(path: string): boolean {
  return /(^|\/)_llm-wiki\/runtime\//u.test(path) || /(^|\/)local-daemon\.json$/u.test(path);
}

function isUploadPagePath(path: string): boolean {
  return /(^|\/)_llm-wiki\/upload(?:\.md|\/|$)/u.test(path);
}

function isReviewPagePath(path: string): boolean {
  return /(^|\/)_llm-wiki\/review(?:\/|$)/u.test(path);
}

function isRawInputsPath(path: string): boolean {
  return /(^|\/)raw\/inputs(?:\/|$)/u.test(path);
}

function isRawQueuePath(path: string): boolean {
  return /(^|\/)raw\/queue(?:\/|$)/u.test(path);
}

function uniqueMatches(matches: MarkerMatch[]): MarkerMatch[] {
  const seenCodes = new Set<StaticLeakCode>();
  const unique: MarkerMatch[] = [];

  for (const match of matches) {
    if (seenCodes.has(match.code)) {
      continue;
    }

    seenCodes.add(match.code);
    unique.push(match);
  }

  return unique;
}

function firstMatchLine(content: string, pattern: RegExp): number | null {
  const match = pattern.exec(content);
  if (match?.index === undefined) {
    return null;
  }

  return lineNumberAtIndex(content, match.index);
}

function lineNumberAtIndex(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/u).length;
}

function finding(code: Exclude<StaticLeakCode, "STATIC_SCAN_TARGET_UNSAFE">, path: string, line: number): StaticLeakFinding {
  return {
    severity: "error",
    code,
    path,
    line,
    message: `${messageForCode(code)}: ${path}.`,
    hint: PUBLICATION_HINT,
  };
}

function messageForCode(code: Exclude<StaticLeakCode, "STATIC_SCAN_TARGET_UNSAFE">): string {
  switch (code) {
    case "STATIC_UPLOAD_COMPONENT_LEAK":
      return "GitHub Pages static output contains upload component code";
    case "STATIC_UPLOAD_FORM_LEAK":
      return "GitHub Pages static output contains an upload form marker";
    case "STATIC_UPLOAD_ENDPOINT_LEAK":
      return "GitHub Pages static output references /api/raw-upload";
    case "STATIC_UPLOAD_TOKEN_LEAK":
      return "GitHub Pages static output contains local upload token metadata";
    case "STATIC_DAEMON_METADATA_LEAK":
      return "GitHub Pages static output contains local daemon metadata";
    case "STATIC_UPLOAD_ENDPOINT_CONFIG_LEAK":
      return "GitHub Pages static output contains upload endpoint configuration";
    case "STATIC_UPLOAD_AUTH_LEAK":
      return "GitHub Pages static output contains upload auth or signature markers";
    case "STATIC_RAW_INPUTS_LEAK":
      return "GitHub Pages static output contains raw input path metadata";
    case "STATIC_RAW_QUEUE_LEAK":
      return "GitHub Pages static output contains raw queue metadata";
    case "STATIC_PRIVATE_SOURCE_CARD_LEAK":
      return "GitHub Pages static output contains private source-card metadata";
    case "STATIC_REVIEW_PAGE_LEAK":
      return "GitHub Pages static output contains review-only page data";
    case "STATIC_SECRET_MARKER_LEAK":
      return "GitHub Pages static output contains a known secret marker";
  }
}

function unsafeTargetFinding(path: string): StaticLeakFinding {
  return {
    severity: "error",
    code: "STATIC_SCAN_TARGET_UNSAFE",
    path,
    message: `Static output scan target is unsafe: ${path}.`,
    hint: "Remove the symlink or replace it with a regular directory before publishing GitHub Pages output.",
  };
}

async function staticScanTargetSafety(repoRoot: string, path: string): Promise<"safe" | "missing" | "unsafe"> {
  const absoluteRepoRoot = resolve(repoRoot);
  const absoluteTarget = resolve(absoluteRepoRoot, path);
  if (!pathIsInsideRoot(absoluteRepoRoot, absoluteTarget)) {
    return "unsafe";
  }

  const relativeTarget = pathFromRoot(absoluteRepoRoot, absoluteTarget);
  const segments = relativeTarget.split("/").filter(Boolean);
  let currentPath = absoluteRepoRoot;
  for (const [index, segment] of segments.entries()) {
    currentPath = resolve(currentPath, segment);
    const state = await safeLstatAbsolute(currentPath);
    if (state === null) {
      return "missing";
    }

    if (state.isSymbolicLink()) {
      return "unsafe";
    }

    if (index < segments.length - 1 && !state.isDirectory()) {
      return "unsafe";
    }
  }

  return "safe";
}

function pathIsInsideRoot(absoluteRoot: string, absolutePath: string): boolean {
  const pathFromRootToTarget = relative(absoluteRoot, absolutePath);
  return pathFromRootToTarget === "" || (!pathFromRootToTarget.startsWith("..") && !isAbsolute(pathFromRootToTarget));
}

async function safeLstat(repoRoot: string, path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return safeLstatAbsolute(resolve(repoRoot, path));
}

async function safeLstatAbsolute(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return null;
    }

    throw error;
  }
}

function pathFromRoot(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function sortFindings(findings: StaticLeakFinding[]): StaticLeakFinding[] {
  return [...findings].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0) || left.code.localeCompare(right.code),
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
