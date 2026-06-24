import { execFile } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { stringify } from "yaml";

import {
  deployProfileBaseUrlError,
  deployProfileCustomDomainBaseUrlError,
  deployProfileCustomDomainError,
} from "../deploy/profileValidation.js";
import { computeContentHash } from "../scanner/index.js";
import { scanWikiRepository, type RepoMarkdownFile, type RepoScan } from "../scanner/repo.js";
import { createLinkResolutionIndex, lintWiki, resolveLinks, type LintResult } from "../lint/index.js";
import {
  isExploreProfileName,
  isPublicLikeProfile,
  readWikiProfile,
  selectMarkdownForProfile,
  shouldIgnorePublicSyncIssue,
  type ExploreProfileName,
  type WikiProfile,
} from "../profiles/index.js";
import { gitCommandEnv } from "../utils/git.js";
import { validateTextFileWriteInsideRoot, writeTextFileInsideRoot, type ScaffoldEntry } from "../utils/fs.js";
import { buildReviewDataModel, filterReviewScanForProfile, type ReviewCategory, type ReviewDataModel } from "./reviewData.js";

export { buildReviewDataModel, type ReviewDataModel } from "./reviewData.js";

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

export type QuartzSyncOptions = {
  preserveContentRoot?: boolean;
};

export type QuartzLocalDaemonRuntimeMetadata =
  | {
      enabled: true;
      url: string;
      upload_path: string;
      token_header: string;
      upload_token: string;
      commit_uploads: boolean;
      auto_ingest_available: boolean;
      updated_at?: string;
    }
  | {
      enabled: false;
      updated_at?: string;
    };

