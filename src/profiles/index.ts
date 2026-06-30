import { readFile } from "node:fs/promises";

import { parseProfile } from "../scanner/index.js";
import type { RepoMarkdownFile, RepoOriginalFile } from "../scanner/repo.js";
import { validateReadFileInsideRoot } from "../utils/fs.js";
import { err, ok, type Result } from "../utils/result.js";

export type ExploreProfileName = "local" | "review" | "public" | "github-pages";

export type WikiProfile = {
  requestedName: ExploreProfileName;
  sourceName: string;
  path: string;
  baseUrl: string | null;
  customDomain: string | null;
  include: string[];
  exclude: string[];
  includePrivate: boolean;
  requiredVisibility: string | null;
  features: Record<string, boolean>;
};

export type ProfileError = {
  code:
    | "PROFILE_INVALID"
    | "PROFILE_MISSING"
    | "PROFILE_UNSUPPORTED"
    | "PROFILE_UPLOAD_FEATURE_FORBIDDEN"
    | "PROFILE_REVIEW_FEATURE_FORBIDDEN";
  message: string;
  path: string;
  hint: string;
};

export type PublicLikeProfileFeatureIssue = {
  code: Extract<ProfileError["code"], "PROFILE_UPLOAD_FEATURE_FORBIDDEN" | "PROFILE_REVIEW_FEATURE_FORBIDDEN">;
  lintRuleId: "public_profile_upload_feature_forbidden" | "public_profile_review_feature_forbidden";
  message: string;
  path: string;
  hint: string;
};

export type ProfileSelection = {
  markdown: RepoMarkdownFile[];
  matchedMarkdown: RepoMarkdownFile[];
  excludedRawOriginals: string[];
};

export function isExploreProfileName(value: string): value is ExploreProfileName {
  return value === "local" || value === "review" || value === "public" || value === "github-pages";
}

export function isPublicLikeProfile(profileName: ExploreProfileName): boolean {
  return isPublicLikeProfileName(profileName);
}

function isPublicLikeProfileName(profileName: string): profileName is Extract<ExploreProfileName, "public" | "github-pages"> {
  return profileName === "public" || profileName === "github-pages";
}

export async function readWikiProfile(
  repoRoot: string,
  profileName: ExploreProfileName,
): Promise<Result<WikiProfile, ProfileError>> {
  const profilePathResult = profileName === "github-pages"
    ? await existingProfilePath(repoRoot, "github-pages", "public")
    : await existingProfilePath(repoRoot, profileName, profileName);
  if (!profilePathResult.ok) {
    return profilePathResult;
  }

  const profilePath = profilePathResult.value;
  const sourceName = profilePath.match(/\/github-pages\.ya?ml$/) ? "github-pages" : profileName === "github-pages" ? "public" : profileName;

  const readableProfile = await readableProfilePath(repoRoot, profileName, profilePath);
  if (!readableProfile.ok) {
    return readableProfile;
  }

  let content: string;
  try {
    content = await readFile(readableProfile.value, "utf8");
  } catch (error) {
    return err({
      code: "PROFILE_INVALID",
      message: `Could not inspect profile: ${profileName}.`,
      path: profilePath,
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before syncing Quartz content.",
    });
  }

  const scan = parseProfile({ path: profilePath, content });
  if (!scan.profile) {
    const firstIssue = scan.issues[0];
    return err({
      code: "PROFILE_INVALID",
      message: firstIssue?.message ?? `Profile is invalid: ${profileName}.`,
      path: firstIssue?.path ?? profilePath,
      hint: firstIssue?.hint ?? "Fix the profile YAML before syncing Quartz content.",
    });
  }

  const profile: WikiProfile = {
    requestedName: profileName,
    sourceName,
    path: profilePath,
    baseUrl: profileBaseUrl(scan.profile),
    customDomain: profileCustomDomain(scan.profile),
    include: toStringArray(scan.profile.include),
    exclude: toStringArray(scan.profile.exclude),
    includePrivate: profileIncludePrivate(scan.profile),
    requiredVisibility: profileRequiredVisibility(scan.profile),
    features: profileFeatures(scan.profile),
  };
  const forbiddenFeature = publicLikeProfileFeatureIssues(profile)[0];
  if (forbiddenFeature !== undefined) {
    return err({
      code: forbiddenFeature.code,
      message: forbiddenFeature.message,
      path: forbiddenFeature.path,
      hint: forbiddenFeature.hint,
    });
  }

  return ok(profile);
}

