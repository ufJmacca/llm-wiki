import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { createWiki, type CreateWikiOptions } from "../src/scaffold/createWiki.js";
import { planWikiScaffold } from "../src/scaffold/files.js";

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

async function readGeneratedFile(targetDir: string, path: string): Promise<string> {
  return readFile(resolve(targetDir, path), "utf8");
}

describe("core wiki scaffold templates", () => {
  it("creates the required default wiki tree on init", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-core-tree-"));
    const targetDir = resolve(parent, "wiki");
    const requiredPaths = [
      "README.md",
      "AGENTS.md",
      ".gitignore",
      ".llm-wiki/config.yml",
      ".llm-wiki/schema.yml",
      ".llm-wiki/templates/concept.md",
      ".llm-wiki/templates/comparison.md",
      ".llm-wiki/templates/entity.md",
      ".llm-wiki/templates/log-entry.md",
      ".llm-wiki/templates/question.md",
      ".llm-wiki/templates/review-page.md",
      ".llm-wiki/templates/source-card.md",
      ".llm-wiki/templates/source-summary.md",
      ".llm-wiki/templates/topic.md",
      "raw/README.md",
      "raw/inputs/.gitkeep",
      "raw/queue/.gitkeep",
      "curated/index.md",
      "curated/log.md",
      "curated/home.md",
      "curated/contradictions.md",
      "curated/open-questions.md",
    ];

    try {
      // Act
      const result = await createWiki(targetDir, defaultOptions);

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.created).toEqual(planWikiScaffold(defaultOptions).map((entry) => entry.path));
      for (const requiredPath of requiredPaths) {
        expect(await pathExists(resolve(targetDir, requiredPath)), requiredPath).toBe(true);
      }
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("generates deterministic scaffold content without timestamps", () => {
    // Arrange
    const dynamicTimestampPattern = /\b\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+)?\b/;

    // Act
    const firstPlan = planWikiScaffold(defaultOptions);
    const secondPlan = planWikiScaffold(defaultOptions);

    // Assert
    expect(secondPlan).toEqual(firstPlan);
    for (const entry of firstPlan) {
      expect(entry.content, entry.path).not.toMatch(dynamicTimestampPattern);
    }
  });

  it("generates canonical model-agnostic AGENTS.md instructions", () => {
    // Arrange
    const plannedEntries = new Map(planWikiScaffold(defaultOptions).map((entry) => [entry.path, entry.content]));

    // Act
    const agents = plannedEntries.get("AGENTS.md");

    // Assert
    expect(agents).toBeDefined();
    expect(agents).toContain("# LLM Wiki Agent Instructions");
    expect(agents).toContain("Maintain this repo as a persistent, compounding LLM Wiki.");
    expect(agents).toContain("Never modify files under `raw/inputs/**/original.*`.");
    expect(agents).toContain("Write and update curated Markdown pages under `curated/`.");
    expect(agents).toContain("Update `curated/index.md` after every ingest.");
    expect(agents).toContain("Append to `curated/log.md` after every ingest, query save, or lint pass.");
    expect(agents).toContain("Preserve provenance through `source_ids`.");
    expect(agents).toContain("Never make private/raw content public without explicit human instruction.");
    expect(agents).not.toContain("Codex");
    expect(agents).not.toContain("Claude");
  });

  it("generates parseable config and schema YAML for private raw/curated separation", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-core-yaml-"));
    const targetDir = resolve(parent, "wiki");

    try {
      await createWiki(targetDir, defaultOptions);

      // Act
      const config = parse(await readGeneratedFile(targetDir, ".llm-wiki/config.yml")) as {
        defaults: { visibility: string };
        paths: { raw: string; curated: string };
        raw: { immutable_original_glob: string };
        curated: { require_source_ids: boolean };
      };
      const schema = parse(await readGeneratedFile(targetDir, ".llm-wiki/schema.yml")) as {
        visibility: { default: string; allowed: string[] };
        raw_source: { immutable: string[] };
        curated_page: { required: string[] };
      };

      // Assert
      expect(config.defaults.visibility).toBe("private");
      expect(config.paths).toMatchObject({ raw: "raw", curated: "curated" });
      expect(config.raw.immutable_original_glob).toBe("raw/inputs/**/original.*");
      expect(config.curated.require_source_ids).toBe(true);
      expect(schema.visibility).toMatchObject({ default: "private", allowed: ["private", "public"] });
      expect(schema.raw_source.immutable).toContain("raw/inputs/**/original.*");
      expect(schema.curated_page.required).toEqual(expect.arrayContaining(["type", "title", "visibility", "source_ids"]));
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("generates stable parseable index and log control-plane pages", () => {
    // Arrange
    const plannedEntries = new Map(planWikiScaffold(defaultOptions).map((entry) => [entry.path, entry.content]));

    // Act
    const index = plannedEntries.get("curated/index.md");
    const log = plannedEntries.get("curated/log.md");

    // Assert
    expect(index).toMatch(/^---\ntype: index\ntitle: Index\nvisibility: private\nsource_ids: \[\]\n---\n\n# Index\n/);
    expect(index).toContain("| Source | Status | Summary | Key pages |");
    expect(index).toContain("| Page | Summary | Source count | Updated |");
    expect(index).toContain("## Needs review");
    expect(index).toContain("## Orphans / weakly connected pages");
    expect(log).toMatch(/^---\ntype: log\ntitle: Log\nvisibility: private\nsource_ids: \[\]\n---\n\n# Log\n/);
    expect(log).toContain("## Entry format");
    expect(log).toContain("## [operation-timestamp] operation | affected-id | title");
    expect(log).toContain("- actor:");
    expect(log).toContain("- command:");
    expect(log).toContain("- git_branch:");
    expect(log).toContain("- git_commit:");
  });
});
