import type { Command } from "commander";

import type { CliIo } from "../cli.js";
import {
  buildGitHubPagesLocal,
  checkGitHubPagesDeploy,
  getGitHubPagesDeployStatus,
  initializeGitHubPagesDeploy,
  toDeployRuntimeCommandError,
  type GitHubPagesBuildLocalResult,
  type GitHubPagesCheckResult,
  type GitHubPagesInitResult,
} from "../deploy/githubPages.js";
import { addRuntimeOptions, runRuntimeCommand, type RawRuntimeCommandOptions } from "../runtime/command.js";
import type { RuntimeSuccessEnvelope } from "../runtime/envelope.js";

type RawDeployInitOptions = RawRuntimeCommandOptions & {
  customDomain?: unknown;
};

export function registerDeployCommand(program: Command, io: CliIo): void {
  const deploy = program.command("deploy").description("Manage deploy targets");
  const githubPages = deploy.command("github-pages").description("Manage GitHub Pages deployment");

  addRuntimeOptions(
    githubPages
      .command("init")
      .description("Generate GitHub Pages workflow and deploy profiles")
      .option("--custom-domain <domain>", "custom GitHub Pages domain"),
  ).action(async (rawOptions: RawDeployInitOptions) => {
    await runRuntimeCommand({
      command: "deploy.github-pages.init",
      rawOptions,
      io,
      run: async ({ repo }) => {
        try {
          return await initializeGitHubPagesDeploy(repo.rootDir, {
            customDomain: typeof rawOptions.customDomain === "string" ? rawOptions.customDomain : undefined,
          });
        } catch (error) {
          throw toDeployRuntimeCommandError(error, "deploy github-pages init");
        }
      },
      formatHuman: formatHumanDeployInit,
    });
  });

  addRuntimeOptions(
    githubPages
      .command("check")
      .description("Validate GitHub Pages workflow, deploy profile, Quartz readiness, and public preflight"),
  ).action(async (rawOptions: RawRuntimeCommandOptions) => {
    await runRuntimeCommand({
      command: "deploy.github-pages.check",
      rawOptions,
      io,
      run: async ({ repo }) => {
        try {
          return await checkGitHubPagesDeploy(repo.rootDir);
        } catch (error) {
          throw toDeployRuntimeCommandError(error, "deploy github-pages check");
        }
      },
      formatHuman: formatHumanDeployCheck,
    });
  });

  addRuntimeOptions(
    githubPages
      .command("build-local")
      .description("Run the same public sync, strict lint, and Quartz build sequence as Pages CI"),
  ).action(async (rawOptions: RawRuntimeCommandOptions) => {
    await runRuntimeCommand({
      command: "deploy.github-pages.build-local",
      rawOptions,
      io,
      run: async ({ repo }) => {
        try {
          return await buildGitHubPagesLocal(repo.rootDir);
        } catch (error) {
          throw toDeployRuntimeCommandError(error, "deploy github-pages build-local");
        }
      },
      formatHuman: formatHumanBuildLocal,
    });
  });

  addRuntimeOptions(
    githubPages
      .command("status")
      .description("Report GitHub Pages deploy readiness without failing on incomplete setup"),
  ).action(async (rawOptions: RawRuntimeCommandOptions) => {
    await runRuntimeCommand({
      command: "deploy.github-pages.status",
      rawOptions,
      io,
      run: async ({ repo }) => {
        try {
          return await getGitHubPagesDeployStatus(repo.rootDir);
        } catch (error) {
          throw toDeployRuntimeCommandError(error, "deploy github-pages status");
        }
      },
      formatHuman: formatHumanDeployStatus,
    });
  });
}

function formatHumanDeployInit(envelope: RuntimeSuccessEnvelope<"deploy.github-pages.init", GitHubPagesInitResult>): string {
  return [
    "GitHub Pages deploy initialized",
    `Workflow: ${envelope.data.workflow_path}`,
    `Deploy profile: ${envelope.data.deploy_profile_path}`,
    `Public profile: ${envelope.data.public_profile_path}`,
    `Base URL: ${envelope.data.base_url}`,
    ...envelope.data.instructions.map((instruction) => `Next: ${instruction}`),
  ].join("\n");
}

function formatHumanDeployCheck(envelope: RuntimeSuccessEnvelope<"deploy.github-pages.check", GitHubPagesCheckResult>): string {
  return [
    "GitHub Pages deploy check passed",
    `Workflow: ${envelope.data.workflow.status}`,
    `Profiles: ${envelope.data.profiles.status}`,
    `Quartz: ${envelope.data.quartz.status}`,
    `Public preflight: ${envelope.data.public_preflight.status}`,
    ...envelope.data.setup_instructions.map((instruction) => `Next: ${instruction}`),
  ].join("\n");
}

function formatHumanBuildLocal(
  envelope: RuntimeSuccessEnvelope<"deploy.github-pages.build-local", GitHubPagesBuildLocalResult>,
): string {
  return [
    "GitHub Pages local build complete",
    `Workflow: ${envelope.data.workflow.status}`,
    `Profiles: ${envelope.data.profiles.status}`,
    `Quartz readiness: ${envelope.data.quartz_readiness.status}`,
    `Public preflight: ${envelope.data.public_preflight.status}`,
    `Profile: ${envelope.data.profile}`,
    `Output: ${envelope.data.output_path}`,
    `Manifest: ${envelope.data.sync.manifest_path}`,
    ...envelope.data.setup_instructions.map((instruction) => `Next: ${instruction}`),
  ].join("\n");
}

function formatHumanDeployStatus(
  envelope: RuntimeSuccessEnvelope<"deploy.github-pages.status", GitHubPagesCheckResult>,
): string {
  return [
    "GitHub Pages deploy status",
    `Workflow: ${envelope.data.workflow.status}`,
    ...formatWorkflowIssue(envelope.data.workflow),
    `Profiles: ${envelope.data.profiles.status}`,
    ...formatProfileIssue(envelope.data.profiles),
    `Quartz: ${envelope.data.quartz.status}`,
    `Public preflight: ${envelope.data.public_preflight.status}`,
    ...envelope.data.setup_instructions.map((instruction) => `Next: ${instruction}`),
  ].join("\n");
}

function formatWorkflowIssue(workflow: GitHubPagesCheckResult["workflow"]): string[] {
  if (!workflow.error) {
    return [];
  }

  return [
    `Workflow issue: ${workflow.error.path}: ${workflow.error.message}`,
    `Workflow hint: ${workflow.error.hint}`,
  ];
}

function formatProfileIssue(profiles: GitHubPagesCheckResult["profiles"]): string[] {
  if (!profiles.error) {
    return [];
  }

  return [
    `Profile issue: ${profiles.error.path}: ${profiles.error.message}`,
    `Profile hint: ${profiles.error.hint}`,
  ];
}
