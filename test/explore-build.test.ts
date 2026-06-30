import { EventEmitter } from "node:events";
import { execFile, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { stringify } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { parseInitJson, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileAsync = promisify(execFile);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn: spawnMock,
  };
});

type ExploreBuildEnvelope = {
  ok: true;
  command: "explore.build";
  repo: string;
  data: {
    profile: "local" | "review" | "public" | "github-pages";
    output_path: "quartz/public";
    sync: {
      manifest_path: string;
      materialized_paths: string[];
      generated_paths: string[];
    };
    lint: {
      counts: {
        total: number;
        error: number;
        warning: number;
        fixed: number;
      };
    };
    quartz: {
      command: "npm";
      args: string[];
      cwd: string;
      exit_code: number;
    };
  };
  warnings: string[];
};

type ExploreBuildFailureEnvelope = {
  ok: false;
  command: "explore.build";
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

async function markQuartzDependenciesInstalled(wikiDir: string): Promise<void> {
  await mkdir(resolve(wikiDir, "quartz/node_modules/.bin"), { recursive: true });
  await writeFile(resolve(wikiDir, "quartz/node_modules/.bin/quartz"), "#!/usr/bin/env node\n", "utf8");
  await mkdir(resolve(wikiDir, "quartz/quartz/components"), { recursive: true });
  await mkdir(resolve(wikiDir, "quartz/quartz/plugins"), { recursive: true });
  await writeFile(resolve(wikiDir, "quartz/quartz/build.ts"), "export {}\n", "utf8");
  await writeFile(resolve(wikiDir, "quartz/quartz/components/index.ts"), "export {}\n", "utf8");
  await writeFile(resolve(wikiDir, "quartz/quartz/plugins/index.ts"), "export {}\n", "utf8");
}

function parseExploreBuild(stdout: string[]): ExploreBuildEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreBuildEnvelope;
}

function parseExploreBuildFailure(stdout: string[]): ExploreBuildFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreBuildFailureEnvelope;
}

