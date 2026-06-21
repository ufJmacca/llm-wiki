import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { parseInitJson, pathExists, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const execFileAsync = promisify(execFile);

type ExploreSyncEnvelope = {
  ok: true;
  command: "explore.sync";
  repo: string;
  data: {
    profile: "local" | "review" | "public" | "github-pages";
    source_profile: string;
    content_root: "quartz/content";
    manifest_path: string;
    materialized_paths: string[];
    generated_paths: string[];
    excluded_paths: string[];
    warnings: string[];
  };
  warnings: string[];
};

type ExploreSyncFailureEnvelope = {
  ok: false;
  command: "explore.sync";
  repo: string;
  error: {
    code: string;
    message: string;
    hint: string;
  };
  issues: Array<{
    severity: "error";
    code: string;
    message: string;
    path: string;
    hint: string;
  }>;
};

type QuartzManifest = {
  profile: string;
  source_profile: string;
  content_root: "quartz/content";
  files: Array<{
    source_path: string;
    content_path: string;
    content_hash: string;
    page_type: string | null;
    title: string | null;
    visibility: string | null;
  }>;
  generated_files: Array<{
    content_path: string;
    content_hash: string;
    title: string;
  }>;
  excluded_paths: string[];
};

type SourceCaptureData = {
  status: "added" | "duplicate";
  source: {
    source_id: string;
    title: string;
    source_kind: "file" | "text";
    origin: string;
    captured_at: string;
    content_hash: string;
    visibility: "private";
    queue_status: "queued" | "ingesting" | "ingested" | "blocked";
    original_path: string;
    source_card_path: string;
    queue_path: string;
  };
  created_paths: string[];
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

async function prepareGitHubPagesSyncProfile(wikiDir: string): Promise<void> {
  await initializeQuartzRuntime(wikiDir);
  const publicProfile = await readFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "utf8");
  await writeFile(
    resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"),
    publicProfile.replace(
      /^name: public\nmode: deploy\n/u,
      "name: github-pages\nmode: deploy\nbase_url: https://docs.example.com\n",
    ),
    "utf8",
  );
}

async function initializeGitRepository(wikiDir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: wikiDir });
}

async function withUnavailableGitPath<T>(workspaceDir: string, run: () => Promise<T>): Promise<T> {
  const oldPath = process.env.PATH;
  const binDir = resolve(workspaceDir, "no-git-bin");
  await mkdir(binDir, { recursive: true });
  process.env.PATH = binDir;

  try {
    return await run();
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
  }
}

async function gitIgnoresPath(wikiDir: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", path], { cwd: wikiDir });
    return true;
  } catch (error) {
    if (isExitCode(error, 1)) {
      return false;
    }

    throw error;
  }
}

function isExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

function parseExploreSync(stdout: string[]): ExploreSyncEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreSyncEnvelope;
}

function parseExploreSyncFailure(stdout: string[]): ExploreSyncFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreSyncFailureEnvelope;
}

function parseSourceCapture(stdout: string[]): SourceCaptureData {
  expect(stdout).toHaveLength(1);
  return (JSON.parse(stdout[0]) as { data: SourceCaptureData }).data;
}

