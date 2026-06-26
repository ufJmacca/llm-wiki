import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";

import { PUBLIC_PROFILE_EXCLUDES, PUBLIC_PROFILE_REQUIRED_VISIBILITY } from "../config/defaults.js";
import { lintWiki } from "../lint/index.js";
import { readWikiProfile, type ExploreProfileName, type ProfileError } from "../profiles/index.js";
import { buildQuartzExplorer, type QuartzBuildResult } from "../quartz/build.js";
import { assertProfileBaseUrlQuartzConfigCanSync, assertPublicQuartzBuildPreflight, QuartzOperationError } from "../quartz/index.js";
import { assertQuartzDependenciesInstalled } from "../quartz/server.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { publicProfileContent } from "../scaffold/templates/profiles.js";
import { validateTextFileWriteInsideRoot, writeTextFileInsideRoot, type BinaryWriteError } from "../utils/fs.js";
import { areAnyGitPathsIgnored, readGitCurrentBranch, readGitRemoteUrl, readGitTopLevel } from "../utils/git.js";
import {
  customDomainHostIsValid,
  deployProfileBaseUrlError,
  deployProfileCustomDomainBaseUrlError,
  deployProfileCustomDomainError,
} from "./profileValidation.js";

export type GitHubPagesInitOptions = {
  customDomain?: string;
};

export type GitHubPagesInitResult = {
  workflow_path: typeof GITHUB_PAGES_WORKFLOW_PATH;
  deploy_profile_path: string;
  public_profile_path: string;
  base_url: string;
  custom_domain: string | null;
  created_paths: string[];
  updated_paths: string[];
  instructions: string[];
};

export type GitHubPagesCheckResult = {
  workflow: DeployWorkflowState;
  profiles: DeployProfilesState;
  quartz: DeployQuartzState;
  public_preflight: DeployPublicPreflightState;
  setup_instructions: string[];
};

export type GitHubPagesBuildLocalResult = QuartzBuildResult & {
  steps: typeof LOCAL_BUILD_STEPS;
  workflow: DeployWorkflowState;
  profiles: DeployProfilesState;
  quartz_readiness: DeployQuartzState;
  public_preflight: DeployPublicPreflightState;
  setup_instructions: string[];
};

export type DeployWorkflowState = {
  status: "valid" | "missing" | "invalid";
  path: typeof GITHUB_PAGES_WORKFLOW_PATH;
  error?: DeployProfileStateError;
};

export type DeployProfilesState = {
  status: "valid" | "missing" | "invalid";
  paths: [string, string];
  error?: DeployProfileStateError;
};

export type DeployProfileStateError = {
  code: string;
  message: string;
  path: string;
  hint: string;
};

export type DeployQuartzState = {
  status: "ready" | "missing_runtime" | "missing_dependencies";
  install_command: typeof QUARTZ_INSTALL_COMMAND;
};

export type DeployPublicPreflightState = {
  status: "pass" | "fail";
  issue_count: number;
};

const GITHUB_PAGES_WORKFLOW_PATH = ".github/workflows/llm-wiki-pages.yml" as const;
const GITHUB_PAGES_PROFILE_PATH = ".llm-wiki/profiles/github-pages.yml" as const;
const PUBLIC_PROFILE_PATH = ".llm-wiki/profiles/public.yml" as const;
const GITIGNORE_PATH = ".gitignore" as const;
const QUARTZ_PUBLIC_ARTIFACT_PROBES = [
  "quartz/public/index.html",
  "quartz/public/assets/llm-wiki-trackability-probe",
  "quartz/public/static/llm-wiki-trackability-probe",
] as const;
const PROFILE_EXTENSIONS = ["yml", "yaml"] as const;
const QUARTZ_INSTALL_COMMAND = "cd quartz && npm install" as const;
const GITHUB_PAGES_BUILD_COMMAND = "llm-wiki explore build --profile github-pages" as const;
const LOCAL_BUILD_STEPS = [
  GITHUB_PAGES_BUILD_COMMAND,
  "materialize .llm-wiki/cache/github-pages-CNAME to quartz/public/CNAME when configured",
  "scan quartz/public for static leaks",
] as const;

const REQUIRED_WORKFLOW_PERMISSIONS = {
  contents: "read",
  pages: "write",
  "id-token": "write",
} as const;

type RequiredWorkflowStep =
  | { kind: "run"; command: string }
  | { kind: "uses"; uses: string; with?: Record<string, string> };

const REQUIRED_WORKFLOW_STEPS = [
  { kind: "uses", uses: "actions/checkout@v4" },
  { kind: "uses", uses: "actions/upload-pages-artifact@v3", with: { path: "quartz/public" } },
  { kind: "uses", uses: "actions/deploy-pages@v4" },
] as const satisfies readonly RequiredWorkflowStep[];

