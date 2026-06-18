import { execFile } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { computeContentHash } from "../scanner/index.js";
import { scanWikiRepository, type RepoMarkdownFile, type RepoScan } from "../scanner/repo.js";
import { createLinkResolutionIndex, lintWiki, resolveLinks } from "../lint/index.js";
import {
  isExploreProfileName,
  isPublicLikeProfile,
  readWikiProfile,
  selectMarkdownForProfile,
  shouldIgnorePublicSyncIssue,
  type ExploreProfileName,
  type WikiProfile,
} from "../profiles/index.js";
import { validateTextFileWriteInsideRoot, writeTextFileInsideRoot, type ScaffoldEntry } from "../utils/fs.js";

export type QuartzInstallResult = {
  attempted: boolean;
  ok: boolean;
  command: "cd quartz && npm install";
  cwd: string;
  stdout: string;
  stderr: string;
};

export type QuartzInitResult = {
  created_paths: string[];
  install: QuartzInstallResult;
};

export type QuartzSyncResult = {
  profile: ExploreProfileName;
  source_profile: string;
  content_root: "quartz/content";
  manifest_path: string;
  materialized_paths: string[];
  generated_paths: string[];
  excluded_paths: string[];
  warnings: string[];
};

export type QuartzManifest = {
  profile: ExploreProfileName;
  source_profile: string;
  content_root: "quartz/content";
  files: QuartzManifestFile[];
  generated_files: QuartzManifestGeneratedFile[];
  excluded_paths: string[];
};

export type QuartzManifestFile = {
  source_path: string;
  content_path: string;
  content_hash: string;
  page_type: string | null;
  title: string | null;
  visibility: string | null;
};

export type QuartzManifestGeneratedFile = {
  content_path: string;
  content_hash: string;
  title: string;
};

export type QuartzOperationErrorCode =
  | "PROFILE_INVALID"
  | "PROFILE_MISSING"
  | "PROFILE_UNSUPPORTED"
  | "PUBLIC_PROFILE_LEAK_CHECK_FAILED"
  | "QUARTZ_CONTENT_UNSAFE"
  | "QUARTZ_INSTALL_FAILED"
  | "QUARTZ_WRITE_FAILED";

export class QuartzOperationError extends Error {
  readonly code: QuartzOperationErrorCode;
  readonly hint: string;
  readonly path: string;

  constructor(options: { code: QuartzOperationErrorCode; message: string; hint: string; path: string }) {
    super(options.message);
    this.name = "QuartzOperationError";
    this.code = options.code;
    this.hint = options.hint;
    this.path = options.path;
  }
}

const INSTALL_COMMAND = "cd quartz && npm install" as const;
const EXPLORE_PROFILE_NAMES = ["local", "review", "public", "github-pages"] as const satisfies readonly ExploreProfileName[];
const QUARTZ_CONTENT_IGNORE_RULE = "quartz/content/";
const QUARTZ_CONTENT_IGNORE_PROBE = "quartz/content/.llm-wiki-sync-probe.md";
const QUARTZ_CONTENT_GITIGNORE_PATH = "quartz/content/.gitignore";
const QUARTZ_CONTENT_GITIGNORE_CONTENT = "*\n";
const VALID_VISIBILITIES = new Set(["private", "public"]);

export async function initializeQuartzRuntime(
  repoRoot: string,
  options: { install: boolean },
): Promise<{ data: QuartzInitResult; warnings: string[] }> {
  const entries = quartzRuntimeEntries();
  const createdPaths: string[] = [];
  const skippedPaths: string[] = [];
  for (const entry of entries) {
    if (await quartzRuntimeFileExists(repoRoot, entry.path)) {
      skippedPaths.push(entry.path);
      continue;
    }

    const writeResult = await writeTextFileInsideRoot(repoRoot, entry.path, entry.content);
    if (!writeResult.ok) {
      throw new QuartzOperationError({
        code: "QUARTZ_WRITE_FAILED",
        message: `Failed to write Quartz runtime file: ${entry.path}.`,
        path: entry.path,
        hint: writeResult.error.hint,
      });
    }
    createdPaths.push(entry.path);
  }

  const install = options.install ? await runNpmInstall(repoRoot) : skippedInstall(repoRoot);
  const warnings = [
    ...(skippedPaths.length > 0
      ? [`Existing Quartz runtime files were left unchanged: ${skippedPaths.sort().join(", ")}`]
      : []),
    ...(install.attempted ? [] : [`Quartz dependencies were not installed. Run: ${INSTALL_COMMAND}`]),
  ];

  return {
    data: {
      created_paths: createdPaths.sort(),
      install,
    },
    warnings,
  };
}