async function readManifest(wikiDir: string, profile: string): Promise<QuartzManifest> {
  return JSON.parse(await readGeneratedFile(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`)) as QuartzManifest;
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

async function listTree(rootDir: string, relativeDir: string): Promise<string[]> {
  const absoluteDir = resolve(rootDir, relativeDir);
  if (!(await pathExists(absoluteDir))) {
    return [];
  }

  const paths: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = resolve(dir, entry.name);
      const relativePath = absolutePath.slice(rootDir.length + 1).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        paths.push(relativePath);
      }
    }
  }

  await visit(absoluteDir);
  return paths;
}

describe("explore sync command", () => {
  it("materializes local Markdown, raw source cards, and static review pages while excluding raw originals", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-local-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Queue Note",
        "--text",
        "Private queue text.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, "local");
      const syncedPaths = await listTree(wikiDir, "quartz/content");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.profile).toBe("local");
      expect(payload.data.materialized_paths).toContain("quartz/content/curated/home.md");
      expect(payload.data.generated_paths).toEqual([
        "quartz/content/_llm-wiki/review/profile-summary.md",
        "quartz/content/_llm-wiki/review/source-queue.md",
      ]);
      expect(payload.data.excluded_paths).toEqual(expect.arrayContaining([expect.stringMatching(/original\.md$/)]));
      expect(syncedPaths).toContain("quartz/content/curated/home.md");
      expect(syncedPaths).toContain("quartz/content/_llm-wiki/review/source-queue.md");
      expect(syncedPaths.some((path) => path.endsWith("/_source.md"))).toBe(true);
      expect(syncedPaths.some((path) => path.endsWith("/original.md"))).toBe(false);
      expect(manifest.profile).toBe("local");
      expect(manifest.files.some((file) => file.source_path.endsWith("/_source.md"))).toBe(true);
      expect(manifest.files.some((file) => file.source_path.endsWith("/original.md"))).toBe(false);
      expect(await readGeneratedFile(wikiDir, "quartz/content/_llm-wiki/review/source-queue.md")).toContain("Queue Note");
    });
  });

  it("treats missing Git as no worktree for no-git sync", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-no-git-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "No Git Queue Note",
        "--text",
        "Private no-git queue text.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);

      // Act
      const result = await withUnavailableGitPath(workspaceDir, () =>
        runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]),
      );
      const payload = parseExploreSync(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.materialized_paths).toContain("quartz/content/curated/home.md");
      expect(await pathExists(resolve(wikiDir, "quartz/content/curated/home.md"))).toBe(true);
    });
  });

  it("loads supported .yaml profile files during sync", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-local-yaml-profile-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await rename(
        resolve(wikiDir, ".llm-wiki/profiles/local.yml"),
        resolve(wikiDir, ".llm-wiki/profiles/local.yaml"),
      );

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, "local");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.profile).toBe("local");
      expect(payload.data.source_profile).toBe("local");
      expect(payload.data.materialized_paths).toContain("quartz/content/curated/home.md");
      expect(manifest.source_profile).toBe("local");
    });
  });

  it.each(["public", "github-pages"] as const)("rejects duplicate public profile extensions before %s sync", async (profile) => {
    await withTempWorkspace(`llm-wiki-explore-sync-${profile}-duplicate-public-profile-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Private Local Fixture",
        "--text",
        "Private local sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      const localResult = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      expect(localResult.exitCode).toBe(0);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).toBe(true);
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.source_card_path}`))).toBe(true);

      const publicProfile = await readFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yaml"), publicProfile, "utf8");
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROFILE_INVALID");
      expect(payload.error.message).toContain("Duplicate profile files found for public");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PROFILE_INVALID",
          path: ".llm-wiki/profiles/public.yml",
        }),
      ]);
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.source_card_path}`))).toBe(true);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).toBe(true);
      expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
    });
  });

  it("rejects duplicate github-pages profile extensions before github-pages sync", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-duplicate-github-pages-profile-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const publicProfile = await readFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"), publicProfile, "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yaml"), publicProfile, "utf8");
      await makeDefaultCuratedPagesPublic(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROFILE_INVALID");
      expect(payload.error.message).toContain("Duplicate profile files found for github-pages");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PROFILE_INVALID",
          path: ".llm-wiki/profiles/github-pages.yml",
        }),
      ]);
      expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
    });
  });

  it.each([
    {
      name: "missing base_url",
      profile: `name: github-pages
mode: deploy
custom_domain: docs.example.com
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
      message: "GitHub Pages deploy profile must define base_url.",
    },
    {
      name: "unsafe base_url",
      profile: `name: github-pages
mode: deploy
base_url: https://docs.example.com/%2e%2e/private
custom_domain: docs.example.com
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
      message: "GitHub Pages deploy profile base_url must be an absolute HTTPS URL.",
    },
    {
      name: "invalid custom_domain",
      profile: `name: github-pages
mode: deploy
base_url: https://docs.example.com
custom_domain: docs.example.com/wiki
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
      message: "GitHub Pages deploy profile custom_domain must be a host name only.",
    },
    {
      name: "custom_domain and base_url host mismatch",
      profile: `name: github-pages
mode: deploy
base_url: https://org.github.io/repo
custom_domain: docs.example.com
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
      message: "GitHub Pages deploy profile base_url host must match custom_domain.",
    },
    {
      name: "custom_domain and base_url path prefix",
      profile: `name: github-pages
mode: deploy
base_url: https://docs.example.com/wiki
custom_domain: docs.example.com
include:
  - curated/**
exclude: []
visibility:
  include_private: false
  required_value: public
`,
      message: "GitHub Pages deploy profile base_url must use custom_domain at the domain root.",
    },
  ])("rejects edited github-pages deploy profile fields before applying them: $name", async ({ profile, message }) => {
    await withTempWorkspace("llm-wiki-explore-sync-invalid-github-pages-profile-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeQuartzRuntime(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/github-pages.yml"), profile, "utf8");
      const configPath = resolve(wikiDir, "quartz/quartz.config.ts");
      const originalConfig = await readFile(configPath, "utf8");

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "github-pages", "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROFILE_INVALID");
      expect(payload.error.message).toBe(message);
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PROFILE_INVALID",
          path: ".llm-wiki/profiles/github-pages.yml",
        }),
      ]);
      await expect(readFile(configPath, "utf8")).resolves.toBe(originalConfig);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/github-pages-CNAME"))).toBe(false);
    });
  });

  it.each(["public", "github-pages"] as const)("rejects symlinked public profiles for %s sync", async (profile) => {
    await withTempWorkspace(`llm-wiki-explore-sync-${profile}-symlink-profile-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const publicProfilePath = resolve(wikiDir, ".llm-wiki/profiles/public.yml");
      const linkedProfilePath = resolve(wikiDir, ".llm-wiki/profiles/public.link-target.yml");
      await rename(publicProfilePath, linkedProfilePath);
      await symlink(linkedProfilePath, publicProfilePath);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nPublic body.\n",
      );

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROFILE_INVALID");
      expect(payload.error.message).toContain("symlink");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PROFILE_INVALID",
          path: ".llm-wiki/profiles/public.yml",
        }),
      ]);
      expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"))).toBe(false);
    });
  });

  it.each(["public", "github-pages"] as const)("rejects symlinked profile parent directories for %s sync", async (profile) => {
    await withTempWorkspace(`llm-wiki-explore-sync-${profile}-symlink-profile-parent-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const profilesPath = resolve(wikiDir, ".llm-wiki/profiles");
      const outsideProfilesPath = resolve(workspaceDir, "outside-profiles");
      await rename(profilesPath, outsideProfilesPath);
      await symlink(outsideProfilesPath, profilesPath, "dir");
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nPublic body.\n",
      );

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("PROFILE_INVALID");
      expect(payload.error.message).toContain("symlink");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "PROFILE_INVALID",
          path: `.llm-wiki/profiles/${profile === "github-pages" ? "github-pages" : "public"}.yml`,
        }),
      ]);
      expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"))).toBe(false);
    });
  });

  it.each(["public", "github-pages"] as const)("creates an empty content root for %s sync with no public pages", async (profile) => {
    await withTempWorkspace(`llm-wiki-explore-sync-${profile}-empty-content-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      if (profile === "github-pages") {
        await prepareGitHubPagesSyncProfile(wikiDir);
      }

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, profile);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.content_root).toBe("quartz/content");
      expect(payload.data.materialized_paths).toEqual([]);
      expect(payload.data.generated_paths).toEqual([]);
      expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(true);
      expect(await listTree(wikiDir, "quartz/content")).toEqual([]);
      expect(manifest.files).toEqual([]);
      expect(manifest.generated_files).toEqual([]);
    });
  });

  it("materializes review profile content with review static pages and no raw originals", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-review-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Review Queue Note",
        "--text",
        "Needs review.\n",
        "--json",
      ]);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "review", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, "review");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.profile).toBe("review");
      expect(payload.data.generated_paths).toContain("quartz/content/_llm-wiki/review/source-queue.md");
      expect(manifest.profile).toBe("review");
      expect(manifest.files.some((file) => file.source_path.endsWith("/_source.md"))).toBe(true);
      expect(manifest.files.some((file) => file.source_path.includes("raw/queue/"))).toBe(false);
      await expect(readFile(resolve(wikiDir, "quartz/content/_llm-wiki/review/source-queue.md"), "utf8")).resolves.toContain(
        "Review Queue Note",
      );
    });
  });

  it.each(["local", "review"] as const)("rewrites excluded raw original links in %s source cards", async (profile) => {
    await withTempWorkspace(`llm-wiki-explore-sync-${profile}-source-card-links-`, async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Linked Original",
        "--text",
        "Private original body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
      const payload = parseExploreSync(result.stdout);
      const syncedSourceCard = await readGeneratedFile(wikiDir, `quartz/content/${capture.source.source_card_path}`);
      const sourceSourceCard = await readGeneratedFile(wikiDir, capture.source.source_card_path);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.materialized_paths).toContain(`quartz/content/${capture.source.source_card_path}`);
      expect(payload.data.excluded_paths).toContain(capture.source.original_path);
      expect(syncedSourceCard).toContain(`Original file: \`${capture.source.original_path}\` (excluded from Explorer sync)`);
      expect(syncedSourceCard).not.toContain(`[[${capture.source.original_path}`);
      expect(sourceSourceCard).toContain(`Original file: [[${capture.source.original_path}|original.md]]`);
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.original_path}`))).toBe(false);
    });
  });

  it("removes stale manifests for other profiles when replacing shared content", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-switch-manifest-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Private Local Fixture",
        "--text",
        "Private local sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nPublic body.\n",
      );
      const publicResult = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "public", "--json"]);
      expect(publicResult.exitCode).toBe(0);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.public.json"))).toBe(true);

      // Act
      const localResult = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const localPayload = parseExploreSync(localResult.stdout);

      // Assert
      expect(localResult.exitCode).toBe(0);
      expect(localPayload.data.profile).toBe("local");
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).toBe(true);
      expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.public.json"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.source_card_path}`))).toBe(true);
    });
  });

  it("patches upgraded repo ignore rules before private-capable sync output", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-upgraded-gitignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".gitignore"), ".DS_Store\n.llm-wiki/cache/\nnode_modules/\n", "utf8");
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Upgraded Private Fixture",
        "--text",
        "Private upgraded sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual(["Added missing generated Quartz ignore rule: quartz/content/"]);
      expect(payload.data.warnings).toEqual(payload.warnings);
      expect(gitignore).toContain("quartz/content/\n");
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.source_card_path}`))).toBe(true);
    });
  });

  it("repairs later gitignore negations before private-capable sync output", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-negated-gitignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir);
      await writeFile(
        resolve(wikiDir, ".gitignore"),
        ".DS_Store\n.llm-wiki/cache/\nquartz/content/\n!quartz/content/\n!quartz/content/**\n",
        "utf8",
      );
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Negated Private Fixture",
        "--text",
        "Private negated sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      const privateContentPath = `quartz/content/${capture.source.source_card_path}`;
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(false);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual([`Repaired overridden generated Quartz ignore rule: quartz/content/`]);
      expect(payload.data.warnings).toEqual(payload.warnings);
      expect(gitignore.trimEnd().endsWith("quartz/content/")).toBe(true);
      expect(await pathExists(resolve(wikiDir, privateContentPath))).toBe(true);
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(true);
    });
  });

  it("repairs nested Quartz ignore rules outside the content root", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-nested-gitignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir);
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/.gitignore"), "!content/\n!content/**\n", "utf8");
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Nested Ignore Private Fixture",
        "--text",
        "Private nested ignore sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      const privateContentPath = `quartz/content/${capture.source.source_card_path}`;
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(false);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const quartzGitignore = await readFile(resolve(wikiDir, "quartz/.gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual(["Repaired nested generated Quartz ignore rule: quartz/.gitignore"]);
      expect(payload.data.warnings).toEqual(payload.warnings);
      expect(quartzGitignore.trimEnd().endsWith("content/")).toBe(true);
      expect(await pathExists(resolve(wikiDir, "quartz/content/.gitignore"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, privateContentPath))).toBe(true);
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(true);
    });
  });

  it("checks actual generated paths when nested Quartz ignore rules keep the probe ignored", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-specific-negated-gitignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await initializeGitRepository(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Specific Ignore Private Fixture",
        "--text",
        "Private specific ignore sync body.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      const privateContentPath = `quartz/content/${capture.source.source_card_path}`;
      const quartzIgnorePath = `content/${capture.source.source_card_path}`;
      const quartzIgnoreSegments = quartzIgnorePath.split("/");
      const quartzIgnoreRules = quartzIgnoreSegments.flatMap((_, index) => {
        const pattern = quartzIgnoreSegments.slice(0, index + 1).join("/");
        return index === quartzIgnoreSegments.length - 1 ? [`!${pattern}`] : [`!${pattern}/`, `${pattern}/*`];
      });
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/.gitignore"), `${quartzIgnoreRules.join("\n")}\n`, "utf8");
      expect(await gitIgnoresPath(wikiDir, "quartz/content/.llm-wiki-sync-probe.md")).toBe(true);
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(false);

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const quartzGitignore = await readFile(resolve(wikiDir, "quartz/.gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(payload.warnings).toEqual(["Repaired nested generated Quartz ignore rule: quartz/.gitignore"]);
      expect(quartzGitignore.trimEnd().endsWith("content/")).toBe(true);
      expect(await pathExists(resolve(wikiDir, "quartz/content/.gitignore"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, privateContentPath))).toBe(true);
      expect(await gitIgnoresPath(wikiDir, privateContentPath)).toBe(true);
    });
  });

  it.each(["public", "github-pages"] as const)(
    "patches upgraded repo ignore rules before %s sync output",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-upgraded-gitignore-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await writeFile(resolve(wikiDir, ".gitignore"), ".DS_Store\n.llm-wiki/cache/\nnode_modules/\n", "utf8");
        await makeDefaultCuratedPagesPublic(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await writeCuratedPage(
          wikiDir,
          "curated/topics/public-topic.md",
          {
            type: "topic",
            title: "Public Topic",
            visibility: "public",
            source_ids: [],
          },
          "# Public Topic\n\nPublic body.\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSync(result.stdout);
        const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");

        // Assert
        expect(result.exitCode).toBe(0);
        expect(payload.warnings).toEqual(["Added missing generated Quartz ignore rule: quartz/content/"]);
        expect(payload.data.warnings).toEqual(payload.warnings);
        expect(gitignore).toContain("quartz/content/\n");
        expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"))).toBe(true);
      });
    },
  );

  it("materializes public and github-pages profiles without private pages, raw cards, or raw originals", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-public-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const privateRawText = "Private raw capture sentence that must never reach public Quartz.";
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Public Sync Raw Fixture",
        "--text",
        privateRawText,
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      await makeDefaultCuratedPagesPublic(wikiDir);
      await prepareGitHubPagesSyncProfile(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nPublic body.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/private-topic.md",
        {
          type: "topic",
          title: "Private Topic",
          visibility: "private",
          source_ids: [],
        },
        "# Private Topic\n\nPrivate body.\n",
      );
      const publicLikeProfiles = ["public", "github-pages"] as const;

      for (const profile of publicLikeProfiles) {
        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSync(result.stdout);
        const manifest = await readManifest(wikiDir, profile);
        const syncedPaths = await listTree(wikiDir, "quartz/content");
        const syncedContent = await Promise.all(
          syncedPaths.map(async (path) => readFile(resolve(wikiDir, path), "utf8")),
        );

        // Assert
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toEqual([]);
        expect(payload.data.source_profile).toBe(profile === "github-pages" ? "github-pages" : "public");
        expect(manifest.profile).toBe(profile);
        expect(manifest.files.map((file) => file.source_path)).toContain("curated/topics/public-topic.md");
        expect(manifest.files.map((file) => file.source_path)).not.toContain("curated/topics/private-topic.md");
        await expect(readGeneratedFile(wikiDir, "quartz/content/curated/topics/public-topic.md")).resolves.toContain(
          "Public body.",
        );
        expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/private-topic.md"))).toBe(false);
        expect(syncedPaths).not.toContain(`quartz/content/${capture.source.source_card_path}`);
        expect(syncedPaths).not.toContain(`quartz/content/${capture.source.original_path}`);
        expect(syncedPaths).not.toContain(`quartz/content/${capture.source.queue_path}`);
        expect(syncedContent.join("\n")).not.toContain(privateRawText);
        expect(manifest.files.some((file) => file.source_path === capture.source.source_card_path)).toBe(false);
        expect(manifest.files.some((file) => file.source_path === capture.source.original_path)).toBe(false);
        expect(manifest.files.some((file) => file.source_path === capture.source.queue_path)).toBe(false);
        expect(JSON.stringify(payload.data)).not.toContain(capture.source.source_card_path);
        expect(JSON.stringify(payload.data)).not.toContain(capture.source.original_path);
        expect(JSON.stringify(payload.data)).not.toContain(capture.source.queue_path);
        expect(JSON.stringify(manifest)).not.toContain(capture.source.source_card_path);
        expect(JSON.stringify(manifest)).not.toContain(capture.source.original_path);
        expect(JSON.stringify(manifest)).not.toContain(capture.source.queue_path);
        expect(JSON.stringify(manifest)).not.toContain(privateRawText);
      }
    });
  });

  it.each(["public", "github-pages"] as const)(
    "fails %s sync when a selected page links to a public page excluded from output",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-excluded-public-link-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        await makeDefaultCuratedPagesPublic(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await writeCuratedPage(
          wikiDir,
          "curated/sources/public-summary.md",
          {
            type: "source_summary",
            title: "Excluded Public Summary",
            visibility: "public",
            source_ids: [],
          },
          "# Excluded Public Summary\n\nThis page is public but excluded by the default public profile.\n",
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
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(payload.error.message).toContain("public_quartz_link_target_excluded");
        expect(payload.error.hint).toContain("curated/sources/public-summary.md");
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: "curated/topics/public-topic.md",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "fails %s sync without deleting an existing Explorer materialization when strict leak checks fail",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-leak-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await writeCuratedPage(
          wikiDir,
          "curated/topics/public-topic.md",
          {
            type: "topic",
            title: "Public Topic",
            visibility: "public",
            source_ids: [],
          },
          "# Public Topic\n\n[[Private Topic]]\n",
        );
        await writeCuratedPage(
          wikiDir,
          "curated/topics/private-topic.md",
          {
            type: "topic",
            title: "Private Topic",
            visibility: "private",
            source_ids: [],
          },
          "# Private Topic\n",
        );
        const localResult = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
        expect(localResult.exitCode).toBe(0);
        expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/private-topic.md"))).toBe(true);
        expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).toBe(true);

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: "curated/topics/public-topic.md",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/private-topic.md"))).toBe(true);
        expect(await pathExists(resolve(wikiDir, ".llm-wiki/cache/quartz-manifest.local.json"))).toBe(true);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "fails %s sync when selected page is missing visibility and another required field",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-missing-type-and-visibility-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await makeDefaultCuratedPagesPublic(wikiDir);
        await writeCuratedPage(
          wikiDir,
          "curated/topics/missing-required-field.md",
          {
            title: "Missing Type And Visibility",
            source_ids: [],
          },
          "# Missing Type And Visibility\n\nThis selected page has no type or visibility frontmatter.\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(payload.error.message).toContain("public_private_page_selected");
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: "curated/topics/missing-required-field.md",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "fails %s sync before materialization when a selected page is missing visibility",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-missing-visibility-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await makeDefaultCuratedPagesPublic(wikiDir);
        await writeCuratedPage(
          wikiDir,
          "curated/topics/missing-visibility.md",
          {
            type: "topic",
            title: "Missing Visibility",
            source_ids: [],
          },
          "# Missing Visibility\n\nThis selected page has no visibility frontmatter.\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(payload.error.message).toContain("curated_frontmatter_required_missing");
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: "curated/topics/missing-visibility.md",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "preserves last successful %s output when leak checks fail after a successful sync",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-stale-manifest-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await makeDefaultCuratedPagesPublic(wikiDir);
        await writeCuratedPage(
          wikiDir,
          "curated/topics/public-topic.md",
          {
            type: "topic",
            title: "Public Topic",
            visibility: "public",
            source_ids: [],
          },
          "# Public Topic\n\nPublic body.\n",
        );
        await writeCuratedPage(
          wikiDir,
          "curated/topics/private-topic.md",
          {
            type: "topic",
            title: "Private Topic",
            visibility: "private",
            source_ids: [],
          },
          "# Private Topic\n",
        );
        const initialSync = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        expect(initialSync.exitCode).toBe(0);
        const manifestPath = resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`);
        expect(await pathExists(manifestPath)).toBe(true);
        expect((await readManifest(wikiDir, profile)).files.map((file) => file.source_path)).toContain(
          "curated/topics/public-topic.md",
        );
        expect(await pathExists(resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"))).toBe(true);
        const previousManifest = await readFile(manifestPath, "utf8");
        const previousPublicTopic = await readFile(
          resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"),
          "utf8",
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
          "# Public Topic\n\n[[Private Topic]]\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(await readFile(manifestPath, "utf8")).toBe(previousManifest);
        await expect(readFile(resolve(wikiDir, "quartz/content/curated/topics/public-topic.md"), "utf8")).resolves.toBe(
          previousPublicTopic,
        );
      });
    },
  );

  it.each(["public", "github-pages"] as const)(
    "fails %s sync when selected public content has strict lint errors",
    async (profile) => {
      await withTempWorkspace(`llm-wiki-explore-sync-${profile}-public-lint-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        if (profile === "github-pages") {
          await prepareGitHubPagesSyncProfile(wikiDir);
        }
        await makeDefaultCuratedPagesPublic(wikiDir);
        await writeCuratedPage(
          wikiDir,
          "curated/topics/public-broken-link.md",
          {
            type: "topic",
            title: "Public Broken Link",
            visibility: "public",
            source_ids: [],
          },
          "# Public Broken Link\n\n[[Missing Public Target]]\n",
        );

        // Act
        const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", profile, "--json"]);
        const payload = parseExploreSyncFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(payload.error.code).toBe("PUBLIC_PROFILE_LEAK_CHECK_FAILED");
        expect(payload.error.message).toContain("wikilink_broken");
        expect(payload.issues).toEqual([
          expect.objectContaining({
            severity: "error",
            code: "PUBLIC_PROFILE_LEAK_CHECK_FAILED",
            path: "curated/topics/public-broken-link.md",
          }),
        ]);
        expect(await pathExists(resolve(wikiDir, "quartz/content"))).toBe(false);
        expect(await pathExists(resolve(wikiDir, `.llm-wiki/cache/quartz-manifest.${profile}.json`))).toBe(false);
      });
    },
  );

  it("ignores excluded private raw lint errors during public materialization", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-public-raw-drift-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const addResult = await runCliBuffered([
        "add-text",
        "--repo",
        wikiDir,
        "--title",
        "Private Drift Fixture",
        "--text",
        "Original private text.\n",
        "--json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const capture = parseSourceCapture(addResult.stdout);
      await writeFile(resolve(wikiDir, capture.source.original_path), "Tampered private text.\n", "utf8");
      await makeDefaultCuratedPagesPublic(wikiDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        {
          type: "topic",
          title: "Public Topic",
          visibility: "public",
          source_ids: [],
        },
        "# Public Topic\n\nPublic body.\n",
      );
      const lintResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      expect(lintResult.exitCode).toBe(1);
      expect(lintResult.stdout.join("\n")).toContain("raw_hash_drift");

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "public", "--json"]);
      const payload = parseExploreSync(result.stdout);
      const manifest = await readManifest(wikiDir, "public");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.materialized_paths).toContain("quartz/content/curated/topics/public-topic.md");
      expect(manifest.files.map((file) => file.source_path)).toContain("curated/topics/public-topic.md");
      expect(manifest.files.some((file) => file.source_path.startsWith("raw/"))).toBe(false);
      expect(await pathExists(resolve(wikiDir, `quartz/content/${capture.source.original_path}`))).toBe(false);
    });
  });

  it("refuses a symlinked Quartz parent before clearing content outside the wiki", async () => {
    await withTempWorkspace("llm-wiki-explore-sync-quartz-symlink-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const outsideQuartzDir = resolve(workspaceDir, "outside-quartz");
      const outsideContentPath = resolve(outsideQuartzDir, "content/keep.md");
      await mkdir(resolve(outsideQuartzDir, "content"), { recursive: true });
      await writeFile(outsideContentPath, "# Outside\n", "utf8");
      await symlink(outsideQuartzDir, resolve(wikiDir, "quartz"), "dir");

      // Act
      const result = await runCliBuffered(["explore", "sync", "--repo", wikiDir, "--profile", "local", "--json"]);
      const payload = parseExploreSyncFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.error.code).toBe("QUARTZ_CONTENT_UNSAFE");
      expect(payload.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          code: "QUARTZ_CONTENT_UNSAFE",
          path: "quartz/content",
        }),
      ]);
      await expect(readFile(outsideContentPath, "utf8")).resolves.toBe("# Outside\n");
    });
  });
});