export async function initializeGitHubPagesDeploy(
  repoRoot: string,
  options: GitHubPagesInitOptions = {},
): Promise<{ data: GitHubPagesInitResult; warnings: string[] }> {
  const customDomain = normalizeCustomDomain(options.customDomain);
  await assertWikiRootIsGitTopLevelForPages(repoRoot);
  const baseUrl = customDomain ? `https://${customDomain}` : await inferGitHubPagesBaseUrl(repoRoot);
  const branch = await inferGitHubPagesWorkflowBranch(repoRoot);
  const workflowContent = githubPagesWorkflowContent({ branch });
  const deployProfileContent = githubPagesProfileContent({ baseUrl, customDomain });
  const publicContent = publicProfileContent();
  const deployProfilePath = await profileWritePath(repoRoot, "github-pages");
  const publicProfilePath = await profileWritePath(repoRoot, "public");
  const quartz = await quartzState(repoRoot);
  const migrationWarnings = await removeLegacyQuartzPublicIgnoreRules(repoRoot);
  const createdPaths: string[] = [];
  const updatedPaths: string[] = [];

  for (const entry of [
    { path: GITHUB_PAGES_WORKFLOW_PATH, content: workflowContent },
    { path: deployProfilePath, content: deployProfileContent },
    { path: publicProfilePath, content: publicContent },
  ] as const) {
    const write = await writeTrackedTextFile(repoRoot, entry.path, entry.content);
    if (write === "created") {
      createdPaths.push(entry.path);
    } else if (write === "updated") {
      updatedPaths.push(entry.path);
    }
  }
  if (migrationWarnings.length > 0) {
    updatedPaths.push(GITIGNORE_PATH);
  }

  return {
    data: {
      workflow_path: GITHUB_PAGES_WORKFLOW_PATH,
      deploy_profile_path: deployProfilePath,
      public_profile_path: publicProfilePath,
      base_url: baseUrl,
      custom_domain: customDomain,
      created_paths: createdPaths,
      updated_paths: updatedPaths,
      instructions: setupInstructions({ quartz }, { includeStateRemediation: false }),
    },
    warnings: migrationWarnings,
  };
}

export async function checkGitHubPagesDeploy(repoRoot: string): Promise<{ data: GitHubPagesCheckResult; warnings: string[] }> {
  const status = await getGitHubPagesDeployStatus(repoRoot);

  if (status.data.workflow.status === "missing") {
    throw deployError({
      code: "GITHUB_PAGES_WORKFLOW_MISSING",
      message: "GitHub Pages workflow is missing.",
      path: GITHUB_PAGES_WORKFLOW_PATH,
      hint: "Run llm-wiki deploy github-pages init.",
    });
  }

  if (status.data.workflow.status === "invalid") {
    throw deployWorkflowRuntimeError(status.data.workflow);
  }

  if (status.data.profiles.status === "missing") {
    throw deployError({
      code: "PROFILE_MISSING",
      message: "GitHub Pages deploy profile is missing.",
      path: GITHUB_PAGES_PROFILE_PATH,
      hint: "Run llm-wiki deploy github-pages init.",
    });
  }

  if (status.data.profiles.status === "invalid") {
    throw deployProfileRuntimeError(status.data.profiles);
  }

  if (status.data.quartz.status === "missing_runtime") {
    throw deployError({
      code: "QUARTZ_RUNTIME_MISSING",
      message: "Quartz runtime package file is missing.",
      path: "quartz/package.json",
      hint: "Run llm-wiki explore init before checking GitHub Pages deployment.",
    });
  }

  if (status.data.quartz.status === "missing_dependencies") {
    throw deployError({
      code: "QUARTZ_DEPENDENCIES_MISSING",
      message: "Quartz dependencies are not installed.",
      path: "quartz/package.json",
      hint: "Run cd quartz && npm install.",
    });
  }

  if (status.data.public_preflight.status === "fail") {
    const syncBuildError = await publicSyncBuildPreflightError(repoRoot);
    if (syncBuildError !== null && syncBuildError.code !== "PUBLIC_PROFILE_LEAK_CHECK_FAILED") {
      throw syncBuildError;
    }

    const baseUrlError = await publicBaseUrlConfigError(repoRoot);
    if (baseUrlError !== null) {
      throw baseUrlError;
    }

    throw deployError({
      code: "PUBLIC_LINT_FAILED",
      message: "Public preflight failed before GitHub Pages deployment.",
      path: ".",
      hint: "Run llm-wiki explore sync --profile github-pages and llm-wiki lint --profile github-pages --strict, then fix public preflight errors.",
    });
  }

  await assertQuartzPublicArtifactTrackable(repoRoot);
  await assertQuartzPublicArtifactExistsForDeployCheck(repoRoot);

  return status;
}

export async function buildGitHubPagesLocal(repoRoot: string): Promise<{ data: GitHubPagesBuildLocalResult; warnings: string[] }> {
  const migrationWarnings = await removeLegacyQuartzPublicIgnoreRules(repoRoot);
  await assertGitHubPagesWorkflowValid(repoRoot);
  await assertGitHubPagesProfileValid(repoRoot);
  const build = await buildQuartzExplorer(repoRoot, "github-pages");
  const status = await getGitHubPagesDeployStatus(repoRoot);

  return {
    data: {
      ...build.data,
      steps: LOCAL_BUILD_STEPS,
      workflow: status.data.workflow,
      profiles: status.data.profiles,
      quartz_readiness: status.data.quartz,
      public_preflight: status.data.public_preflight,
      setup_instructions: status.data.setup_instructions,
    },
    warnings: [...migrationWarnings, ...build.warnings, ...status.warnings],
  };
}

export async function getGitHubPagesDeployStatus(
  repoRoot: string,
): Promise<{ data: GitHubPagesCheckResult; warnings: string[] }> {
  const [workflow, profiles, quartz, publicPreflight] = await Promise.all([
    workflowState(repoRoot),
    profilesState(repoRoot),
    quartzState(repoRoot),
    publicPreflightState(repoRoot),
  ]);

  return {
    data: {
      workflow,
      profiles,
      quartz,
      public_preflight: publicPreflight,
      setup_instructions: setupInstructions({ workflow, profiles, quartz, public_preflight: publicPreflight }),
    },
    warnings: [],
  };
}