export async function syncQuartzContent(
  repoRoot: string,
  profileName: string,
): Promise<{ data: QuartzSyncResult; warnings: string[] }> {
  if (!isExploreProfileName(profileName)) {
    throw new QuartzOperationError({
      code: "PROFILE_UNSUPPORTED",
      message: `Unsupported Quartz sync profile: ${profileName}.`,
      path: "--profile",
      hint: "Use --profile local, review, public, or github-pages.",
    });
  }

  const publicLike = isPublicLikeProfile(profileName);
  if (publicLike) {
    await clearQuartzContent(repoRoot);
    await removeQuartzManifests(repoRoot);
  }

  const scan = await scanWikiRepository(repoRoot);
  const profileResult = await readWikiProfile(repoRoot, profileName);
  if (!profileResult.ok) {
    throw new QuartzOperationError({
      code: profileResult.error.code,
      message: profileResult.error.message,
      path: profileResult.error.path,
      hint: profileResult.error.hint,
    });
  }

  const profile = profileResult.value;
  const selection = selectMarkdownForProfile(profile, scan.markdown, scan.rawOriginals);
  const warnings = await ensureQuartzContentIgnored(repoRoot);
  if (publicLike) {
    await assertPublicSyncIsSafe(repoRoot, scan, profile, selection.markdown, selection.matchedMarkdown);
  } else {
    await clearQuartzContent(repoRoot);
    await removeQuartzManifests(repoRoot);
  }
  await ensureQuartzContentRoot(repoRoot);
  const staticReviewPages = publicLike ? [] : staticReviewPageDefinitions(profile, scan);
  const expectedContentPaths = [
    ...selection.markdown.map((file) => `quartz/content/${file.path}`),
    ...staticReviewPages.map((page) => page.path),
  ];
  warnings.push(...await ensureQuartzContentIgnoredByGit(repoRoot, expectedContentPaths));

  const manifestFiles = await materializeMarkdown(repoRoot, selection.markdown, selection.excludedRawOriginals);
  const generatedFiles = publicLike ? [] : await writeStaticReviewPages(repoRoot, staticReviewPages);
  const excludedPaths = publicLike ? [] : selection.excludedRawOriginals;
  const manifest: QuartzManifest = {
    profile: profileName,
    source_profile: profile.sourceName,
    content_root: "quartz/content",
    files: manifestFiles,
    generated_files: generatedFiles,
    excluded_paths: excludedPaths,
  };
  const manifestPath = `.llm-wiki/cache/quartz-manifest.${profileName}.json`;
  const manifestWrite = await writeTextFileInsideRoot(repoRoot, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!manifestWrite.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: `Failed to write Quartz manifest: ${manifestPath}.`,
      path: manifestPath,
      hint: manifestWrite.error.hint,
    });
  }

  const materializedPaths = manifestFiles.map((file) => file.content_path).sort();
  const generatedPaths = generatedFiles.map((file) => file.content_path).sort();

  return {
    data: {
      profile: profileName,
      source_profile: profile.sourceName,
      content_root: "quartz/content",
      manifest_path: manifestPath,
      materialized_paths: materializedPaths,
      generated_paths: generatedPaths,
      excluded_paths: excludedPaths,
      warnings,
    },
    warnings,
  };
}

async function assertPublicSyncIsSafe(
  repoRoot: string,
  scan: RepoScan,
  profile: WikiProfile,
  materializedFiles: readonly RepoMarkdownFile[],
  matchedFiles: readonly RepoMarkdownFile[],
): Promise<void> {
  const lintResult = await lintWiki(repoRoot, { profile: profile.sourceName, strict: true });
  const materializedPaths = new Set(materializedFiles.map((file) => file.path));
  const matchedPaths = new Set(matchedFiles.map((file) => file.path));
  const matchedMissingOrInvalidVisibilityPaths = new Set(
    matchedFiles.filter((file) => hasMissingOrInvalidVisibility(file)).map((file) => file.path),
  );
  const blockingIssue = lintResult.issues.find(
    (issue) =>
      issue.severity === "error" &&
      !shouldIgnorePublicSyncIssue(
        issue,
        materializedPaths,
        matchedPaths,
        matchedMissingOrInvalidVisibilityPaths,
      ),
  );
  if (blockingIssue) {
    throw new QuartzOperationError({
      code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
      message: `Public profile leak check failed: ${blockingIssue.rule_id}.`,
      path: blockingIssue.path,
      hint: blockingIssue.fix_hint,
    });
  }

  assertPublicLinksTargetMaterializedFiles(scan, materializedFiles);
}

