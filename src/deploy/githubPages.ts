import { lstat, readFile } from "node:fs/promises";
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
import { readGitCurrentBranch, readGitRemoteUrl, readGitTopLevel } from "../utils/git.js";
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
const PROFILE_EXTENSIONS = ["yml", "yaml"] as const;
const QUARTZ_INSTALL_COMMAND = "cd quartz && npm install" as const;
const LOCAL_BUILD_STEPS = [
  "llm-wiki explore sync --profile github-pages",
  "llm-wiki lint --profile github-pages --strict",
  "cd quartz && npm run build",
  "copy .llm-wiki/cache/github-pages-CNAME to quartz/public/CNAME when configured",
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
  { kind: "uses", uses: "actions/setup-node@v4", with: { "node-version": "22" } },
  { kind: "run", command: "npm install --global llm-wiki@latest" },
  { kind: "run", command: "llm-wiki explore init" },
  { kind: "run", command: "cd quartz && npm install" },
  { kind: "run", command: "llm-wiki explore sync --profile github-pages" },
  { kind: "run", command: "llm-wiki lint --profile github-pages --strict" },
  { kind: "run", command: "cd quartz && npm run build" },
  { kind: "run", command: "cp .llm-wiki/cache/github-pages-CNAME quartz/public/CNAME" },
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

  return {
    data: {
      workflow_path: GITHUB_PAGES_WORKFLOW_PATH,
      deploy_profile_path: deployProfilePath,
      public_profile_path: publicProfilePath,
      base_url: baseUrl,
      custom_domain: customDomain,
      created_paths: createdPaths,
      updated_paths: updatedPaths,
      instructions: setupInstructions({ quartz }),
    },
    warnings: [],
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

  return status;
}

export async function buildGitHubPagesLocal(repoRoot: string): Promise<{ data: GitHubPagesBuildLocalResult; warnings: string[] }> {
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
    warnings: [...build.warnings, ...status.warnings],
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
  if (!isRecord(parsed) || !isRecord(parsed.jobs) || !isRecord(parsed.jobs.deploy)) {
    return false;
  }

  const steps = parsed.jobs.deploy.steps;
  if (!Array.isArray(steps)) {
    return false;
  }

  let nextSearchIndex = 0;
  for (const requiredStep of REQUIRED_WORKFLOW_STEPS) {
    const stepIndex = steps.findIndex((step, index) => index >= nextSearchIndex && workflowStepMatches(step, requiredStep));
    if (stepIndex === -1) {
      return false;
    }

    nextSearchIndex = stepIndex + 1;
  }

  return true;
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
    return true;
  }

  const stepWith = step.with;
  if (!isRecord(stepWith)) {
    return false;
  }

  return Object.entries(requiredStep.with).every(([key, value]) => String(stepWith[key]) === value);
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
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install llm-wiki CLI
        run: npm install --global llm-wiki@latest
      - name: Initialize Quartz runtime
        run: llm-wiki explore init
      - name: Install Quartz dependencies
        run: cd quartz && npm install
      - name: Sync public Quartz content
        run: llm-wiki explore sync --profile github-pages
      - name: Strict public lint
        run: llm-wiki lint --profile github-pages --strict
      - name: Build Quartz
        run: cd quartz && npm run build
      - name: Preserve custom domain
        run: |
          if [ -f .llm-wiki/cache/github-pages-CNAME ]; then
            cp .llm-wiki/cache/github-pages-CNAME quartz/public/CNAME
          fi
      - name: Upload Pages artifact
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

function setupInstructions(
  state: Partial<Pick<GitHubPagesCheckResult, "workflow" | "profiles" | "quartz" | "public_preflight">>,
): string[] {
  const instructions: string[] = [];
  if (state.workflow?.status === "missing" || state.profiles?.status === "missing") {
    instructions.push("Run llm-wiki deploy github-pages init to generate Pages workflow and profiles.");
  }
  if (state.workflow?.status === "invalid" || state.profiles?.status === "invalid") {
    instructions.push("Regenerate Pages workflow and deploy profiles with llm-wiki deploy github-pages init.");
  }
  if (state.quartz?.status === "missing_runtime") {
    instructions.push("Run llm-wiki explore init before building Pages locally or in CI.");
  }
  if (state.quartz?.status === "missing_dependencies") {
    instructions.push("Run cd quartz && npm install before building Pages locally or in CI.");
  }
  if (state.public_preflight?.status === "fail") {
    instructions.push("Run llm-wiki explore sync --profile github-pages and llm-wiki lint --profile github-pages --strict, then fix public preflight errors.");
  }
  instructions.push("In GitHub, enable Pages with Source: GitHub Actions.");

  return [...new Set(instructions)];
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