export function toDeployRuntimeCommandError(error: unknown, fallbackCommand: string): RuntimeCommandError {
  if (error instanceof RuntimeCommandError) {
    return error;
  }

  if (error instanceof QuartzOperationError) {
    return deployError({
      code: error.code,
      message: error.message,
      path: error.path,
      hint: error.hint,
    });
  }

  return deployError({
    code: "GITHUB_PAGES_DEPLOY_FAILED",
    message: error instanceof Error ? error.message : String(error),
    path: ".",
    hint: `Fix the repository data or permissions, then rerun llm-wiki ${fallbackCommand}.`,
  });
}

async function assertGitHubPagesWorkflowValid(repoRoot: string): Promise<void> {
  const workflow = await workflowState(repoRoot);
  if (workflow.status === "missing") {
    throw deployError({
      code: "GITHUB_PAGES_WORKFLOW_MISSING",
      message: "GitHub Pages workflow is missing.",
      path: GITHUB_PAGES_WORKFLOW_PATH,
      hint: "Run llm-wiki deploy github-pages init.",
    });
  }

  if (workflow.status === "invalid") {
    throw deployWorkflowRuntimeError(workflow);
  }
}

async function assertGitHubPagesProfileValid(repoRoot: string): Promise<void> {
  const profiles = await profilesState(repoRoot);
  if (profiles.status === "missing") {
    throw deployError({
      code: "PROFILE_MISSING",
      message: "GitHub Pages deploy profile is missing.",
      path: GITHUB_PAGES_PROFILE_PATH,
      hint: "Run llm-wiki deploy github-pages init.",
    });
  }

  if (profiles.status === "invalid") {
    throw deployProfileRuntimeError(profiles);
  }
}

async function workflowState(repoRoot: string): Promise<DeployWorkflowState> {
  const workflowFile = await readOptionalManagedTextFile(repoRoot, GITHUB_PAGES_WORKFLOW_PATH);
  if (workflowFile.status === "missing") {
    return {
      status: "missing",
      path: GITHUB_PAGES_WORKFLOW_PATH,
    };
  }

  if (workflowFile.status === "invalid") {
    return {
      status: "invalid",
      path: GITHUB_PAGES_WORKFLOW_PATH,
      error: workflowFile.error,
    };
  }

  const valid = workflowContentIsValid(workflowFile.content);
  return {
    status: valid ? "valid" : "invalid",
    path: GITHUB_PAGES_WORKFLOW_PATH,
    ...(valid ? {} : {
      error: {
        code: "GITHUB_PAGES_WORKFLOW_INVALID",
        message: "GitHub Pages workflow is invalid.",
        path: GITHUB_PAGES_WORKFLOW_PATH,
        hint: "Regenerate it with llm-wiki deploy github-pages init.",
      },
    }),
  };
}

async function profilesState(repoRoot: string): Promise<DeployProfilesState> {
  const [deployProfileFile, publicProfileFile] = await Promise.all([
    profileFileState(repoRoot, "github-pages"),
    profileFileState(repoRoot, "public"),
  ]);
  const deployProfilePath = deployProfileFile.path;
  const publicProfilePath = publicProfileFile.path;

  if (deployProfileFile.status === "invalid" || publicProfileFile.status === "invalid") {
    return {
      status: "invalid",
      paths: [deployProfilePath, publicProfilePath],
      error: deployProfileFile.status === "invalid"
        ? await profileStateError(repoRoot, "github-pages", deployProfilePath)
        : await profileStateError(repoRoot, "public", publicProfilePath),
    };
  }

  if (deployProfileFile.status === "missing" || publicProfileFile.status === "missing") {
    return {
      status: "missing",
      paths: [deployProfilePath, publicProfilePath],
    };
  }

  const deployProfile = await readWikiProfile(repoRoot, "github-pages");
  const publicProfile = await readWikiProfile(repoRoot, "public");
  if (!deployProfile.ok) {
    return {
      status: "invalid",
      paths: [deployProfilePath, publicProfilePath],
      error: profileErrorToStateError(deployProfile.error),
    };
  }

  if (!publicProfile.ok) {
    return {
      status: "invalid",
      paths: [deployProfilePath, publicProfilePath],
      error: profileErrorToStateError(publicProfile.error),
    };
  }

  const baseUrlError = deployProfileBaseUrlError(deployProfile.value.baseUrl, deployProfile.value.path);
  if (baseUrlError !== null) {
    return {
      status: "invalid",
      paths: [deployProfilePath, publicProfilePath],
      error: baseUrlError,
    };
  }

  const customDomainError = deployProfileCustomDomainError(deployProfile.value.customDomain, deployProfile.value.path);
  if (customDomainError !== null) {
    return {
      status: "invalid",
      paths: [deployProfilePath, publicProfilePath],
      error: customDomainError,
    };
  }

  const customDomainBaseUrlError = deployProfileCustomDomainBaseUrlError(
    deployProfile.value.baseUrl,
    deployProfile.value.customDomain,
    deployProfile.value.path,
  );
  if (customDomainBaseUrlError !== null) {
    return {
      status: "invalid",
      paths: [deployProfilePath, publicProfilePath],
      error: customDomainBaseUrlError,
    };
  }

  return {
    status: "valid",
    paths: [deployProfilePath, publicProfilePath],
  };
}

async function profileStateError(
  repoRoot: string,
  profileName: Extract<ExploreProfileName, "github-pages" | "public">,
  fallbackPath: string,
): Promise<DeployProfileStateError> {
  const profileResult = await readWikiProfile(repoRoot, profileName);
  if (!profileResult.ok) {
    return profileErrorToStateError(profileResult.error);
  }

  return {
    code: "PROFILE_INVALID",
    message: `Profile path is invalid: ${profileName}.`,
    path: fallbackPath,
    hint: "Replace the profile path with a regular YAML file before rerunning deploy checks.",
  };
}