function assertPublicLinksTargetMaterializedFiles(
  scan: RepoScan,
  materializedFiles: readonly RepoMarkdownFile[],
): void {
  const materializedPaths = new Set(materializedFiles.map((file) => file.path));
  const linkIndex = createLinkResolutionIndex(scan);

  for (const file of materializedFiles) {
    for (const resolution of resolveLinks(scan, file, linkIndex)) {
      const targetPath = resolution.resolved_path;
      if (targetPath === null || materializedPaths.has(targetPath) || !linkIndex.markdownByPath.has(targetPath)) {
        continue;
      }

      throw new QuartzOperationError({
        code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
        message: "Public profile leak check failed: public_quartz_link_target_excluded.",
        path: file.path,
        hint: `Include ${targetPath} in the public Quartz profile output or remove the link ${resolution.link.raw} from ${file.path}.`,
      });
    }
  }
}

function hasMissingOrInvalidVisibility(file: RepoMarkdownFile): boolean {
  const visibility = file.scan.frontmatter?.visibility;
  return typeof visibility !== "string" || !VALID_VISIBILITIES.has(visibility);
}

async function materializeMarkdown(
  repoRoot: string,
  files: readonly RepoMarkdownFile[],
  excludedRawOriginals: readonly string[],
): Promise<QuartzManifestFile[]> {
  const manifestFiles: QuartzManifestFile[] = [];
  const excludedRawOriginalSet = new Set(excludedRawOriginals);
  for (const file of files) {
    const contentPath = `quartz/content/${file.path}`;
    const content = quartzMaterializedMarkdownContent(file, excludedRawOriginalSet);
    const writeResult = await writeTextFileInsideRoot(repoRoot, contentPath, content);
    if (!writeResult.ok) {
      throw new QuartzOperationError({
        code: "QUARTZ_WRITE_FAILED",
        message: `Failed to materialize Quartz content: ${contentPath}.`,
        path: contentPath,
        hint: writeResult.error.hint,
      });
    }

    manifestFiles.push({
      source_path: file.path,
      content_path: contentPath,
      content_hash: computeContentHash(content),
      page_type: stringFrontmatterValue(file, "type"),
      title: stringFrontmatterValue(file, "title"),
      visibility: stringFrontmatterValue(file, "visibility"),
    });
  }

  return manifestFiles.sort((left, right) => left.source_path.localeCompare(right.source_path));
}

function quartzMaterializedMarkdownContent(file: RepoMarkdownFile, excludedRawOriginals: ReadonlySet<string>): string {
  if (!isRawSourceCard(file) || excludedRawOriginals.size === 0) {
    return file.content;
  }

  return file.content.replace(/!?\[\[((?:[^\]\n]|\](?!\]))+)\]\]/gu, (raw, body: string) => {
    const target = wikilinkTarget(body);
    if (!excludedRawOriginals.has(target)) {
      return raw;
    }

    return `\`${target}\` (excluded from Explorer sync)`;
  });
}

function isRawSourceCard(file: RepoMarkdownFile): boolean {
  return file.path.startsWith("raw/inputs/") && file.path.endsWith("/_source.md") && stringFrontmatterValue(file, "type") === "raw_source";
}

function wikilinkTarget(body: string): string {
  return (body.split("|")[0] ?? "").trim();
}

type StaticReviewPage = {
  path: string;
  title: string;
  content: string;
};

function staticReviewPageDefinitions(profile: WikiProfile, scan: RepoScan): StaticReviewPage[] {
  return [
    {
      path: "quartz/content/_llm-wiki/review/profile-summary.md",
      title: "Profile Summary",
      content: profileSummaryContent(profile, scan),
    },
    {
      path: "quartz/content/_llm-wiki/review/source-queue.md",
      title: "Source Queue",
      content: sourceQueueContent(scan),
    },
  ];
}

