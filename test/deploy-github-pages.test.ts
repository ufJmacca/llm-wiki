import { EventEmitter } from "node:events";
import { execFile, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { constants, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { parseInitJson, pathExists, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileAsync = promisify(execFile);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn: spawnMock,
  };
});

type DeployInitEnvelope = {
  ok: true;
  command: "deploy.github-pages.init";
  repo: string;
  data: {
    workflow_path: ".github/workflows/llm-wiki-pages.yml";
    deploy_profile_path: string;
    public_profile_path: string;
    base_url: string;
    custom_domain: string | null;
    created_paths: string[];
    updated_paths: string[];
    instructions: string[];
  };
  warnings: string[];
};

type DeployBuildLocalEnvelope = {
  ok: true;
  command: "deploy.github-pages.build-local";
  repo: string;
  data: {
    profile: "github-pages";
    output_path: "quartz/public";
    steps: string[];
    sync: {
      manifest_path: ".llm-wiki/cache/quartz-manifest.github-pages.json";
    };
    lint: {
      counts: {
        error: number;
      };
    };
    quartz: {
      command: "npm";
      args: string[];
      cwd: string;
      exit_code: number;
    };
    workflow: {
      status: "valid" | "missing" | "invalid";
      path: string;
      error?: { code: string; message: string; path: string; hint: string };
    };
    profiles: {
      status: "valid" | "missing" | "invalid";
      paths: string[];
      error?: { code: string; message: string; path: string; hint: string };
    };
    quartz_readiness: { status: "ready" | "missing_runtime" | "missing_dependencies"; install_command: string };
    public_preflight: { status: "pass" | "fail"; issue_count: number };
    setup_instructions: string[];
  };
  warnings: string[];
};

type DeployStatusEnvelope = {
  ok: true;
  command: "deploy.github-pages.status";
  repo: string;
  data: {
    workflow: {
      status: "valid" | "missing" | "invalid";
      path: string;
      error?: { code: string; message: string; path: string; hint: string };
    };
    profiles: {
      status: "valid" | "missing" | "invalid";
      paths: string[];
      error?: { code: string; message: string; path: string; hint: string };
    };
    quartz: { status: "ready" | "missing_runtime" | "missing_dependencies"; install_command: string };
    public_preflight: { status: "pass" | "fail"; issue_count: number };
    setup_instructions: string[];
  };
  warnings: string[];
};

type DeployFailureEnvelope = {
  ok: false;
  command: string;
  repo: string;
  error: {
    code: string;
    message: string;
    hint: string;
  };
  issues: Array<{
    severity: "error";
    code: string;
    path: string;
    hint: string;
  }>;
};

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function initializeQuartzRuntime(wikiDir: string): Promise<void> {
  const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);

  expect(result.exitCode).toBe(0);
}

async function initializeGitRepository(wikiDir: string, remoteUrl: string, branch = "main"): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: wikiDir });
  await execFileAsync("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: wikiDir });
  await execFileAsync("git", ["remote", "add", "origin", remoteUrl], { cwd: wikiDir });
}

async function resolveExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") {
      continue;
    }

    const path = resolve(directory, name);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Keep searching PATH.
    }
  }

  throw new Error(`Could not locate ${name} on PATH.`);
}

async function markQuartzDependenciesInstalled(wikiDir: string): Promise<void> {
  await mkdir(resolve(wikiDir, "quartz/node_modules/.bin"), { recursive: true });
  await writeFile(resolve(wikiDir, "quartz/node_modules/.bin/quartz"), "#!/usr/bin/env node\n", "utf8");
  await mkdir(resolve(wikiDir, "quartz/quartz/components"), { recursive: true });
  await mkdir(resolve(wikiDir, "quartz/quartz/plugins"), { recursive: true });
  await writeFile(resolve(wikiDir, "quartz/quartz/build.ts"), "export {}\n", "utf8");
  await writeFile(resolve(wikiDir, "quartz/quartz/components/index.ts"), "export {}\n", "utf8");
  await writeFile(resolve(wikiDir, "quartz/quartz/plugins/index.ts"), "export {}\n", "utf8");
}

async function writeCuratedPage(
  wikiDir: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  const absolutePath = resolve(wikiDir, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    `---\n${Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? "[]" : String(value)}`)
      .join("\n")}\n---\n\n${body}`,
    "utf8",
  );
}

async function makeDefaultCuratedPagesPublic(wikiDir: string): Promise<void> {
  const pages = [
    ["curated/contradictions.md", "Contradictions"],
    ["curated/home.md", "Home"],
    ["curated/index.md", "Index"],
    ["curated/map.md", "Map"],
    ["curated/open-questions.md", "Open Questions"],
  ] as const;

  for (const [path, title] of pages) {
    await writeCuratedPage(
      wikiDir,
      path,
      {
        type: path === "curated/index.md" ? "index" : "page",
        title,
        visibility: "public",
        source_ids: [],
      },
      `# ${title}\n`,
    );
  }
}

function parseDeployInit(stdout: string[]): DeployInitEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as DeployInitEnvelope;
}

function parseDeployBuildLocal(stdout: string[]): DeployBuildLocalEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as DeployBuildLocalEnvelope;
}

function parseDeployStatus(stdout: string[]): DeployStatusEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as DeployStatusEnvelope;
}

function parseDeployFailure(stdout: string[]): DeployFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as DeployFailureEnvelope;
}

function mockSuccessfulQuartzBuild(): {
  githubPagesManifestExistedBeforeBuild: () => boolean;
  publicManifestExistedBeforeBuild: () => boolean;
} {
  let githubPagesManifestExistedBeforeBuild = false;
  let publicManifestExistedBeforeBuild = false;
  spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
    const cwd = typeof options.cwd === "string" ? options.cwd : "";
    const wikiDir = resolve(cwd, "..");
    githubPagesManifestExistedBeforeBuild = existsSync(
      resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.github-pages.json"),
    );
    publicManifestExistedBeforeBuild = existsSync(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.public.json"));
    rmSync(resolve(wikiDir, "quartz/public"), { recursive: true, force: true });
    mkdirSync(resolve(wikiDir, "quartz/public"), { recursive: true });
    writeFileSync(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");

    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => child.emit("close", 0, null));

    return child;
  });

  return {
    githubPagesManifestExistedBeforeBuild: () => githubPagesManifestExistedBeforeBuild,
    publicManifestExistedBeforeBuild: () => publicManifestExistedBeforeBuild,
  };
}

function mockQuartzBuildDoesNotCreatePublicOutput(): void {
  spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
    const cwd = typeof options.cwd === "string" ? options.cwd : "";
    const wikiDir = resolve(cwd, "..");
    rmSync(resolve(wikiDir, "quartz/public"), { recursive: true, force: true });

    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => child.emit("close", 0, null));

    return child;
  });
}

function mockQuartzBuildEmitsPublicUploadLeak(): void {
  spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
    const cwd = typeof options.cwd === "string" ? options.cwd : "";
    const wikiDir = resolve(cwd, "..");
    const leakDir = resolve(wikiDir, "quartz/public/assets");
    mkdirSync(leakDir, { recursive: true });
    writeFileSync(resolve(leakDir, "upload.js"), "LlmWikiUploadForm\n", "utf8");

    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => child.emit("close", 0, null));

    return child;
  });
}

function commandOrder(content: string, commands: readonly string[]): number[] {
  return commands.map((command) => content.indexOf(command));
}

function assertPublicProfileFailClosed(publicProfile: {
  features?: Record<string, unknown>;
  visibility?: { include_private?: boolean; required_value?: string };
  safety?: Record<string, unknown>;
}): void {
  expect(publicProfile.features).toMatchObject({
    upload: false,
    review: false,
    review_panel: false,
  });
  expect(publicProfile.visibility).toEqual({
    include_private: false,
    required_value: "public",
  });
  expect(publicProfile.safety).toMatchObject({
    fail_on_private_pages: true,
    fail_on_private_links: true,
    fail_on_raw_links: true,
    fail_on_missing_visibility: true,
    fail_on_public_graph_private_nodes: true,
    fail_on_public_search_private_text: true,
  });
}

function assertWorkflowUsesOnlyLeastPagesPermissions(workflow: string): void {
  const parsedWorkflow = parse(workflow) as Record<string, unknown>;
  const expectedPermissions = {
    contents: "read",
    pages: "write",
    "id-token": "write",
  };
  const workflowPermissions = expectPermissionRecord(parsedWorkflow.permissions);

  expect(workflowPermissions).toEqual(expectedPermissions);

  const jobs = isRecord(parsedWorkflow.jobs) ? parsedWorkflow.jobs : {};
  for (const [jobName, jobConfig] of Object.entries(jobs)) {
    const jobPermissions = isRecord(jobConfig) && "permissions" in jobConfig
      ? expectPermissionRecord(jobConfig.permissions)
      : workflowPermissions;

    expect(jobPermissions, `effective permissions for job ${jobName}`).toEqual(expectedPermissions);
    expect(Object.keys(jobPermissions).sort(), `permission keys for job ${jobName}`).toEqual(
      Object.keys(expectedPermissions).sort(),
    );
  }
}