function profileErrorToStateError(error: ProfileError): DeployProfileStateError {
  return {
    code: error.code,
    message: error.message,
    path: error.path,
    hint: error.hint,
  };
}

function deployProfileRuntimeError(profiles: DeployProfilesState): RuntimeCommandError {
  const error = profiles.error ?? {
    code: "PROFILE_INVALID",
    message: "GitHub Pages deploy profile is invalid.",
    path: GITHUB_PAGES_PROFILE_PATH,
    hint: "Regenerate it with llm-wiki deploy github-pages init.",
  };

  return deployError(error);
}

function deployWorkflowRuntimeError(workflow: DeployWorkflowState): RuntimeCommandError {
  const error = workflow.error ?? {
    code: "GITHUB_PAGES_WORKFLOW_INVALID",
    message: "GitHub Pages workflow is invalid.",
    path: GITHUB_PAGES_WORKFLOW_PATH,
    hint: "Regenerate it with llm-wiki deploy github-pages init.",
  };

  return deployError(error);
}

async function quartzState(repoRoot: string): Promise<DeployQuartzState> {
  try {
    await assertQuartzDependenciesInstalled(repoRoot);
    return {
      status: "ready",
      install_command: QUARTZ_INSTALL_COMMAND,
    };
  } catch (error) {
    if (error instanceof QuartzOperationError && error.code === "QUARTZ_RUNTIME_MISSING") {
      return {
        status: "missing_runtime",
        install_command: QUARTZ_INSTALL_COMMAND,
      };
    }

    return {
      status: "missing_dependencies",
      install_command: QUARTZ_INSTALL_COMMAND,
    };
  }
}

async function publicPreflightState(repoRoot: string): Promise<DeployPublicPreflightState> {
  const result = await lintWiki(repoRoot, { profile: "github-pages", strict: true });
  const syncBuildIssueCount = result.counts.error === 0 ? await publicSyncBuildPreflightIssueCount(repoRoot, result) : 0;
  const baseUrlConfigIssueCount = result.counts.error === 0 ? await publicBaseUrlConfigIssueCount(repoRoot) : 0;
  const issueCount = result.counts.error + syncBuildIssueCount + baseUrlConfigIssueCount;

  return {
    status: issueCount > 0 ? "fail" : "pass",
    issue_count: issueCount,
  };
}

async function publicSyncBuildPreflightIssueCount(repoRoot: string, lintResult: Awaited<ReturnType<typeof lintWiki>>): Promise<number> {
  return (await publicSyncBuildPreflightError(repoRoot, lintResult)) === null ? 0 : 1;
}

async function publicSyncBuildPreflightError(
  repoRoot: string,
  lintResult?: Awaited<ReturnType<typeof lintWiki>>,
): Promise<RuntimeCommandError | null> {
  try {
    await assertPublicQuartzBuildPreflight(repoRoot, "github-pages", { lintResult });
    return null;
  } catch (error) {
    if (error instanceof QuartzOperationError) {
      return deployError({
        code: error.code,
        message: error.message,
        path: error.path,
        hint: error.hint,
      });
    }

    throw error;
  }
}

async function publicBaseUrlConfigIssueCount(repoRoot: string): Promise<number> {
  return (await publicBaseUrlConfigError(repoRoot)) === null ? 0 : 1;
}

async function publicBaseUrlConfigError(repoRoot: string): Promise<RuntimeCommandError | null> {
  try {
    await assertProfileBaseUrlQuartzConfigCanSync(repoRoot, "github-pages");
    return null;
  } catch (error) {
    if (error instanceof QuartzOperationError) {
      return deployError({
        code: error.code,
        message: error.message,
        path: error.path,
        hint: error.hint,
      });
    }

    throw error;
  }
}

function workflowContentIsValid(content: string): boolean {
  const normalizedContent = content.replace(/\r\n?/gu, "\n");
  let parsed: unknown;
  try {
    parsed = parse(normalizedContent) as unknown;
  } catch {
    return false;
  }

  if (!workflowPermissionsAreLeastPrivilege(parsed)) {
    return false;
  }

  if (!workflowHasRequiredTriggers(parsed)) {
    return false;
  }

  return workflowDeployStepsAreValid(parsed);
}

function workflowPermissionsAreLeastPrivilege(parsed: unknown): boolean {
  if (!isRecord(parsed) || !permissionsMatchRequired(parsed.permissions) || !isRecord(parsed.jobs)) {
    return false;
  }

  for (const jobConfig of Object.values(parsed.jobs)) {
    if (!isRecord(jobConfig)) {
      return false;
    }

    if ("permissions" in jobConfig && !permissionsMatchRequired(jobConfig.permissions)) {
      return false;
    }
  }

  return true;
}

function workflowHasRequiredTriggers(parsed: unknown): boolean {
  if (!isRecord(parsed) || !isRecord(parsed.on)) {
    return false;
  }

  return "push" in parsed.on && "workflow_dispatch" in parsed.on;
}

function workflowDeployStepsAreValid(parsed: unknown): boolean {
  if (!isRecord(parsed) || !isRecord(parsed.jobs) || !workflowJobsArePublisherOnly(parsed.jobs)) {
    return false;
  }

  const deployJob = parsed.jobs.deploy;
  if (!isRecord(deployJob)) {
    return false;
  }

  const steps = deployJob.steps;
  if (!Array.isArray(steps) || steps.length !== REQUIRED_WORKFLOW_STEPS.length) {
    return false;
  }

  return REQUIRED_WORKFLOW_STEPS.every((requiredStep, index) => workflowStepMatches(steps[index], requiredStep));
}