async function writeStaticReviewPages(
  repoRoot: string,
  pages: readonly StaticReviewPage[],
): Promise<QuartzManifestGeneratedFile[]> {
  for (const page of pages) {
    const writeResult = await writeTextFileInsideRoot(repoRoot, page.path, page.content);
    if (!writeResult.ok) {
      throw new QuartzOperationError({
        code: "QUARTZ_WRITE_FAILED",
        message: `Failed to write static review page: ${page.path}.`,
        path: page.path,
        hint: writeResult.error.hint,
      });
    }
  }

  return pages
    .map((page) => ({
      content_path: page.path,
      content_hash: computeContentHash(page.content),
      title: page.title,
    }))
    .sort((left, right) => left.content_path.localeCompare(right.content_path));
}

async function clearQuartzContent(repoRoot: string): Promise<void> {
  const validation = await validateTextFileWriteInsideRoot(repoRoot, "quartz/content/.llm-wiki-sync-probe");
  if (!validation.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_CONTENT_UNSAFE",
      message: "Quartz content path is not a safe generated directory.",
      path: "quartz/content",
      hint: validation.error.message,
    });
  }

  const contentPath = resolve(repoRoot, "quartz/content");
  try {
    const state = await lstat(contentPath);
    if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new QuartzOperationError({
        code: "QUARTZ_CONTENT_UNSAFE",
        message: "Quartz content path is not a safe generated directory.",
        path: "quartz/content",
        hint: "Replace quartz/content with a regular directory before syncing.",
      });
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    if (error instanceof QuartzOperationError) {
      throw error;
    }

    throw new QuartzOperationError({
      code: "QUARTZ_CONTENT_UNSAFE",
      message: "Could not inspect Quartz content directory.",
      path: "quartz/content",
      hint: "Fix filesystem permissions or unsafe paths before syncing Quartz content.",
    });
  }

  await rm(contentPath, { force: true, recursive: true });
}

async function ensureQuartzContentRoot(repoRoot: string): Promise<void> {
  const probePath = "quartz/content/.llm-wiki-sync-probe";
  const writeResult = await writeTextFileInsideRoot(repoRoot, probePath, "");
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to create Quartz content root.",
      path: "quartz/content",
      hint: writeResult.error.hint,
    });
  }

  try {
    await rm(resolve(repoRoot, probePath), { force: true });
  } catch (error) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to prepare Quartz content root.",
      path: "quartz/content",
      hint: error instanceof Error ? error.message : String(error),
    });
  }
}

async function removeQuartzManifest(repoRoot: string, profileName: ExploreProfileName): Promise<void> {
  const manifestPath = `.llm-wiki/cache/quartz-manifest.${profileName}.json`;
  const validation = await validateTextFileWriteInsideRoot(repoRoot, manifestPath);
  if (!validation.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: `Failed to remove Quartz manifest: ${manifestPath}.`,
      path: manifestPath,
      hint: validation.error.hint,
    });
  }

  await rm(resolve(repoRoot, manifestPath), { force: true });
}

async function removeQuartzManifests(repoRoot: string): Promise<void> {
  for (const profileName of EXPLORE_PROFILE_NAMES) {
    await removeQuartzManifest(repoRoot, profileName);
  }
}

async function ensureQuartzContentIgnored(repoRoot: string): Promise<string[]> {
  const gitignorePath = ".gitignore";
  const content = await readOptionalTextFile(repoRoot, gitignorePath);
  const hasExplicitRule = hasGitignoreLine(content, QUARTZ_CONTENT_IGNORE_RULE);
  if (hasExplicitRule && isQuartzContentEffectivelyIgnored(content)) {
    return [];
  }

  const updatedContent = appendGitignoreLine(content, QUARTZ_CONTENT_IGNORE_RULE);
  if (!isQuartzContentEffectivelyIgnored(updatedContent)) {
    throw new QuartzOperationError({
      code: "QUARTZ_CONTENT_UNSAFE",
      message: "Generated Quartz content is not protected by .gitignore.",
      path: gitignorePath,
      hint: `Move ${QUARTZ_CONTENT_IGNORE_RULE} to the end of .gitignore or remove later negation rules before syncing.`,
    });
  }

  const writeResult = await writeTextFileInsideRoot(repoRoot, gitignorePath, updatedContent);
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to update generated Quartz ignore rule.",
      path: gitignorePath,
      hint: writeResult.error.hint,
    });
  }

  return [
    hasExplicitRule
      ? `Repaired overridden generated Quartz ignore rule: ${QUARTZ_CONTENT_IGNORE_RULE}`
      : `Added missing generated Quartz ignore rule: ${QUARTZ_CONTENT_IGNORE_RULE}`,
  ];
}