function expectPermissionRecord(value: unknown): Record<string, string> {
  expect(isRecord(value)).toBe(true);
  const permissions = value as Record<string, unknown>;
  const normalized: Record<string, string> = {};

  for (const [key, permission] of Object.entries(permissions)) {
    expect(typeof permission, `permission value for ${key}`).toBe("string");
    normalized[key] = permission as string;
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("deploy github-pages commands", () => {
  it("initializes least-permission Pages workflow and fail-closed deploy profiles with inferred base URL", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-init-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--json"]);
      const payload = parseDeployInit(result.stdout);
      const workflow = await readGeneratedFile(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      const deployProfile = parse(await readGeneratedFile(wikiDir, ".llm-wiki/profiles/github-pages.yml")) as {
        name: string;
        mode: string;
        base_url: string;
        features: Record<string, unknown>;
        visibility: { include_private: boolean; required_value: string };
        safety: Record<string, boolean>;
      };
      const publicProfile = parse(await readGeneratedFile(wikiDir, ".llm-wiki/profiles/public.yml")) as {
        features: Record<string, unknown>;
        visibility: { include_private: boolean; required_value: string };
        safety: Record<string, boolean>;
      };

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data).toMatchObject({
        workflow_path: ".github/workflows/llm-wiki-pages.yml",
        deploy_profile_path: ".llm-wiki/profiles/github-pages.yml",
        public_profile_path: ".llm-wiki/profiles/public.yml",
        base_url: "https://example-org.github.io/research-wiki",
        custom_domain: null,
      });
      expect(payload.data.created_paths).toEqual([
        ".github/workflows/llm-wiki-pages.yml",
        ".llm-wiki/profiles/github-pages.yml",
      ]);
      expect(payload.data.instructions).toEqual([
        "Run llm-wiki deploy github-pages build-local to generate committed Pages output in quartz/public.",
        "Run llm-wiki deploy github-pages check before publishing.",
        "Commit quartz/public with the reviewed public source changes.",
        "Open a pull request for review before merging Pages output.",
        "In GitHub, enable Pages with Source: GitHub Actions.",
      ]);
      expect(workflow).toContain("on:\n  push:\n    branches: [\"main\"]\n  workflow_dispatch:");
      assertWorkflowUsesOnlyLeastPagesPermissions(workflow);
      expect(workflow).toContain("uses: actions/checkout@v4");
      expect(workflow).not.toContain("uses: actions/setup-node@v4");
      expect(workflow).not.toContain("node-version: 22");
      expect(workflow).not.toContain("run: npm ci");
      expect(workflow).not.toContain("cache: npm");
      expect(workflow).not.toContain("npm install --global llm-wiki");
      expect(workflow).not.toContain("llm-wiki explore init");
      expect(workflow).not.toContain("cd quartz && npm install");
      expect(workflow).not.toContain("llm-wiki explore sync");
      expect(workflow).not.toContain("llm-wiki ingest");
      expect(workflow).not.toContain("llm-wiki lint --profile github-pages --strict");
      expect(workflow).not.toContain("llm-wiki explore build");
      expect(workflow).not.toContain("cp .llm-wiki/cache/github-pages-CNAME quartz/public/CNAME");
      expect(workflow).toContain("uses: actions/upload-pages-artifact@v3");
      expect(workflow).toContain("path: quartz/public");
      expect(workflow).toContain("uses: actions/deploy-pages@v4");
      const workflowOrder = commandOrder(workflow, [
        "uses: actions/checkout@v4",
        "uses: actions/upload-pages-artifact@v3",
        "uses: actions/deploy-pages@v4",
      ]);
      expect(workflowOrder.every((index) => index >= 0)).toBe(true);
      expect(workflowOrder).toEqual([...workflowOrder].sort((left, right) => left - right));
      expect(deployProfile).toMatchObject({
        name: "github-pages",
        mode: "deploy",
        base_url: "https://example-org.github.io/research-wiki",
        visibility: {
          include_private: false,
          required_value: "public",
        },
        features: {
          upload: false,
          review: false,
          review_panel: false,
        },
      });
      expect(deployProfile.safety).toMatchObject({
        fail_on_private_pages: true,
        fail_on_private_links: true,
        fail_on_raw_links: true,
        fail_on_missing_visibility: true,
        fail_on_public_graph_private_nodes: true,
        fail_on_public_search_private_text: true,
      });
      assertPublicProfileFailClosed(publicProfile);
    });
  });

  it("leaves Quartz content generation to local sync outside the generated publisher workflow", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-workflow-homepage-sync-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const workflow = await readGeneratedFile(wikiDir, ".github/workflows/llm-wiki-pages.yml");

      // Act
      const sync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const payload = JSON.parse(sync.stdout[0] ?? "{}") as {
        data: { generated_paths: string[]; materialized_paths: string[] };
      };
      const curatedIndex = await readGeneratedFile(wikiDir, "quartz/content/curated/index.md");
      const buildHomepage = await readGeneratedFile(wikiDir, "quartz/content/index.md");

      // Assert
      expect(sync.exitCode).toBe(0);
      expect(sync.stderr).toEqual([]);
      expect(workflow).not.toContain("llm-wiki explore sync --profile github-pages");
      expect(workflow).not.toContain("llm-wiki explore build --profile github-pages");
      expect(payload.data.materialized_paths).toContain("quartz/content/curated/index.md");
      expect(payload.data.generated_paths).toContain("quartz/content/index.md");
      expect(buildHomepage).toBe(curatedIndex);
    });
  });

  it("removes legacy quartz/public gitignore rules during deploy init", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-init-public-gitignore-migration-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await writeFile(
        resolve(wikiDir, ".gitignore"),
        ".DS_Store\n.llm-wiki/cache/\nquartz/content/\n/quartz/public/\nquartz/public/**\nquartz/quartz/\n",
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--json"]);
      const payload = parseDeployInit(result.stdout);
      const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual(["Removed legacy quartz/public ignore rule from .gitignore."]);
      expect(payload.data.updated_paths).toContain(".gitignore");
      expect(gitignore).toContain("quartz/content/");
      expect(gitignore).toContain("quartz/quartz/");
      expect(gitignore).not.toContain("quartz/public/");
      expect(gitignore).not.toContain("quartz/public/**");
    });
  });

  it("accepts a symlinked .gitignore when no legacy quartz/public migration is needed", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-symlink-gitignore-no-migration-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      mockSuccessfulQuartzBuild();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const linkedGitignorePath = resolve(workspaceDir, "linked-gitignore");
      const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");
      await writeFile(linkedGitignorePath, gitignore, "utf8");
      await rm(resolve(wikiDir, ".gitignore"));
      await symlink(linkedGitignorePath, resolve(wikiDir, ".gitignore"), "file");

      // Act
      const init = await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--json"]);
      const buildLocal = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir, "--json"]);
      const initPayload = parseDeployInit(init.stdout);
      const buildPayload = parseDeployBuildLocal(buildLocal.stdout);

      // Assert
      expect(init.exitCode).toBe(0);
      expect(initPayload.warnings).toEqual([]);
      expect(initPayload.data.updated_paths).not.toContain(".gitignore");
      expect(buildLocal.exitCode).toBe(0);
      expect(buildPayload.warnings).not.toContain("Removed legacy quartz/public ignore rule from .gitignore.");
      expect(await readFile(linkedGitignorePath, "utf8")).toBe(gitignore);
    });
  });

  it("rejects forbidden publisher workflow steps hidden in non-deploy jobs", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-extra-job-publisher-steps-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      const workflowPath = resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        workflowPath,
        `${await readFile(workflowPath, "utf8")}
  remote-build:
    runs-on: ubuntu-latest
    steps:
      - name: Hidden remote build
        run: |
          npm install --global llm-wiki
          llm-wiki explore sync --profile github-pages
`,
        "utf8",
      );

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(parseDeployStatus(status.stdout).data.workflow.status).toBe("invalid");
      expect(check.exitCode).toBe(1);
      expect(parseDeployFailure(check.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
    });
  });

  it("rejects unlisted run steps before uploading the committed Pages artifact", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-build-run-step-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      const workflowPath = resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        workflowPath,
        (await readFile(workflowPath, "utf8")).replace(
          "      - name: Upload committed Pages artifact\n",
          "      - name: Build in CI\n        run: npm run build\n      - name: Upload committed Pages artifact\n",
        ),
        "utf8",
      );

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(parseDeployStatus(status.stdout).data.workflow.status).toBe("invalid");
      expect(check.exitCode).toBe(1);
      expect(parseDeployFailure(check.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
    });
  });

  it("rejects unlisted action steps before uploading the committed Pages artifact", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-build-action-step-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      const workflowPath = resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        workflowPath,
        (await readFile(workflowPath, "utf8")).replace(
          "      - name: Upload committed Pages artifact\n",
          "      - name: Local composite build\n        uses: ./.github/actions/build-quartz\n      - name: Upload committed Pages artifact\n",
        ),
        "utf8",
      );

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(parseDeployStatus(status.stdout).data.workflow.status).toBe("invalid");
      expect(check.exitCode).toBe(1);
      expect(parseDeployFailure(check.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
    });
  });

  it("rejects checkout steps that repopulate the committed Pages artifact before upload", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-artifact-checkout-step-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      const workflowPath = resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        workflowPath,
        (await readFile(workflowPath, "utf8")).replace(
          "      - name: Upload committed Pages artifact\n",
          "      - name: Checkout unreviewed Pages artifact\n        uses: actions/checkout@v4\n        with:\n          repository: example-org/unreviewed-pages\n          path: quartz/public\n      - name: Upload committed Pages artifact\n",
        ),
        "utf8",
      );

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(parseDeployStatus(status.stdout).data.workflow.status).toBe("invalid");
      expect(check.exitCode).toBe(1);
      expect(parseDeployFailure(check.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
    });
  });

  it("rejects job-level reusable workflow jobs", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-reusable-workflow-job-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      const workflowPath = resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        workflowPath,
        `${await readFile(workflowPath, "utf8")}
  remote-build:
    uses: ./.github/workflows/build-quartz.yml
`,
        "utf8",
      );

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(parseDeployStatus(status.stdout).data.workflow.status).toBe("invalid");
      expect(check.exitCode).toBe(1);
      expect(parseDeployFailure(check.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
    });
  });

  it("infers the Pages URL from credentialed GitHub HTTPS remotes", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-credentialed-https-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "https://x-access-token:TOKEN@github.com/example-org/research-wiki.git");

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--json"]);
      const payload = parseDeployInit(result.stdout);
      const deployProfile = parse(await readGeneratedFile(wikiDir, ".llm-wiki/profiles/github-pages.yml")) as {
        base_url: string;
      };

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.base_url).toBe("https://example-org.github.io/research-wiki");
      expect(deployProfile.base_url).toBe("https://example-org.github.io/research-wiki");
    });
  });

  it("rejects init when the wiki root is below an ancestor Git repository", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-nested-git-root-", async (workspaceDir) => {
      // Arrange
      const gitRoot = resolve(workspaceDir, "repo");
      const wikiDir = resolve(gitRoot, "wiki");
      await mkdir(gitRoot, { recursive: true });
      await initializeGitRepository(gitRoot, "git@github.com:example-org/research-wiki.git");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe("GITHUB_PAGES_WIKI_ROOT_NOT_GIT_ROOT");
      expect(payload.error.message).toBe("GitHub Pages deploy init requires the wiki root to be the Git repository root.");
      expect(payload.error.hint).toContain(gitRoot);
      expect(payload.issues[0]).toMatchObject({
        path: ".github/workflows/llm-wiki-pages.yml",
      });
      expect(await pathExists(resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"))).toBe(false);
    });
  });

  it("accepts CRLF-normalized generated workflows during check and status validation", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-crlf-workflow-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      const workflowPath = resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      const workflow = await readFile(workflowPath, "utf8");
      await writeFile(workflowPath, workflow.replace(/\n/gu, "\r\n"), "utf8");

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(parseDeployStatus(status.stdout).data.workflow.status).toBe("valid");
      expect(check.exitCode).toBe(1);
      expect(parseDeployFailure(check.stdout).error.code).toBe("QUARTZ_RUNTIME_MISSING");
    });
  });

  it("rejects a symlinked generated workflow before reading or skipping it", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-symlink-workflow-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      const workflowPath = resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      const linkedWorkflowPath = resolve(workspaceDir, "linked-llm-wiki-pages.yml");
      const workflow = await readFile(workflowPath, "utf8");
      await writeFile(linkedWorkflowPath, workflow, "utf8");
      await rm(workflowPath);
      await symlink(linkedWorkflowPath, workflowPath, "file");

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const humanStatus = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const init = await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        wikiDir,
        "--custom-domain",
        "docs.example.com",
        "--json",
      ]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);
      const initPayload = parseDeployFailure(init.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.workflow).toMatchObject({
        status: "invalid",
        path: ".github/workflows/llm-wiki-pages.yml",
        error: {
          code: "GITHUB_PAGES_FILE_INVALID",
          path: ".github/workflows/llm-wiki-pages.yml",
        },
      });
      expect(statusPayload.data.workflow.error?.message).toContain("not a symlink");
      expect(humanStatus.stdout.join("\n")).toContain("Workflow issue: .github/workflows/llm-wiki-pages.yml");
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error.code).toBe("GITHUB_PAGES_FILE_INVALID");
      expect(checkPayload.issues[0]).toMatchObject({
        path: ".github/workflows/llm-wiki-pages.yml",
      });
      expect(init.exitCode).toBe(1);
      expect(initPayload.error.code).toBe("GITHUB_PAGES_FILE_INVALID");
      expect(await readFile(linkedWorkflowPath, "utf8")).toBe(workflow);
    });
  });

  it.each([
    { parentPath: ".github", linkedPath: "linked-github", targetPath: "linked-github/workflows/llm-wiki-pages.yml" },
    {
      parentPath: ".github/workflows",
      linkedPath: "linked-workflows",
      targetPath: "linked-workflows/llm-wiki-pages.yml",
    },
  ])("rejects symlinked workflow parent directories: $parentPath", async ({ parentPath, linkedPath, targetPath }) => {
    await withTempWorkspace("llm-wiki-deploy-pages-symlink-workflow-parent-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      const workflowPath = resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      const workflow = await readFile(workflowPath, "utf8");
      const linkedWorkflowPath = resolve(workspaceDir, targetPath);
      await mkdir(dirname(linkedWorkflowPath), { recursive: true });
      await writeFile(linkedWorkflowPath, workflow, "utf8");
      await rm(resolve(wikiDir, parentPath), { recursive: true });
      await symlink(resolve(workspaceDir, linkedPath), resolve(wikiDir, parentPath), "dir");

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const humanStatus = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const init = await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        wikiDir,
        "--custom-domain",
        "docs.example.com",
        "--json",
      ]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);
      const initPayload = parseDeployFailure(init.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.workflow).toMatchObject({
        status: "invalid",
        path: ".github/workflows/llm-wiki-pages.yml",
        error: {
          code: "GITHUB_PAGES_FILE_INVALID",
          path: ".github/workflows/llm-wiki-pages.yml",
        },
      });
      expect(statusPayload.data.workflow.error?.message).toContain("symlinked directories");
      expect(statusPayload.data.workflow.error?.message).toContain(parentPath);
      expect(humanStatus.stdout.join("\n")).toContain("Workflow issue: .github/workflows/llm-wiki-pages.yml");
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error.code).toBe("GITHUB_PAGES_FILE_INVALID");
      expect(init.exitCode).toBe(1);
      expect(initPayload.error.code).toBe("GITHUB_PAGES_FILE_INVALID");
      expect(await readFile(linkedWorkflowPath, "utf8")).toBe(workflow);
    });
  });

  it("rejects a schema-valid GitHub Pages deploy profile without a string base_url", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-profile-base-url-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"),
        `name: github-pages
mode: deploy
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
        "utf8",
      );

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(parseDeployStatus(status.stdout).data.profiles.status).toBe("invalid");
      expect(check.exitCode).toBe(1);
      expect(parseDeployFailure(check.stdout).error.code).toBe("PROFILE_INVALID");
    });
  });

  it.each([
    {
      profilePath: ".llm-wiki/profiles/github-pages.yml",
      mutate: (content: string) => content.replace("  upload: false", "  upload: true"),
      expectedCode: "PROFILE_UPLOAD_FEATURE_FORBIDDEN",
      expectedMessage: "upload",
    },
    {
      profilePath: ".llm-wiki/profiles/public.yml",
      mutate: (content: string) => content.replace("  review_panel: false", "  review_panel: true"),
      expectedCode: "PROFILE_REVIEW_FEATURE_FORBIDDEN",
      expectedMessage: "review_panel",
    },
  ] as const)(
    "maps forbidden public-like feature config in $profilePath to deploy profile error $expectedCode",
    async ({ profilePath, mutate, expectedCode, expectedMessage }) => {
      await withTempWorkspace("llm-wiki-deploy-pages-forbidden-profile-feature-", async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
        const absoluteProfilePath = resolve(wikiDir, profilePath);
        await writeFile(absoluteProfilePath, mutate(await readFile(absoluteProfilePath, "utf8")), "utf8");

        // Act
        const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
        const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
        const statusPayload = parseDeployStatus(status.stdout);
        const checkPayload = parseDeployFailure(check.stdout);

        // Assert
        expect(status.exitCode).toBe(0);
        expect(statusPayload.data.profiles).toMatchObject({
          status: "invalid",
          error: {
            code: expectedCode,
            path: profilePath,
            message: expect.stringContaining(expectedMessage),
          },
        });
        expect(check.exitCode).toBe(1);
        expect(checkPayload.error).toMatchObject({
          code: expectedCode,
          message: expect.stringContaining(expectedMessage),
        });
        expect(checkPayload.issues).toEqual([
          expect.objectContaining({
            code: expectedCode,
            path: profilePath,
          }),
        ]);
      });
    },
  );

  it.each(["not a url", "ftp://docs.example.com/wiki", "https://docs.example.com/wiki?preview=true", "https://docs.example.com/%2e%2e/private"])(
    "rejects edited deploy profile base_url values that are not safe absolute HTTPS URLs: %s",
    async (baseUrl) => {
      await withTempWorkspace("llm-wiki-deploy-pages-profile-invalid-base-url-", async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
        const profilePath = resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml");
        await writeFile(
          profilePath,
          (await readFile(profilePath, "utf8")).replace("base_url: https://docs.example.com", `base_url: ${baseUrl}`),
          "utf8",
        );

        // Act
        const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
        const humanStatus = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir]);
        const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
        const buildLocal = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir, "--json"]);
        const statusPayload = parseDeployStatus(status.stdout);
        const checkPayload = parseDeployFailure(check.stdout);
        const buildLocalPayload = parseDeployFailure(buildLocal.stdout);

        // Assert
        expect(status.exitCode).toBe(0);
        expect(statusPayload.data.profiles).toMatchObject({
          status: "invalid",
          error: {
            code: "PROFILE_INVALID",
            path: ".llm-wiki/profiles/github-pages.yml",
            message: "GitHub Pages deploy profile base_url must be an absolute HTTPS URL.",
          },
        });
        expect(statusPayload.data.profiles.error?.hint).toContain("without credentials, ports, query strings, fragments");
        expect(humanStatus.stdout.join("\n")).toContain("Profile issue: .llm-wiki/profiles/github-pages.yml");
        expect(check.exitCode).toBe(1);
        expect(checkPayload.error).toMatchObject({
          code: "PROFILE_INVALID",
          message: "GitHub Pages deploy profile base_url must be an absolute HTTPS URL.",
        });
        expect(buildLocal.exitCode).toBe(1);
        expect(buildLocalPayload.error).toMatchObject({
          code: "PROFILE_INVALID",
          message: "GitHub Pages deploy profile base_url must be an absolute HTTPS URL.",
        });
      });
    },
  );

  it("reuses existing supported .yaml deploy profile paths during init", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-yaml-profiles-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const publicProfile = await readGeneratedFile(wikiDir, ".llm-wiki/profiles/public.yml");
      await rm(resolve(wikiDir, ".llm-wiki/profiles/public.yml"));
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yaml"), publicProfile, "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yaml"), "name: github-pages\nmode: deploy\n", "utf8");

      // Act
      const result = await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        wikiDir,
        "--custom-domain",
        "docs.example.com",
        "--json",
      ]);
      const payload = parseDeployInit(result.stdout);
      const deployProfile = parse(await readGeneratedFile(wikiDir, ".llm-wiki/profiles/github-pages.yaml")) as {
        base_url: string;
      };
      const publicProfileYaml = parse(await readGeneratedFile(wikiDir, ".llm-wiki/profiles/public.yaml")) as {
        visibility: { include_private: boolean; required_value: string };
        safety: Record<string, unknown>;
      };

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.deploy_profile_path).toBe(".llm-wiki/profiles/github-pages.yaml");
      expect(payload.data.public_profile_path).toBe(".llm-wiki/profiles/public.yaml");
      expect(payload.data.updated_paths).toContain(".llm-wiki/profiles/github-pages.yaml");
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/profiles/public.yml"))).toBe(false);
      expect(deployProfile.base_url).toBe("https://docs.example.com");
      assertPublicProfileFailClosed(publicProfileYaml);
    });
  });

  it("generates the Pages workflow push trigger for the current branch", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-branch-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git", "docs-site");

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--json"]);
      const workflow = await readGeneratedFile(wikiDir, ".github/workflows/llm-wiki-pages.yml");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(workflow).toContain("on:\n  push:\n    branches: [\"docs-site\"]\n  workflow_dispatch:");
    });
  });

  it("infers the root Pages URL for user and organization Pages repositories", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-user-site-url-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:alice/alice.github.io.git");

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--json"]);
      const payload = parseDeployInit(result.stdout);
      const deployProfile = parse(await readGeneratedFile(wikiDir, ".llm-wiki/profiles/github-pages.yml")) as {
        base_url: string;
      };

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.data.base_url).toBe("https://alice.github.io");
      expect(deployProfile.base_url).toBe("https://alice.github.io");
    });
  });

  it("creates or re-hardens the public profile during deploy init and reports the path", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-profile-repair-", async (workspaceDir) => {
      // Arrange
      const missingPublicWiki = resolve(workspaceDir, "missing-public-profile");
      await initializeWiki(missingPublicWiki);
      await rm(resolve(missingPublicWiki, ".llm-wiki/profiles/public.yml"));

      const weakenedPublicWiki = resolve(workspaceDir, "weakened-public-profile");
      await initializeWiki(weakenedPublicWiki);
      await writeFile(
        resolve(weakenedPublicWiki, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - curated/**
exclude: []
visibility:
  include_private: true
features:
  search: true
  graph: true
  backlinks: true
  upload: true
source_links:
  allow_local_file_links: true
safety:
  fail_on_private_pages: false
  fail_on_private_links: false
  fail_on_raw_links: false
  fail_on_missing_visibility: false
`,
        "utf8",
      );

      // Act
      const missingResult = await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        missingPublicWiki,
        "--custom-domain",
        "missing.example.com",
        "--json",
      ]);
      const weakenedResult = await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        weakenedPublicWiki,
        "--custom-domain",
        "weakened.example.com",
        "--json",
      ]);
      const missingPayload = parseDeployInit(missingResult.stdout);
      const weakenedPayload = parseDeployInit(weakenedResult.stdout);
      const createdPublicProfile = parse(await readGeneratedFile(missingPublicWiki, ".llm-wiki/profiles/public.yml")) as {
        visibility: { include_private: boolean; required_value: string };
        safety: Record<string, unknown>;
      };
      const repairedPublicProfile = parse(await readGeneratedFile(weakenedPublicWiki, ".llm-wiki/profiles/public.yml")) as {
        visibility: { include_private: boolean; required_value: string };
        safety: Record<string, unknown>;
      };

      // Assert
      expect(missingResult.exitCode).toBe(0);
      expect(weakenedResult.exitCode).toBe(0);
      expect(missingPayload.data.created_paths).toContain(".llm-wiki/profiles/public.yml");
      expect(weakenedPayload.data.updated_paths).toContain(".llm-wiki/profiles/public.yml");
      assertPublicProfileFailClosed(createdPublicProfile);
      assertPublicProfileFailClosed(repairedPublicProfile);
    });
  });

  it("accepts a custom domain instead of inferring a GitHub Pages project URL", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-custom-domain-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        wikiDir,
        "--custom-domain",
        "docs.example.com",
        "--json",
      ]);
      const payload = parseDeployInit(result.stdout);
      const deployProfile = parse(await readGeneratedFile(wikiDir, ".llm-wiki/profiles/github-pages.yml")) as {
        base_url: string;
        custom_domain: string;
      };

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.base_url).toBe("https://docs.example.com");
      expect(payload.data.custom_domain).toBe("docs.example.com");
      expect(deployProfile).toMatchObject({
        base_url: "https://docs.example.com",
        custom_domain: "docs.example.com",
      });
    });
  });

  it.each(["https://", "/"])("rejects custom domain input that normalizes to empty: %s", async (customDomain) => {
    await withTempWorkspace("llm-wiki-deploy-pages-empty-custom-domain-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");

      // Act
      const result = await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        wikiDir,
        "--custom-domain",
        customDomain,
        "--json",
      ]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe("CUSTOM_DOMAIN_INVALID");
      expect(payload.issues[0]).toMatchObject({
        path: "--custom-domain",
      });
    });
  });

  it.each([
    "https://docs.example.com/wiki",
    "https://docs.example.com?preview=true",
    "https://docs.example.com#deploy",
    "docs.example.com/wiki",
    "docs.example.com?preview=true",
    "docs.example.com#deploy",
    "docs.example.com:443",
  ])("rejects custom domain input that is not host-only: %s", async (customDomain) => {
    await withTempWorkspace("llm-wiki-deploy-pages-invalid-custom-domain-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");

      // Act
      const result = await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        wikiDir,
        "--custom-domain",
        customDomain,
        "--json",
      ]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe("CUSTOM_DOMAIN_INVALID");
      expect(payload.issues[0]).toMatchObject({
        path: "--custom-domain",
      });
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml"))).toBe(false);
    });
  });

  it.each(["docs.example.com/wiki", "docs.example.com:443"])(
    "rejects edited deploy profile custom_domain values that are not host-only: %s",
    async (customDomain) => {
      await withTempWorkspace("llm-wiki-deploy-pages-profile-custom-domain-", async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
        const profilePath = resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml");
        await writeFile(
          profilePath,
          (await readFile(profilePath, "utf8")).replace("custom_domain: docs.example.com", `custom_domain: ${customDomain}`),
          "utf8",
        );

        // Act
        const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
        const humanStatus = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir]);
        const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
        const buildLocal = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir, "--json"]);
        const statusPayload = parseDeployStatus(status.stdout);
        const checkPayload = parseDeployFailure(check.stdout);
        const buildLocalPayload = parseDeployFailure(buildLocal.stdout);

        // Assert
        expect(status.exitCode).toBe(0);
        expect(statusPayload.data.profiles).toMatchObject({
          status: "invalid",
          error: {
            code: "PROFILE_INVALID",
            path: ".llm-wiki/profiles/github-pages.yml",
            message: "GitHub Pages deploy profile custom_domain must be a host name only.",
          },
        });
        expect(statusPayload.data.profiles.error?.hint).toContain("without a path, query, fragment, or port");
        expect(humanStatus.stdout.join("\n")).toContain("Profile issue: .llm-wiki/profiles/github-pages.yml");
        expect(check.exitCode).toBe(1);
        expect(checkPayload.error).toMatchObject({
          code: "PROFILE_INVALID",
          message: "GitHub Pages deploy profile custom_domain must be a host name only.",
        });
        expect(buildLocal.exitCode).toBe(1);
        expect(buildLocalPayload.error).toMatchObject({
          code: "PROFILE_INVALID",
          message: "GitHub Pages deploy profile custom_domain must be a host name only.",
        });
      });
    },
  );

  it("rejects edited deploy profiles when custom_domain and base_url hosts differ", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-profile-domain-mismatch-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      const profilePath = resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml");
      await writeFile(
        profilePath,
        (await readFile(profilePath, "utf8")).replace("base_url: https://docs.example.com", "base_url: https://org.github.io/repo"),
        "utf8",
      );
      const configPath = resolve(wikiDir, "quartz/quartz.config.ts");
      const originalConfig = await readFile(configPath, "utf8");

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const humanStatus = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const buildLocal = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir, "--json"]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);
      const buildLocalPayload = parseDeployFailure(buildLocal.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.profiles).toMatchObject({
        status: "invalid",
        error: {
          code: "PROFILE_INVALID",
          path: ".llm-wiki/profiles/github-pages.yml",
          message: "GitHub Pages deploy profile base_url host must match custom_domain.",
        },
      });
      expect(statusPayload.data.profiles.error?.hint).toContain("Set base_url to https://docs.example.com");
      expect(humanStatus.stdout.join("\n")).toContain("Profile issue: .llm-wiki/profiles/github-pages.yml");
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error).toMatchObject({
        code: "PROFILE_INVALID",
        message: "GitHub Pages deploy profile base_url host must match custom_domain.",
      });
      expect(buildLocal.exitCode).toBe(1);
      expect(buildLocalPayload.error).toMatchObject({
        code: "PROFILE_INVALID",
        message: "GitHub Pages deploy profile base_url host must match custom_domain.",
      });
      await expect(readFile(configPath, "utf8")).resolves.toBe(originalConfig);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/github-pages-CNAME"))).toBe(false);
    });
  });

  it("rejects edited deploy profiles when custom_domain base_url includes a path", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-profile-domain-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      const profilePath = resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml");
      await writeFile(
        profilePath,
        (await readFile(profilePath, "utf8")).replace("base_url: https://docs.example.com", "base_url: https://docs.example.com/wiki"),
        "utf8",
      );
      const configPath = resolve(wikiDir, "quartz/quartz.config.ts");
      const originalConfig = await readFile(configPath, "utf8");

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const humanStatus = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const buildLocal = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir, "--json"]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);
      const buildLocalPayload = parseDeployFailure(buildLocal.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.profiles).toMatchObject({
        status: "invalid",
        error: {
          code: "PROFILE_INVALID",
          path: ".llm-wiki/profiles/github-pages.yml",
          message: "GitHub Pages deploy profile base_url must use custom_domain at the domain root.",
        },
      });
      expect(statusPayload.data.profiles.error?.hint).toContain("Set base_url to https://docs.example.com");
      expect(humanStatus.stdout.join("\n")).toContain("Profile issue: .llm-wiki/profiles/github-pages.yml");
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error).toMatchObject({
        code: "PROFILE_INVALID",
        message: "GitHub Pages deploy profile base_url must use custom_domain at the domain root.",
      });
      expect(buildLocal.exitCode).toBe(1);
      expect(buildLocalPayload.error).toMatchObject({
        code: "PROFILE_INVALID",
        message: "GitHub Pages deploy profile base_url must use custom_domain at the domain root.",
      });
      await expect(readFile(configPath, "utf8")).resolves.toBe(originalConfig);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/github-pages-CNAME"))).toBe(false);
    });
  });

  it("clears the generated Pages baseUrl when syncing a non-Pages profile", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-clear-base-url-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const githubPagesSync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const pagesConfig = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");
      const publicSync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "public", "--json"]);
      const publicConfig = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");

      // Assert
      expect(githubPagesSync.exitCode).toBe(0);
      expect(publicSync.exitCode).toBe(0);
      expect(pagesConfig).toContain("// llm-wiki generated baseUrl");
      expect(pagesConfig).toContain('baseUrl: "docs.example.com",');
      expect(publicConfig).not.toContain("// llm-wiki generated baseUrl");
      expect(publicConfig).not.toContain("baseUrl:");
    });
  });

  it("does not rewrite an unrelated configuration object before the exported Quartz config", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-scoped-base-url-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const configPath = resolve(wikiDir, "quartz/quartz.config.ts");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        config.replace(
          "const config: QuartzConfig = {",
          `const helperPlugin = {
  configuration: {
    baseUrl: "plugin.example",
  },
}

const config: QuartzConfig = {`,
        ),
        "utf8",
      );

      // Act
      const sync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const syncedConfig = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");

      // Assert
      expect(sync.exitCode).toBe(0);
      expect(sync.stderr).toEqual([]);
      expect(syncedConfig).toContain('const helperPlugin = {\n  configuration: {\n    baseUrl: "plugin.example",\n  },\n}');
      expect(syncedConfig).toMatch(
        /configuration: \{\n\s*\/\/ llm-wiki generated baseUrl\n\s*baseUrl: "docs\.example\.com",\n\s*pageTitle: "LLM Wiki",/u,
      );
    });
  });

  it("inserts the Pages baseUrl when only a nested Quartz configuration baseUrl exists", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-nested-base-url-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const configPath = resolve(wikiDir, "quartz/quartz.config.ts");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        config.replace(
          '    pageTitle: "LLM Wiki",',
          `    nestedPluginConfig: {
      baseUrl: "nested.example",
    },
    pageTitle: "LLM Wiki",`,
        ),
        "utf8",
      );

      // Act
      const sync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const syncedConfig = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");

      // Assert
      expect(sync.exitCode).toBe(0);
      expect(sync.stderr).toEqual([]);
      expect(syncedConfig).toContain('nestedPluginConfig: {\n      baseUrl: "nested.example",\n    },');
      expect(syncedConfig).toMatch(
        /configuration: \{\n\s*\/\/ llm-wiki generated baseUrl\n\s*baseUrl: "docs\.example\.com",\n\s*nestedPluginConfig: \{/u,
      );
    });
  });

  it("preserves a user-managed Quartz baseUrl when syncing a profile without base_url", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-preserve-user-base-url-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const configPath = resolve(wikiDir, "quartz/quartz.config.ts");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        config.replace('    pageTitle: "LLM Wiki",', '    baseUrl: "docs.user.example",\n    pageTitle: "LLM Wiki",'),
        "utf8",
      );

      // Act
      const publicSync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "public", "--json"]);
      const publicConfig = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");

      // Assert
      expect(publicSync.exitCode).toBe(0);
      expect(publicSync.stderr).toEqual([]);
      expect(publicConfig).toContain('baseUrl: "docs.user.example",');
      expect(publicConfig).not.toContain("// llm-wiki generated baseUrl");
    });
  });

  it.each([
    ["template literal", "    baseUrl: `old.example.com`,", "`old.example.com`"],
    ["expression", "    baseUrl: process.env.BASE_URL,", "process.env.BASE_URL"],
  ])("replaces an existing Quartz baseUrl %s without duplicating the property", async (_label, baseUrlLine, oldValue) => {
    await withTempWorkspace("llm-wiki-deploy-pages-replace-custom-base-url-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const configPath = resolve(wikiDir, "quartz/quartz.config.ts");
      const config = await readFile(configPath, "utf8");
      await writeFile(
        configPath,
        config.replace('    pageTitle: "LLM Wiki",', `${baseUrlLine}\n    pageTitle: "LLM Wiki",`),
        "utf8",
      );

      // Act
      const sync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const syncedConfig = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");
      const baseUrlLines = syncedConfig.match(/^\s*baseUrl\s*:/gmu) ?? [];

      // Assert
      expect(sync.exitCode).toBe(0);
      expect(sync.stderr).toEqual([]);
      expect(baseUrlLines).toHaveLength(1);
      expect(syncedConfig).toContain("// llm-wiki generated baseUrl");
      expect(syncedConfig).toContain('baseUrl: "docs.example.com",');
      expect(syncedConfig).not.toContain(oldValue);
    });
  });

  it("reports check failures for missing workflow, invalid profile, missing Quartz dependencies, and public leaks", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-check-failures-", async (workspaceDir) => {
      // Arrange
      const missingWorkflowWiki = resolve(workspaceDir, "missing-workflow");
      await initializeWiki(missingWorkflowWiki);

      // Act
      const missingWorkflow = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        missingWorkflowWiki,
        "--json",
      ]);

      // Assert
      expect(missingWorkflow.exitCode).toBe(1);
      expect(parseDeployFailure(missingWorkflow.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_MISSING");

      // Act
      const missingWorkflowHuman = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        missingWorkflowWiki,
      ]);

      // Assert
      expect(missingWorkflowHuman.exitCode).toBe(1);
      expect(missingWorkflowHuman.stderr.join("\n")).toContain("Error: GitHub Pages workflow is missing.");
      expect(missingWorkflowHuman.stderr.join("\n")).toContain("Hint: Run llm-wiki deploy github-pages init.");

      // Arrange
      const invalidProfileWiki = resolve(workspaceDir, "invalid-profile");
      await initializeWiki(invalidProfileWiki);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", invalidProfileWiki, "--custom-domain", "docs.example.com"]);
      await writeFile(resolve(invalidProfileWiki, ".llm-wiki/profiles/github-pages.yml"), "name: github-pages\n", "utf8");

      // Act
      const invalidProfile = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        invalidProfileWiki,
        "--json",
      ]);

      // Assert
      expect(invalidProfile.exitCode).toBe(1);
      expect(parseDeployFailure(invalidProfile.stdout).error.code).toBe("PROFILE_INVALID");

      // Arrange
      const invalidPublicProfileWiki = resolve(workspaceDir, "invalid-public-profile");
      await initializeWiki(invalidPublicProfileWiki);
      await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        invalidPublicProfileWiki,
        "--custom-domain",
        "docs.example.com",
      ]);
      await writeFile(
        resolve(invalidPublicProfileWiki, ".llm-wiki/profiles/public.yml"),
        "name: public\ninclude:\n  - [broken\n",
        "utf8",
      );

      // Act
      const invalidPublicStatus = await runCliBuffered([
        "deploy",
        "github-pages",
        "status",
        "--repo",
        invalidPublicProfileWiki,
        "--json",
      ]);
      const invalidPublicHumanStatus = await runCliBuffered([
        "deploy",
        "github-pages",
        "status",
        "--repo",
        invalidPublicProfileWiki,
      ]);
      const invalidPublicProfile = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        invalidPublicProfileWiki,
        "--json",
      ]);
      const invalidPublicStatusPayload = parseDeployStatus(invalidPublicStatus.stdout);
      const invalidPublicProfilePayload = parseDeployFailure(invalidPublicProfile.stdout);

      // Assert
      expect(invalidPublicStatus.exitCode).toBe(0);
      expect(invalidPublicStatusPayload.data.profiles.status).toBe("invalid");
      expect(invalidPublicStatusPayload.data.profiles.error).toMatchObject({
        code: "PROFILE_INVALID",
        path: ".llm-wiki/profiles/public.yml",
      });
      expect(invalidPublicHumanStatus.stdout.join("\n")).toContain("Profile issue: .llm-wiki/profiles/public.yml");
      expect(invalidPublicProfile.exitCode).toBe(1);
      expect(invalidPublicProfilePayload.error.code).toBe("PROFILE_INVALID");
      expect(invalidPublicProfilePayload.issues[0]).toMatchObject({
        path: ".llm-wiki/profiles/public.yml",
      });

      // Arrange
      const invalidWorkflowWiki = resolve(workspaceDir, "invalid-workflow");
      await initializeWiki(invalidWorkflowWiki);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", invalidWorkflowWiki, "--custom-domain", "docs.example.com"]);
      const workflowPath = resolve(invalidWorkflowWiki, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        workflowPath,
        (await readFile(workflowPath, "utf8")).replace(
          "path: quartz/public",
          "path: quartz/content",
        ),
        "utf8",
      );

      // Act
      const invalidWorkflow = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        invalidWorkflowWiki,
        "--json",
      ]);
      const invalidWorkflowStatus = await runCliBuffered([
        "deploy",
        "github-pages",
        "status",
        "--repo",
        invalidWorkflowWiki,
        "--json",
      ]);

      // Assert
      expect(invalidWorkflow.exitCode).toBe(1);
      expect(parseDeployFailure(invalidWorkflow.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
      expect(invalidWorkflowStatus.exitCode).toBe(0);
      expect(parseDeployStatus(invalidWorkflowStatus.stdout).data.workflow.status).toBe("invalid");

      for (const [label, setupNodeAction] of [
        ["tagged", "actions/setup-node@v3"],
        ["pinned", "actions/setup-node@8f152b3d06b0286ee2e3a828bc0570901b6a096e"],
      ] as const) {
        // Arrange
        const setupNodeWorkflowWiki = resolve(workspaceDir, `${label}-setup-node-workflow`);
        await initializeWiki(setupNodeWorkflowWiki);
        await runCliBuffered([
          "deploy",
          "github-pages",
          "init",
          "--repo",
          setupNodeWorkflowWiki,
          "--custom-domain",
          "docs.example.com",
        ]);
        const setupNodeWorkflowPath = resolve(setupNodeWorkflowWiki, ".github/workflows/llm-wiki-pages.yml");
        await writeFile(
          setupNodeWorkflowPath,
          (await readFile(setupNodeWorkflowPath, "utf8")).replace(
            "      - name: Upload committed Pages artifact\n",
            `      - name: Set up Node\n        uses: ${setupNodeAction}\n      - name: Upload committed Pages artifact\n`,
          ),
          "utf8",
        );

        // Act
        const setupNodeWorkflow = await runCliBuffered([
          "deploy",
          "github-pages",
          "check",
          "--repo",
          setupNodeWorkflowWiki,
          "--json",
        ]);
        const setupNodeWorkflowStatus = await runCliBuffered([
          "deploy",
          "github-pages",
          "status",
          "--repo",
          setupNodeWorkflowWiki,
          "--json",
        ]);

        // Assert
        expect(setupNodeWorkflow.exitCode).toBe(1);
        expect(parseDeployFailure(setupNodeWorkflow.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
        expect(setupNodeWorkflowStatus.exitCode).toBe(0);
        expect(parseDeployStatus(setupNodeWorkflowStatus.stdout).data.workflow.status).toBe("invalid");
      }

      // Arrange
      const commentedWorkflowWiki = resolve(workspaceDir, "commented-workflow");
      await initializeWiki(commentedWorkflowWiki);
      await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        commentedWorkflowWiki,
        "--custom-domain",
        "docs.example.com",
      ]);
      const commentedWorkflowPath = resolve(commentedWorkflowWiki, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        commentedWorkflowPath,
        (await readFile(commentedWorkflowPath, "utf8")).replace(
          "      - name: Upload committed Pages artifact\n        uses: actions/upload-pages-artifact@v3\n        with:\n          path: quartz/public",
          "      # - name: Upload committed Pages artifact\n      #   uses: actions/upload-pages-artifact@v3\n      #   with:\n      #     path: quartz/public",
        ),
        "utf8",
      );

      // Act
      const commentedWorkflow = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        commentedWorkflowWiki,
        "--json",
      ]);
      const commentedWorkflowStatus = await runCliBuffered([
        "deploy",
        "github-pages",
        "status",
        "--repo",
        commentedWorkflowWiki,
        "--json",
      ]);

      // Assert
      expect(commentedWorkflow.exitCode).toBe(1);
      expect(parseDeployFailure(commentedWorkflow.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
      expect(commentedWorkflowStatus.exitCode).toBe(0);
      expect(parseDeployStatus(commentedWorkflowStatus.stdout).data.workflow.status).toBe("invalid");

      // Arrange
      const missingPushWorkflowWiki = resolve(workspaceDir, "missing-push-workflow");
      await initializeWiki(missingPushWorkflowWiki);
      await runCliBuffered([
        "deploy",
        "github-pages",
        "init",
        "--repo",
        missingPushWorkflowWiki,
        "--custom-domain",
        "docs.example.com",
      ]);
      const missingPushWorkflowPath = resolve(missingPushWorkflowWiki, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        missingPushWorkflowPath,
        (await readFile(missingPushWorkflowPath, "utf8")).replace(
          "on:\n  push:\n    branches: [\"main\"]\n  workflow_dispatch:",
          "on:\n  workflow_dispatch:",
        ),
        "utf8",
      );

      // Act
      const missingPushWorkflow = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        missingPushWorkflowWiki,
        "--json",
      ]);
      const missingPushWorkflowStatus = await runCliBuffered([
        "deploy",
        "github-pages",
        "status",
        "--repo",
        missingPushWorkflowWiki,
        "--json",
      ]);

      // Assert
      expect(missingPushWorkflow.exitCode).toBe(1);
      expect(parseDeployFailure(missingPushWorkflow.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
      expect(missingPushWorkflowStatus.exitCode).toBe(0);
      expect(parseDeployStatus(missingPushWorkflowStatus.stdout).data.workflow.status).toBe("invalid");

      // Arrange
      const extraPermissionsWiki = resolve(workspaceDir, "extra-workflow-permissions");
      await initializeWiki(extraPermissionsWiki);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", extraPermissionsWiki, "--custom-domain", "docs.example.com"]);
      const extraPermissionsWorkflowPath = resolve(extraPermissionsWiki, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        extraPermissionsWorkflowPath,
        (await readFile(extraPermissionsWorkflowPath, "utf8")).replace(
          "  id-token: write\n\nconcurrency:",
          "  id-token: write\n  actions: write\n\nconcurrency:",
        ),
        "utf8",
      );

      // Act
      const extraPermissionsWorkflow = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        extraPermissionsWiki,
        "--json",
      ]);
      const extraPermissionsStatus = await runCliBuffered([
        "deploy",
        "github-pages",
        "status",
        "--repo",
        extraPermissionsWiki,
        "--json",
      ]);

      // Assert
      expect(extraPermissionsWorkflow.exitCode).toBe(1);
      expect(parseDeployFailure(extraPermissionsWorkflow.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
      expect(extraPermissionsStatus.exitCode).toBe(0);
      expect(parseDeployStatus(extraPermissionsStatus.stdout).data.workflow.status).toBe("invalid");

      // Arrange
      const jobPermissionsWiki = resolve(workspaceDir, "job-workflow-permissions");
      await initializeWiki(jobPermissionsWiki);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", jobPermissionsWiki, "--custom-domain", "docs.example.com"]);
      const jobPermissionsWorkflowPath = resolve(jobPermissionsWiki, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        jobPermissionsWorkflowPath,
        (await readFile(jobPermissionsWorkflowPath, "utf8")).replace(
          "jobs:\n  deploy:\n",
          "jobs:\n  deploy:\n    permissions:\n      contents: write\n      pages: write\n      id-token: write\n",
        ),
        "utf8",
      );

      // Act
      const jobPermissionsWorkflow = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        jobPermissionsWiki,
        "--json",
      ]);
      const jobPermissionsStatus = await runCliBuffered([
        "deploy",
        "github-pages",
        "status",
        "--repo",
        jobPermissionsWiki,
        "--json",
      ]);

      // Assert
      expect(jobPermissionsWorkflow.exitCode).toBe(1);
      expect(parseDeployFailure(jobPermissionsWorkflow.stdout).error.code).toBe("GITHUB_PAGES_WORKFLOW_INVALID");
      expect(jobPermissionsStatus.exitCode).toBe(0);
      expect(parseDeployStatus(jobPermissionsStatus.stdout).data.workflow.status).toBe("invalid");

      // Arrange
      const missingDepsWiki = resolve(workspaceDir, "missing-deps");
      await initializeWiki(missingDepsWiki);
      await initializeQuartzRuntime(missingDepsWiki);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", missingDepsWiki, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(missingDepsWiki);

      // Act
      const missingDeps = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        missingDepsWiki,
        "--json",
      ]);

      // Assert
      expect(missingDeps.exitCode).toBe(1);
      expect(parseDeployFailure(missingDeps.stdout).error.code).toBe("QUARTZ_DEPENDENCIES_MISSING");

      // Arrange
      const leakWiki = resolve(workspaceDir, "public-leak");
      await initializeWiki(leakWiki);
      await initializeQuartzRuntime(leakWiki);
      await markQuartzDependenciesInstalled(leakWiki);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", leakWiki, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(leakWiki);
      await writeCuratedPage(
        leakWiki,
        "curated/topics/private-topic.md",
        {
          type: "topic",
          title: "Private Topic",
          visibility: "private",
          source_ids: [],
        },
        "# Private Topic\n\nPrivate page selected by the deploy profile.\n",
      );

      // Act
      const publicLeak = await runCliBuffered([
        "deploy",
        "github-pages",
        "check",
        "--repo",
        leakWiki,
        "--json",
      ]);

      // Assert
      expect(publicLeak.exitCode).toBe(1);
      expect(parseDeployFailure(publicLeak.stdout).error.code).toBe("PUBLIC_LINT_FAILED");
    });
  });

  it("fails check and status preflight when committed Quartz public output contains upload-capable code", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-static-upload-leak-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/assets/upload.js"), "LlmWikiUploadForm\n", "utf8");

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.public_preflight).toEqual({
        status: "fail",
        issue_count: 1,
      });
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error).toMatchObject({
        code: "PUBLIC_LINT_FAILED",
        message: "Public preflight failed before GitHub Pages deployment.",
      });
      expect(checkPayload.error.hint).toContain("llm-wiki lint --profile github-pages --strict");
    });
  });

  it("fails deploy check when Git still ignores committed Pages output", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-gitignore-check-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeFile(
        resolve(wikiDir, ".gitignore"),
        `${await readFile(resolve(wikiDir, ".gitignore"), "utf8")}quartz/public/\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error).toEqual({
        code: "GITHUB_PAGES_PUBLIC_IGNORED",
        message: "Committed GitHub Pages output is ignored by Git.",
        hint: "Remove ignore rules such as quartz/public/ or rerun llm-wiki deploy github-pages init before committing quartz/public.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "GITHUB_PAGES_PUBLIC_IGNORED",
          path: ".gitignore",
        }),
      ]);
    });
  });

  it("fails deploy check when committed Pages output has not been generated", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-artifact-missing-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir]);
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error).toEqual({
        code: "GITHUB_PAGES_PUBLIC_ARTIFACT_MISSING",
        message: "Committed GitHub Pages output is missing.",
        hint: "Run llm-wiki deploy github-pages build-local, then commit quartz/public before rerunning deploy checks.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "GITHUB_PAGES_PUBLIC_ARTIFACT_MISSING",
          path: "quartz/public",
        }),
      ]);
    });
  });

  it("fails deploy check when committed Pages output is missing index.html", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-index-missing-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public"), { recursive: true });

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error).toEqual({
        code: "GITHUB_PAGES_PUBLIC_ARTIFACT_INCOMPLETE",
        message: "Committed GitHub Pages output is incomplete.",
        hint: "Run llm-wiki deploy github-pages build-local, then commit quartz/public before rerunning deploy checks.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "GITHUB_PAGES_PUBLIC_ARTIFACT_INCOMPLETE",
          path: "quartz/public/index.html",
        }),
      ]);
    });
  });

  it.each([
    { label: "missing", cname: null, expectedCode: "GITHUB_PAGES_PUBLIC_ARTIFACT_INCOMPLETE" },
    { label: "stale", cname: "old.example.com\n", expectedCode: "GITHUB_PAGES_PUBLIC_ARTIFACT_INVALID" },
  ])("fails deploy check when custom-domain Pages CNAME is $label", async ({ cname, expectedCode }) => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-cname-invalid-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");
      if (cname !== null) {
        await writeFile(resolve(wikiDir, "quartz/public/CNAME"), cname, "utf8");
      }

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error.code).toBe(expectedCode);
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: expectedCode,
          path: "quartz/public/CNAME",
        }),
      ]);
    });
  });

  it("fails deploy check when Pages CNAME remains committed without a configured custom domain", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-cname-stale-without-domain-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");
      await writeFile(resolve(wikiDir, "quartz/public/CNAME"), "old.example.com\n", "utf8");

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error).toEqual({
        code: "GITHUB_PAGES_PUBLIC_ARTIFACT_INVALID",
        message: "Committed GitHub Pages custom domain artifact is stale.",
        hint: "Remove quartz/public/CNAME or rerun llm-wiki deploy github-pages build-local without a custom domain, then commit quartz/public.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "GITHUB_PAGES_PUBLIC_ARTIFACT_INVALID",
          path: "quartz/public/CNAME",
        }),
      ]);
    });
  });

  it("fails deploy check when Git trackability cannot be verified", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-trackability-unknown-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error).toEqual({
        code: "GITHUB_PAGES_PUBLIC_TRACKABILITY_UNKNOWN",
        message: "Could not verify that quartz/public is trackable.",
        hint: "Ensure Git is available and the wiki root is inside a Git worktree before rerunning deploy checks.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "GITHUB_PAGES_PUBLIC_TRACKABILITY_UNKNOWN",
          path: ".gitignore",
        }),
      ]);
    });
  });

  it("fails deploy check when a tracked Pages index still matches an ignore rule", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-tracked-index-ignore-check-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");
      await execFileAsync("git", ["add", "--", "quartz/public/index.html"], { cwd: wikiDir });
      await writeFile(
        resolve(wikiDir, ".gitignore"),
        `${await readFile(resolve(wikiDir, ".gitignore"), "utf8")}quartz/public/index.html\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error).toEqual({
        code: "GITHUB_PAGES_PUBLIC_IGNORED",
        message: "Committed GitHub Pages output is ignored by Git.",
        hint: "Remove ignore rules such as quartz/public/ or rerun llm-wiki deploy github-pages init before committing quartz/public.",
      });
    });
  });

  it("fails deploy check when Git ignores nested Pages asset output", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-nested-asset-gitignore-check-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");
      await writeFile(resolve(wikiDir, "quartz/public/assets/app.js"), "console.log('pages asset')\n", "utf8");
      await writeFile(
        resolve(wikiDir, ".gitignore"),
        `${await readFile(resolve(wikiDir, ".gitignore"), "utf8")}quartz/public/assets/\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(payload.error).toEqual({
        code: "GITHUB_PAGES_PUBLIC_IGNORED",
        message: "Committed GitHub Pages output is ignored by Git.",
        hint: "Remove ignore rules such as quartz/public/ or rerun llm-wiki deploy github-pages init before committing quartz/public.",
      });
    });
  });

  it("batches Pages artifact trackability checks through one Git check-ignore invocation", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-public-trackability-batched-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");
      for (let index = 0; index < 20; index += 1) {
        await writeFile(resolve(wikiDir, `quartz/public/assets/page-${index}.js`), "console.log('pages asset')\n", "utf8");
      }

      const realGit = await resolveExecutable("git");
      const gitWrapperDir = resolve(workspaceDir, "git-wrapper-bin");
      const gitWrapperPath = resolve(gitWrapperDir, "git");
      const counterPath = resolve(workspaceDir, "git-check-ignore-count");
      await mkdir(gitWrapperDir, { recursive: true });
      await writeFile(counterPath, "", "utf8");
      await writeFile(
        gitWrapperPath,
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const isCheckIgnore = args[0] === "check-ignore";
if (isCheckIgnore) {
  appendFileSync(process.env.LLM_WIKI_GIT_COUNTER_PATH, "check-ignore\\n");
}
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  encoding: "buffer",
  input: isCheckIgnore ? readFileSync(0) : undefined,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error(result.error.message);
  process.exit(127);
}
process.exit(result.status ?? 1);
`,
        "utf8",
      );
      await chmod(gitWrapperPath, 0o755);
      const originalPath = process.env.PATH;
      const originalCounterPath = process.env.LLM_WIKI_GIT_COUNTER_PATH;
      process.env.PATH = `${gitWrapperDir}${delimiter}${originalPath ?? ""}`;
      process.env.LLM_WIKI_GIT_COUNTER_PATH = counterPath;

      let result: Awaited<ReturnType<typeof runCliBuffered>>;
      try {
        // Act
        result = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      } finally {
        process.env.PATH = originalPath;
        if (originalCounterPath === undefined) {
          delete process.env.LLM_WIKI_GIT_COUNTER_PATH;
        } else {
          process.env.LLM_WIKI_GIT_COUNTER_PATH = originalCounterPath;
        }
      }
      const checkIgnoreCount = (await readFile(counterPath, "utf8")).trim().split("\n").filter(Boolean).length;

      // Assert
      expect(result.exitCode).toBe(0);
      expect(checkIgnoreCount).toBe(1);
    });
  });

  it("fails check and status preflight when the Pages Quartz config is missing", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-missing-quartz-config-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await rm(resolve(wikiDir, "quartz/quartz.config.ts"));

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.public_preflight).toEqual({
        status: "fail",
        issue_count: 1,
      });
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error).toMatchObject({
        code: "QUARTZ_WRITE_FAILED",
        message: "Quartz config is missing; cannot apply GitHub Pages baseUrl.",
      });
      expect(checkPayload.error.hint).toContain("Restore quartz/quartz.config.ts");
      expect(checkPayload.issues[0]).toMatchObject({
        path: "quartz/quartz.config.ts",
      });
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.github-pages.json"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
    });
  });

  it("fails check and status preflight for a symlinked Quartz config even when the Pages baseUrl is current", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-base-url-noop-symlink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const sync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      expect(sync.exitCode).toBe(0);

      const configPath = resolve(wikiDir, "quartz/quartz.config.ts");
      const configContent = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");
      const linkedConfigPath = resolve(workspaceDir, "linked-current-quartz.config.ts");
      expect(configContent).toContain('baseUrl: "docs.example.com",');
      await writeFile(linkedConfigPath, configContent, "utf8");
      await rm(configPath);
      await symlink(linkedConfigPath, configPath, "file");

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.public_preflight).toEqual({
        status: "fail",
        issue_count: 1,
      });
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error).toMatchObject({
        code: "QUARTZ_WRITE_FAILED",
      });
      expect(checkPayload.error.message).toContain("destination file is a symlink: quartz/quartz.config.ts");
      expect(checkPayload.issues[0]).toMatchObject({
        path: "quartz/quartz.config.ts",
      });
      expect(await readFile(linkedConfigPath, "utf8")).toBe(configContent);
    });
  });

  it("fails check and status preflight when GitHub Pages sync cannot update the Quartz baseUrl", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-base-url-dry-run-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const customConfig = `import { QuartzConfig } from "./quartz/cfg"

const customConfiguration = {
  pageTitle: "Custom Wiki",
}

const config: QuartzConfig = {
  configuration: customConfiguration,
  plugins: {},
}

export default config
`;
      await writeFile(resolve(wikiDir, "quartz/quartz.config.ts"), customConfig, "utf8");

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);
      const configAfterCheck = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.public_preflight).toEqual({
        status: "fail",
        issue_count: 1,
      });
      expect(statusPayload.data.setup_instructions).toContain(
        "Run llm-wiki explore sync --profile github-pages and llm-wiki lint --profile github-pages --strict, then fix public preflight errors.",
      );
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error).toMatchObject({
        code: "QUARTZ_WRITE_FAILED",
        message: "Failed to locate Quartz configuration block for GitHub Pages baseUrl.",
      });
      expect(checkPayload.error.hint).toContain("configuration: {");
      expect(checkPayload.issues[0]).toMatchObject({
        path: "quartz/quartz.config.ts",
      });
      expect(configAfterCheck).toBe(customConfig);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.github-pages.json"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
    });
  });

  it("fails check and status preflight when the Quartz config baseUrl write target is unsafe", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-base-url-symlink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);

      const configPath = resolve(wikiDir, "quartz/quartz.config.ts");
      const configContent = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");
      const linkedConfigPath = resolve(workspaceDir, "linked-quartz.config.ts");
      await writeFile(linkedConfigPath, configContent, "utf8");
      await rm(configPath);
      await symlink(linkedConfigPath, configPath, "file");

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.public_preflight).toEqual({
        status: "fail",
        issue_count: 1,
      });
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error).toMatchObject({
        code: "QUARTZ_WRITE_FAILED",
      });
      expect(checkPayload.error.message).toContain("destination file is a symlink: quartz/quartz.config.ts");
      expect(checkPayload.error.hint).toContain("must not follow symlinks");
      expect(checkPayload.issues[0]).toMatchObject({
        path: "quartz/quartz.config.ts",
        hint: expect.stringContaining("must not follow symlinks"),
      });
      expect(await readFile(linkedConfigPath, "utf8")).toBe(configContent);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.github-pages.json"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
    });
  });

  it("fails check and status preflight when the github-pages profile excludes curated/index.md", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-index-excluded-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);

      const profilePath = resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml");
      await writeFile(
        profilePath,
        (await readFile(profilePath, "utf8")).replace(
          "  - curated/sources/**\n",
          "  - curated/sources/**\n  - curated/index.md\n",
        ),
        "utf8",
      );

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.public_preflight).toEqual({
        status: "fail",
        issue_count: 1,
      });
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error).toMatchObject({
        code: "QUARTZ_CONTENT_UNSAFE",
        message: "GitHub Pages profile does not materialize curated/index.md for the Quartz build homepage.",
      });
      expect(checkPayload.issues[0]).toMatchObject({
        path: "curated/index.md",
        hint: expect.stringContaining("Make curated/index.md eligible for the github-pages profile"),
      });
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.github-pages.json"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
    });
  });

  it("fails check and status preflight when quartz/content is not a safe generated directory", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-content-target-unsafe-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeFile(resolve(wikiDir, "quartz/content"), "user-managed content placeholder\n", "utf8");

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.public_preflight).toEqual({
        status: "fail",
        issue_count: 1,
      });
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error).toMatchObject({
        code: "QUARTZ_CONTENT_UNSAFE",
        message: "Quartz content path is not a safe generated directory.",
      });
      expect(checkPayload.error.hint).toContain("destination parent is not a directory: quartz/content");
      expect(checkPayload.issues[0]).toMatchObject({
        path: "quartz/content",
      });
      await expect(readFile(resolve(wikiDir, "quartz/content"), "utf8")).resolves.toBe("user-managed content placeholder\n");
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.github-pages.json"))).toBe(false);
    });
  });

  it("runs local build preflight in the same sync, strict lint, build order as the workflow", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-build-local-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockSuccessfulQuartzBuild();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir, "git@github.com:example-org/research-wiki.git");
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");

      // Act
      const checkResult = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir]);
      const result = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir, "--json"]);
      const humanResult = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir]);
      const payload = parseDeployBuildLocal(result.stdout);
      const workflow = await readGeneratedFile(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      const quartzConfig = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");

      // Assert
      expect(checkResult.exitCode).toBe(0);
      expect(checkResult.stdout.join("\n")).toContain("GitHub Pages deploy check passed");
      expect(checkResult.stdout.join("\n")).toContain("Workflow: valid");
      expect(checkResult.stdout.join("\n")).toContain("Profiles: valid");
      expect(checkResult.stdout.join("\n")).toContain("Quartz: ready");
      expect(checkResult.stdout.join("\n")).toContain("Public preflight: pass");
      expect(checkResult.stdout.join("\n")).toContain("Next: Commit quartz/public with the reviewed public source changes.");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(humanResult.exitCode).toBe(0);
      expect(humanResult.stderr).toEqual([]);
      expect(humanResult.stdout.join("\n")).toContain("GitHub Pages local build complete");
      expect(humanResult.stdout.join("\n")).toContain("Workflow: valid");
      expect(humanResult.stdout.join("\n")).toContain("Profiles: valid");
      expect(humanResult.stdout.join("\n")).toContain("Quartz readiness: ready");
      expect(humanResult.stdout.join("\n")).toContain("Public preflight: pass");
      expect(humanResult.stdout.join("\n")).toContain("Next: Commit quartz/public with the reviewed public source changes.");
      expect(spawnObservation.githubPagesManifestExistedBeforeBuild()).toBe(true);
      expect(spawnObservation.publicManifestExistedBeforeBuild()).toBe(false);
      expect(quartzConfig).toContain('baseUrl: "example-org.github.io/research-wiki",');
      expect(spawnMock).toHaveBeenCalledWith(
        "npm",
        ["run", "build"],
        expect.objectContaining({ cwd: resolve(wikiDir, "quartz"), stdio: ["ignore", "pipe", "pipe"] }),
      );
      expect(payload.data).toMatchObject({
        profile: "github-pages",
        output_path: "quartz/public",
        steps: [
          "llm-wiki explore build --profile github-pages",
          "materialize .llm-wiki/cache/github-pages-CNAME to quartz/public/CNAME when configured",
          "scan quartz/public for static leaks",
        ],
        sync: {
          manifest_path: ".llm-wiki/cache/quartz-manifest.github-pages.json",
        },
        lint: {
          counts: {
            error: 0,
          },
        },
        workflow: {
          status: "valid",
          path: ".github/workflows/llm-wiki-pages.yml",
        },
        profiles: {
          status: "valid",
          paths: [".llm-wiki/profiles/github-pages.yml", ".llm-wiki/profiles/public.yml"],
        },
        quartz_readiness: {
          status: "ready",
          install_command: "cd quartz && npm install",
        },
        public_preflight: {
          status: "pass",
          issue_count: 0,
        },
        setup_instructions: [
          "Run llm-wiki deploy github-pages build-local to generate committed Pages output in quartz/public.",
          "Run llm-wiki deploy github-pages check before publishing.",
          "Commit quartz/public with the reviewed public source changes.",
          "Open a pull request for review before merging Pages output.",
          "In GitHub, enable Pages with Source: GitHub Actions.",
        ],
      });
      expect(workflow).not.toContain("llm-wiki explore sync --profile github-pages");
      expect(workflow).not.toContain("llm-wiki lint --profile github-pages --strict");
      expect(workflow).not.toContain("llm-wiki explore build --profile github-pages");
      expect(workflow).not.toContain("cp .llm-wiki/cache/github-pages-CNAME quartz/public/CNAME");
      expect(workflow.indexOf("uses: actions/checkout@v4")).toBeLessThan(
        workflow.indexOf("uses: actions/upload-pages-artifact@v3"),
      );
      expect(workflow.indexOf("path: quartz/public")).toBeLessThan(
        workflow.indexOf("uses: actions/deploy-pages@v4"),
      );
    });
  });

  it("emits a root CNAME artifact for custom-domain Pages builds", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-cname-artifact-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      mockSuccessfulQuartzBuild();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir, "--json"]);
      const workflow = await readGeneratedFile(wikiDir, ".github/workflows/llm-wiki-pages.yml");
      const cachedCname = await readGeneratedFile(wikiDir, ".llm-wiki/cache/github-pages-CNAME");
      const artifactCname = await readGeneratedFile(wikiDir, "quartz/public/CNAME");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(cachedCname).toBe("docs.example.com\n");
      expect(artifactCname).toBe("docs.example.com\n");
      expect(workflow).not.toContain("cp .llm-wiki/cache/github-pages-CNAME quartz/public/CNAME");
      expect(workflow).toContain("path: quartz/public");
    });
  });

  it("fails check and status preflight when github-pages sync would exclude a linked public page", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-excluded-public-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/sources/public-summary.md",
        {
          type: "source_summary",
          title: "Excluded Public Summary",
          visibility: "public",
          source_ids: [],
        },
        "# Excluded Public Summary\n\nThis page is public but excluded by the deploy profile.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nSee [[Excluded Public Summary]].\n",
      );

      // Act
      const status = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const check = await runCliBuffered(["deploy", "github-pages", "check", "--repo", wikiDir, "--json"]);
      const statusPayload = parseDeployStatus(status.stdout);
      const checkPayload = parseDeployFailure(check.stdout);

      // Assert
      expect(status.exitCode).toBe(0);
      expect(statusPayload.data.public_preflight).toEqual({
        status: "fail",
        issue_count: 1,
      });
      expect(statusPayload.data.setup_instructions).toContain(
        "Run llm-wiki explore sync --profile github-pages and llm-wiki lint --profile github-pages --strict, then fix public preflight errors.",
      );
      expect(check.exitCode).toBe(1);
      expect(checkPayload.error).toMatchObject({
        code: "PUBLIC_LINT_FAILED",
        message: "Public preflight failed before GitHub Pages deployment.",
      });
      expect(checkPayload.error.hint).toContain("llm-wiki explore sync --profile github-pages");
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.github-pages.json"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
    });
  });

  it("fails build-local on strict public lint errors before spawning the Quartz build", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-build-local-lint-failure-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        {
          type: "topic",
          title: "Private Topic",
          visibility: "private",
          source_ids: [],
        },
        "# Private Topic\n\nPrivate body selected by the deploy profile but excluded by visibility.\n",
      );

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(payload.error).toEqual({
        code: "PUBLIC_LINT_FAILED",
        message: "Strict public lint failed before Quartz build.",
        hint: "Fix error-severity lint issues before building public Quartz output.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PUBLIC_LINT_FAILED",
          path: ".",
        }),
      ]);
      await expect(readFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.github-pages.json"), "utf8")).resolves.toContain(
        "\"profile\": \"github-pages\"",
      );
    });
  });

  it("fails build-local when Quartz exits successfully without producing the Pages output directory", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-build-local-missing-public-output-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      mockQuartzBuildDoesNotCreatePublicOutput();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).toHaveBeenCalled();
      expect(payload.error).toEqual({
        code: "PUBLIC_PROFILE_ARTIFACT_MISSING",
        message: "Quartz build did not produce the expected Pages output directory.",
        hint: "Ensure the Quartz build writes static Pages output to quartz/public before rerunning llm-wiki explore build.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PUBLIC_PROFILE_ARTIFACT_MISSING",
          path: "quartz/public",
        }),
      ]);
      expect(existsSync(resolve(wikiDir, "quartz/public/CNAME"))).toBe(false);
    });
  });

  it("fails build-local when the Quartz build emits static upload leaks into the Pages artifact", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-build-local-post-build-leak-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      mockQuartzBuildEmitsPublicUploadLeak();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["deploy", "github-pages", "build-local", "--repo", wikiDir, "--json"]);
      const payload = parseDeployFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).toHaveBeenCalled();
      expect(payload.error).toEqual({
        code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
        message: "Public profile leak check failed after Quartz build: public_static_upload_component_leak.",
        hint: "Remove upload, runtime, review, queue, raw, and secret data from committed GitHub Pages static output.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
          path: "quartz/public/assets/upload.js",
        }),
      ]);
    });
  });

  it("reports deploy status in JSON and human output with actionable setup instructions", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-status-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", wikiDir, "--custom-domain", "docs.example.com"]);
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const jsonResult = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir, "--json"]);
      const humanResult = await runCliBuffered(["deploy", "github-pages", "status", "--repo", wikiDir]);
      const payload = parseDeployStatus(jsonResult.stdout);

      // Assert
      expect(jsonResult.exitCode).toBe(0);
      expect(humanResult.exitCode).toBe(0);
      expect(payload.data.workflow).toEqual({
        status: "valid",
        path: ".github/workflows/llm-wiki-pages.yml",
      });
      expect(payload.data.profiles.status).toBe("valid");
      expect(payload.data.quartz).toEqual({
        status: "missing_dependencies",
        install_command: "cd quartz && npm install",
      });
      expect(payload.data.public_preflight.status).toBe("pass");
      expect(payload.data.setup_instructions).toEqual([
        "Run cd quartz && npm install before building GitHub Pages output.",
        "Run llm-wiki deploy github-pages build-local to generate committed Pages output in quartz/public.",
        "Run llm-wiki deploy github-pages check before publishing.",
        "Commit quartz/public with the reviewed public source changes.",
        "Open a pull request for review before merging Pages output.",
        "In GitHub, enable Pages with Source: GitHub Actions.",
      ]);
      expect(humanResult.stdout.join("\n")).toContain("GitHub Pages deploy status");
      expect(humanResult.stdout.join("\n")).toContain("Quartz: missing_dependencies");
      expect(humanResult.stdout.join("\n")).toContain("Run cd quartz && npm install before building GitHub Pages output");
      expect(humanResult.stdout.join("\n")).toContain("Commit quartz/public");
      expect(humanResult.stdout.join("\n")).toContain("enable Pages with Source: GitHub Actions");
      expect(await pathExists(resolve(wikiDir, ".github/workflows/llm-wiki-pages.yml"))).toBe(true);
    });
  });

  it("places setup repair guidance before the publish checklist for incomplete deploy status", async () => {
    await withTempWorkspace("llm-wiki-deploy-pages-status-incomplete-guidance-", async (workspaceDir) => {
      // Arrange
      const uninitializedWiki = resolve(workspaceDir, "uninitialized");
      await initializeWiki(uninitializedWiki);

      const invalidWorkflowWiki = resolve(workspaceDir, "invalid-workflow");
      await initializeWiki(invalidWorkflowWiki);
      await runCliBuffered(["deploy", "github-pages", "init", "--repo", invalidWorkflowWiki, "--custom-domain", "docs.example.com"]);
      const workflowPath = resolve(invalidWorkflowWiki, ".github/workflows/llm-wiki-pages.yml");
      await writeFile(
        workflowPath,
        (await readFile(workflowPath, "utf8")).replace("path: quartz/public", "path: quartz/content"),
        "utf8",
      );

      // Act
      const uninitializedStatus = await runCliBuffered([
        "deploy",
        "github-pages",
        "status",
        "--repo",
        uninitializedWiki,
        "--json",
      ]);
      const invalidWorkflowStatus = await runCliBuffered([
        "deploy",
        "github-pages",
        "status",
        "--repo",
        invalidWorkflowWiki,
        "--json",
      ]);
      const uninitializedInstructions = parseDeployStatus(uninitializedStatus.stdout).data.setup_instructions;
      const invalidWorkflowInstructions = parseDeployStatus(invalidWorkflowStatus.stdout).data.setup_instructions;
      const publishInstruction = "Run llm-wiki deploy github-pages build-local to generate committed Pages output in quartz/public.";

      // Assert
      expect(uninitializedStatus.exitCode).toBe(0);
      expect(uninitializedInstructions[0]).toBe("Run llm-wiki deploy github-pages init.");
      expect(uninitializedInstructions.indexOf("Run llm-wiki explore init before building GitHub Pages output.")).toBeLessThan(
        uninitializedInstructions.indexOf(publishInstruction),
      );
      expect(invalidWorkflowStatus.exitCode).toBe(0);
      expect(invalidWorkflowInstructions[0]).toBe(
        "Regenerate the GitHub Pages workflow with llm-wiki deploy github-pages init.",
      );
      expect(invalidWorkflowInstructions.indexOf(invalidWorkflowInstructions[0] ?? "")).toBeLessThan(
        invalidWorkflowInstructions.indexOf(publishInstruction),
      );
    });
  });
});