function workflowJobsArePublisherOnly(jobs: Record<string, unknown>): boolean {
  const jobNames = Object.keys(jobs);
  if (jobNames.length !== 1 || jobNames[0] !== "deploy") {
    return false;
  }

  const deployJob = jobs.deploy;
  return isRecord(deployJob) && !("uses" in deployJob);
}

function workflowStepMatches(step: unknown, requiredStep: RequiredWorkflowStep): boolean {
  if (!isRecord(step)) {
    return false;
  }

  if (requiredStep.kind === "uses") {
    return workflowStepUsesAction(step, requiredStep);
  }

  return workflowStepRunsCommand(step, requiredStep.command);
}

function workflowStepUsesAction(step: Record<string, unknown>, requiredStep: Extract<RequiredWorkflowStep, { kind: "uses" }>): boolean {
  if (step.uses !== requiredStep.uses) {
    return false;
  }

  if (requiredStep.with === undefined) {
    return step.with === undefined;
  }

  const stepWith = step.with;
  if (!isRecord(stepWith)) {
    return false;
  }

  const expectedEntries = Object.entries(requiredStep.with);
  return Object.keys(stepWith).length === expectedEntries.length &&
    expectedEntries.every(([key, value]) => String(stepWith[key]) === value);
}

function workflowStepRunsCommand(step: Record<string, unknown>, command: string): boolean {
  if (typeof step.run !== "string") {
    return false;
  }

  return step.run
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === command);
}

function permissionsMatchRequired(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const expectedEntries = Object.entries(REQUIRED_WORKFLOW_PERMISSIONS);
  return Object.keys(value).length === expectedEntries.length &&
    expectedEntries.every(([key, permission]) => value[key] === permission);
}

async function inferGitHubPagesBaseUrl(repoRoot: string): Promise<string> {
  const remoteUrl = await readGitRemoteUrl(repoRoot);
  const parsed = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
  if (parsed === null) {
    throw deployError({
      code: "GITHUB_PAGES_BASE_URL_UNRESOLVED",
      message: "Could not infer GitHub Pages base URL from git remote.",
      path: ".git/config",
      hint: "Add a GitHub origin remote or pass --custom-domain <domain>.",
    });
  }

  if (parsed.repo.toLowerCase() === `${parsed.owner.toLowerCase()}.github.io`) {
    return `https://${parsed.owner}.github.io`;
  }

  return `https://${parsed.owner}.github.io/${parsed.repo}`;
}

async function assertWikiRootIsGitTopLevelForPages(repoRoot: string): Promise<void> {
  const gitTopLevel = await readGitTopLevel(repoRoot);
  if (gitTopLevel === null || resolve(gitTopLevel) === resolve(repoRoot)) {
    return;
  }

  throw deployError({
    code: "GITHUB_PAGES_WIKI_ROOT_NOT_GIT_ROOT",
    message: "GitHub Pages deploy init requires the wiki root to be the Git repository root.",
    path: GITHUB_PAGES_WORKFLOW_PATH,
    hint: `Git reports ${gitTopLevel} as the repository root. Move the wiki to the Git repository root or initialize a separate Git repository at ${resolve(repoRoot)} before rerunning deploy init.`,
  });
}

async function inferGitHubPagesWorkflowBranch(repoRoot: string): Promise<string> {
  return await readGitCurrentBranch(repoRoot) ?? "main";
}

function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const httpsRemote = parseGitHubHttpsRemote(remoteUrl);
  if (httpsRemote !== null) {
    return httpsRemote;
  }

  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = remoteUrl.match(pattern);
    if (match) {
      const owner = match[1]?.trim();
      const repo = match[2]?.trim();
      if (owner && repo) {
        return { owner, repo };
      }
    }
  }

  return null;
}

function parseGitHubHttpsRemote(remoteUrl: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
      return null;
    }

    const [owner, rawRepo, ...extraSegments] = url.pathname.split("/").filter(Boolean);
    if (!owner || !rawRepo || extraSegments.length > 0) {
      return null;
    }

    const repo = rawRepo.replace(/\.git$/u, "").trim();
    const trimmedOwner = owner.trim();
    return trimmedOwner && repo ? { owner: trimmedOwner, repo } : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCustomDomain(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    throw deployError({
      code: "CUSTOM_DOMAIN_INVALID",
      message: "Custom domain must not be empty.",
      path: "--custom-domain",
      hint: "Pass a host name such as docs.example.com.",
    });
  }

  let normalized: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    normalized = parseCustomDomainUrl(trimmed);
  } else {
    normalized = trimmed.replace(/^\/+|\/+$/gu, "");
  }

  if (!customDomainHostIsValid(normalized)) {
    throw deployError({
      code: "CUSTOM_DOMAIN_INVALID",
      message: "Custom domain must be a host name only.",
      path: "--custom-domain",
      hint: "Pass a host name such as docs.example.com, without a path, query, fragment, or port.",
    });
  }

  return normalized;
}

function parseCustomDomainUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "";
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/*$/u.test(url.pathname)
  ) {
    return "";
  }

  return url.hostname;
}

function githubPagesWorkflowContent(options: { branch: string }): string {
  return `name: Deploy LLM Wiki to GitHub Pages

on:
  push:
    branches: [${JSON.stringify(options.branch)}]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Upload committed Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: quartz/public
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;
}

async function profileWritePath(repoRoot: string, profileName: "github-pages" | "public"): Promise<string> {
  const state = await profileFileState(repoRoot, profileName);
  if (state.status === "invalid") {
    throw deployError({
      code: "PROFILE_INVALID",
      message: `Duplicate profile files found for ${profileName}.`,
      path: state.path,
      hint: "Keep exactly one profile file for each name; remove either the .yml or .yaml variant before rerunning deploy init.",
    });
  }

  return state.path;
}

async function profileFileState(
  repoRoot: string,
  profileName: "github-pages" | "public",
): Promise<{ status: "present" | "missing" | "invalid"; path: string }> {
  const existingPaths: string[] = [];
  const invalidPaths: string[] = [];
  for (const extension of PROFILE_EXTENSIONS) {
    const profilePath = `.llm-wiki/profiles/${profileName}.${extension}`;
    const state = await profilePathState(repoRoot, profilePath);
    if (state === "present") {
      existingPaths.push(profilePath);
    } else if (state === "invalid") {
      invalidPaths.push(profilePath);
    }
  }

  const foundPaths = [...existingPaths, ...invalidPaths];
  if (foundPaths.length > 1 || invalidPaths.length > 0) {
    return {
      status: "invalid",
      path: foundPaths[0] ?? `.llm-wiki/profiles/${profileName}.yml`,
    };
  }

  if (existingPaths.length === 1) {
    return {
      status: "present",
      path: existingPaths[0] ?? `.llm-wiki/profiles/${profileName}.yml`,
    };
  }

  return {
    status: "missing",
    path: `.llm-wiki/profiles/${profileName}.yml`,
  };
}

async function profilePathState(repoRoot: string, path: string): Promise<"present" | "missing" | "invalid"> {
  try {
    const stat = await lstat(resolve(repoRoot, path));
    return stat.isFile() ? "present" : "invalid";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "missing";
    }

    throw deployError({
      code: "GITHUB_PAGES_READ_FAILED",
      message: `Failed to inspect ${path}.`,
      path,
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning the command.",
    });
  }
}

function githubPagesProfileContent(options: { baseUrl: string; customDomain: string | null }): string {
  return `name: github-pages
mode: deploy
base_url: ${options.baseUrl}
${options.customDomain ? `custom_domain: ${options.customDomain}\n` : ""}include:
  - curated/**
exclude:
${formatYamlList(PUBLIC_PROFILE_EXCLUDES)}
visibility:
  include_private: false
  required_value: ${PUBLIC_PROFILE_REQUIRED_VISIBILITY}
features:
  search: true
  graph: true
  backlinks: true
  upload: false
  review: false
  review_panel: false
source_links:
  allow_local_file_links: false
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_missing_visibility: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
deploy:
  provider: github-pages
  artifact_path: quartz/public
`;
}

async function removeLegacyQuartzPublicIgnoreRules(repoRoot: string): Promise<string[]> {
  const content = await readOptionalGitignoreForMigration(repoRoot);
  if (content === null) {
    return [];
  }

  const lineBreak = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r\n|\n/u);
  const filteredLines = lines.filter((line) => !isLegacyQuartzPublicIgnoreLine(line));
  if (filteredLines.length === lines.length) {
    return [];
  }

  const write = await writeTextFileInsideRoot(repoRoot, GITIGNORE_PATH, filteredLines.join(lineBreak));
  if (!write.ok) {
    throw deployError({
      code: "GITHUB_PAGES_GITIGNORE_UPDATE_FAILED",
      message: "Failed to remove legacy GitHub Pages artifact ignore rule.",
      path: GITIGNORE_PATH,
      hint: write.error.hint,
    });
  }

  return ["Removed legacy quartz/public ignore rule from .gitignore."];
}

async function readOptionalGitignoreForMigration(repoRoot: string): Promise<string | null> {
  try {
    return await readFile(resolve(repoRoot, GITIGNORE_PATH), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw deployError({
      code: "GITHUB_PAGES_READ_FAILED",
      message: `Failed to read ${GITIGNORE_PATH}.`,
      path: GITIGNORE_PATH,
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning the command.",
    });
  }
}

function isLegacyQuartzPublicIgnoreLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) {
    return false;
  }

  const normalized = trimmed.replace(/^\/+/u, "").replace(/\/+$/u, "");
  return normalized === "quartz/public" || normalized === "quartz/public/*" || normalized === "quartz/public/**";
}

async function assertQuartzPublicArtifactTrackable(repoRoot: string): Promise<void> {
  let ignored: boolean | null;
  try {
    ignored = await areQuartzPublicArtifactPathsIgnored(repoRoot);
  } catch (error) {
    throw deployError({
      code: "GITHUB_PAGES_PUBLIC_TRACKABILITY_UNKNOWN",
      message: "Could not verify that quartz/public is trackable.",
      path: GITIGNORE_PATH,
      hint: error instanceof Error ? error.message : "Fix Git ignore configuration before rerunning deploy checks.",
    });
  }

  if (ignored === null) {
    throw deployError({
      code: "GITHUB_PAGES_PUBLIC_TRACKABILITY_UNKNOWN",
      message: "Could not verify that quartz/public is trackable.",
      path: GITIGNORE_PATH,
      hint: "Ensure Git is available and the wiki root is inside a Git worktree before rerunning deploy checks.",
    });
  }

  if (!ignored) {
    return;
  }

  throw deployError({
    code: "GITHUB_PAGES_PUBLIC_IGNORED",
    message: "Committed GitHub Pages output is ignored by Git.",
    path: GITIGNORE_PATH,
    hint: "Remove ignore rules such as quartz/public/ or rerun llm-wiki deploy github-pages init before committing quartz/public.",
  });
}

async function assertQuartzPublicArtifactExistsForDeployCheck(repoRoot: string): Promise<void> {
  let publicIsDirectory = false;
  try {
    const state = await lstat(resolve(repoRoot, "quartz/public"));
    publicIsDirectory = state.isDirectory();
  } catch (error) {
    if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
      throw deployError({
        code: "GITHUB_PAGES_READ_FAILED",
        message: "Failed to inspect committed GitHub Pages output.",
        path: "quartz/public",
        hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning deploy checks.",
      });
    }

    throwQuartzPublicArtifactMissing();
  }

  if (!publicIsDirectory) {
    throwQuartzPublicArtifactMissing();
  }

  await assertQuartzPublicArtifactFile(repoRoot, "quartz/public/index.html");

  const deployProfile = await readWikiProfile(repoRoot, "github-pages");
  if (!deployProfile.ok) {
    throw deployError(profileErrorToStateError(deployProfile.error));
  }

  const cnamePath = "quartz/public/CNAME";
  if (deployProfile.value.customDomain === null) {
    try {
      await lstat(resolve(repoRoot, cnamePath));
      throw deployError({
        code: "GITHUB_PAGES_PUBLIC_ARTIFACT_INVALID",
        message: "Committed GitHub Pages custom domain artifact is stale.",
        path: cnamePath,
        hint: "Remove quartz/public/CNAME or rerun llm-wiki deploy github-pages build-local without a custom domain, then commit quartz/public.",
      });
    } catch (error) {
      if (error instanceof RuntimeCommandError) {
        throw error;
      }

      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return;
      }

      throw deployError({
        code: "GITHUB_PAGES_READ_FAILED",
        message: "Failed to inspect committed GitHub Pages output.",
        path: cnamePath,
        hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning deploy checks.",
      });
    }

    return;
  }

  await assertQuartzPublicArtifactFile(repoRoot, cnamePath);
  let cname: string;
  try {
    cname = (await readFile(resolve(repoRoot, cnamePath), "utf8")).trim();
  } catch (error) {
    throw deployError({
      code: "GITHUB_PAGES_READ_FAILED",
      message: "Failed to inspect committed GitHub Pages output.",
      path: cnamePath,
      hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning deploy checks.",
    });
  }
  if (cname === deployProfile.value.customDomain) {
    return;
  }

  throw deployError({
    code: "GITHUB_PAGES_PUBLIC_ARTIFACT_INVALID",
    message: "Committed GitHub Pages custom domain artifact does not match the deploy profile.",
    path: cnamePath,
    hint: `Run llm-wiki deploy github-pages build-local so quartz/public/CNAME contains ${deployProfile.value.customDomain}, then commit quartz/public.`,
  });
}

async function assertQuartzPublicArtifactFile(repoRoot: string, path: string): Promise<void> {
  try {
    const state = await lstat(resolve(repoRoot, path));
    if (state.isFile()) {
      return;
    }
  } catch (error) {
    if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
      throw deployError({
        code: "GITHUB_PAGES_READ_FAILED",
        message: "Failed to inspect committed GitHub Pages output.",
        path,
        hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning deploy checks.",
      });
    }
  }

  throw deployError({
    code: "GITHUB_PAGES_PUBLIC_ARTIFACT_INCOMPLETE",
    message: "Committed GitHub Pages output is incomplete.",
    path,
    hint: "Run llm-wiki deploy github-pages build-local, then commit quartz/public before rerunning deploy checks.",
  });
}

function throwQuartzPublicArtifactMissing(): never {
  throw deployError({
    code: "GITHUB_PAGES_PUBLIC_ARTIFACT_MISSING",
    message: "Committed GitHub Pages output is missing.",
    path: "quartz/public",
    hint: "Run llm-wiki deploy github-pages build-local, then commit quartz/public before rerunning deploy checks.",
  });
}

async function areQuartzPublicArtifactPathsIgnored(repoRoot: string): Promise<boolean | null> {
  const artifactPaths = await quartzPublicArtifactTrackabilityPaths(repoRoot);
  return await areAnyGitPathsIgnored(repoRoot, artifactPaths);
}

async function quartzPublicArtifactTrackabilityPaths(repoRoot: string): Promise<string[]> {
  const paths = new Set<string>(QUARTZ_PUBLIC_ARTIFACT_PROBES);
  await collectQuartzPublicArtifactPaths(repoRoot, "quartz/public", paths);
  return [...paths];
}

async function collectQuartzPublicArtifactPaths(repoRoot: string, relativePath: string, paths: Set<string>): Promise<void> {
  let state: Awaited<ReturnType<typeof lstat>>;
  try {
    state = await lstat(resolve(repoRoot, relativePath));
  } catch {
    return;
  }

  if (state.isSymbolicLink() || state.isFile()) {
    paths.add(relativePath);
    return;
  }

  if (!state.isDirectory()) {
    return;
  }

  const entries = await readdir(resolve(repoRoot, relativePath));
  for (const entry of entries.sort()) {
    await collectQuartzPublicArtifactPaths(repoRoot, `${relativePath}/${entry}`, paths);
  }
}

function setupInstructions(
  state: Partial<Pick<GitHubPagesCheckResult, "workflow" | "profiles" | "quartz" | "public_preflight">>,
  options: { includeStateRemediation?: boolean } = {},
): string[] {
  const instructions: string[] = options.includeStateRemediation === false ? [] : stateRemediationInstructions(state);
  instructions.push(...publishInstructions());
  instructions.push("In GitHub, enable Pages with Source: GitHub Actions.");

  return [...new Set(instructions)];
}

function stateRemediationInstructions(
  state: Partial<Pick<GitHubPagesCheckResult, "workflow" | "profiles" | "quartz" | "public_preflight">>,
): string[] {
  const instructions: string[] = [];

  if (state.workflow?.status === "missing" || state.profiles?.status === "missing") {
    instructions.push("Run llm-wiki deploy github-pages init.");
  } else {
    if (state.workflow?.status === "invalid") {
      instructions.push("Regenerate the GitHub Pages workflow with llm-wiki deploy github-pages init.");
    }

    if (state.profiles?.status === "invalid") {
      instructions.push("Regenerate GitHub Pages deploy profiles with llm-wiki deploy github-pages init.");
    }
  }

  if (state.quartz?.status === "missing_runtime") {
    instructions.push("Run llm-wiki explore init before building GitHub Pages output.");
  } else if (state.quartz?.status === "missing_dependencies") {
    instructions.push("Run cd quartz && npm install before building GitHub Pages output.");
  }

  if (state.public_preflight?.status === "fail") {
    instructions.push("Run llm-wiki explore sync --profile github-pages and llm-wiki lint --profile github-pages --strict, then fix public preflight errors.");
  }

  return instructions;
}

function publishInstructions(): string[] {
  return [
    "Run llm-wiki deploy github-pages build-local to generate committed Pages output in quartz/public.",
    "Run llm-wiki deploy github-pages check before publishing.",
    "Commit quartz/public with the reviewed public source changes.",
    "Open a pull request for review before merging Pages output.",
  ];
}

async function writeTrackedTextFile(repoRoot: string, path: string, content: string): Promise<"created" | "updated" | "skipped"> {
  const existingContent = await readOptionalTextFile(repoRoot, path);
  if (existingContent === content) {
    return "skipped";
  }

  const write = await writeTextFileInsideRoot(repoRoot, path, content);
  if (!write.ok) {
    throw deployError({
      code: "GITHUB_PAGES_WRITE_FAILED",
      message: `Failed to write ${path}.`,
      path,
      hint: write.error.hint,
    });
  }

  return existingContent === null ? "created" : "updated";
}

type ManagedTextFileRead =
  | { status: "present"; content: string }
  | { status: "missing" }
  | { status: "invalid"; error: DeployProfileStateError };

async function readOptionalTextFile(repoRoot: string, path: string): Promise<string | null> {
  const file = await readOptionalManagedTextFile(repoRoot, path);
  if (file.status === "missing") {
    return null;
  }

  if (file.status === "invalid") {
    throw deployError(file.error);
  }

  return file.content;
}

async function readOptionalManagedTextFile(repoRoot: string, path: string): Promise<ManagedTextFileRead> {
  const absolutePath = resolve(repoRoot, path);
  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      return {
        status: "invalid",
        error: {
          code: "GITHUB_PAGES_FILE_INVALID",
          message: `Managed deploy file must be a regular file, not a symlink: ${path}.`,
          path,
          hint: "Replace the symlink with a regular file before rerunning GitHub Pages deploy commands.",
        },
      };
    }

    if (!stat.isFile()) {
      return {
        status: "invalid",
        error: {
          code: "GITHUB_PAGES_FILE_INVALID",
          message: `Managed deploy file must be a regular file: ${path}.`,
          path,
          hint: "Replace the path with a regular file before rerunning GitHub Pages deploy commands.",
        },
      };
    }

    const pathValidation = await validateTextFileWriteInsideRoot(repoRoot, path);
    if (!pathValidation.ok) {
      return {
        status: "invalid",
        error: managedPathValidationError(pathValidation.error, path),
      };
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const pathValidation = await validateTextFileWriteInsideRoot(repoRoot, path);
      if (!pathValidation.ok) {
        return {
          status: "invalid",
          error: managedPathValidationError(pathValidation.error, path),
        };
      }

      return { status: "missing" };
    }

    return {
      status: "invalid",
      error: {
        code: "GITHUB_PAGES_READ_FAILED",
        message: `Failed to inspect ${path}.`,
        path,
        hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning the command.",
      },
    };
  }

  try {
    return {
      status: "present",
      content: await readFile(absolutePath, "utf8"),
    };
  } catch (error) {
    return {
      status: "invalid",
      error: {
        code: "GITHUB_PAGES_READ_FAILED",
        message: `Failed to read ${path}.`,
        path,
        hint: error instanceof Error ? error.message : "Fix filesystem permissions before rerunning the command.",
      },
    };
  }
}

function managedPathValidationError(error: BinaryWriteError, path: string): DeployProfileStateError {
  if (error.message.includes("symlink")) {
    const symlinkPath = error.message.match(/: ([^:]+)$/u)?.[1] ?? path;
    return {
      code: "GITHUB_PAGES_FILE_INVALID",
      message: `Managed deploy file path must not include symlinked directories: ${symlinkPath}.`,
      path,
      hint: "Replace the symlinked directory with a real directory inside the repository before rerunning GitHub Pages deploy commands.",
    };
  }

  if (error.code === "DESTINATION_PATH_UNSAFE") {
    return {
      code: "GITHUB_PAGES_FILE_INVALID",
      message: `Managed deploy file path must stay inside the repository: ${path}.`,
      path,
      hint: "Replace the path with a regular file inside the repository before rerunning GitHub Pages deploy commands.",
    };
  }

  return {
    code: "GITHUB_PAGES_FILE_INVALID",
    message: `Managed deploy file path is invalid: ${path}.`,
    path,
    hint: error.hint,
  };
}

function deployError(options: { code: string; message: string; path: string; hint: string }): RuntimeCommandError {
  return new RuntimeCommandError(options);
}

function formatYamlList(values: readonly string[]): string {
  return values.map((value) => `  - ${value}`).join("\n");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