async function readOptionalTextFile(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(resolve(repoRoot, path), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: `Failed to inspect generated Quartz ignore rule: ${path}.`,
      path,
      hint: error instanceof Error ? error.message : String(error),
    });
  }
}

function hasGitignoreLine(content: string, line: string): boolean {
  return content.split(/\r?\n/u).some((entry) => entry.trim() === line);
}

function isQuartzContentEffectivelyIgnored(content: string): boolean {
  return ["quartz/content", "quartz/content/.llm-wiki-sync-probe.md"].every((path) =>
    isGitignorePathIgnored(content, path),
  );
}

function isGitignorePathIgnored(content: string, path: string): boolean {
  let ignored = false;
  for (const line of content.split(/\r?\n/u)) {
    const rule = parseGitignoreRule(line);
    if (rule && gitignorePatternMatches(rule.pattern, path)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

function parseGitignoreRule(line: string): { pattern: string; negated: boolean } | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return null;
  }

  const negated = trimmed.startsWith("!");
  const pattern = (negated ? trimmed.slice(1) : trimmed).replace(/^\/+/u, "");
  if (pattern === "") {
    return null;
  }

  return { pattern, negated };
}

function gitignorePatternMatches(pattern: string, path: string): boolean {
  const directoryPattern = pattern.endsWith("/");
  const normalizedPattern = directoryPattern ? pattern.slice(0, -1) : pattern;
  if (normalizedPattern === "") {
    return false;
  }

  if (directoryPattern) {
    const candidates = pathAncestorsAndSelf(path);
    if (!normalizedPattern.includes("/") && !hasGlob(normalizedPattern)) {
      return candidates.some((candidate) => pathBasename(candidate) === normalizedPattern);
    }

    if (hasGlob(normalizedPattern)) {
      const regex = gitignoreGlobToRegExp(normalizedPattern, !normalizedPattern.includes("/"));
      return candidates.some((candidate) => regex.test(candidate));
    }

    return candidates.some((candidate) => candidate === normalizedPattern);
  }

  if (!normalizedPattern.includes("/") && !hasGlob(normalizedPattern)) {
    return path.split("/").some((segment) => segment === normalizedPattern);
  }

  if (!hasGlob(normalizedPattern)) {
    return matchesPathOrDescendant(normalizedPattern, path);
  }

  return gitignoreGlobToRegExp(normalizedPattern, !normalizedPattern.includes("/")).test(path);
}

function matchesPathOrDescendant(pattern: string, path: string): boolean {
  return path === pattern || path.startsWith(`${pattern}/`);
}

function pathAncestorsAndSelf(path: string): string[] {
  const segments = path.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

function pathBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function hasGlob(pattern: string): boolean {
  return /[*?]/u.test(pattern);
}

function gitignoreGlobToRegExp(pattern: string, basenameMatch: boolean): RegExp {
  let source = basenameMatch ? "(?:^|/)" : "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char);
  }

  source += "$";
  return new RegExp(source, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function appendGitignoreLine(content: string, line: string): string {
  if (content === "") {
    return `${line}\n`;
  }

  return `${content.endsWith("\n") ? content : `${content}\n`}${line}\n`;
}

async function ensureQuartzContentIgnoredByGit(repoRoot: string, contentPaths: readonly string[]): Promise<string[]> {
  const unsafePath = await firstUnignoredGitPath(repoRoot, contentPaths);
  if (unsafePath === null) {
    return [];
  }

  const writeResult = await writeTextFileInsideRoot(
    repoRoot,
    QUARTZ_CONTENT_GITIGNORE_PATH,
    QUARTZ_CONTENT_GITIGNORE_CONTENT,
  );
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to write generated Quartz content ignore override.",
      path: QUARTZ_CONTENT_GITIGNORE_PATH,
      hint: writeResult.error.hint,
    });
  }

  const repairedUnsafePath = await firstUnignoredGitPath(repoRoot, contentPaths);
  if (repairedUnsafePath !== null) {
    throw new QuartzOperationError({
      code: "QUARTZ_CONTENT_UNSAFE",
      message: "Generated Quartz content is not protected by Git ignore rules.",
      path: repairedUnsafePath,
      hint: "Remove nested .gitignore negation rules that re-include quartz/content/** before syncing.",
    });
  }

  return [`Added content-level generated Quartz ignore override: ${QUARTZ_CONTENT_GITIGNORE_PATH}`];
}

