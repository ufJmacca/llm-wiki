import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { lintWiki, type LintResult } from "../lint/index.js";
import { isExploreProfileName, isPublicLikeProfile, type ExploreProfileName } from "../profiles/index.js";
import { writeTextFileInsideRoot } from "../utils/fs.js";
import { GITHUB_PAGES_CNAME_CACHE_PATH, syncQuartzContent, QuartzOperationError, type QuartzSyncResult } from "./index.js";
import { assertQuartzDependenciesInstalled, runQuartzCommand, syncSummary, type QuartzProcessResult } from "./server.js";

export type QuartzBuildResult = {
  profile: QuartzSyncResult["profile"];
  output_path: "quartz/public";
  sync: Pick<QuartzSyncResult, "manifest_path" | "materialized_paths" | "generated_paths">;
  lint: {
    counts: LintResult["counts"];
  };
  quartz: QuartzProcessResult;
};

const QUARTZ_BUILD_ROOT_INDEX_PATH = "quartz/content/index.md" as const;
const QUARTZ_BUILD_CURATED_INDEX_PATH = "quartz/content/curated/index.md" as const;
const QUARTZ_PUBLIC_CNAME_PATH = "quartz/public/CNAME" as const;

export async function buildQuartzExplorer(
  repoRoot: string,
  profileName: string,
): Promise<{ data: QuartzBuildResult; warnings: string[] }> {
  assertStaticBuildProfile(profileName);
  const syncResult = await syncQuartzContent(repoRoot, profileName);
  const lintResult = await lintWiki(repoRoot, {
    profile: syncResult.data.source_profile,
    strict: isPublicLikeProfile(syncResult.data.profile),
  });
  if (lintResult.counts.error > 0) {
    throw new QuartzOperationError({
      code: "PUBLIC_LINT_FAILED",
      message: "Strict public lint failed before Quartz build.",
      path: ".",
      hint: "Fix error-severity lint issues before building public Quartz output.",
    });
  }

  await ensureQuartzBuildRootIndex(repoRoot);
  await assertQuartzDependenciesInstalled(repoRoot);
  const quartz = await runQuartzCommand(repoRoot, ["run", "build"]);
  await materializeGitHubPagesCnameArtifact(repoRoot, syncResult.data.profile);

  return {
    data: {
      profile: syncResult.data.profile,
      output_path: "quartz/public",
      sync: syncSummary(syncResult.data),
      lint: {
        counts: lintResult.counts,
      },
      quartz,
    },
    warnings: syncResult.warnings,
  };
}

async function materializeGitHubPagesCnameArtifact(repoRoot: string, profileName: ExploreProfileName): Promise<void> {
  if (profileName !== "github-pages") {
    return;
  }

  let content: string;
  try {
    content = await readFile(resolve(repoRoot, GITHUB_PAGES_CNAME_CACHE_PATH), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to read generated GitHub Pages CNAME cache.",
      path: GITHUB_PAGES_CNAME_CACHE_PATH,
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning Quartz build.",
    });
  }

  const writeResult = await writeTextFileInsideRoot(repoRoot, QUARTZ_PUBLIC_CNAME_PATH, content);
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to materialize GitHub Pages CNAME artifact.",
      path: QUARTZ_PUBLIC_CNAME_PATH,
      hint: writeResult.error.hint,
    });
  }
}

async function ensureQuartzBuildRootIndex(repoRoot: string): Promise<void> {
  if (await isRegularFile(repoRoot, QUARTZ_BUILD_ROOT_INDEX_PATH)) {
    return;
  }

  let content: string;
  try {
    content = await readFile(resolve(repoRoot, QUARTZ_BUILD_CURATED_INDEX_PATH), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new QuartzOperationError({
        code: "QUARTZ_CONTENT_UNSAFE",
        message: "Quartz build root homepage is missing.",
        path: QUARTZ_BUILD_CURATED_INDEX_PATH,
        hint: "Make curated/index.md eligible for the build profile before running llm-wiki explore build.",
      });
    }

    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to read Quartz build homepage source.",
      path: QUARTZ_BUILD_CURATED_INDEX_PATH,
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning Quartz build.",
    });
  }

  const writeResult = await writeTextFileInsideRoot(repoRoot, QUARTZ_BUILD_ROOT_INDEX_PATH, content);
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to materialize Quartz build root homepage.",
      path: QUARTZ_BUILD_ROOT_INDEX_PATH,
      hint: writeResult.error.hint,
    });
  }
}

async function isRegularFile(repoRoot: string, path: string): Promise<boolean> {
  try {
    const state = await lstat(resolve(repoRoot, path));
    if (state.isFile()) {
      return true;
    }

    throw new QuartzOperationError({
      code: "QUARTZ_CONTENT_UNSAFE",
      message: "Quartz build root homepage path is not a regular file.",
      path,
      hint: "Remove or replace quartz/content/index.md before running llm-wiki explore build.",
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
      message: "Failed to inspect Quartz build root homepage.",
      path,
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning Quartz build.",
    });
  }
}

function assertStaticBuildProfile(profileName: string): asserts profileName is ExploreProfileName {
  if (isExploreProfileName(profileName) && isPublicLikeProfile(profileName)) {
    return;
  }

  throw new QuartzOperationError({
    code: "PROFILE_UNSUPPORTED",
    message: `Unsupported Quartz build profile: ${profileName}.`,
    path: "--profile",
    hint: "Use --profile public or github-pages for static builds.",
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