export function publicLikeProfileFeatureIssues(input: {
  requestedName: string;
  path: string;
  features?: unknown;
}): PublicLikeProfileFeatureIssue[] {
  if (!isPublicLikeProfileName(input.requestedName)) {
    return [];
  }

  const features = isRecord(input.features) ? input.features : {};
  const issues: PublicLikeProfileFeatureIssue[] = [];

  if (features.upload === true) {
    issues.push({
      code: "PROFILE_UPLOAD_FEATURE_FORBIDDEN",
      lintRuleId: "public_profile_upload_feature_forbidden",
      message: `Public-like profile ${input.requestedName} must not enable features.upload.`,
      path: input.path,
      hint: "Set features.upload: false for public and github-pages profiles; uploads belong to local or private Explorer sessions.",
    });
  }

  const enabledReviewFeatures = ["review", "review_panel"].filter((feature) => features[feature] === true);
  if (enabledReviewFeatures.length > 0) {
    const featureNames = enabledReviewFeatures.map((feature) => `features.${feature}`).join(", ");
    issues.push({
      code: "PROFILE_REVIEW_FEATURE_FORBIDDEN",
      lintRuleId: "public_profile_review_feature_forbidden",
      message: `Public-like profile ${input.requestedName} must not enable ${featureNames}.`,
      path: input.path,
      hint: "Set review features to false for public and github-pages profiles; review surfaces belong to local or private Explorer sessions.",
    });
  }

  return issues;
}

export function selectMarkdownForProfile(
  profile: WikiProfile,
  markdown: readonly RepoMarkdownFile[],
  rawOriginals: readonly RepoOriginalFile[],
): ProfileSelection {
  const matched = markdown
    .filter((file) => matchesProfile(file.path, profile.include, profile.exclude))
    .sort((left, right) => left.path.localeCompare(right.path));
  const selected = matched
    .filter((file) => isVisibilityEligible(file, profile))
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    markdown: selected,
    matchedMarkdown: matched,
    excludedRawOriginals: rawOriginals
      .filter((file) => rawOriginalExcludedByProfile(file, profile))
      .map((file) => file.path)
      .sort(),
  };
}

export function matchesFileProfile(path: string, profile: WikiProfile): boolean {
  return matchesProfile(path, profile.include, profile.exclude);
}

export function shouldIgnorePublicSyncIssue(
  issue: { rule_id?: string; path: string },
  materializedPaths: ReadonlySet<string>,
  matchedPaths: ReadonlySet<string> = materializedPaths,
  matchedMissingOrInvalidVisibilityPaths: ReadonlySet<string> = new Set(),
): boolean {
  if (materializedPaths.has(issue.path)) {
    return false;
  }

  if (matchedMissingOrInvalidVisibilityPaths.has(issue.path) && isSelectedVisibilityBlockingIssue(issue)) {
    return false;
  }

  if (matchedPaths.has(issue.path) && isSelectedVisibilityFrontmatterIssue(issue)) {
    return false;
  }

  if (!issue.rule_id?.startsWith("public_")) {
    return true;
  }

  if (issue.rule_id !== "public_private_page_selected" && issue.rule_id !== "public_search_private_text_leak") {
    return false;
  }

  return !materializedPaths.has(issue.path);
}

function profileIncludePrivate(profile: Record<string, unknown>): boolean {
  const visibility = profile.visibility;
  if (isRecord(visibility) && typeof visibility.include_private === "boolean") {
    return visibility.include_private;
  }

  return false;
}

function profileRequiredVisibility(profile: Record<string, unknown>): string | null {
  const visibility = profile.visibility;
  if (isRecord(visibility) && typeof visibility.required_value === "string" && visibility.required_value.trim() !== "") {
    return visibility.required_value;
  }

  return null;
}

function profileFeatures(profile: Record<string, unknown>): Record<string, boolean> {
  if (!isRecord(profile.features)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(profile.features).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
  );
}

function profileBaseUrl(profile: Record<string, unknown>): string | null {
  return typeof profile.base_url === "string" && profile.base_url.trim() !== "" ? profile.base_url.trim() : null;
}

function profileCustomDomain(profile: Record<string, unknown>): string | null {
  return typeof profile.custom_domain === "string" && profile.custom_domain.trim() !== "" ? profile.custom_domain.trim() : null;
}

function isVisibilityEligible(file: RepoMarkdownFile, profile: WikiProfile): boolean {
  if (profile.requiredVisibility !== null) {
    return file.scan.frontmatter?.visibility === profile.requiredVisibility;
  }

  if (profile.includePrivate) {
    return true;
  }

  return file.scan.frontmatter?.visibility !== "private";
}

function rawOriginalExcludedByProfile(file: RepoOriginalFile, profile: WikiProfile): boolean {
  return matchesFileProfile(file.path, profile) || profile.exclude.some((pattern) => matchesGlob(file.path, pattern));
}