async function firstUnignoredGitPath(repoRoot: string, paths: readonly string[]): Promise<string | null> {
  for (const path of gitIgnoreProbePaths(paths)) {
    const ignored = await gitCheckIgnore(repoRoot, path);
    if (ignored === null) {
      return null;
    }

    if (!ignored) {
      return path;
    }
  }

  return null;
}

function gitIgnoreProbePaths(paths: readonly string[]): string[] {
  const uniquePaths = new Set(paths.length === 0 ? [QUARTZ_CONTENT_IGNORE_PROBE] : paths);
  return [...uniquePaths].sort();
}

async function gitCheckIgnore(repoRoot: string, path: string): Promise<boolean | null> {
  const inWorkTree = await isGitWorkTree(repoRoot);
  if (!inWorkTree) {
    return null;
  }

  return new Promise((resolveCheck, rejectCheck) => {
    execFile("git", ["check-ignore", "-q", "--", path], { cwd: repoRoot }, (error) => {
      if (!error) {
        resolveCheck(true);
        return;
      }

      if (isProcessExitCode(error, 1)) {
        resolveCheck(false);
        return;
      }

      rejectCheck(
        new QuartzOperationError({
          code: "QUARTZ_CONTENT_UNSAFE",
          message: "Could not verify generated Quartz Git ignore protection.",
          path,
          hint: error instanceof Error ? error.message : "Fix Git ignore configuration before syncing Quartz content.",
        }),
      );
    });
  });
}

async function isGitWorkTree(repoRoot: string): Promise<boolean> {
  return new Promise((resolveCheck, rejectCheck) => {
    execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot }, (error, stdout = "") => {
      if (!error) {
        resolveCheck(stdout.trim() === "true");
        return;
      }

      if (isProcessExitCode(error, 128)) {
        resolveCheck(false);
        return;
      }

      if (isNodeError(error) && error.code === "ENOENT") {
        resolveCheck(false);
        return;
      }

      rejectCheck(
        new QuartzOperationError({
          code: "QUARTZ_CONTENT_UNSAFE",
          message: "Could not inspect Git worktree state before Quartz sync.",
          path: ".git",
          hint: error instanceof Error ? error.message : "Fix Git availability before syncing Quartz content.",
        }),
      );
    });
  });
}

async function quartzRuntimeFileExists(repoRoot: string, path: string): Promise<boolean> {
  const validation = await validateTextFileWriteInsideRoot(repoRoot, path);
  if (!validation.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: `Failed to inspect Quartz runtime file: ${path}.`,
      path,
      hint: validation.error.message,
    });
  }

  try {
    const state = await lstat(resolve(repoRoot, path));
    if (state.isFile()) {
      return true;
    }

    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: `Quartz runtime path is not a regular file: ${path}.`,
      path,
      hint: "Move the existing path aside before initializing the Quartz runtime.",
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    if (error instanceof QuartzOperationError) {
      throw error;
    }

    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: `Failed to inspect Quartz runtime file: ${path}.`,
      path,
      hint: error instanceof Error ? error.message : String(error),
    });
  }
}

function skippedInstall(repoRoot: string): QuartzInstallResult {
  return {
    attempted: false,
    ok: false,
    command: INSTALL_COMMAND,
    cwd: resolve(repoRoot, "quartz"),
    stdout: "",
    stderr: "",
  };
}