export type QuartzPublicSyncSafetyOptions = {
  lintResult?: LintResult;
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
  | "EXPLORER_STATE_WRITE_FAILED"
  | "PROFILE_INVALID"
  | "PROFILE_MISSING"
  | "PROFILE_UNSUPPORTED"
  | "PUBLIC_LINT_FAILED"
  | "PUBLIC_PROFILE_LEAK_CHECK_FAILED"
  | "QUARTZ_COMMAND_FAILED"
  | "QUARTZ_CONTENT_UNSAFE"
  | "QUARTZ_DEPENDENCIES_MISSING"
  | "QUARTZ_INSTALL_FAILED"
  | "QUARTZ_RUNTIME_MISSING"
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
const QUARTZ_VERSION = "4.5.2" as const;
const EXPLORE_PROFILE_NAMES = ["local", "review", "public", "github-pages"] as const satisfies readonly ExploreProfileName[];
const QUARTZ_CONTENT_IGNORE_RULE = "quartz/content/";
const QUARTZ_CONTENT_IGNORE_PROBE = "quartz/content/.llm-wiki-sync-probe.md";
const QUARTZ_CONTENT_GITIGNORE_PATH = "quartz/content/.gitignore";
const QUARTZ_CONTENT_GITIGNORE_CONTENT = "*\n";
const QUARTZ_CONFIG_PATH = "quartz/quartz.config.ts";
const QUARTZ_GENERATED_BASE_URL_MARKER = "// llm-wiki generated baseUrl";
export const GITHUB_PAGES_CNAME_CACHE_PATH = ".llm-wiki/cache/github-pages-CNAME";
const QUARTZ_BUILD_HOMEPAGE_SOURCE_PATH = "curated/index.md";
const QUARTZ_BUILD_HOMEPAGE_CONTENT_PATH = "quartz/content/index.md";
const QUARTZ_LOCAL_DAEMON_RUNTIME_METADATA_PATH = "quartz/content/_llm-wiki/runtime/local-daemon.json";
const QUARTZ_UPLOAD_FORM_COMPONENT_PATH = "quartz/components/LlmWikiUploadForm.tsx";
const QUARTZ_LAYOUT_COMPONENTS = [
  {
    path: "quartz/components/LlmWikiQueueDashboard.tsx",
    componentName: "LlmWikiQueueDashboard",
    className: "llm-wiki-queue-dashboard",
  },
  {
    path: "quartz/components/LlmWikiReviewPanel.tsx",
    componentName: "LlmWikiReviewPanel",
    className: "llm-wiki-review-panel",
  },
  {
    path: "quartz/components/LlmWikiSourceBadge.tsx",
    componentName: "LlmWikiSourceBadge",
    className: "llm-wiki-source-badge",
  },
  {
    path: QUARTZ_UPLOAD_FORM_COMPONENT_PATH,
    componentName: "LlmWikiUploadForm",
    className: "llm-wiki-upload-form",
  },
  {
    path: "quartz/components/LlmWikiVisibilityWarning.tsx",
    componentName: "LlmWikiVisibilityWarning",
    className: "llm-wiki-visibility-warning",
  },
] as const;
const QUARTZ_PARENT_GITIGNORE_PATH = "quartz/.gitignore";
const QUARTZ_PARENT_CONTENT_IGNORE_RULE = "content/";
const QUARTZ_RUNTIME_IGNORE_RULE = "quartz/quartz/";
const QUARTZ_RUNTIME_IGNORE_PROBE = "quartz/quartz/.llm-wiki-runtime-probe";
const QUARTZ_RUNTIME_IGNORE_PROBE_PATHS = [
  QUARTZ_RUNTIME_IGNORE_PROBE,
  "quartz/quartz/build.ts",
  "quartz/quartz/components/index.ts",
  "quartz/quartz/plugins/index.ts",
] as const;
const QUARTZ_PARENT_RUNTIME_IGNORE_RULE = "quartz/";
const VALID_VISIBILITIES = new Set(["private", "public"]);

type QuartzConfigurationBlock = {
  closeBraceIndex: number;
  openBraceIndex: number;
  openingLineEnd: number;
  propertyIndent: string;
};

type QuartzConfigObjectBlock = {
  closeBraceIndex: number;
  openBraceIndex: number;
  openingLineEnd: number;
};

const OLD_PLACEHOLDER_QUARTZ_PACKAGE_JSON = `${JSON.stringify(
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
const OLD_PLACEHOLDER_QUARTZ_README = `# Quartz Runtime

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
const OLD_PLACEHOLDER_QUARTZ_CONFIG = `// LLM Wiki Quartz placeholder.
// Replace this file with a full Quartz config when wiring the upstream Quartz runtime.
export default {
  configuration: {
    pageTitle: "LLM Wiki",
  },
  plugins: {},
};
`;
const OLD_PLACEHOLDER_QUARTZ_LAYOUT = `// LLM Wiki Quartz layout placeholder.
export const defaultContentPageLayout = {
  beforeBody: [],
  left: [],
  right: [],
};
`;

export async function initializeQuartzRuntime(
  repoRoot: string,
  options: { install: boolean },
): Promise<{ data: QuartzInitResult; warnings: string[] }> {
  const entries = quartzRuntimeEntries();
  const createdPaths: string[] = [];
  const updatedPaths: string[] = [];
  const skippedPaths: string[] = [];
  for (const entry of entries) {
    if (await quartzRuntimeFileExists(repoRoot, entry.path)) {
      const migrationContent = await quartzRuntimeEntryMigrationContent(repoRoot, entry);
      if (migrationContent !== null) {
        await writeQuartzRuntimeEntry(repoRoot, { ...entry, content: migrationContent });
        updatedPaths.push(entry.path);
        continue;
      }

      skippedPaths.push(entry.path);
      continue;
    }

    await writeQuartzRuntimeEntry(repoRoot, entry);
    createdPaths.push(entry.path);
  }

  const ignoreWarnings = await ensureQuartzRuntimeIgnored(repoRoot);
  const install = options.install ? await runNpmInstall(repoRoot) : skippedInstall(repoRoot);
  const warnings = [
    ...ignoreWarnings,
    ...(skippedPaths.length > 0
      ? [`Existing Quartz runtime files were left unchanged: ${skippedPaths.sort().join(", ")}`]
      : []),
    ...(updatedPaths.length > 0
      ? [`Updated generated Quartz runtime files: ${updatedPaths.sort().join(", ")}`]
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
  options: QuartzSyncOptions = {},
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
  const preserveContentRoot = options.preserveContentRoot === true;

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
  assertGitHubPagesDeployProfileFieldsValid(profile);
  await applyProfileBaseUrlToQuartzConfig(repoRoot, profile);
  await applyProfileCustomDomainToGitHubPagesCname(repoRoot, profile);
  const selection = selectMarkdownForProfile(profile, scan.markdown, scan.rawOriginals);
  const warnings = await ensureQuartzContentIgnored(repoRoot);
  if (publicLike) {
    await assertPublicSyncIsSafe(repoRoot, scan, profile, selection.markdown, selection.matchedMarkdown);
    if (!preserveContentRoot) {
      await clearQuartzContent(repoRoot);
      await removeQuartzManifests(repoRoot);
    }
  } else if (!preserveContentRoot) {
    await clearQuartzContent(repoRoot);
    await removeQuartzManifests(repoRoot);
  }
  await ensureQuartzContentRoot(repoRoot);
  const localRootMaterializedPages = publicLike
    ? []
    : localRootMaterializedPageDefinitions(selection.markdown, selection.excludedRawOriginals);
  const privateExplorerPages = publicLike
    ? []
    : localExplorerPageDefinitions(profile, scan, selection.markdown);
  const buildHomepagePages = publicLike
    ? quartzBuildHomepageDefinitions(selection.markdown, selection.excludedRawOriginals)
    : [];
  const generatedPages = [...privateExplorerPages, ...buildHomepagePages];
  const expectedContentPaths = [
    ...selection.markdown.map((file) => `quartz/content/${file.path}`),
    ...localRootMaterializedPages.map((page) => page.path),
    ...generatedPages.map((page) => page.path),
  ];
  const ignoreCheckedContentPaths = publicLike
    ? expectedContentPaths
    : [...expectedContentPaths, QUARTZ_LOCAL_DAEMON_RUNTIME_METADATA_PATH];
  warnings.push(...await ensureQuartzContentIgnoredByGit(repoRoot, ignoreCheckedContentPaths));

  const previousContentPaths = preserveContentRoot ? await readQuartzManifestContentPaths(repoRoot, profileName) : [];
  const manifestFiles = [
    ...await materializeMarkdown(repoRoot, selection.markdown, selection.excludedRawOriginals),
    ...await writeMaterializedPages(repoRoot, localRootMaterializedPages),
  ].sort(compareQuartzManifestFiles);
  const generatedFiles = await writeGeneratedPages(repoRoot, generatedPages);
  if (previousContentPaths.length > 0) {
    await removeStaleQuartzContent(repoRoot, previousContentPaths, new Set(expectedContentPaths));
  }

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

export async function writeLocalDaemonRuntimeMetadata(
  repoRoot: string,
  metadata: QuartzLocalDaemonRuntimeMetadata,
): Promise<void> {
  const runtimeMetadata = metadata.enabled
    ? metadata
    : {
        enabled: false,
        updated_at: metadata.updated_at,
      };
  const content = `${JSON.stringify(
    {
      ...runtimeMetadata,
      updated_at: metadata.updated_at ?? new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
  const writeResult = await writeTextFileInsideRoot(repoRoot, QUARTZ_LOCAL_DAEMON_RUNTIME_METADATA_PATH, content);
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to write local daemon runtime metadata.",
      path: QUARTZ_LOCAL_DAEMON_RUNTIME_METADATA_PATH,
      hint: writeResult.error.hint,
    });
  }
}

export async function writeDisabledLocalDaemonRuntimeMetadataIfCurrent(
  repoRoot: string,
  expected: Pick<Extract<QuartzLocalDaemonRuntimeMetadata, { enabled: true }>, "url" | "upload_token">,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(resolve(repoRoot, QUARTZ_LOCAL_DAEMON_RUNTIME_METADATA_PATH), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to inspect local daemon runtime metadata.",
      path: QUARTZ_LOCAL_DAEMON_RUNTIME_METADATA_PATH,
      hint: error instanceof Error ? error.message : String(error),
    });
  }

  if (!localDaemonRuntimeMetadataMatches(content, expected)) {
    return;
  }

  await writeLocalDaemonRuntimeMetadata(repoRoot, { enabled: false });
}

async function readQuartzManifestContentPaths(
  repoRoot: string,
  profileName: ExploreProfileName,
): Promise<string[]> {
  try {
    const content = await readFile(resolve(repoRoot, `.llm-wiki/cache/quartz-manifest.${profileName}.json`), "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return [];
    }

    return [
      ...manifestEntryContentPaths(parsed.files),
      ...manifestEntryContentPaths(parsed.generated_files),
    ];
  } catch (error) {
    if (
      (isNodeError(error) && error.code === "ENOENT") ||
      error instanceof SyntaxError
    ) {
      return [];
    }

    throw error;
  }
}

export async function assertPublicQuartzSyncSafety(
  repoRoot: string,
  profileName: string,
  options: QuartzPublicSyncSafetyOptions = {},
): Promise<void> {
  if (!isExploreProfileName(profileName) || !isPublicLikeProfile(profileName)) {
    throw new QuartzOperationError({
      code: "PROFILE_UNSUPPORTED",
      message: `Unsupported public Quartz sync profile: ${profileName}.`,
      path: "--profile",
      hint: "Use --profile public or github-pages for public sync safety checks.",
    });
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
  await assertPublicSyncIsSafe(
    repoRoot,
    scan,
    profile,
    selection.markdown,
    selection.matchedMarkdown,
    options.lintResult,
  );
}

export async function assertPublicQuartzBuildPreflight(
  repoRoot: string,
  profileName: string,
  options: QuartzPublicSyncSafetyOptions = {},
): Promise<void> {
  if (!isExploreProfileName(profileName) || !isPublicLikeProfile(profileName)) {
    throw new QuartzOperationError({
      code: "PROFILE_UNSUPPORTED",
      message: `Unsupported public Quartz build profile: ${profileName}.`,
      path: "--profile",
      hint: "Use --profile public or github-pages for public Quartz build preflight checks.",
    });
  }

  await assertQuartzContentRootCanSync(repoRoot);

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
  await assertPublicSyncIsSafe(
    repoRoot,
    scan,
    profile,
    selection.markdown,
    selection.matchedMarkdown,
    options.lintResult,
  );
  assertQuartzBuildHomepageSelected(selection.markdown);
}

export async function assertProfileBaseUrlQuartzConfigCanSync(repoRoot: string, profileName: string): Promise<void> {
  if (!isExploreProfileName(profileName)) {
    throw new QuartzOperationError({
      code: "PROFILE_UNSUPPORTED",
      message: `Unsupported Quartz sync profile: ${profileName}.`,
      path: "--profile",
      hint: "Use --profile local, review, public, or github-pages.",
    });
  }

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
  assertGitHubPagesDeployProfileFieldsValid(profile);
  await validatedQuartzConfigBaseUrlUpdate(repoRoot, profile);
  await validateGitHubPagesCnameCacheTarget(repoRoot, profile);
}

function assertGitHubPagesDeployProfileFieldsValid(profile: WikiProfile): void {
  if (profile.requestedName !== "github-pages") {
    return;
  }

  const error =
    deployProfileBaseUrlError(profile.baseUrl, profile.path) ??
    deployProfileCustomDomainError(profile.customDomain, profile.path) ??
    deployProfileCustomDomainBaseUrlError(profile.baseUrl, profile.customDomain, profile.path);
  if (error === null) {
    return;
  }

  throw new QuartzOperationError({
    code: error.code,
    message: error.message,
    path: error.path,
    hint: error.hint,
  });
}

async function removeStaleQuartzContent(
  repoRoot: string,
  previousPaths: readonly string[],
  expectedContentPaths: ReadonlySet<string>,
): Promise<void> {
  for (const path of previousPaths) {
    if (expectedContentPaths.has(path)) {
      continue;
    }

    if (!path.startsWith("quartz/content/")) {
      continue;
    }

    const validation = await validateTextFileWriteInsideRoot(repoRoot, path);
    if (!validation.ok) {
      throw new QuartzOperationError({
        code: "QUARTZ_WRITE_FAILED",
        message: `Failed to remove stale Quartz content: ${path}.`,
        path,
        hint: validation.error.hint,
      });
    }

    await rm(resolve(repoRoot, path), { force: true });
  }
}

function manifestEntryContentPaths(entries: unknown): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.flatMap((entry) =>
    isRecord(entry) && typeof entry.content_path === "string" ? [entry.content_path] : [],
  );
}

async function assertPublicSyncIsSafe(
  repoRoot: string,
  scan: RepoScan,
  profile: WikiProfile,
  materializedFiles: readonly RepoMarkdownFile[],
  matchedFiles: readonly RepoMarkdownFile[],
  lintResult?: LintResult,
): Promise<void> {
  const publicLintResult = lintResult ?? await lintWiki(repoRoot, { profile: profile.sourceName, strict: true });
  const materializedPaths = new Set(materializedFiles.map((file) => file.path));
  const matchedPaths = new Set(matchedFiles.map((file) => file.path));
  const matchedMissingOrInvalidVisibilityPaths = new Set(
    matchedFiles.filter((file) => hasMissingOrInvalidVisibility(file)).map((file) => file.path),
  );
  const blockingIssue = publicLintResult.issues.find(
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

async function writeMaterializedPages(
  repoRoot: string,
  pages: readonly StaticMaterializedPage[],
): Promise<QuartzManifestFile[]> {
  const manifestFiles: QuartzManifestFile[] = [];
  for (const page of pages) {
    const writeResult = await writeTextFileInsideRoot(repoRoot, page.path, page.content);
    if (!writeResult.ok) {
      throw new QuartzOperationError({
        code: "QUARTZ_WRITE_FAILED",
        message: `Failed to materialize Quartz content: ${page.path}.`,
        path: page.path,
        hint: writeResult.error.hint,
      });
    }

    manifestFiles.push(manifestFileForContent(page.source, page.path, page.content));
  }

  return manifestFiles.sort(compareQuartzManifestFiles);
}

function manifestFileForContent(file: RepoMarkdownFile, contentPath: string, content: string): QuartzManifestFile {
  return {
    source_path: file.path,
    content_path: contentPath,
    content_hash: computeContentHash(content),
    page_type: stringFrontmatterValue(file, "type"),
    title: stringFrontmatterValue(file, "title"),
    visibility: stringFrontmatterValue(file, "visibility"),
  };
}

function compareQuartzManifestFiles(left: QuartzManifestFile, right: QuartzManifestFile): number {
  return left.content_path.localeCompare(right.content_path) || left.source_path.localeCompare(right.source_path);
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

type StaticMaterializedPage = StaticReviewPage & {
  source: RepoMarkdownFile;
};

function localExplorerPageDefinitions(
  profile: WikiProfile,
  scan: RepoScan,
  files: readonly RepoMarkdownFile[],
): StaticReviewPage[] {
  const reviewScan = filterReviewScanForProfile(scan, profile);
  const reviewData = buildReviewDataModel(scan, {
    profile,
    materializedMarkdownPaths: new Set(files.map((file) => file.path)),
  });
  const fallbackHomepage = localGeneratedHomepageDefinition(files);

  return [
    ...(fallbackHomepage === null ? [] : [fallbackHomepage]),
    {
      path: "quartz/content/_llm-wiki/upload.md",
      title: "Upload",
      content: uploadPageContent(),
    },
    {
      path: "quartz/content/_llm-wiki/review/overview.md",
      title: "Review Overview",
      content: reviewOverviewContent(reviewData),
    },
    {
      path: "quartz/content/_llm-wiki/review/profile-summary.md",
      title: "Profile Summary",
      content: profileSummaryContent(reviewData, reviewScan),
    },
    {
      path: "quartz/content/_llm-wiki/review/source-queue.md",
      title: "Source Queue",
      content: sourceQueueContent(reviewData),
    },
    {
      path: "quartz/content/_llm-wiki/review/recent-ingests.md",
      title: "Recent Ingests",
      content: reviewCategoryContent({
        title: "Recent Ingests",
        component: "LlmWikiReviewPanel",
        category: reviewData.recent_ingests,
      }),
    },
    {
      path: "quartz/content/_llm-wiki/review/needs-review.md",
      title: "Needs Review",
      content: reviewCategoryContent({
        title: "Needs Review",
        component: "LlmWikiReviewPanel",
        category: reviewData.needs_review,
      }),
    },
    {
      path: "quartz/content/_llm-wiki/review/contradictions.md",
      title: "Contradictions",
      content: reviewCategoryContent({
        title: "Contradictions",
        component: "LlmWikiReviewPanel",
        category: reviewData.contradictions,
      }),
    },
    {
      path: "quartz/content/_llm-wiki/review/orphans.md",
      title: "Orphans",
      content: reviewCategoryContent({
        title: "Orphans",
        component: "LlmWikiReviewPanel",
        category: reviewData.orphans,
      }),
    },
    {
      path: "quartz/content/_llm-wiki/review/stale-pages.md",
      title: "Stale Pages",
      content: reviewCategoryContent({
        title: "Stale Pages",
        component: "LlmWikiReviewPanel",
        category: reviewData.stale_pages,
      }),
    },
    {
      path: "quartz/content/_llm-wiki/review/visibility-warnings.md",
      title: "Visibility Warnings",
      content: reviewCategoryContent({
        title: "Visibility Warnings",
        component: "LlmWikiVisibilityWarning",
        category: reviewData.visibility_warnings,
      }),
    },
    {
      path: "quartz/content/_llm-wiki/review/status.md",
      title: "Review Status",
      content: reviewStatusContent(reviewData),
    },
  ];
}

function localRootMaterializedPageDefinitions(
  files: readonly RepoMarkdownFile[],
  excludedRawOriginals: readonly string[],
): StaticMaterializedPage[] {
  if (files.some(materializesToQuartzBuildHomepage)) {
    return [];
  }

  const source = files.find((file) => file.path === QUARTZ_BUILD_HOMEPAGE_SOURCE_PATH);
  if (source !== undefined) {
    return [
      {
        source,
        path: QUARTZ_BUILD_HOMEPAGE_CONTENT_PATH,
        title: stringFrontmatterValue(source, "title") ?? "Index",
        content: quartzMaterializedMarkdownContent(source, new Set(excludedRawOriginals)),
      },
    ];
  }

  return [];
}

function localGeneratedHomepageDefinition(files: readonly RepoMarkdownFile[]): StaticReviewPage | null {
  if (
    files.some(materializesToQuartzBuildHomepage) ||
    files.some((file) => file.path === QUARTZ_BUILD_HOMEPAGE_SOURCE_PATH)
  ) {
    return null;
  }

  return {
    path: QUARTZ_BUILD_HOMEPAGE_CONTENT_PATH,
    title: "LLM Wiki Home",
    content: generatedLocalHomeContent(),
  };
}

function materializesToQuartzBuildHomepage(file: RepoMarkdownFile): boolean {
  return `quartz/content/${file.path}` === QUARTZ_BUILD_HOMEPAGE_CONTENT_PATH;
}

function quartzBuildHomepageDefinitions(
  files: readonly RepoMarkdownFile[],
  excludedRawOriginals: readonly string[],
): StaticReviewPage[] {
  const source = files.find((file) => file.path === QUARTZ_BUILD_HOMEPAGE_SOURCE_PATH);
  if (source === undefined) {
    return [];
  }

  return [
    {
      path: QUARTZ_BUILD_HOMEPAGE_CONTENT_PATH,
      title: stringFrontmatterValue(source, "title") ?? "Index",
      content: quartzMaterializedMarkdownContent(source, new Set(excludedRawOriginals)),
    },
  ];
}

async function writeGeneratedPages(
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
  await assertQuartzContentRootCanSync(repoRoot);
  await rm(resolve(repoRoot, "quartz/content"), { force: true, recursive: true });
}

async function assertQuartzContentRootCanSync(repoRoot: string): Promise<void> {
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
}

function assertQuartzBuildHomepageSelected(materializedFiles: readonly RepoMarkdownFile[]): void {
  if (materializedFiles.some((file) => file.path === QUARTZ_BUILD_HOMEPAGE_SOURCE_PATH)) {
    return;
  }

  throw new QuartzOperationError({
    code: "QUARTZ_CONTENT_UNSAFE",
    message: "GitHub Pages profile does not materialize curated/index.md for the Quartz build homepage.",
    path: QUARTZ_BUILD_HOMEPAGE_SOURCE_PATH,
    hint: "Make curated/index.md eligible for the github-pages profile before deploying; remove it from profile excludes and keep visibility: public.",
  });
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
  if (hasExplicitRule && areGitignorePathsIgnored(content, ["quartz/content", QUARTZ_CONTENT_IGNORE_PROBE])) {
    return [];
  }

  const updatedContent = appendGitignoreLine(content, QUARTZ_CONTENT_IGNORE_RULE);
  if (!areGitignorePathsIgnored(updatedContent, ["quartz/content", QUARTZ_CONTENT_IGNORE_PROBE])) {
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

async function ensureQuartzRuntimeIgnored(repoRoot: string): Promise<string[]> {
  const gitignorePath = ".gitignore";
  const content = await readOptionalTextFile(repoRoot, gitignorePath);
  const hasExplicitRule = hasGitignoreLine(content, QUARTZ_RUNTIME_IGNORE_RULE);
  const warnings: string[] = [];
  if (hasExplicitRule && areGitignorePathsIgnored(content, ["quartz/quartz", QUARTZ_RUNTIME_IGNORE_PROBE])) {
    warnings.push(...await ensureQuartzRuntimeIgnoredByGit(repoRoot));
    return warnings;
  }

  const updatedContent = appendGitignoreLine(content, QUARTZ_RUNTIME_IGNORE_RULE);
  if (!areGitignorePathsIgnored(updatedContent, ["quartz/quartz", QUARTZ_RUNTIME_IGNORE_PROBE])) {
    throw new QuartzOperationError({
      code: "QUARTZ_CONTENT_UNSAFE",
      message: "Generated Quartz runtime is not protected by .gitignore.",
      path: gitignorePath,
      hint: `Move ${QUARTZ_RUNTIME_IGNORE_RULE} to the end of .gitignore or remove later negation rules before installing Quartz dependencies.`,
    });
  }

  const writeResult = await writeTextFileInsideRoot(repoRoot, gitignorePath, updatedContent);
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to update generated Quartz runtime ignore rule.",
      path: gitignorePath,
      hint: writeResult.error.hint,
    });
  }

  warnings.push(
    hasExplicitRule
      ? `Repaired overridden generated Quartz ignore rule: ${QUARTZ_RUNTIME_IGNORE_RULE}`
      : `Added missing generated Quartz ignore rule: ${QUARTZ_RUNTIME_IGNORE_RULE}`,
  );
  warnings.push(...await ensureQuartzRuntimeIgnoredByGit(repoRoot));

  return warnings;
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

async function applyProfileBaseUrlToQuartzConfig(repoRoot: string, profile: WikiProfile): Promise<void> {
  const update = await validatedQuartzConfigBaseUrlUpdate(repoRoot, profile);
  if (update === null || update.updatedContent === update.content) {
    return;
  }

  const writeResult = await writeTextFileInsideRoot(repoRoot, QUARTZ_CONFIG_PATH, update.updatedContent);
  if (!writeResult.ok) {
    throw quartzConfigBaseUrlWriteError(writeResult.error.message, writeResult.error.hint);
  }
}

async function applyProfileCustomDomainToGitHubPagesCname(repoRoot: string, profile: WikiProfile): Promise<void> {
  if (profile.requestedName !== "github-pages") {
    return;
  }

  await validateGitHubPagesCnameCacheTarget(repoRoot, profile);

  if (profile.customDomain === null) {
    await rm(resolve(repoRoot, GITHUB_PAGES_CNAME_CACHE_PATH), { force: true });
    return;
  }

  const writeResult = await writeTextFileInsideRoot(repoRoot, GITHUB_PAGES_CNAME_CACHE_PATH, `${profile.customDomain}\n`);
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to write generated GitHub Pages CNAME cache.",
      path: GITHUB_PAGES_CNAME_CACHE_PATH,
      hint: writeResult.error.hint,
    });
  }
}

async function validateGitHubPagesCnameCacheTarget(repoRoot: string, profile: WikiProfile): Promise<void> {
  if (profile.requestedName !== "github-pages") {
    return;
  }

  const validation = await validateTextFileWriteInsideRoot(repoRoot, GITHUB_PAGES_CNAME_CACHE_PATH);
  if (!validation.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: profile.customDomain === null
        ? "Failed to remove generated GitHub Pages CNAME cache."
        : "Failed to write generated GitHub Pages CNAME cache.",
      path: GITHUB_PAGES_CNAME_CACHE_PATH,
      hint: validation.error.hint,
    });
  }
}

async function validatedQuartzConfigBaseUrlUpdate(
  repoRoot: string,
  profile: WikiProfile,
): Promise<{ content: string; updatedContent: string } | null> {
  if (profile.baseUrl !== null) {
    const writeValidation = await validateTextFileWriteInsideRoot(repoRoot, QUARTZ_CONFIG_PATH);
    if (!writeValidation.ok) {
      throw quartzConfigBaseUrlWriteError(writeValidation.error.message, writeValidation.error.hint);
    }
  }

  const update = await quartzConfigBaseUrlUpdate(repoRoot, profile);
  if (update === null || update.updatedContent === update.content) {
    return update;
  }

  const writeValidation = await validateTextFileWriteInsideRoot(repoRoot, QUARTZ_CONFIG_PATH);
  if (!writeValidation.ok) {
    throw quartzConfigBaseUrlWriteError(writeValidation.error.message, writeValidation.error.hint);
  }

  return update;
}

function quartzConfigBaseUrlWriteError(message: string, hint: string): QuartzOperationError {
  return new QuartzOperationError({
    code: "QUARTZ_WRITE_FAILED",
    message: `Failed to update Quartz config with GitHub Pages baseUrl: ${message}`,
    path: QUARTZ_CONFIG_PATH,
    hint,
  });
}

async function quartzConfigBaseUrlUpdate(
  repoRoot: string,
  profile: WikiProfile,
): Promise<{ content: string; updatedContent: string } | null> {
  let content: string;
  try {
    content = await readFile(resolve(repoRoot, QUARTZ_CONFIG_PATH), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      if (profile.baseUrl !== null) {
        throw new QuartzOperationError({
          code: "QUARTZ_WRITE_FAILED",
          message: "Quartz config is missing; cannot apply GitHub Pages baseUrl.",
          path: QUARTZ_CONFIG_PATH,
          hint: "Restore quartz/quartz.config.ts or rerun llm-wiki explore init before checking GitHub Pages deployment.",
        });
      }

      return null;
    }

    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to read Quartz config before applying GitHub Pages baseUrl.",
      path: QUARTZ_CONFIG_PATH,
      hint: error instanceof Error ? error.message : String(error),
    });
  }

  const updatedContent = profile.baseUrl === null
    ? clearQuartzConfigBaseUrl(content)
    : setQuartzConfigBaseUrl(content, quartzBaseUrlFromDeployBaseUrl(profile.baseUrl));
  return { content, updatedContent };
}

function clearQuartzConfigBaseUrl(content: string): string {
  return content.replace(/^\s*\/\/ llm-wiki generated baseUrl\s*\r?\n\s*baseUrl\s*:[^\r\n]*(?:\r?\n)?/mu, "");
}

function quartzBaseUrlFromDeployBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/u, "");
    return `${url.hostname}${path === "/" ? "" : path}`;
  } catch {
    return trimmed.replace(/^https?:\/\//u, "").replace(/^\/+|\/+$/gu, "");
  }
}

function setQuartzConfigBaseUrl(content: string, baseUrl: string): string {
  const baseUrlLine = `baseUrl: ${JSON.stringify(baseUrl)},`;
  const configurationBlock = findQuartzConfigurationBlock(content);
  if (configurationBlock !== null) {
    const generatedBaseUrl = replaceGeneratedQuartzConfigBaseUrl(content, configurationBlock, baseUrlLine);
    if (generatedBaseUrl !== null) {
      return generatedBaseUrl;
    }

    const existingBaseUrl = replaceExistingQuartzConfigBaseUrl(content, configurationBlock, baseUrlLine);
    if (existingBaseUrl !== null) {
      return existingBaseUrl;
    }

    const block = `${configurationBlock.propertyIndent}${QUARTZ_GENERATED_BASE_URL_MARKER}\n${configurationBlock.propertyIndent}${baseUrlLine}\n`;
    return `${content.slice(0, configurationBlock.openingLineEnd)}${block}${content.slice(configurationBlock.openingLineEnd)}`;
  }

  throw new QuartzOperationError({
    code: "QUARTZ_WRITE_FAILED",
    message: "Failed to locate Quartz configuration block for GitHub Pages baseUrl.",
    path: QUARTZ_CONFIG_PATH,
    hint: "Add a configuration: { ... } object to quartz/quartz.config.ts or regenerate the Quartz runtime before rerunning deploy sync.",
  });
}

function findQuartzConfigurationBlock(content: string): QuartzConfigurationBlock | null {
  const configBlock = findExportedQuartzConfigObjectBlock(content);
  if (configBlock === null) {
    return null;
  }

  const body = content.slice(configBlock.openingLineEnd, configBlock.closeBraceIndex);
  const configurationPattern = /^([ \t]*)configuration[ \t]*:[ \t]*\{[ \t]*$/gmu;
  let match: RegExpExecArray | null;
  while ((match = configurationPattern.exec(body)) !== null) {
    if (match.index === undefined) {
      continue;
    }

    const absoluteIndex = configBlock.openingLineEnd + match.index;
    if (braceDepthBeforeIndex(content, configBlock.openBraceIndex, absoluteIndex) !== 1) {
      continue;
    }

    const openBraceOffset = match[0].indexOf("{");
    const openBraceIndex = absoluteIndex + openBraceOffset;
    const closeBraceIndex = findMatchingBrace(content, openBraceIndex);
    if (closeBraceIndex === null || closeBraceIndex > configBlock.closeBraceIndex) {
      return null;
    }

    const lineEnd = absoluteIndex + match[0].length;
    const lineBreakLength = content.startsWith("\r\n", lineEnd) ? 2 : content.startsWith("\n", lineEnd) ? 1 : 0;
    return {
      closeBraceIndex,
      openBraceIndex,
      openingLineEnd: lineEnd + lineBreakLength,
      propertyIndent: `${match[1] ?? ""}  `,
    };
  }

  return null;
}

function findExportedQuartzConfigObjectBlock(content: string): QuartzConfigObjectBlock | null {
  const configPattern = /^([ \t]*)(export[ \t]+)?const[ \t]+([A-Za-z_$][\w$]*)[ \t]*:[ \t]*QuartzConfig[ \t]*=[ \t]*\{[ \t]*$/gmu;
  let match: RegExpExecArray | null;
  while ((match = configPattern.exec(content)) !== null) {
    if (match.index === undefined) {
      continue;
    }

    const name = match[3] ?? "";
    if ((match[2] === undefined || match[2] === "") && !isDefaultExportedConfigName(content, name)) {
      continue;
    }

    const openBraceOffset = match[0].indexOf("{");
    const openBraceIndex = match.index + openBraceOffset;
    const closeBraceIndex = findMatchingBrace(content, openBraceIndex);
    if (closeBraceIndex === null) {
      return null;
    }

    const lineEnd = match.index + match[0].length;
    const lineBreakLength = content.startsWith("\r\n", lineEnd) ? 2 : content.startsWith("\n", lineEnd) ? 1 : 0;
    return {
      closeBraceIndex,
      openBraceIndex,
      openingLineEnd: lineEnd + lineBreakLength,
    };
  }

  return null;
}

function isDefaultExportedConfigName(content: string, name: string): boolean {
  return new RegExp(`\\bexport\\s+default\\s+${escapeRegExp(name)}\\b`, "u").test(content);
}

function findMatchingBrace(content: string, openBraceIndex: number): number | null {
  let depth = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];
    const nextChar = content[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && nextChar === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && nextChar === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  return null;
}

function braceDepthBeforeIndex(content: string, openBraceIndex: number, targetIndex: number): number | null {
  let depth = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openBraceIndex; index < targetIndex; index += 1) {
    const char = content[index];
    const nextChar = content[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && nextChar === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && nextChar === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth < 0) {
        return null;
      }
    }
  }

  return depth;
}

function replaceGeneratedQuartzConfigBaseUrl(
  content: string,
  configurationBlock: QuartzConfigurationBlock,
  baseUrlLine: string,
): string | null {
  const body = content.slice(configurationBlock.openingLineEnd, configurationBlock.closeBraceIndex);
  const pattern = /^([ \t]*)\/\/ llm-wiki generated baseUrl[ \t]*\r?\n[ \t]*baseUrl[ \t]*:[^\r\n]*$/gmu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match.index === undefined) {
      continue;
    }

    const start = configurationBlock.openingLineEnd + match.index;
    if (braceDepthBeforeIndex(content, configurationBlock.openBraceIndex, start) !== 1) {
      continue;
    }

    const indentation = match[1] ?? "";
    return `${content.slice(0, start)}${indentation}${QUARTZ_GENERATED_BASE_URL_MARKER}\n${indentation}${baseUrlLine}${content.slice(start + match[0].length)}`;
  }

  return null;
}

function replaceExistingQuartzConfigBaseUrl(
  content: string,
  configurationBlock: QuartzConfigurationBlock,
  baseUrlLine: string,
): string | null {
  const body = content.slice(configurationBlock.openingLineEnd, configurationBlock.closeBraceIndex);
  const pattern = /^([ \t]*)baseUrl[ \t]*:[ \t]*([^\r\n]*)$/gmu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match.index === undefined) {
      continue;
    }

    const start = configurationBlock.openingLineEnd + match.index;
    if (braceDepthBeforeIndex(content, configurationBlock.openBraceIndex, start) !== 1) {
      continue;
    }

    const value = match[2]?.trim() ?? "";
    const nextLine = nextNonBlankLine(body.slice(match.index + match[0].length));
    const lineHasTrailingComma = /,\s*(?:(?:\/\/.*)|(?:\/\*.*\*\/)\s*)?$/u.test(value);
    if (value === "" || (!lineHasTrailingComma && nextLine !== null && !nextLine.startsWith("}"))) {
      throw new QuartzOperationError({
        code: "QUARTZ_WRITE_FAILED",
        message: "Failed to replace multi-line Quartz baseUrl configuration.",
        path: QUARTZ_CONFIG_PATH,
        hint: "Put configuration.baseUrl on one line or remove it before rerunning deploy sync.",
      });
    }

    const indentation = match[1] ?? "";
    return `${content.slice(0, start)}${indentation}${QUARTZ_GENERATED_BASE_URL_MARKER}\n${indentation}${baseUrlLine}${content.slice(start + match[0].length)}`;
  }

  return null;
}

function nextNonBlankLine(content: string): string | null {
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }

  return null;
}

function hasGitignoreLine(content: string, line: string): boolean {
  return content.split(/\r?\n/u).some((entry) => entry.trim() === line);
}

function areGitignorePathsIgnored(content: string, paths: readonly string[]): boolean {
  return paths.every((path) => isGitignorePathIgnored(content, path));
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

async function ensureQuartzContentIgnoredByGit(
  repoRoot: string,
  contentPaths: readonly string[],
  gitProbePaths: readonly string[] = contentPaths,
): Promise<string[]> {
  const warnings = await removeGeneratedQuartzContentGitignore(repoRoot);
  await assertQuartzContentGitignoreAllowsSyncedContent(repoRoot, contentPaths);

  const unsafePath = await firstUnignoredGitPath(repoRoot, gitProbePaths);
  if (unsafePath === null) {
    return warnings;
  }

  const parentGitignore = await readOptionalTextFile(repoRoot, QUARTZ_PARENT_GITIGNORE_PATH);
  const writeResult = await writeTextFileInsideRoot(
    repoRoot,
    QUARTZ_PARENT_GITIGNORE_PATH,
    appendGitignoreLine(parentGitignore, QUARTZ_PARENT_CONTENT_IGNORE_RULE),
  );
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to repair nested generated Quartz ignore rule.",
      path: QUARTZ_PARENT_GITIGNORE_PATH,
      hint: writeResult.error.hint,
    });
  }

  const repairedUnsafePath = await firstUnignoredGitPath(repoRoot, gitProbePaths);
  if (repairedUnsafePath !== null) {
    throw new QuartzOperationError({
      code: "QUARTZ_CONTENT_UNSAFE",
      message: "Generated Quartz content is not protected by Git ignore rules.",
      path: repairedUnsafePath,
      hint: `Move ${QUARTZ_PARENT_CONTENT_IGNORE_RULE} to the end of ${QUARTZ_PARENT_GITIGNORE_PATH} or remove nested .gitignore negation rules that re-include quartz/content/** before syncing.`,
    });
  }

  return [...warnings, `Repaired nested generated Quartz ignore rule: ${QUARTZ_PARENT_GITIGNORE_PATH}`];
}

async function ensureQuartzRuntimeIgnoredByGit(repoRoot: string): Promise<string[]> {
  const parentGitignore = await readOptionalTextFile(repoRoot, QUARTZ_PARENT_GITIGNORE_PATH);
  if (!canNestedGitignoreReincludeRuntime(parentGitignore)) {
    return [];
  }

  if (!(await hasGitMetadataInAncestor(repoRoot))) {
    return [];
  }

  const unsafePath = await firstUnignoredGitPath(repoRoot, QUARTZ_RUNTIME_IGNORE_PROBE_PATHS);
  if (unsafePath === null) {
    return [];
  }

  const writeResult = await writeTextFileInsideRoot(
    repoRoot,
    QUARTZ_PARENT_GITIGNORE_PATH,
    appendGitignoreLine(parentGitignore, QUARTZ_PARENT_RUNTIME_IGNORE_RULE),
  );
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to repair nested generated Quartz runtime ignore rule.",
      path: QUARTZ_PARENT_GITIGNORE_PATH,
      hint: writeResult.error.hint,
    });
  }

  const repairedUnsafePath = await firstUnignoredGitPath(repoRoot, QUARTZ_RUNTIME_IGNORE_PROBE_PATHS);
  if (repairedUnsafePath !== null) {
    throw new QuartzOperationError({
      code: "QUARTZ_CONTENT_UNSAFE",
      message: "Generated Quartz runtime is not protected by Git ignore rules.",
      path: repairedUnsafePath,
      hint: `Move ${QUARTZ_PARENT_RUNTIME_IGNORE_RULE} to the end of ${QUARTZ_PARENT_GITIGNORE_PATH} or remove nested .gitignore negation rules that re-include quartz/quartz/** before installing Quartz dependencies.`,
    });
  }

  return [`Repaired nested generated Quartz runtime ignore rule: ${QUARTZ_PARENT_GITIGNORE_PATH}`];
}

function canNestedGitignoreReincludeRuntime(content: string): boolean {
  const lines = content.split(/\r?\n/u);
  return QUARTZ_RUNTIME_IGNORE_PROBE_PATHS.some((path) => {
    const nestedPath = path.startsWith("quartz/") ? path.slice("quartz/".length) : path;
    return lines.some((line) => {
      const rule = parseGitignoreRule(line);
      return rule?.negated === true && gitignorePatternMatches(rule.pattern, nestedPath);
    });
  });
}

async function hasGitMetadataInAncestor(repoRoot: string): Promise<boolean> {
  let current = resolve(repoRoot);
  while (true) {
    try {
      await lstat(resolve(current, ".git"));
      return true;
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) {
        throw new QuartzOperationError({
          code: "QUARTZ_CONTENT_UNSAFE",
          message: "Could not inspect Git metadata before Quartz runtime setup.",
          path: ".git",
          hint: error instanceof Error ? error.message : "Fix Git metadata permissions before initializing Quartz Explorer.",
        });
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

async function removeGeneratedQuartzContentGitignore(repoRoot: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(resolve(repoRoot, QUARTZ_CONTENT_GITIGNORE_PATH), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to inspect generated Quartz content ignore override.",
      path: QUARTZ_CONTENT_GITIGNORE_PATH,
      hint: error instanceof Error ? error.message : String(error),
    });
  }

  if (content !== QUARTZ_CONTENT_GITIGNORE_CONTENT) {
    return [];
  }

  try {
    await rm(resolve(repoRoot, QUARTZ_CONTENT_GITIGNORE_PATH), { force: true });
  } catch (error) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to remove generated Quartz content ignore override.",
      path: QUARTZ_CONTENT_GITIGNORE_PATH,
      hint: error instanceof Error ? error.message : String(error),
    });
  }

  return [`Removed obsolete content-level generated Quartz ignore override: ${QUARTZ_CONTENT_GITIGNORE_PATH}`];
}

async function assertQuartzContentGitignoreAllowsSyncedContent(
  repoRoot: string,
  contentPaths: readonly string[],
): Promise<void> {
  if (contentPaths.length === 0) {
    return;
  }

  const content = await readOptionalTextFile(repoRoot, QUARTZ_CONTENT_GITIGNORE_PATH);
  if (content === "") {
    return;
  }

  const ignoredPath = contentPaths
    .map((path) => stripQuartzContentPrefix(path))
    .find((path) => path !== null && isGitignorePathIgnored(content, path));
  if (ignoredPath === undefined || ignoredPath === null) {
    return;
  }

  throw new QuartzOperationError({
    code: "QUARTZ_CONTENT_UNSAFE",
    message: "Quartz content-level .gitignore would hide synced pages from Quartz.",
    path: QUARTZ_CONTENT_GITIGNORE_PATH,
    hint: "Remove quartz/content/.gitignore or change it so synced Markdown remains visible to Quartz.",
  });
}

function stripQuartzContentPrefix(path: string): string | null {
  const prefix = "quartz/content/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
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
    execFile("git", ["check-ignore", "-q", "--", path], { cwd: repoRoot, env: gitCommandEnv() }, (error) => {
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
    execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot, env: gitCommandEnv() }, (error, stdout = "") => {
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

async function writeQuartzRuntimeEntry(repoRoot: string, entry: ScaffoldEntry): Promise<void> {
  const writeResult = await writeTextFileInsideRoot(repoRoot, entry.path, entry.content);
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: `Failed to write Quartz runtime file: ${entry.path}.`,
      path: entry.path,
      hint: writeResult.error.hint,
    });
  }
}

async function quartzRuntimeEntryMigrationContent(repoRoot: string, entry: ScaffoldEntry): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(resolve(repoRoot, entry.path), "utf8");
  } catch (error) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: `Failed to inspect Quartz runtime file: ${entry.path}.`,
      path: entry.path,
      hint: error instanceof Error ? error.message : String(error),
    });
  }

  if (content === entry.content) {
    return null;
  }

  switch (entry.path) {
    case "quartz/package.json":
      return content === OLD_PLACEHOLDER_QUARTZ_PACKAGE_JSON ? entry.content : null;
    case "quartz/README.md":
      return content === OLD_PLACEHOLDER_QUARTZ_README ? entry.content : null;
    case "quartz/quartz.config.ts":
      return (
        content === OLD_PLACEHOLDER_QUARTZ_CONFIG ||
        content === quartzConfigContent({ enableContentIndexFeeds: true })
      )
        ? entry.content
        : null;
    case "quartz/quartz.layout.ts": {
      const componentsSupportDefaultLayoutImports = await llmWikiLayoutComponentsSupportDefaultImports(repoRoot);

      if (content === OLD_PLACEHOLDER_QUARTZ_LAYOUT) {
        return componentsSupportDefaultLayoutImports ? entry.content : quartzLayoutContentBeforeUploadForm();
      }

      if (
        content === quartzLayoutContentBeforeReviewGates() ||
        content === quartzLayoutContentBeforeSourceBadge()
      ) {
        return componentsSupportDefaultLayoutImports ? entry.content : null;
      }

      if (content === quartzLayoutContentBeforeUploadForm()) {
        return componentsSupportDefaultLayoutImports ? entry.content : null;
      }

      return null;
    }
    case "quartz/components/LlmWikiQueueDashboard.tsx":
      return (
        content === componentPlaceholder("LlmWikiQueueDashboard", "llm-wiki-queue-dashboard") ||
        content === oldComponentPlaceholder("llm-wiki-queue-dashboard") ||
        content === queueDashboardComponentContentBeforeFrontmatter()
      )
        ? entry.content
        : null;
    case "quartz/components/LlmWikiReviewPanel.tsx":
      return (
        content === componentPlaceholder("LlmWikiReviewPanel", "llm-wiki-review-panel") ||
        content === oldComponentPlaceholder("llm-wiki-review-panel") ||
        content === reviewPanelComponentContentBeforeBaseAwareLinks()
      )
        ? entry.content
        : null;
    case "quartz/components/LlmWikiSourceBadge.tsx":
      return (
        content === componentPlaceholder("LlmWikiSourceBadge", "llm-wiki-source-badge") ||
        content === oldComponentPlaceholder("llm-wiki-source-badge")
      )
        ? entry.content
        : null;
    case QUARTZ_UPLOAD_FORM_COMPONENT_PATH:
      return isMigratableUploadFormComponent(content) ? entry.content : null;
    case "quartz/components/LlmWikiVisibilityWarning.tsx":
      return (
        content === componentPlaceholder("LlmWikiVisibilityWarning", "llm-wiki-visibility-warning") ||
        content === oldComponentPlaceholder("llm-wiki-visibility-warning")
      )
        ? entry.content
        : null;
    default:
      return null;
  }
}

async function llmWikiLayoutComponentsSupportDefaultImports(repoRoot: string): Promise<boolean> {
  const componentSupport = await Promise.all(
    QUARTZ_LAYOUT_COMPONENTS.map((component) => llmWikiLayoutComponentSupportsDefaultImport(repoRoot, component)),
  );

  return componentSupport.every(Boolean);
}

async function llmWikiLayoutComponentSupportsDefaultImport(
  repoRoot: string,
  component: (typeof QUARTZ_LAYOUT_COMPONENTS)[number],
): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(resolve(repoRoot, component.path), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return true;
    }

    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: `Failed to inspect Quartz runtime file: ${component.path}.`,
      path: component.path,
      hint: error instanceof Error ? error.message : String(error),
    });
  }

  return isMigratableLayoutComponent(content, component) || hasDefaultExport(content);
}

function isMigratableUploadFormComponent(content: string): boolean {
  const uploadFormComponent = QUARTZ_LAYOUT_COMPONENTS.find(
    (component) => component.path === QUARTZ_UPLOAD_FORM_COMPONENT_PATH,
  );
  return uploadFormComponent !== undefined && isMigratableLayoutComponent(content, uploadFormComponent);
}

function isMigratableLayoutComponent(
  content: string,
  component: (typeof QUARTZ_LAYOUT_COMPONENTS)[number],
): boolean {
  return (
    content === componentPlaceholder(component.componentName, component.className) ||
    content === oldComponentPlaceholder(component.className) ||
    (component.componentName === "LlmWikiReviewPanel" && content === reviewPanelComponentContentBeforeBaseAwareLinks())
  );
}

function hasDefaultExport(content: string): boolean {
  const withoutComments = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  return (
    /^\s*export\s+default\b/m.test(withoutComments) ||
    /^\s*export\s*\{[^}]*\bas\s+default\b[^}]*\}/ms.test(withoutComments)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localDaemonRuntimeMetadataMatches(
  content: string,
  expected: Pick<Extract<QuartzLocalDaemonRuntimeMetadata, { enabled: true }>, "url" | "upload_token">,
): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return false;
    }

    return parsed.enabled === true && parsed.url === expected.url && parsed.upload_token === expected.upload_token;
  } catch {
    return false;
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
    execFile(npmCommand(), ["install"], { cwd }, (error, stdout = "", stderr = "") => {
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

function npmCommand(): "npm" | "npm.cmd" {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function quartzRuntimeEntries(): ScaffoldEntry[] {
  return [
    { path: "quartz/README.md", content: quartzReadmeContent() },
    { path: "quartz/components/LlmWikiQueueDashboard.tsx", content: queueDashboardComponentContent() },
    { path: "quartz/components/LlmWikiReviewPanel.tsx", content: reviewPanelComponentContent() },
    { path: "quartz/components/LlmWikiSourceBadge.tsx", content: sourceBadgeComponentContent() },
    { path: "quartz/components/LlmWikiUploadForm.tsx", content: uploadFormComponentContent() },
    { path: "quartz/components/LlmWikiVisibilityWarning.tsx", content: visibilityWarningComponentContent() },
    { path: "quartz/package.json", content: quartzPackageJsonContent() },
    { path: "quartz/quartz.config.ts", content: quartzConfigContent() },
    { path: "quartz/quartz.layout.ts", content: quartzLayoutContent() },
    { path: "quartz/scripts/llm-wiki-loopback-listen.cjs", content: quartzLoopbackListenContent() },
    { path: "quartz/scripts/llm-wiki-sync-quartz-runtime.cjs", content: quartzRuntimeSyncContent() },
  ].sort((left, right) => left.path.localeCompare(right.path));
}

function quartzPackageJsonContent(): string {
  return `${JSON.stringify(
    {
      name: "llm-wiki-quartz-runtime",
      version: QUARTZ_VERSION,
      private: true,
      type: "module",
      scripts: {
        postinstall: "node scripts/llm-wiki-sync-quartz-runtime.cjs",
        build: "node ./quartz/bootstrap-cli.mjs build",
        serve: "node ./quartz/bootstrap-cli.mjs build --serve",
      },
      dependencies: {
        "@jackyzha0/quartz": `github:jackyzha0/quartz#v${QUARTZ_VERSION}`,
      },
      devDependencies: {},
    },
    null,
    2,
  )}\n`;
}

function quartzConfigContent(options: { enableContentIndexFeeds?: boolean } = {}): string {
  const enableContentIndexFeeds = options.enableContentIndexFeeds === true;

  return `import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"

const config: QuartzConfig = {
  configuration: {
    pageTitle: "LLM Wiki",
    pageTitleSuffix: "",
    enableSPA: true,
    enablePopovers: true,
    analytics: null,
    locale: "en-US",
    ignorePatterns: ["private", "templates", ".obsidian"],
    defaultDateType: "modified",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        header: "Schibsted Grotesk",
        body: "Source Sans Pro",
        code: "IBM Plex Mono",
      },
      colors: {
        lightMode: {
          light: "#faf8f8",
          lightgray: "#e5e5e5",
          gray: "#b8b8b8",
          darkgray: "#4e4e4e",
          dark: "#2b2b2b",
          secondary: "#284b63",
          tertiary: "#84a59d",
          highlight: "rgba(143, 159, 169, 0.15)",
          textHighlight: "#fff23688",
        },
        darkMode: {
          light: "#161618",
          lightgray: "#393639",
          gray: "#646464",
          darkgray: "#d4d4d4",
          dark: "#ebebec",
          secondary: "#7b97aa",
          tertiary: "#84a59d",
          highlight: "rgba(143, 159, 169, 0.15)",
          textHighlight: "#b3aa0288",
        },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        priority: ["frontmatter", "git", "filesystem"],
      }),
      Plugin.SyntaxHighlighting({
        theme: {
          light: "github-light",
          dark: "github-dark",
        },
        keepBackground: false,
      }),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: "katex" }),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({
        enableSiteMap: ${enableContentIndexFeeds ? "true" : "false"},
        enableRSS: ${enableContentIndexFeeds ? "true" : "false"},
      }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.Favicon(),
      Plugin.NotFoundPage(),
    ],
  },
}

export default config
`;
}

function quartzLayoutContent(options: { includeSourceBadge?: boolean } = {}): string {
  const includeSourceBadge = options.includeSourceBadge !== false;

  return `import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
import LlmWikiQueueDashboard from "./components/LlmWikiQueueDashboard"
import LlmWikiReviewPanel from "./components/LlmWikiReviewPanel"
${includeSourceBadge ? 'import LlmWikiSourceBadge from "./components/LlmWikiSourceBadge"\n' : ""}import LlmWikiUploadForm from "./components/LlmWikiUploadForm"
import LlmWikiVisibilityWarning from "./components/LlmWikiVisibilityWarning"

export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({
    links: {},
  }),
}

export const defaultContentPageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    Component.TagList(),
    Component.ConditionalRender({
      component: LlmWikiVisibilityWarning(),
      condition: (page) =>
        page.fileData.frontmatter?.llm_wiki_visibility_warning === true ||
        page.fileData.frontmatter?.llm_wiki_component === "LlmWikiVisibilityWarning",
    }),
${includeSourceBadge ? `    Component.ConditionalRender({
      component: LlmWikiSourceBadge(),
      condition: (page) =>
        page.fileData.frontmatter?.llm_wiki_source_badge === true ||
        page.fileData.frontmatter?.llm_wiki_component === "LlmWikiSourceBadge" ||
        typeof page.fileData.frontmatter?.source_id === "string" ||
        typeof page.fileData.frontmatter?.source_card_path === "string",
    }),
` : ""}    Component.ConditionalRender({
      component: LlmWikiUploadForm(),
      condition: (page) =>
        page.fileData.frontmatter?.llm_wiki_upload === true ||
        page.fileData.frontmatter?.llm_wiki_component === "LlmWikiUploadForm",
    }),
    Component.ConditionalRender({
      component: LlmWikiQueueDashboard(),
      condition: (page) =>
        page.fileData.frontmatter?.llm_wiki_queue_dashboard === true ||
        page.fileData.frontmatter?.llm_wiki_component === "LlmWikiQueueDashboard",
    }),
    Component.ConditionalRender({
      component: LlmWikiReviewPanel(),
      condition: (page) =>
        page.fileData.frontmatter?.llm_wiki_review_panel === true ||
        page.fileData.frontmatter?.llm_wiki_component === "LlmWikiReviewPanel",
    }),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [
    Component.Graph(),
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
  ],
} satisfies PageLayout

export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [],
}
`;
}

function quartzLayoutContentBeforeSourceBadge(): string {
  return quartzLayoutContent({ includeSourceBadge: false });
}

function quartzLayoutContentBeforeUploadForm(): string {
  return `import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"

export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({
    links: {},
  }),
}

export const defaultContentPageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    Component.TagList(),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [
    Component.Graph(),
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
  ],
} satisfies PageLayout

export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [],
}
`;
}

function quartzLayoutContentBeforeReviewGates(): string {
  return `import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
import LlmWikiUploadForm from "./components/LlmWikiUploadForm"

export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({
    links: {},
  }),
}

export const defaultContentPageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    Component.TagList(),
    Component.ConditionalRender({
      component: LlmWikiUploadForm(),
      condition: (page) =>
        page.fileData.frontmatter?.llm_wiki_upload === true ||
        page.fileData.frontmatter?.llm_wiki_component === "LlmWikiUploadForm",
    }),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [
    Component.Graph(),
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
  ],
} satisfies PageLayout

export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [],
}
`;
}

function quartzRuntimeSyncContent(): string {
  return `"use strict";

const { cpSync, existsSync, mkdirSync, rmSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const runtimeRoot = resolve(__dirname, "..");
const source = resolve(runtimeRoot, "node_modules/@jackyzha0/quartz/quartz");
const destination = resolve(runtimeRoot, "quartz");

if (!existsSync(source)) {
  console.error("Installed Quartz source tree not found at node_modules/@jackyzha0/quartz/quartz.");
  process.exit(1);
}

rmSync(destination, { force: true, recursive: true });
mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination, { recursive: true });
`;
}

function quartzLoopbackListenContent(): string {
  return `"use strict";

const net = require("node:net");

const host = process.env.LLM_WIKI_EXPLORER_HOST || "127.0.0.1";
const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function listenWithLlmWikiLoopback(...args) {
  if (typeof args[0] === "number") {
    const requestedHost = args[1];
    if (typeof requestedHost === "number") {
      return originalListen.call(this, args[0], host, requestedHost, args[2]);
    }

    if (requestedHost === undefined || typeof requestedHost === "function") {
      const backlog = typeof args[2] === "number" ? args[2] : undefined;
      const callback =
        typeof requestedHost === "function"
          ? requestedHost
          : typeof args[2] === "function"
            ? args[2]
            : typeof args[3] === "function"
              ? args[3]
              : undefined;
      return backlog === undefined
        ? originalListen.call(this, args[0], host, callback)
        : originalListen.call(this, args[0], host, backlog, callback);
    }
  }

  if (
    args[0] &&
    typeof args[0] === "object" &&
    !Array.isArray(args[0]) &&
    args[0].host === undefined &&
    args[0].port !== undefined
  ) {
    return originalListen.call(this, { ...args[0], host }, ...args.slice(1));
  }

  return originalListen.apply(this, args);
};
`;
}

function componentPlaceholder(componentName: string, className: string): string {
  return `import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"

const ${componentName}: QuartzComponent = () => {
  return <section class="${className}" data-llm-wiki-component="${componentName}" />
}

export default (() => ${componentName}) satisfies QuartzComponentConstructor
`;
}

function oldComponentPlaceholder(className: string): string {
  return `export function Component() {
  return <div className="${className}" />;
}
`;
}

function queueDashboardComponentContent(): string {
  return `import { resolveRelative } from "../quartz/util/path"
import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"
import type { FullSlug } from "../quartz/util/path"

type QueueDashboardItem = {
  title: string
  source_id: string
  source_kind: string
  queue_status: string
  visibility: string
  source_card_path: string
  source_card_materialized: boolean
  queue_path: string
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function queueItems(value: unknown): QueueDashboardItem[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return []
    }

    const record = item as Record<string, unknown>
    const sourceId = stringValue(record.source_id)
    const title = stringValue(record.title)
    if (sourceId === "" && title === "") {
      return []
    }

    return [{
      title: title === "" ? sourceId : title,
      source_id: sourceId,
      source_kind: stringValue(record.source_kind),
      queue_status: stringValue(record.queue_status) || stringValue(record.status),
      visibility: stringValue(record.visibility),
      source_card_path: stringValue(record.source_card_path),
      source_card_materialized: booleanValue(record.source_card_materialized),
      queue_path: stringValue(record.queue_path),
    }]
  })
}

function slugFromMarkdownPath(path: string): FullSlug {
  return path.replace(/^quartz\\/content\\//u, "").replace(/\\.md$/u, "") as FullSlug
}

const LlmWikiQueueDashboard: QuartzComponent = ({ fileData }) => {
  const frontmatter = fileData.frontmatter ?? {}
  const currentSlug = fileData.slug ?? ("index" as FullSlug)
  const counts = [
    ["Total", numberValue(frontmatter.llm_wiki_queue_total)],
    ["Queued", numberValue(frontmatter.llm_wiki_queue_queued)],
    ["Ingesting", numberValue(frontmatter.llm_wiki_queue_ingesting)],
    ["Blocked", numberValue(frontmatter.llm_wiki_queue_blocked)],
    ["Completed", numberValue(frontmatter.llm_wiki_queue_completed)],
  ] as const
  const items = queueItems(frontmatter.llm_wiki_queue_items).slice(0, 8)

  return (
    <section class="llm-wiki-queue-dashboard" data-llm-wiki-queue-dashboard="true" aria-label="LLM Wiki queue dashboard">
      <header>
        <h2>Queue dashboard</h2>
        <p>{items.length === 0 ? "No sources are currently queued." : "Newest source rows from the generated review queue."}</p>
      </header>
      <dl class="llm-wiki-queue-dashboard__metrics">
        {counts.map(([label, value]) => (
          <div class="llm-wiki-queue-dashboard__metric">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {items.length === 0 ? (
        <div class="llm-wiki-queue-dashboard__zero">
          <p>No sources are currently queued.</p>
          <p>
            <a class="internal" href={resolveRelative(currentSlug, "_llm-wiki/upload" as FullSlug)}>Upload sources</a>{" "}
            <a class="internal" href={resolveRelative(currentSlug, "_llm-wiki/review/source-queue" as FullSlug)}>Open source queue</a>
          </p>
        </div>
      ) : (
        <div class="llm-wiki-queue-dashboard__rows">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Source ID</th>
                <th>Kind</th>
                <th>Queue status</th>
                <th>Visibility</th>
                <th>Source card</th>
                <th>Queue path</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr>
                  <td>{item.title}</td>
                  <td><code>{item.source_id}</code></td>
                  <td>{item.source_kind || "unknown"}</td>
                  <td>{item.queue_status || "unknown"}</td>
                  <td>{item.visibility || "unknown"}</td>
                  <td>
                    {item.source_card_path === "" ? (
                      "Not generated"
                    ) : item.source_card_materialized ? (
                      <a class="internal" href={resolveRelative(currentSlug, slugFromMarkdownPath(item.source_card_path))}>
                        {item.source_card_path}
                      </a>
                    ) : (
                      <span>{item.source_card_path} <span class="llm-wiki-queue-dashboard__unavailable">(Not generated)</span></span>
                    )}
                  </td>
                  <td>{item.queue_path === "" ? "Not generated" : item.queue_path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default (() => LlmWikiQueueDashboard) satisfies QuartzComponentConstructor
`;
}

function queueDashboardComponentContentBeforeFrontmatter(): string {
  return `import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"

const LlmWikiQueueDashboard: QuartzComponent = () => {
  return (
    <section class="llm-wiki-queue-dashboard" data-llm-wiki-queue-dashboard="true">
      <h2>Queue dashboard</h2>
      <p>Review queued sources and ingest status from the generated source queue page.</p>
      <dl>
        <dt>Queued</dt>
        <dd>Sources waiting for ingest.</dd>
        <dt>Ingesting</dt>
        <dd>Sources currently being processed.</dd>
        <dt>Blocked</dt>
        <dd>Sources that need reviewer action before ingest can continue.</dd>
      </dl>
    </section>
  )
}

export default (() => LlmWikiQueueDashboard) satisfies QuartzComponentConstructor
`;
}

function reviewPanelComponentContent(): string {
  return `import { resolveRelative } from "../quartz/util/path"
import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"
import type { FullSlug } from "../quartz/util/path"

const reviewLinks: Array<{ href: FullSlug; label: string }> = [
  { href: "_llm-wiki/review/overview" as FullSlug, label: "Overview" },
  { href: "_llm-wiki/review/source-queue" as FullSlug, label: "Source queue" },
  { href: "_llm-wiki/review/recent-ingests" as FullSlug, label: "Recent ingests" },
  { href: "_llm-wiki/review/needs-review" as FullSlug, label: "Needs review" },
  { href: "_llm-wiki/review/contradictions" as FullSlug, label: "Contradictions" },
  { href: "_llm-wiki/review/orphans" as FullSlug, label: "Orphans" },
  { href: "_llm-wiki/review/stale-pages" as FullSlug, label: "Stale pages" },
  { href: "_llm-wiki/review/visibility-warnings" as FullSlug, label: "Visibility warnings" },
  { href: "_llm-wiki/review/profile-summary" as FullSlug, label: "Profile summary" },
]

const LlmWikiReviewPanel: QuartzComponent = ({ fileData }) => {
  const currentSlug = fileData.slug ?? ("index" as FullSlug)

  return (
    <nav class="llm-wiki-review-panel" data-llm-wiki-review-panel="true" aria-label="LLM Wiki review">
      <h2>Review panel</h2>
      <ul>
        {reviewLinks.map((link) => (
          <li>
            <a class="internal" href={resolveRelative(currentSlug, link.href)}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default (() => LlmWikiReviewPanel) satisfies QuartzComponentConstructor
`;
}

function reviewPanelComponentContentBeforeBaseAwareLinks(): string {
  return `import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"

const LlmWikiReviewPanel: QuartzComponent = () => {
  return (
    <nav class="llm-wiki-review-panel" data-llm-wiki-review-panel="true" aria-label="LLM Wiki review">
      <h2>Review panel</h2>
      <ul>
        <li><a href="/_llm-wiki/review/overview">Overview</a></li>
        <li><a href="/_llm-wiki/review/source-queue">Source queue</a></li>
        <li><a href="/_llm-wiki/review/recent-ingests">Recent ingests</a></li>
        <li><a href="/_llm-wiki/review/needs-review">Needs review</a></li>
        <li><a href="/_llm-wiki/review/contradictions">Contradictions</a></li>
        <li><a href="/_llm-wiki/review/orphans">Orphans</a></li>
        <li><a href="/_llm-wiki/review/stale-pages">Stale pages</a></li>
        <li><a href="/_llm-wiki/review/visibility-warnings">Visibility warnings</a></li>
        <li><a href="/_llm-wiki/review/profile-summary">Profile summary</a></li>
      </ul>
    </nav>
  )
}

export default (() => LlmWikiReviewPanel) satisfies QuartzComponentConstructor
`;
}

function sourceBadgeComponentContent(): string {
  return `import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"

const LlmWikiSourceBadge: QuartzComponent = () => {
  return (
    <aside class="llm-wiki-source-badge" data-llm-wiki-source-badge="true" aria-label="LLM Wiki source status">
      <strong>Source status</strong>
      <dl>
        <dt>Visibility</dt>
        <dd>Read this page's frontmatter before publishing.</dd>
        <dt>Review</dt>
        <dd>Use linked source cards and queue entries to verify provenance.</dd>
      </dl>
    </aside>
  )
}

export default (() => LlmWikiSourceBadge) satisfies QuartzComponentConstructor
`;
}

function uploadFormComponentContent(): string {
  const clientScript = `const bindLlmWikiUploadForms = () => {
  for (const root of document.querySelectorAll("[data-llm-wiki-upload-form]")) {
    if (!(root instanceof HTMLElement) || root.dataset.llmWikiUploadBound === "true") continue;

    const form = root.querySelector("form");
    const status = root.querySelector("[data-upload-status]");
    const details = root.querySelector("[data-upload-details]");
    if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLElement) || !(details instanceof HTMLElement)) continue;

    root.dataset.llmWikiUploadBound = "true";
    let daemon = null;
    const controls = Array.from(form.elements).filter((element) => "disabled" in element);
    const setControlsDisabled = (disabled) => {
      for (const control of controls) {
        control.disabled = disabled;
      }
    };
    const setStatus = (message) => {
      status.textContent = message;
    };
    const clearDetails = () => {
      details.replaceChildren();
    };
    const addDetail = (label, value) => {
      if (value === undefined || value === null || value === "") return;
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = String(value);
      details.append(term, description);
    };
    const showDetails = (rows) => {
      clearDetails();
      for (const [label, value] of rows) {
        addDetail(label, value);
      }
    };
    const requireValue = (value, message) => {
      const text = String(value ?? "").trim();
      if (text === "") {
        throw new Error(message);
      }
      return text;
    };
    const daemonUnavailableHint = "Run llm-wiki explore serve --profile local --with-daemon and keep the daemon running.";
    const browserGuidance = "Check that the local daemon is still running, then refresh this page to load the current upload token.";
    const showError = (error, fallback) => {
      const shown = error && typeof error === "object" ? error : { code: "UPLOAD_FAILED", message: fallback };
      setStatus(String(shown.message || fallback));
      const hint = shown.hint || (shown.code === "DAEMON_UNAVAILABLE" ? daemonUnavailableHint : undefined);
      showDetails([
        ["Code", shown.code],
        ["Message", shown.message],
        ["Hint", hint],
        ["Path", shown.path],
        ["Browser guidance", browserGuidance],
      ]);
    };
    const successStatusMessage = (data) => {
      const uploadStatus = typeof data.status === "string" ? data.status : "";
      const queueStatus = typeof data.queue_status === "string" ? data.queue_status : "";
      if (uploadStatus === "duplicate") {
        return queueStatus === "ingested" ? "Source already captured and ingested." : "Source already captured.";
      }
      if (queueStatus === "queued") return "Upload queued.";
      if (queueStatus !== "") return "Upload recorded with queue status: " + queueStatus + ".";
      return "Upload succeeded.";
    };

    const daemonMetadataUrl = () => {
      const marker = "/_llm-wiki/";
      const markerIndex = window.location.pathname.indexOf(marker);
      const basePath = markerIndex >= 0 ? window.location.pathname.slice(0, markerIndex + 1) : "/";
      return basePath + "_llm-wiki/runtime/local-daemon.json";
    };

    async function loadDaemonMetadata() {
      try {
        const response = await fetch(daemonMetadataUrl(), { cache: "no-store" });
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    }

    async function initialize() {
      const metadata = await loadDaemonMetadata();
      const tokenHeader = typeof metadata?.token_header === "string" ? metadata.token_header : "x-llm-wiki-upload-token";
      if (
        metadata?.enabled !== true ||
        typeof metadata.url !== "string" ||
        typeof metadata.upload_path !== "string" ||
        typeof metadata.upload_token !== "string"
      ) {
        daemon = null;
        setControlsDisabled(true);
        setStatus("Local upload daemon is disabled.");
        showDetails([
          ["Hint", "Run llm-wiki explore serve --profile local --with-daemon"],
        ]);
        return;
      }

      daemon = { ...metadata, token_header: tokenHeader };
      setControlsDisabled(false);
      setStatus("Local upload daemon is ready.");
      showDetails([
        ["Endpoint", String(daemon.url) + String(daemon.upload_path)],
        ["Token header", daemon.token_header],
      ]);
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (daemon === null) {
        showError({ code: "DAEMON_UNAVAILABLE", message: "Local upload daemon metadata is unavailable." }, "Upload daemon unavailable.");
        return;
      }

      const formData = new FormData(form);
      const mode = String(formData.get("mode") || "file");
      const upload = new FormData();
      const title = String(formData.get("title") || "").trim();

      try {
        if (title !== "") upload.set("title", title);
        if (mode === "file") {
          const fileInput = form.querySelector('input[name="file"]');
          const file = fileInput instanceof HTMLInputElement ? fileInput.files?.[0] : null;
          if (!(file instanceof File)) throw new Error("Choose a file to upload.");
          upload.set("file", file, file.name);
        } else if (mode === "text") {
          upload.set("title", requireValue(title, "Title is required for pasted text uploads."));
          upload.set("text", requireValue(formData.get("text"), "Paste text before uploading."));
        } else if (mode === "url") {
          upload.set("url", requireValue(formData.get("url"), "Enter a URL before uploading."));
        } else {
          throw new Error("Choose file, text, or URL upload mode.");
        }
      } catch (error) {
        showError({ code: "UPLOAD_FORM_INVALID", message: error instanceof Error ? error.message : String(error) }, "Upload form is invalid.");
        return;
      }

      setControlsDisabled(true);
      setStatus("Uploading...");
      clearDetails();

      try {
        const endpoint = String(daemon.url).replace(/\\/$/, "") + String(daemon.upload_path);
        const headers = {};
        headers[String(daemon.token_header)] = String(daemon.upload_token);
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: upload,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || body?.ok !== true) {
          const error =
            body?.error && typeof body.error === "object"
              ? { ...body.error, path: body.error.path || body?.issues?.[0]?.path }
              : body?.error;
          showError(error, "Upload failed.");
          return;
        }

        const data = body.data || {};
        setStatus(successStatusMessage(data));
        showDetails([
          ["Upload status", data.status],
          ["Title", data.title],
          ["Source ID", data.source_id],
          ["Source kind", data.source_kind],
          ["Queue status", data.queue_status],
          ["Source card", data.source_card_path],
          ["Original", data.original_path],
          ["Ingest", data.source_id ? "llm-wiki ingest " + data.source_id : ""],
          ["Auto ingest", daemon.auto_ingest_available === true && data.source_id ? "llm-wiki ingest " + data.source_id + " --auto" : ""],
        ]);
      } catch (error) {
        showError({ code: "DAEMON_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) }, "Upload daemon unavailable.");
      } finally {
        setControlsDisabled(false);
      }
    });

    void initialize();
  }
};

document.addEventListener("nav", bindLlmWikiUploadForms);
bindLlmWikiUploadForms();`;

  return `import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"

const uploadFormScript = ${JSON.stringify(clientScript)}

const LlmWikiUploadForm: QuartzComponent = () => {
  return (
    <section class="llm-wiki-upload-form" data-llm-wiki-upload-form="true">
      <form encType="multipart/form-data" noValidate>
        <fieldset>
          <legend>Source type</legend>
          <label><input type="radio" name="mode" value="file" checked disabled /> File</label>
          <label><input type="radio" name="mode" value="text" disabled /> Text</label>
          <label><input type="radio" name="mode" value="url" disabled /> URL</label>
        </fieldset>
        <label>
          Title
          <input name="title" type="text" autoComplete="off" disabled />
        </label>
        <label>
          File
          <input name="file" type="file" disabled />
        </label>
        <label>
          Text
          <textarea name="text" rows={8} disabled />
        </label>
        <label>
          URL
          <input name="url" type="url" inputMode="url" disabled />
        </label>
        <button type="submit" disabled>Upload</button>
      </form>
      <p data-upload-status="">Checking local upload daemon...</p>
      <dl data-upload-details=""></dl>
    </section>
  )
}

LlmWikiUploadForm.afterDOMLoaded = uploadFormScript

export default (() => LlmWikiUploadForm) satisfies QuartzComponentConstructor
`;
}

function visibilityWarningComponentContent(): string {
  return `import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"

const LlmWikiVisibilityWarning: QuartzComponent = () => {
  return (
    <aside class="llm-wiki-visibility-warning" data-llm-wiki-visibility-warning="true" role="note">
      <strong>Local or review-only content</strong>
      <p>This page can include private titles, queue state, or upload metadata. Keep it out of public profiles.</p>
    </aside>
  )
}

export default (() => LlmWikiVisibilityWarning) satisfies QuartzComponentConstructor
`;
}

function quartzReadmeContent(): string {
  return `# Quartz Runtime

This directory contains the LLM Wiki generated Quartz runtime.

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

function generatedLocalHomeContent(): string {
  return `${generatedPageFrontmatter("LLM Wiki Home", "LlmWikiReviewPanel")}# LLM Wiki Home

Start from the generated Explorer surfaces below.

- [[curated/home|Curated home]]
- [[_llm-wiki/upload|Upload]]
- [[_llm-wiki/review/overview|Review overview]]
- [[_llm-wiki/review/status|Status]]
- [[_llm-wiki/review/source-queue|Source queue]]
`;
}

function uploadPageContent(): string {
  return `${generatedPageFrontmatter("Upload", "LlmWikiUploadForm", ["llm_wiki_upload: true"])}# Upload
`;
}

function reviewOverviewContent(reviewData: ReviewDataModel): string {
  return `${generatedPageFrontmatter("Review Overview", "LlmWikiReviewPanel", queueDashboardFrontmatterFields(reviewData))}# Review Overview

## Status

| Metric | Value |
|---|---:|
| Queue total | ${reviewData.queue.counts.total} |
| Queued | ${reviewData.queue.counts.queued} |
| Ingesting | ${reviewData.queue.counts.ingesting} |
| Blocked | ${reviewData.queue.counts.blocked} |
| Completed | ${reviewData.queue.counts.completed} |

## Review Surfaces

| Surface | Count | Page |
|---|---:|---|
| Source queue | ${reviewData.queue.counts.total} | [[source-queue|Source queue]] |
| Recent ingests | ${reviewData.recent_ingests.count} | [[recent-ingests|Recent ingests]] |
| Needs review | ${reviewData.needs_review.count} | [[needs-review|Needs review]] |
| Contradictions | ${reviewData.contradictions.count} | [[_llm-wiki/review/contradictions|Contradictions]] |
| Orphans | ${reviewData.orphans.count} | [[orphans|Orphans]] |
| Stale pages | ${reviewData.stale_pages.count} | [[stale-pages|Stale pages]] |
| Visibility warnings | ${reviewData.visibility_warnings.count} | [[visibility-warnings|Visibility warnings]] |
| Profile summary | ${reviewData.profile === null ? 0 : 1} | [[profile-summary|Profile summary]] |
| Status | ${reviewData.queue.counts.total} | [[status|Status]] |
`;
}

function reviewStatusContent(reviewData: ReviewDataModel): string {
  return `${generatedPageFrontmatter("Review Status", "LlmWikiReviewPanel", queueDashboardFrontmatterFields(reviewData))}# Review Status

| Status | Count |
|---|---:|
| Queued | ${reviewData.queue.counts.queued} |
| Ingesting | ${reviewData.queue.counts.ingesting} |
| Blocked | ${reviewData.queue.counts.blocked} |
| Ingested | ${reviewData.queue.counts.completed} |

Generated at: ${reviewData.generated_at}
`;
}

function profileSummaryContent(reviewData: ReviewDataModel, scan: RepoScan): string {
  const profile = reviewData.profile;

  return `${generatedPageFrontmatter("Profile Summary", "LlmWikiReviewPanel")}# Profile Summary

| Field | Value |
|---|---|
| Profile | ${escapeTableCell(profile?.requested_name ?? "unknown")} |
| Source profile | ${escapeTableCell(profile?.source_name ?? "unknown")} |
| Include private | ${profile?.include_private === true ? "true" : "false"} |
| Required visibility | ${escapeTableCell(profile?.required_visibility ?? "")} |
| Markdown pages | ${scan.markdown.length} |
| Queue items | ${scan.queueItems.length} |
| Raw source cards | ${scan.sourceCards.length} |
`;
}

function sourceQueueContent(reviewData: ReviewDataModel): string {
  const rows = reviewData.queue.items.map((item) =>
    [
      item.source_id,
      item.title,
      item.status,
      item.source_kind,
      item.visibility ?? "",
      item.source_card_path ?? "",
      item.queue_path,
      item.original_path ?? "",
    ].map((value) => escapeTableCell(String(value))).join(" | "),
  );

  return `${generatedPageFrontmatter("Source Queue", "LlmWikiQueueDashboard", queueDashboardFrontmatterFields(reviewData))}# Source Queue

| Status | Count |
|---|---:|
| Total | ${reviewData.queue.counts.total} |
| Queued | ${reviewData.queue.counts.queued} |
| Ingesting | ${reviewData.queue.counts.ingesting} |
| Blocked | ${reviewData.queue.counts.blocked} |
| Ingested | ${reviewData.queue.counts.completed} |

| Source ID | Title | Status | Kind | Visibility | Source card | Queue file | Original |
|---|---|---|---|---|---|---|---|
${rows.map((row) => `| ${row} |`).join("\n")}
`;
}

function queueDashboardFrontmatterFields(reviewData: ReviewDataModel): string[] {
  const frontmatter = {
    llm_wiki_queue_dashboard: true,
    llm_wiki_queue_total: reviewData.queue.counts.total,
    llm_wiki_queue_queued: reviewData.queue.counts.queued,
    llm_wiki_queue_ingesting: reviewData.queue.counts.ingesting,
    llm_wiki_queue_blocked: reviewData.queue.counts.blocked,
    llm_wiki_queue_completed: reviewData.queue.counts.completed,
    llm_wiki_queue_items: reviewData.queue.items.map((item) => ({
      title: item.title,
      source_id: item.source_id,
      source_kind: item.source_kind,
      queue_status: item.status,
      visibility: item.visibility,
      source_card_path: item.source_card_path,
      source_card_materialized: item.source_card_materialized,
      queue_path: item.queue_path,
    })),
  };

  return stringify(frontmatter).trimEnd().split("\n");
}

function reviewCategoryContent(options: {
  title: string;
  component: string;
  category: ReviewCategory<unknown>;
}): string {
  return `${generatedPageFrontmatter(options.title, options.component)}# ${options.title}

Count: ${options.category.count}

${reviewItemsJson(options.category.items)}
`;
}

function reviewItemsJson(items: readonly unknown[]): string {
  if (items.length === 0) {
    return "No items.\n";
  }

  return `\`\`\`json
${JSON.stringify(items, null, 2)}
\`\`\`
`;
}

function generatedPageFrontmatter(title: string, component: string, extraFields: readonly string[] = []): string {
  const gateField = llmWikiComponentGateField(component);
  const gateFrontmatter =
    gateField === null || extraFields.some((field) => field.startsWith(`${gateField}:`)) ? [] : [`${gateField}: true`];
  const generatedFields = [...gateFrontmatter, ...extraFields];
  const extraFrontmatter = generatedFields.length === 0 ? "" : `${generatedFields.join("\n")}\n`;

  return `---
type: dashboard
title: ${title}
visibility: private
source_ids: []
llm_wiki_component: ${component}
${extraFrontmatter}---

`;
}

function llmWikiComponentGateField(component: string): string | null {
  switch (component) {
    case "LlmWikiUploadForm":
      return "llm_wiki_upload";
    case "LlmWikiQueueDashboard":
      return "llm_wiki_queue_dashboard";
    case "LlmWikiReviewPanel":
      return "llm_wiki_review_panel";
    case "LlmWikiSourceBadge":
      return "llm_wiki_source_badge";
    case "LlmWikiVisibilityWarning":
      return "llm_wiki_visibility_warning";
    default:
      return null;
  }
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