async function existingProfilePath(
  repoRoot: string,
  primaryName: string,
  fallbackName: string,
): Promise<Result<string, ProfileError>> {
  const profileNames = primaryName === fallbackName ? [primaryName] : [primaryName, fallbackName];
  for (const profileName of profileNames) {
    const paths = await existingProfilePaths(repoRoot, profileName);
    if (!paths.ok) {
      return paths;
    }

    if (paths.value.length > 1) {
      return err({
        code: "PROFILE_INVALID",
        message: `Duplicate profile files found for ${profileName}: ${paths.value.join(", ")}.`,
        path: paths.value[0] ?? `.llm-wiki/profiles/${profileName}.yml`,
        hint: "Keep exactly one profile file for each name; remove either the .yml or .yaml variant before syncing Quartz content.",
      });
    }

    if (paths.value.length === 1) {
      return ok(paths.value[0] ?? `.llm-wiki/profiles/${profileName}.yml`);
    }
  }

  return ok(`.llm-wiki/profiles/${fallbackName}.yml`);
}

async function existingProfilePaths(repoRoot: string, profileName: string): Promise<Result<string[], ProfileError>> {
  const paths: string[] = [];
  for (const extension of ["yml", "yaml"]) {
    const profilePath = `.llm-wiki/profiles/${profileName}.${extension}`;
    const profileState = await existingReadableProfilePath(repoRoot, profileName, profilePath);
    if (!profileState.ok) {
      return profileState;
    }

    if (profileState.value === "present") {
      paths.push(profilePath);
    }
  }

  return ok(paths);
}

async function existingReadableProfilePath(
  repoRoot: string,
  profileName: string,
  profilePath: string,
): Promise<Result<"present" | "missing", ProfileError>> {
  const readableProfile = await readableProfilePath(repoRoot, profileName, profilePath);
  if (readableProfile.ok) {
    return ok("present");
  }

  if (readableProfile.error.code === "PROFILE_MISSING") {
    return ok("missing");
  }

  return readableProfile;
}

async function readableProfilePath(
  repoRoot: string,
  profileName: string,
  profilePath: string,
): Promise<Result<string, ProfileError>> {
  const validation = await validateReadFileInsideRoot(repoRoot, profilePath);
  if (!validation.ok) {
    return err(profileReadError(profileName, profilePath, validation.error));
  }

  return ok(validation.value.absolutePath);
}

function profileReadError(profileName: string, profilePath: string, error: { message: string; hint: string }): ProfileError {
  if (isMissingProfilePath(error.message)) {
    return {
      code: "PROFILE_MISSING",
      message: `Profile is missing: ${profileName}.`,
      path: profilePath,
      hint: "Restore the profile YAML before syncing Quartz content.",
    };
  }

  if (error.message.includes("symlink")) {
    return {
      code: "PROFILE_INVALID",
      message: `Profile path must not include symlinks: ${profileName}.`,
      path: profilePath,
      hint: "Keep profile YAML as a regular file inside .llm-wiki/profiles without symlinked parent directories.",
    };
  }

  if (error.message.includes("not a regular file")) {
    return {
      code: "PROFILE_INVALID",
      message: `Profile must be a regular file: ${profileName}.`,
      path: profilePath,
      hint: "Replace the profile path with a regular YAML file before syncing Quartz content.",
    };
  }

  return {
    code: "PROFILE_INVALID",
    message: `Profile path must stay inside the wiki repository: ${profileName}.`,
    path: profilePath,
    hint: error.hint,
  };
}

function isMissingProfilePath(message: string): boolean {
  return message.includes("ENOENT") || message.startsWith("destination parent does not exist:");
}

function isSelectedVisibilityFrontmatterIssue(issue: { rule_id?: string; message?: string }): boolean {
  if (issue.rule_id === "frontmatter_malformed" || issue.rule_id === "curated_frontmatter_missing") {
    return true;
  }

  if (issue.rule_id === "curated_frontmatter_required_missing" || issue.rule_id === "curated_frontmatter_invalid") {
    return issue.message?.includes("visibility") ?? false;
  }

  return false;
}

function isSelectedVisibilityBlockingIssue(issue: { rule_id?: string; message?: string }): boolean {
  return (
    isSelectedVisibilityFrontmatterIssue(issue) ||
    issue.rule_id === "public_private_page_selected" ||
    issue.rule_id === "public_search_private_text_leak"
  );
}

function matchesProfile(path: string, include: string[], exclude: string[]): boolean {
  return include.some((pattern) => matchesGlob(path, pattern)) && !exclude.some((pattern) => matchesGlob(path, pattern));
}

function matchesGlob(path: string, pattern: string): boolean {
  const globstarSlash = "\u0000";
  const globstar = "\u0001";
  const regexSource = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", globstarSlash)
    .replaceAll("**", globstar)
    .replaceAll("*", "[^/]*")
    .replaceAll(globstarSlash, "(?:.*/)?")
    .replaceAll(globstar, ".*");

  return new RegExp(`^${regexSource}$`).test(path);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