async function runNpmInstall(repoRoot: string): Promise<QuartzInstallResult> {
  const cwd = resolve(repoRoot, "quartz");

  return new Promise((resolveInstall, rejectInstall) => {
    execFile("npm", ["install"], { cwd }, (error, stdout = "", stderr = "") => {
      if (error) {
        rejectInstall(
          new QuartzOperationError({
            code: "QUARTZ_INSTALL_FAILED",
            message: "Quartz dependency install failed.",
            path: "quartz/package.json",
            hint: `Run ${INSTALL_COMMAND} after fixing the package manager error.`,
          }),
        );
        return;
      }

      resolveInstall({
        attempted: true,
        ok: true,
        command: INSTALL_COMMAND,
        cwd,
        stdout,
        stderr,
      });
    });
  });
}

function quartzRuntimeEntries(): ScaffoldEntry[] {
  return [
    { path: "quartz/README.md", content: quartzReadmeContent() },
    { path: "quartz/components/LlmWikiQueueDashboard.tsx", content: componentPlaceholder("llm-wiki-queue-dashboard") },
    { path: "quartz/components/LlmWikiReviewPanel.tsx", content: componentPlaceholder("llm-wiki-review-panel") },
    { path: "quartz/components/LlmWikiSourceBadge.tsx", content: componentPlaceholder("llm-wiki-source-badge") },
    { path: "quartz/components/LlmWikiUploadForm.tsx", content: componentPlaceholder("llm-wiki-upload-form") },
    { path: "quartz/components/LlmWikiVisibilityWarning.tsx", content: componentPlaceholder("llm-wiki-visibility-warning") },
    { path: "quartz/package.json", content: quartzPackageJsonContent() },
    { path: "quartz/quartz.config.ts", content: quartzConfigContent() },
    { path: "quartz/quartz.layout.ts", content: quartzLayoutContent() },
  ].sort((left, right) => left.path.localeCompare(right.path));
}

function quartzPackageJsonContent(): string {
  return `${JSON.stringify(
    {
      private: true,
      type: "module",
      scripts: {
        build: "quartz build",
        serve: "quartz build --serve",
      },
      dependencies: {},
      devDependencies: {},
    },
    null,
    2,
  )}\n`;
}

function quartzConfigContent(): string {
  return `// LLM Wiki Quartz placeholder.
// Replace this file with a full Quartz config when wiring the upstream Quartz runtime.
export default {
  configuration: {
    pageTitle: "LLM Wiki",
  },
  plugins: {},
};
`;
}

function quartzLayoutContent(): string {
  return `// LLM Wiki Quartz layout placeholder.
export const defaultContentPageLayout = {
  beforeBody: [],
  left: [],
  right: [],
};
`;
}

function componentPlaceholder(className: string): string {
  return `export function Component() {
  return <div className="${className}" />;
}
`;
}

function quartzReadmeContent(): string {
  return `# Quartz Runtime

This directory contains LLM Wiki generated Quartz placeholders.

Install dependencies:

\`\`\`bash
cd quartz && npm install
\`\`\`

Sync content with:

\`\`\`bash
llm-wiki explore sync --profile local
\`\`\`
`;
}

function profileSummaryContent(profile: WikiProfile, scan: RepoScan): string {
  return `---
type: dashboard
title: Profile Summary
visibility: private
source_ids: []
---

# Profile Summary

| Field | Value |
|---|---|
| Profile | ${escapeTableCell(profile.requestedName)} |
| Source profile | ${escapeTableCell(profile.sourceName)} |
| Markdown pages | ${scan.markdown.length} |
| Queue items | ${scan.queueItems.length} |
| Raw source cards | ${scan.sourceCards.length} |
`;
}

function sourceQueueContent(scan: RepoScan): string {
  const rows = scan.queueItems.map((queueFile) =>
    [
      queueFile.item.source_id,
      queueFile.item.title,
      queueFile.item.status,
      queueFile.item.kind,
      queueFile.item.path,
    ].map((value) => escapeTableCell(String(value))).join(" | "),
  );

  return `---
type: dashboard
title: Source Queue
visibility: private
source_ids: []
---

# Source Queue

| Source ID | Title | Status | Kind | Source card |
|---|---|---|---|---|
${rows.map((row) => `| ${row} |`).join("\n")}
`;
}

function stringFrontmatterValue(file: RepoMarkdownFile, field: string): string | null {
  const value = file.scan.frontmatter?.[field];
  return typeof value === "string" ? value : null;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProcessExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