function mockSuccessfulSpawn(options: { profile?: "public" | "github-pages" } = {}): {
  syncedBeforeBuild: () => boolean;
  rootIndexMaterializedBeforeBuild: () => boolean;
  contentGitignoreAbsentBeforeBuild: () => boolean;
  localDaemonMetadataAbsentBeforeBuild: () => boolean;
  uploadRuntimeAbsentBeforeBuild: () => boolean;
} {
  const expectedProfile = options.profile ?? "public";
  let syncedBeforeBuild = false;
  let rootIndexMaterializedBeforeBuild = false;
  let contentGitignoreAbsentBeforeBuild = false;
  let localDaemonMetadataAbsentBeforeBuild = false;
  let uploadRuntimeAbsentBeforeBuild = false;
  spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
    const cwd = typeof options.cwd === "string" ? options.cwd : "";
    const wikiDir = resolve(cwd, "..");
    const layout = readFileSync(resolve(wikiDir, "quartz/quartz.layout.ts"), "utf8");
    syncedBeforeBuild =
      existsSync(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${expectedProfile}.json`)) &&
      existsSync(resolve(wikiDir, "quartz/content/curated/home.md"));
    rootIndexMaterializedBeforeBuild = existsSync(resolve(wikiDir, "quartz/content/index.md"));
    contentGitignoreAbsentBeforeBuild = !existsSync(resolve(wikiDir, "quartz/content/.gitignore"));
    localDaemonMetadataAbsentBeforeBuild = !existsSync(
      resolve(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
    );
    uploadRuntimeAbsentBeforeBuild = !layout.includes("LlmWikiUploadForm");
    rmSync(resolve(wikiDir, "quartz/public"), { recursive: true, force: true });
    mkdirSync(resolve(wikiDir, "quartz/public"), { recursive: true });
    writeFileSync(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Public</title>\n", "utf8");
    if (!uploadRuntimeAbsentBeforeBuild) {
      writeFileSync(
        resolve(wikiDir, "quartz/public/postscript.js"),
        'const component = "LlmWikiUploadForm"; window.llm_wiki_daemon = true;\n',
        "utf8",
      );
    }

    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => child.emit("close", 0, null));

    return child;
  });

  return {
    syncedBeforeBuild: () => syncedBeforeBuild,
    rootIndexMaterializedBeforeBuild: () => rootIndexMaterializedBeforeBuild,
    contentGitignoreAbsentBeforeBuild: () => contentGitignoreAbsentBeforeBuild,
    localDaemonMetadataAbsentBeforeBuild: () => localDaemonMetadataAbsentBeforeBuild,
    uploadRuntimeAbsentBeforeBuild: () => uploadRuntimeAbsentBeforeBuild,
  };
}

async function initializeGitRepository(wikiDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: wikiDir });
}

async function writeCuratedPage(
  wikiDir: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  const absolutePath = resolve(wikiDir, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body}`, "utf8");
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

async function makePublicProfileValidAsGitHubPagesFallback(wikiDir: string): Promise<void> {
  const publicProfilePath = resolve(wikiDir, ".llm-wiki/profiles/public.yml");
  const publicProfile = await readFile(publicProfilePath, "utf8");
  await writeFile(
    publicProfilePath,
    publicProfile.replace(/^name: public\nmode: deploy\n/u, "name: public\nmode: deploy\nbase_url: https://docs.example.com\n"),
    "utf8",
  );
  await rm(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"), { force: true });
  await rm(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yaml"), { force: true });
}

async function writeGitHubPagesProfile(wikiDir: string, customDomain?: string): Promise<void> {
  const publicProfile = await readFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "utf8");
  const deployHeader =
    customDomain === undefined
      ? "name: github-pages\nmode: deploy\nbase_url: https://docs.example.com\n"
      : `name: github-pages\nmode: deploy\nbase_url: https://${customDomain}\ncustom_domain: ${customDomain}\n`;
  await writeFile(
    resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"),
    publicProfile.replace(/^name: public\nmode: deploy\n/u, deployHeader),
    "utf8",
  );
}

async function withProcessPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return await run();
  } finally {
    if (descriptor !== undefined) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

describe("explore build command", () => {
  for (const profile of ["local", "review"] as const) {
    it(`rejects ${profile} before syncing or building static Quartz output`, async () => {
      await withTempWorkspace(`llm-wiki-explore-build-${profile}-rejected-`, async (workspaceDir) => {
        // Arrange
        spawnMock.mockReset();
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await initializeQuartzRuntime(wikiDir);
        await markQuartzDependenciesInstalled(wikiDir);

        // Act
        const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreBuildFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(spawnMock).not.toHaveBeenCalled();
        expect(payload.error).toEqual({
          code: "PROFILE_UNSUPPORTED",
          message: `Unsupported Quartz build profile: ${profile}.`,
          hint: "Use --profile public or github-pages for static builds.",
        });
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PROFILE_UNSUPPORTED",
            path: "--profile",
            hint: "Use --profile public or github-pages for static builds.",
          }),
        ]);
        expect(existsSync(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
        expect(existsSync(resolve(wikiDir, "quartz/content"))).toBe(false);
      });
    });
  }

  it("runs public sync, strict public lint, then Quartz build", async () => {
    await withTempWorkspace("llm-wiki-explore-build-public-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockSuccessfulSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuild(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(spawnObservation.syncedBeforeBuild()).toBe(true);
      expect(spawnObservation.rootIndexMaterializedBeforeBuild()).toBe(true);
      expect(spawnObservation.uploadRuntimeAbsentBeforeBuild()).toBe(true);
      expect(spawnMock).toHaveBeenCalledWith(
        "npm",
        ["run", "build"],
        expect.objectContaining({ cwd: resolve(wikiDir, "quartz"), stdio: ["ignore", "pipe", "pipe"] }),
      );
      expect(payload.data).toMatchObject({
        profile: "public",
        output_path: "quartz/public",
        sync: {
          manifest_path: ".llm-wiki/cache/quartz-manifest.public.json",
        },
        lint: {
          counts: {
            error: 0,
          },
        },
        quartz: {
          command: "npm",
          args: ["run", "build"],
          cwd: resolve(wikiDir, "quartz"),
          exit_code: 0,
        },
      });
      await expect(readFile(resolve(wikiDir, "quartz/content/index.md"), "utf8")).resolves.toContain("# Index");
      await expect(readFile(resolve(wikiDir, "quartz/quartz.layout.ts"), "utf8")).resolves.toContain(
        'import LlmWikiUploadForm from "./components/LlmWikiUploadForm"',
      );
      expect(existsSync(resolve(wikiDir, "quartz/public/postscript.js"))).toBe(false);
    });
  });

  it("runs github-pages sync, strict lint, Quartz build, and materializes a custom-domain CNAME", async () => {
    await withTempWorkspace("llm-wiki-explore-build-github-pages-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockSuccessfulSpawn({ profile: "github-pages" });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeGitHubPagesProfile(wikiDir, "docs.example.com");

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const payload = parseExploreBuild(result.stdout);
      const manifest = JSON.parse(await readFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.github-pages.json"), "utf8")) as {
        profile: string;
        source_profile: string;
      };

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(spawnObservation.syncedBeforeBuild()).toBe(true);
      expect(spawnObservation.rootIndexMaterializedBeforeBuild()).toBe(true);
      expect(spawnObservation.uploadRuntimeAbsentBeforeBuild()).toBe(true);
      expect(spawnMock).toHaveBeenCalledWith(
        "npm",
        ["run", "build"],
        expect.objectContaining({ cwd: resolve(wikiDir, "quartz"), stdio: ["ignore", "pipe", "pipe"] }),
      );
      expect(payload.data).toMatchObject({
        profile: "github-pages",
        output_path: "quartz/public",
        sync: {
          manifest_path: ".llm-wiki/cache/quartz-manifest.github-pages.json",
        },
        lint: {
          counts: {
            error: 0,
          },
        },
        quartz: {
          command: "npm",
          args: ["run", "build"],
          cwd: resolve(wikiDir, "quartz"),
          exit_code: 0,
        },
      });
      expect(manifest).toMatchObject({
        profile: "github-pages",
        source_profile: "github-pages",
      });
      await expect(readFile(resolve(wikiDir, ".llm-wiki/cache/github-pages-CNAME"), "utf8")).resolves.toBe(
        "docs.example.com\n",
      );
      await expect(readFile(resolve(wikiDir, "quartz/public/CNAME"), "utf8")).resolves.toBe("docs.example.com\n");
      expect(existsSync(resolve(wikiDir, "quartz/public/postscript.js"))).toBe(false);
    });
  });

  it("fails when Quartz exits successfully without producing the Pages output directory", async () => {
    await withTempWorkspace("llm-wiki-explore-build-missing-public-output-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
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
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuildFailure(result.stdout);

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
    });
  });

  it("does not block a clean public rebuild on stale leaked quartz/public output", async () => {
    await withTempWorkspace("llm-wiki-explore-build-stale-public-output-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockSuccessfulSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/assets/upload.js"), "LlmWikiUploadForm\n", "utf8");

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuild(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(spawnObservation.syncedBeforeBuild()).toBe(true);
      expect(payload.data.lint.counts.error).toBe(0);
      expect(existsSync(resolve(wikiDir, "quartz/public/assets/upload.js"))).toBe(false);
    });
  });

  it("fails github-pages builds when Quartz writes raw upload leaks to the public artifact", async () => {
    await withTempWorkspace("llm-wiki-explore-build-github-pages-post-build-leak-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      let spawnedAfterSync = false;
      spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
        const cwd = typeof options.cwd === "string" ? options.cwd : "";
        const wikiDir = resolve(cwd, "..");
        spawnedAfterSync =
          existsSync(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.github-pages.json")) &&
          existsSync(resolve(wikiDir, "quartz/content/curated/home.md"));
        rmSync(resolve(wikiDir, "quartz/public"), { recursive: true, force: true });
        mkdirSync(resolve(wikiDir, "quartz/public/raw/inputs/2026/06/src_upload"), { recursive: true });
        writeFileSync(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");
        writeFileSync(
          resolve(wikiDir, "quartz/public/raw/inputs/2026/06/src_upload/original.md"),
          "# Raw Upload\n",
          "utf8",
        );

        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = vi.fn();
        queueMicrotask(() => child.emit("close", 0, null));

        return child;
      });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeGitHubPagesProfile(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const payload = parseExploreBuildFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).toHaveBeenCalledWith(
        "npm",
        ["run", "build"],
        expect.objectContaining({ cwd: resolve(wikiDir, "quartz"), stdio: ["ignore", "pipe", "pipe"] }),
      );
      expect(spawnedAfterSync).toBe(true);
      expect(payload.error).toEqual({
        code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
        message: "Public profile leak check failed after Quartz build: public_static_raw_inputs_leak.",
        hint: "Remove upload, runtime, review, queue, raw, and secret data from committed GitHub Pages static output.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
          path: "quartz/public/raw/inputs/2026/06/src_upload/original.md",
        }),
      ]);
    });
  });

  it("fails public builds when Quartz writes auto-ingest runtime markers to the public artifact", async () => {
    await withTempWorkspace("llm-wiki-explore-build-public-auto-ingest-post-build-leak-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
        const cwd = typeof options.cwd === "string" ? options.cwd : "";
        const wikiDir = resolve(cwd, "..");
        rmSync(resolve(wikiDir, "quartz/public"), { recursive: true, force: true });
        mkdirSync(resolve(wikiDir, "quartz/public/assets"), { recursive: true });
        writeFileSync(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");
        writeFileSync(
          resolve(wikiDir, "quartz/public/assets/auto-ingest.js"),
          "window.auto_ingest_available = true; window.auto_ingest = { enabled: true };\n",
          "utf8",
        );

        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = vi.fn();
        queueMicrotask(() => child.emit("close", 0, null));

        return child;
      });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuildFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).toHaveBeenCalled();
      expect(payload.error).toEqual({
        code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
        message: "Public profile leak check failed after Quartz build: public_static_auto_ingest_metadata_leak.",
        hint: "Remove upload, runtime, review, queue, raw, and secret data from committed GitHub Pages static output.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
          path: "quartz/public/assets/auto-ingest.js",
        }),
      ]);
    });
  });

  it("strips formatted upload runtime blocks before public Quartz builds", async () => {
    await withTempWorkspace("llm-wiki-explore-build-formatted-upload-runtime-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockSuccessfulSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const layoutPath = resolve(wikiDir, "quartz/quartz.layout.ts");
      const originalLayout = await readFile(layoutPath, "utf8");
      const formattedLayout = originalLayout.replace(
        "      component: LlmWikiUploadForm(),",
        "      component:\n        LlmWikiUploadForm(),",
      );
      expect(formattedLayout).not.toBe(originalLayout);
      await writeFile(layoutPath, formattedLayout, "utf8");

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(spawnObservation.uploadRuntimeAbsentBeforeBuild()).toBe(true);
      await expect(readFile(layoutPath, "utf8")).resolves.toBe(formattedLayout);
      expect(existsSync(resolve(wikiDir, "quartz/public/postscript.js"))).toBe(false);
    });
  });

  it("restores the upload layout synchronously when a public Quartz build is interrupted", async () => {
    await withTempWorkspace("llm-wiki-explore-build-signal-layout-restore-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const beforeSigint = new Set(process.listeners("SIGINT"));
      const beforeSigterm = new Set(process.listeners("SIGTERM"));
      let spawned!: ChildProcessWithoutNullStreams;
      let resolveSpawned!: () => void;
      const spawnedPromise = new Promise<void>((resolveSpawnedPromise) => {
        resolveSpawned = resolveSpawnedPromise;
      });
      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = vi.fn();
        spawned = child;
        resolveSpawned();

        return child;
      });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const layoutPath = resolve(wikiDir, "quartz/quartz.layout.ts");
      const originalLayout = await readFile(layoutPath, "utf8");

      try {
        // Act
        const buildResult = runCli(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"], {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
          stdin: async () => "",
        });
        await spawnedPromise;
        await expect(readFile(layoutPath, "utf8")).resolves.not.toContain("LlmWikiUploadForm");

        const addedSigintListeners = process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener));
        expect(addedSigintListeners.length).toBeGreaterThanOrEqual(2);
        for (const listener of addedSigintListeners) {
          listener("SIGINT");
        }
        spawned.emit("close", 0, null);
        const exitCode = await buildResult;

        // Assert
        expect(exitCode).toBe(1);
        expect(stderr).toEqual([]);
        expect(stdout.join("\n")).toContain("Quartz build was interrupted by SIGINT.");
        await expect(readFile(layoutPath, "utf8")).resolves.toBe(originalLayout);
        expect(process.listeners("SIGINT").filter((listener) => !beforeSigint.has(listener))).toEqual([]);
        expect(process.listeners("SIGTERM").filter((listener) => !beforeSigterm.has(listener))).toEqual([]);
      } finally {
        for (const listener of process.listeners("SIGINT")) {
          if (!beforeSigint.has(listener)) {
            process.off("SIGINT", listener);
          }
        }
        for (const listener of process.listeners("SIGTERM")) {
          if (!beforeSigterm.has(listener)) {
            process.off("SIGTERM", listener);
          }
        }
      }
    });
  });

  it("keeps customized upload layouts intact when stripping would leave upload references behind", async () => {
    await withTempWorkspace("llm-wiki-explore-build-custom-upload-runtime-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      let uploadImportPresentBeforeBuild = false;
      spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
        const cwd = typeof options.cwd === "string" ? options.cwd : "";
        const wikiDir = resolve(cwd, "..");
        const layout = readFileSync(resolve(wikiDir, "quartz/quartz.layout.ts"), "utf8");
        uploadImportPresentBeforeBuild = layout.includes('import LlmWikiUploadForm from "./components/LlmWikiUploadForm"');
        mkdirSync(resolve(wikiDir, "quartz/public/assets"), { recursive: true });
        writeFileSync(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");
        writeFileSync(resolve(wikiDir, "quartz/public/assets/upload.js"), "LlmWikiUploadForm\n", "utf8");

        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = vi.fn();
        queueMicrotask(() => child.emit("close", 0, null));

        return child;
      });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const layoutPath = resolve(wikiDir, "quartz/quartz.layout.ts");
      const originalLayout = await readFile(layoutPath, "utf8");
      const customizedLayout = originalLayout.replace(
        'import LlmWikiUploadForm from "./components/LlmWikiUploadForm"\n',
        'import LlmWikiUploadForm from "./components/LlmWikiUploadForm"\nconst customUploadRuntime = LlmWikiUploadForm\n',
      );
      await writeFile(layoutPath, customizedLayout, "utf8");

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuildFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(uploadImportPresentBeforeBuild).toBe(true);
      expect(payload.error).toEqual({
        code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
        message: "Public profile leak check failed after Quartz build: public_static_upload_component_leak.",
        hint: "Remove upload, runtime, review, queue, raw, and secret data from committed GitHub Pages static output.",
      });
      await expect(readFile(layoutPath, "utf8")).resolves.toBe(customizedLayout);
    });
  });

  it("leaves embedded upload render calls intact instead of writing partial TypeScript", async () => {
    await withTempWorkspace("llm-wiki-explore-build-embedded-upload-runtime-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      let layoutBeforeBuild = "";
      spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptionsWithoutStdio) => {
        const cwd = typeof options.cwd === "string" ? options.cwd : "";
        const wikiDir = resolve(cwd, "..");
        layoutBeforeBuild = readFileSync(resolve(wikiDir, "quartz/quartz.layout.ts"), "utf8");

        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        const stderr = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = stderr;
        child.stdin = new PassThrough();
        child.kill = vi.fn();
        queueMicrotask(() => {
          if (layoutBeforeBuild.includes("const customUpload = \n")) {
            stderr.write("SyntaxError: expected expression after assignment\n");
            child.emit("close", 1, null);
            return;
          }

          mkdirSync(resolve(wikiDir, "quartz/public/assets"), { recursive: true });
          writeFileSync(resolve(wikiDir, "quartz/public/index.html"), "<!doctype html><title>Pages</title>\n", "utf8");
          writeFileSync(resolve(wikiDir, "quartz/public/assets/upload.js"), "LlmWikiUploadForm\n", "utf8");
          child.emit("close", 0, null);
        });

        return child;
      });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const layoutPath = resolve(wikiDir, "quartz/quartz.layout.ts");
      const originalLayout = await readFile(layoutPath, "utf8");
      const uploadRuntimeBlock = `    Component.ConditionalRender({
      component: LlmWikiUploadForm(),
      condition: (page) =>
        page.fileData.frontmatter?.llm_wiki_upload === true ||
        page.fileData.frontmatter?.llm_wiki_component === "LlmWikiUploadForm",
    }),
`;
      const embeddedUploadRuntime = `const customUpload = Component.ConditionalRender({
  component: LlmWikiUploadForm(),
  condition: (page) =>
    page.fileData.frontmatter?.llm_wiki_upload === true ||
    page.fileData.frontmatter?.llm_wiki_component === "LlmWikiUploadForm",
})

`;
      const customizedLayout = originalLayout
        .replace(
          'import LlmWikiUploadForm from "./components/LlmWikiUploadForm"\n',
          `import LlmWikiUploadForm from "./components/LlmWikiUploadForm"\n${embeddedUploadRuntime}`,
        )
        .replace(uploadRuntimeBlock, "    customUpload,\n");
      expect(customizedLayout).not.toBe(originalLayout);
      await writeFile(layoutPath, customizedLayout, "utf8");

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuildFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(layoutBeforeBuild).toContain("const customUpload = Component.ConditionalRender");
      expect(layoutBeforeBuild).toContain('import LlmWikiUploadForm from "./components/LlmWikiUploadForm"');
      expect(layoutBeforeBuild).not.toContain("const customUpload = \n");
      expect(payload.error).toEqual({
        code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
        message: "Public profile leak check failed after Quartz build: public_static_upload_component_leak.",
        hint: "Remove upload, runtime, review, queue, raw, and secret data from committed GitHub Pages static output.",
      });
      await expect(readFile(layoutPath, "utf8")).resolves.toBe(customizedLayout);
    });
  });

  it("removes stale generated runtime metadata before public Quartz build", async () => {
    await withTempWorkspace("llm-wiki-explore-build-generated-runtime-leak-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockSuccessfulSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/content/_llm-wiki/runtime"), { recursive: true });
      await writeFile(
        resolve(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
        '{"enabled":true,"token_header":"x-llm-wiki-upload-token","upload_token":"redacted","auto_ingest_available":true}\n',
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuild(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).toHaveBeenCalled();
      expect(spawnObservation.syncedBeforeBuild()).toBe(true);
      expect(spawnObservation.localDaemonMetadataAbsentBeforeBuild()).toBe(true);
      expect(payload.data.profile).toBe("public");
      expect(existsSync(resolve(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"))).toBe(false);
    });
  });

  it("removes stale generated runtime metadata before github-pages fallback build", async () => {
    await withTempWorkspace("llm-wiki-explore-build-github-pages-fallback-leak-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockSuccessfulSpawn({ profile: "github-pages" });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await makePublicProfileValidAsGitHubPagesFallback(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/content/_llm-wiki/runtime"), { recursive: true });
      await writeFile(
        resolve(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"),
        '{"enabled":true,"token_header":"x-llm-wiki-upload-token","upload_token":"redacted","auto_ingest_available":true}\n',
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const payload = parseExploreBuild(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).toHaveBeenCalled();
      expect(spawnObservation.syncedBeforeBuild()).toBe(true);
      expect(spawnObservation.localDaemonMetadataAbsentBeforeBuild()).toBe(true);
      expect(payload.data.profile).toBe("github-pages");
      expect(existsSync(resolve(wikiDir, "quartz/content/_llm-wiki/runtime/local-daemon.json"))).toBe(false);
    });
  });

  it.each([
    {
      name: "missing",
      prepareIndex: async (wikiDir: string) => {
        await rm(resolve(wikiDir, "curated/index.md"));
      },
    },
    {
      name: "non-public",
      prepareIndex: async (wikiDir: string) => {
        const index = await readFile(resolve(wikiDir, "curated/index.md"), "utf8");
        await writeFile(resolve(wikiDir, "curated/index.md"), index.replace(/^visibility: public$/m, "visibility: private"), "utf8");
      },
    },
  ])("does not generate a private local home page when curated/index.md is $name for public build", async ({ prepareIndex }) => {
    await withTempWorkspace("llm-wiki-explore-build-public-index-required-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await prepareIndex(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuildFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(["PUBLIC_LINT_FAILED", "QUARTZ_CONTENT_UNSAFE"]).toContain(payload.error.code);
      expect(existsSync(resolve(wikiDir, "quartz/content/index.md"))).toBe(false);
    });
  });

  it.each([
    {
      name: "missing",
      prepareIndex: async (wikiDir: string) => {
        await rm(resolve(wikiDir, "curated/index.md"));
      },
    },
    {
      name: "non-public",
      prepareIndex: async (wikiDir: string) => {
        const index = await readFile(resolve(wikiDir, "curated/index.md"), "utf8");
        await writeFile(resolve(wikiDir, "curated/index.md"), index.replace(/^visibility: public$/m, "visibility: private"), "utf8");
      },
    },
  ])("does not generate a private local home page when curated/index.md is $name for github-pages build", async ({ prepareIndex }) => {
    await withTempWorkspace("llm-wiki-explore-build-github-pages-index-required-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      const publicProfile = await readFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "utf8");
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"),
        publicProfile.replace(
          /^name: public\nmode: deploy\n/u,
          "name: github-pages\nmode: deploy\nbase_url: https://docs.example.com\n",
        ),
        "utf8",
      );
      await prepareIndex(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const payload = parseExploreBuildFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(["PUBLIC_LINT_FAILED", "QUARTZ_CONTENT_UNSAFE"]).toContain(payload.error.code);
      expect(existsSync(resolve(wikiDir, "quartz/content/index.md"))).toBe(false);
    });
  });

  it("does not run Quartz build with a generated content-level gitignore", async () => {
    await withTempWorkspace("llm-wiki-explore-build-nested-gitignore-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const spawnObservation = mockSuccessfulSpawn();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeFile(resolve(wikiDir, "quartz/.gitignore"), "!content/\n!content/**\n", "utf8");

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuild(result.stdout);
      const quartzGitignore = await readFile(resolve(wikiDir, "quartz/.gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(spawnObservation.syncedBeforeBuild()).toBe(true);
      expect(spawnObservation.contentGitignoreAbsentBeforeBuild()).toBe(true);
      expect(quartzGitignore.trimEnd().endsWith("content/")).toBe(true);
      expect(existsSync(resolve(wikiDir, "quartz/content/.gitignore"))).toBe(false);
      expect(payload.warnings).toEqual(["Repaired nested generated Quartz ignore rule: quartz/.gitignore"]);
    });
  });

  it("launches npm through the Windows command shim when building", async () => {
    await withProcessPlatform("win32", async () => {
      await withTempWorkspace("llm-wiki-explore-build-windows-npm-", async (workspaceDir) => {
        // Arrange
        spawnMock.mockReset();
        mockSuccessfulSpawn();
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await initializeQuartzRuntime(wikiDir);
        await markQuartzDependenciesInstalled(wikiDir);
        await makeDefaultCuratedPagesPublic(wikiDir);

        // Act
        const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(spawnMock).toHaveBeenCalledWith(
          "npm.cmd",
          ["run", "build"],
          expect.objectContaining({ cwd: resolve(wikiDir, "quartz"), stdio: ["ignore", "pipe", "pipe"] }),
        );
      });
    });
  });

  it("runs public sync before failing strict public lint and does not build", async () => {
    await withTempWorkspace("llm-wiki-explore-build-public-lint-failure-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await markQuartzDependenciesInstalled(wikiDir);
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
        "# Private Topic\n\nPrivate body selected by public profile but excluded by visibility.\n",
      );
      const ordinaryLint = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--json"]);
      const strictLint = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuildFailure(result.stdout);

      // Assert
      expect(ordinaryLint.exitCode).toBe(0);
      expect(ordinaryLint.stdout.join("\n")).not.toContain("public_private_page_selected");
      expect(strictLint.exitCode).toBe(1);
      expect(strictLint.stdout.join("\n")).toContain("public_private_page_selected");
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
      await expect(readFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.public.json"), "utf8")).resolves.toContain(
        "\"profile\": \"public\"",
      );
      await expect(readFile(resolve(wikiDir, "quartz/content/curated/home.md"), "utf8")).resolves.toContain("# Home");
    });
  });

  it("returns exact install instructions and a stable error code when dependencies are missing", async () => {
    await withTempWorkspace("llm-wiki-explore-build-missing-deps-", async (workspaceDir) => {
      // Arrange
      spawnMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/node_modules"), { recursive: true });
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "build", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreBuildFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(payload.error).toEqual({
        code: "QUARTZ_DEPENDENCIES_MISSING",
        message: "Quartz dependencies are not installed.",
        hint: "Run cd quartz && npm install.",
      });
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "QUARTZ_DEPENDENCIES_MISSING",
          path: "quartz/package.json",
          hint: "Run cd quartz && npm install.",
        }),
      ]);
      await expect(readFile(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.public.json"), "utf8")).resolves.toContain(
        "\"profile\": \"public\"",
      );
    });
  });
});
