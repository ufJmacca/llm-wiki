import { writeFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { lintWiki, type LintResult } from "../lint/index.js";
import { isExploreProfileName, isPublicLikeProfile, type ExploreProfileName } from "../profiles/index.js";
import { scanStaticOutputLeaks, type StaticLeakFinding } from "../scanner/staticLeaks.js";
import { validateTextFileWriteInsideRoot, writeTextFileInsideRoot } from "../utils/fs.js";
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
const QUARTZ_LAYOUT_PATH = "quartz/quartz.layout.ts" as const;
const QUARTZ_PUBLIC_CNAME_PATH = "quartz/public/CNAME" as const;
const QUARTZ_CONTENT_OUTPUT_ROOT = "quartz/content" as const;
const QUARTZ_PUBLIC_OUTPUT_ROOT = "quartz/public" as const;
const QUARTZ_UPLOAD_FORM_IMPORT_PATTERN = /^import\s+LlmWikiUploadForm\s+from\s+["']\.\/components\/LlmWikiUploadForm["'];?[ \t]*\r?\n?/mu;
const QUARTZ_UPLOAD_FORM_REFERENCE_PATTERN = /\bLlmWikiUploadForm\b/u;
const QUARTZ_UPLOAD_FORM_CALL_PATTERN = /\bLlmWikiUploadForm\s*\(/u;
const QUARTZ_UPLOAD_CONDITIONAL_RENDER = "Component.ConditionalRender" as const;

export async function buildQuartzExplorer(
  repoRoot: string,
  profileName: string,
): Promise<{ data: QuartzBuildResult; warnings: string[] }> {
  assertStaticBuildProfile(profileName);
  const syncResult = await syncQuartzContent(repoRoot, profileName);
  const lintResult = await lintWiki(repoRoot, {
    profile: syncResult.data.source_profile,
    strict: isPublicLikeProfile(syncResult.data.profile),
    staticOutputLeakRoots: [QUARTZ_CONTENT_OUTPUT_ROOT],
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
  const quartz = await runQuartzPublicWithoutUploadRuntime(repoRoot);
  await assertQuartzPublicArtifactExists(repoRoot);
  await materializeGitHubPagesCnameArtifact(repoRoot, syncResult.data.profile);
  await assertQuartzPublicArtifactHasNoStaticLeaks(repoRoot);

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

async function runQuartzPublicWithoutUploadRuntime(repoRoot: string): Promise<QuartzProcessResult> {
  const layout = await readQuartzLayoutForPublicBuild(repoRoot);
  if (layout === null) {
    return await runQuartzCommand(repoRoot, ["run", "build"]);
  }

  const publicLayout = stripQuartzUploadRuntime(layout);
  if (publicLayout === layout) {
    return await runQuartzCommand(repoRoot, ["run", "build"]);
  }

  await assertQuartzLayoutWriteSafe(repoRoot);
  const restoration = installQuartzLayoutRestoration(repoRoot, layout);
  try {
    writeQuartzLayoutForPublicBuildSync(repoRoot, publicLayout);
    const quartz = await runQuartzCommand(repoRoot, ["run", "build"], {
      onShutdownSignal: (signal) => {
        restoration.recordInterruptedSignal(signal);
        restoration.restoreSync();
      },
    });
    const interruptedSignal = restoration.interruptedSignal();
    if (interruptedSignal !== null) {
      throw interruptedQuartzBuildError(interruptedSignal);
    }

    return quartz;
  } finally {
    try {
      writeQuartzLayoutForPublicBuildSync(repoRoot, layout);
    } finally {
      restoration.dispose();
    }
  }
}

async function readQuartzLayoutForPublicBuild(repoRoot: string): Promise<string | null> {
  try {
    const state = await lstat(resolve(repoRoot, QUARTZ_LAYOUT_PATH));
    if (!state.isFile()) {
      throw new QuartzOperationError({
        code: "QUARTZ_CONTENT_UNSAFE",
        message: "Quartz layout path is not a regular file.",
        path: QUARTZ_LAYOUT_PATH,
        hint: "Remove or replace quartz/quartz.layout.ts before running llm-wiki explore build.",
      });
    }

    return await readFile(resolve(repoRoot, QUARTZ_LAYOUT_PATH), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    if (error instanceof QuartzOperationError) {
      throw error;
    }

    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to inspect Quartz layout before public build.",
      path: QUARTZ_LAYOUT_PATH,
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning Quartz build.",
    });
  }
}

async function assertQuartzLayoutWriteSafe(repoRoot: string): Promise<void> {
  const writeResult = await validateTextFileWriteInsideRoot(repoRoot, QUARTZ_LAYOUT_PATH);
  if (!writeResult.ok) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to write Quartz layout for public build.",
      path: QUARTZ_LAYOUT_PATH,
      hint: writeResult.error.hint,
    });
  }
}

function writeQuartzLayoutForPublicBuildSync(repoRoot: string, content: string): void {
  try {
    writeFileSync(resolve(repoRoot, QUARTZ_LAYOUT_PATH), content, "utf8");
  } catch (error) {
    throw new QuartzOperationError({
      code: "QUARTZ_WRITE_FAILED",
      message: "Failed to write Quartz layout for public build.",
      path: QUARTZ_LAYOUT_PATH,
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning Quartz build.",
    });
  }
}

function installQuartzLayoutRestoration(repoRoot: string, content: string): {
  dispose: () => void;
  interruptedSignal: () => NodeJS.Signals | null;
  recordInterruptedSignal: (signal: NodeJS.Signals) => void;
  restoreSync: () => void;
} {
  const layoutPath = resolve(repoRoot, QUARTZ_LAYOUT_PATH);
  let active = true;
  let interruptedSignal: NodeJS.Signals | null = null;
  const restoreSync = (): void => {
    if (!active) {
      return;
    }

    try {
      writeFileSync(layoutPath, content, "utf8");
    } catch {
      // Process shutdown cannot report async errors; the normal finally path throws if restoration fails.
    }
  };
  const recordInterruptedSignal = (signal: NodeJS.Signals): void => {
    interruptedSignal ??= signal;
  };
  const handleSignal = (signal: NodeJS.Signals): void => {
    recordInterruptedSignal(signal);
    restoreSync();
  };
  const handleExit = (): void => {
    restoreSync();
  };
  const handleSigint = (): void => handleSignal("SIGINT");
  const handleSigterm = (): void => handleSignal("SIGTERM");

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  process.once("exit", handleExit);

  return {
    dispose: () => {
      active = false;
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
      process.off("exit", handleExit);
    },
    interruptedSignal: () => interruptedSignal,
    recordInterruptedSignal,
    restoreSync,
  };
}

function interruptedQuartzBuildError(signal: NodeJS.Signals): QuartzOperationError {
  return new QuartzOperationError({
    code: "QUARTZ_COMMAND_FAILED",
    message: `Quartz build was interrupted by ${signal}.`,
    path: "quartz/package.json",
    hint: "Rerun llm-wiki explore build after the interrupted Quartz process exits.",
  });
}

function stripQuartzUploadRuntime(content: string): string {
  const withoutBlocks = stripQuartzUploadConditionalRenderBlocks(content);
  if (withoutBlocks === null) {
    return content;
  }

  const withoutImport = withoutBlocks.replace(QUARTZ_UPLOAD_FORM_IMPORT_PATTERN, "");
  if (QUARTZ_UPLOAD_FORM_REFERENCE_PATTERN.test(withoutImport)) {
    return content;
  }

  return withoutImport;
}

function stripQuartzUploadConditionalRenderBlocks(content: string): string | null {
  let cursor = 0;
  let output = "";
  let changed = false;

  while (cursor < content.length) {
    const callStart = content.indexOf(QUARTZ_UPLOAD_CONDITIONAL_RENDER, cursor);
    if (callStart === -1) {
      output += content.slice(cursor);
      return changed ? output : content;
    }

    const openParen = content.indexOf("(", callStart + QUARTZ_UPLOAD_CONDITIONAL_RENDER.length);
    if (openParen === -1) {
      return null;
    }

    const closeParen = findMatchingParen(content, openParen);
    if (closeParen === null) {
      return null;
    }

    const call = content.slice(callStart, closeParen + 1);
    if (!QUARTZ_UPLOAD_FORM_CALL_PATTERN.test(call)) {
      output += content.slice(cursor, closeParen + 1);
      cursor = closeParen + 1;
      continue;
    }

    const removalStart = removableExpressionStart(content, callStart);
    if (removalStart === null) {
      return null;
    }

    const removalEnd = removableExpressionEnd(content, closeParen + 1, true);
    output += content.slice(cursor, removalStart);
    cursor = removalEnd;
    changed = true;
  }

  return changed ? output : content;
}

function removableExpressionStart(content: string, expressionStart: number): number | null {
  const lineStart = content.lastIndexOf("\n", expressionStart - 1) + 1;
  return /^[ \t]*$/u.test(content.slice(lineStart, expressionStart)) ? lineStart : null;
}

function removableExpressionEnd(content: string, expressionEnd: number, removedFromLineStart: boolean): number {
  let cursor = expressionEnd;
  while (content[cursor] === " " || content[cursor] === "\t") {
    cursor += 1;
  }

  if (content[cursor] === ",") {
    cursor += 1;
    while (content[cursor] === " " || content[cursor] === "\t") {
      cursor += 1;
    }
  }

  if (removedFromLineStart) {
    if (content.startsWith("\r\n", cursor)) {
      return cursor + 2;
    }

    if (content[cursor] === "\n" || content[cursor] === "\r") {
      return cursor + 1;
    }
  }

  return cursor;
}

function findMatchingParen(content: string, openParen: number): number | null {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openParen; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
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

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return null;
}

async function assertQuartzPublicArtifactHasNoStaticLeaks(repoRoot: string): Promise<void> {
  const scan = await scanStaticOutputLeaks(repoRoot, { roots: [QUARTZ_PUBLIC_OUTPUT_ROOT] });
  const finding = scan.findings[0];
  if (finding === undefined) {
    return;
  }

  throw new QuartzOperationError({
    code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
    message: `Public profile leak check failed after Quartz build: ${staticLeakRuleId(finding)}.`,
    path: finding.path,
    hint: finding.hint,
  });
}

async function assertQuartzPublicArtifactExists(repoRoot: string): Promise<void> {
  try {
    const state = await lstat(resolve(repoRoot, QUARTZ_PUBLIC_OUTPUT_ROOT));
    if (state.isDirectory()) {
      return;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new QuartzOperationError({
        code: "QUARTZ_WRITE_FAILED",
        message: "Failed to inspect Quartz public output artifact after build.",
        path: QUARTZ_PUBLIC_OUTPUT_ROOT,
        hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning Quartz build.",
      });
    }
  }

  throw new QuartzOperationError({
    code: "PUBLIC_PROFILE_ARTIFACT_MISSING",
    message: "Quartz build did not produce the expected Pages output directory.",
    path: QUARTZ_PUBLIC_OUTPUT_ROOT,
    hint: "Ensure the Quartz build writes static Pages output to quartz/public before rerunning llm-wiki explore build.",
  });
}

function staticLeakRuleId(finding: StaticLeakFinding): string {
  if (finding.code === "STATIC_SCAN_TARGET_UNSAFE") {
    return "public_static_scan_target_unsafe";
  }

  return `public_static_${finding.code.replace(/^STATIC_/u, "").replace(/_LEAK$/u, "").toLowerCase()}_leak`;
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
