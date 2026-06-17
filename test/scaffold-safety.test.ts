import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { createWiki, type CreateWikiOptions } from "../src/scaffold/createWiki.js";
import { planWikiScaffold } from "../src/scaffold/files.js";
import { writeScaffold, type ScaffoldEntry } from "../src/utils/fs.js";

const defaultOptions: CreateWikiOptions = {
  agent: "generic",
  obsidian: false,
  dataview: false,
  git: true,
  quartzReady: false,
  force: false,
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseMarkdownFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\n(?<yaml>[\s\S]*?)\n---\n\n/.exec(content);
  if (match?.groups?.yaml === undefined) {
    throw new Error("missing frontmatter");
  }

  return parse(match.groups.yaml) as Record<string, unknown>;
}

describe("safe scaffold planner and writer", () => {
  it("plans scaffold file paths in deterministic lexical order", () => {
    // Arrange
    const expectedStablePrefix = [
      ".gitignore",
      ".llm-wiki/checks/lint-rules.yml",
      ".llm-wiki/config.yml",
      ".llm-wiki/profiles/local.yml",
      ".llm-wiki/profiles/public.yml",
      ".llm-wiki/profiles/review.yml",
      ".llm-wiki/schema.yml",
    ];

    // Act
    const firstPlan = planWikiScaffold(defaultOptions);
    const secondPlan = planWikiScaffold(defaultOptions);
    const firstPaths = firstPlan.map((entry) => entry.path);
    const secondPaths = secondPlan.map((entry) => entry.path);

    // Assert
    expect(firstPaths.slice(0, expectedStablePrefix.length)).toEqual(expectedStablePrefix);
    expect(firstPaths).toEqual([...firstPaths].sort());
    expect(secondPaths).toEqual(firstPaths);
  });

  it("keeps quartz-ready independent from scaffold files and contents", () => {
    // Arrange
    const quartzReadyOptions: CreateWikiOptions = { ...defaultOptions, quartzReady: true };

    // Act
    const defaultPlan = planWikiScaffold(defaultOptions);
    const quartzReadyPlan = planWikiScaffold(quartzReadyOptions);

    // Assert
    expect(quartzReadyPlan).toEqual(defaultPlan);
  });

  it("creates a missing target and reports created paths in write order", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-create-"));
    const targetDir = resolve(parent, "wiki");
    const plannedPaths = planWikiScaffold(defaultOptions).map((entry) => entry.path);

    try {
      // Act
      const result = await createWiki(targetDir, defaultOptions);

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.created).toEqual(plannedPaths);
      expect(result.value.overwritten).toEqual([]);
      expect(result.value.skipped).toEqual([]);
      expect(await readFile(resolve(targetDir, "curated/index.md"), "utf8")).toContain("# Index");
      expect(await readFile(resolve(targetDir, "curated/log.md"), "utf8")).toContain("# Log");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("creates scaffold files in an existing empty target without force", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-empty-"));
    const targetDir = resolve(parent, "wiki");
    const plannedPaths = planWikiScaffold(defaultOptions).map((entry) => entry.path);

    try {
      await mkdir(targetDir);

      // Act
      const result = await createWiki(targetDir, defaultOptions);

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.created).toEqual(plannedPaths);
      expect(result.value.overwritten).toEqual([]);
      expect(result.value.skipped).toEqual([]);
      expect(await readFile(resolve(targetDir, "README.md"), "utf8")).toContain("# llm-wiki");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("rejects traversal-like scaffold paths before writing any entry", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-invalid-entry-"));
    const targetDir = resolve(parent, "wiki");
    const entries: ScaffoldEntry[] = [
      { path: "README.md", content: "# Valid\n" },
      { path: "../escape.md", content: "invalid\n" },
    ];

    try {
      // Act
      const result = await writeScaffold(targetDir, entries, { force: false });

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.message).toContain("unsafe scaffold path");
      expect(await pathExists(targetDir)).toBe(false);
      expect(await pathExists(resolve(parent, "escape.md"))).toBe(false);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("rejects non-traversal invalid target paths before writing", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-invalid-target-form-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(parent);

      // Act
      const result = await createWiki("", defaultOptions);

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.message).toContain("unsafe target path");
      expect(await pathExists(resolve(parent, "AGENTS.md"))).toBe(false);
      expect(await pathExists(resolve(parent, "curated"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("rejects traversal-like target paths before writing", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-invalid-target-"));
    const targetDir = `${parent}/safe/../wiki`;

    try {
      // Act
      const result = await createWiki(targetDir, defaultOptions);

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.message).toContain("unsafe target path");
      expect(await pathExists(resolve(parent, "wiki"))).toBe(false);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("rejects non-traversal invalid scaffold paths before writing any entry", async () => {
    // Arrange
    const invalidPathCases = ["empty", "absolute", "backslash"] as const;

    for (const invalidPathCase of invalidPathCases) {
      const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-invalid-entry-form-"));
      const targetDir = resolve(parent, "wiki");
      const invalidPath =
        invalidPathCase === "empty"
          ? ""
          : invalidPathCase === "absolute"
            ? resolve(parent, "absolute.md")
            : "nested\\windows-separator.md";
      const entries: ScaffoldEntry[] = [
        { path: "README.md", content: "# Valid\n" },
        { path: invalidPath, content: "invalid\n" },
      ];

      try {
        // Act
        const result = await writeScaffold(targetDir, entries, { force: false });

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) {
          continue;
        }
        expect(result.error.message).toContain("unsafe scaffold path");
        expect(await pathExists(targetDir)).toBe(false);
        expect(await pathExists(resolve(parent, "README.md"))).toBe(false);
        expect(await pathExists(resolve(parent, "absolute.md"))).toBe(false);
      } finally {
        await rm(parent, { force: true, recursive: true });
      }
    }
  });

  it("rejects scaffold paths that normalize to the same file before writing any entry", async () => {
    // Arrange
    const duplicatePathCases = [
      ["README.md", "./README.md"],
      ["foo//bar.md", "foo/bar.md"],
    ] as const;

    for (const [firstPath, secondPath] of duplicatePathCases) {
      const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-duplicate-entry-"));
      const targetDir = resolve(parent, "wiki");
      const entries: ScaffoldEntry[] = [
        { path: "early.md", content: "must not be written\n" },
        { path: firstPath, content: "first\n" },
        { path: secondPath, content: "second\n" },
      ];

      try {
        // Act
        const result = await writeScaffold(targetDir, entries, { force: false });

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) {
          continue;
        }
        expect(result.error.message).toContain("duplicate scaffold path");
        expect(await pathExists(targetDir)).toBe(false);
      } finally {
        await rm(parent, { force: true, recursive: true });
      }
    }
  });

  it("rejects parent and child scaffold file collisions before writing any entry", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-parent-child-entry-"));
    const targetDir = resolve(parent, "wiki");
    const entries: ScaffoldEntry[] = [
      { path: "early.md", content: "must not be written\n" },
      { path: "notes", content: "file\n" },
      { path: "notes/topic.md", content: "child\n" },
    ];

    try {
      // Act
      const result = await writeScaffold(targetDir, entries, { force: false });

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.message).toContain("scaffold path collision");
      expect(await pathExists(targetDir)).toBe(false);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("fails on an existing non-empty target unless force is supplied", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-non-empty-"));
    const targetDir = resolve(parent, "wiki");
    const sentinelPath = resolve(targetDir, "personal-notes.md");

    try {
      await mkdir(targetDir);
      await writeFile(sentinelPath, "keep me\n", "utf8");

      // Act
      const result = await createWiki(targetDir, defaultOptions);

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.message).toContain("target directory is not empty");
      expect(await readFile(sentinelPath, "utf8")).toBe("keep me\n");
      expect(await pathExists(resolve(targetDir, "AGENTS.md"))).toBe(false);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("uses force to overwrite only scaffold files while preserving unrelated files", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-force-"));
    const targetDir = resolve(parent, "wiki");
    const readmePath = resolve(targetDir, "README.md");
    const unrelatedPath = resolve(targetDir, "personal-notes.md");

    try {
      const initial = await createWiki(targetDir, defaultOptions);
      expect(initial.ok).toBe(true);
      await writeFile(readmePath, "# Custom README\n", "utf8");
      await writeFile(unrelatedPath, "do not touch\n", "utf8");

      // Act
      const result = await createWiki(targetDir, { ...defaultOptions, force: true });

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.created).toEqual([]);
      expect(result.value.overwritten).toEqual(["README.md"]);
      expect(result.value.skipped).toEqual(planWikiScaffold(defaultOptions).map((entry) => entry.path).filter((path) => path !== "README.md"));
      expect(await readFile(readmePath, "utf8")).toContain("# llm-wiki");
      expect(await readFile(unrelatedPath, "utf8")).toBe("do not touch\n");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("rejects symlinked scaffold parent directories under force before writing", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-symlink-parent-"));
    const targetDir = resolve(parent, "wiki");
    const outsideDir = resolve(parent, "outside");
    const gitignorePath = resolve(targetDir, ".gitignore");

    try {
      const initial = await createWiki(targetDir, defaultOptions);
      expect(initial.ok).toBe(true);
      await rm(resolve(targetDir, ".llm-wiki"), { force: true, recursive: true });
      await mkdir(outsideDir);
      await writeFile(gitignorePath, "custom ignore\n", "utf8");
      await writeFile(resolve(outsideDir, "config.yml"), "outside config\n", "utf8");
      await symlink(outsideDir, resolve(targetDir, ".llm-wiki"), "dir");

      // Act
      const result = await createWiki(targetDir, { ...defaultOptions, force: true });

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.message).toContain("symlink");
      expect(await readFile(gitignorePath, "utf8")).toBe("custom ignore\n");
      expect(await readFile(resolve(outsideDir, "config.yml"), "utf8")).toBe("outside config\n");
      expect(await pathExists(resolve(outsideDir, "schema.yml"))).toBe(false);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("rejects symlinked scaffold files under force before writing", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-scaffold-symlink-file-"));
    const targetDir = resolve(parent, "wiki");
    const outsideReadmePath = resolve(parent, "outside-readme.md");
    const targetReadmePath = resolve(targetDir, "README.md");
    const gitignorePath = resolve(targetDir, ".gitignore");

    try {
      const initial = await createWiki(targetDir, defaultOptions);
      expect(initial.ok).toBe(true);
      await rm(targetReadmePath);
      await writeFile(gitignorePath, "custom ignore\n", "utf8");
      await writeFile(outsideReadmePath, "outside readme\n", "utf8");
      await symlink(outsideReadmePath, targetReadmePath, "file");

      // Act
      const result = await createWiki(targetDir, { ...defaultOptions, force: true });

      // Assert
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.message).toContain("symlink");
      expect(await readFile(gitignorePath, "utf8")).toBe("custom ignore\n");
      expect(await readFile(outsideReadmePath, "utf8")).toBe("outside readme\n");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("generates required frontmatter for curated starter pages and dashboards", () => {
    // Arrange
    const plannedEntries = new Map(
      planWikiScaffold({ ...defaultOptions, dataview: true }).map((entry) => [entry.path, entry.content]),
    );
    const schemaContent = plannedEntries.get(".llm-wiki/schema.yml");
    if (schemaContent === undefined) {
      throw new Error("missing planned schema");
    }
    const schema = parse(schemaContent) as { curated_page: { required: string[] } };
    const curatedPages = [
      "curated/contradictions.md",
      "curated/dashboards/ingestion-queue.md",
      "curated/dashboards/needs-review.md",
      "curated/home.md",
      "curated/index.md",
      "curated/log.md",
      "curated/map.md",
      "curated/open-questions.md",
    ];

    for (const pagePath of curatedPages) {
      const content = plannedEntries.get(pagePath);
      if (content === undefined) {
        throw new Error(`missing planned page: ${pagePath}`);
      }

      const frontmatter = parseMarkdownFrontmatter(content);
      for (const requiredField of schema.curated_page.required) {
        expect(frontmatter, pagePath).toHaveProperty(requiredField);
      }
      expect(frontmatter.source_ids, pagePath).toEqual([]);
      expect(content).toMatch(/^---\n[\s\S]+?\n---\n\n# /);
    }
  });
});
