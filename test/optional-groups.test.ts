import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { createWiki, type CreateWikiOptions } from "../src/scaffold/createWiki.js";

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

async function readTreeSnapshot(rootDir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const absolutePath = resolve(dir, entry);
      const pathStat = await stat(absolutePath);
      if (pathStat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      snapshot.set(relative(rootDir, absolutePath).replaceAll("\\", "/"), await readFile(absolutePath, "utf8"));
    }
  }

  await visit(rootDir);
  return snapshot;
}

describe("optional init scaffold groups", () => {
  it("creates only canonical agent instructions for the default generic init", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-optional-generic-"));
    const targetDir = resolve(parent, "wiki");

    try {
      // Act
      const result = await createWiki(targetDir, defaultOptions);
      const config = parse(await readGeneratedFile(targetDir, ".llm-wiki/config.yml")) as {
        agent: { default: string };
        agents?: Record<string, unknown>;
      };

      // Assert
      expect(result.ok).toBe(true);
      expect(await pathExists(resolve(targetDir, "AGENTS.md"))).toBe(true);
      expect(await pathExists(resolve(targetDir, "CODEX.md"))).toBe(false);
      expect(await pathExists(resolve(targetDir, "CLAUDE.md"))).toBe(false);
      expect(await readGeneratedFile(targetDir, "AGENTS.md")).toContain(
        "AGENTS.md is the canonical instruction source",
      );
      expect(config.agent.default).toBe("generic");
      expect(config.agents).toBeUndefined();
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("creates only the Codex-specific supplement when requested", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-optional-codex-"));
    const targetDir = resolve(parent, "wiki");
    const options: CreateWikiOptions = { ...defaultOptions, agent: "codex" };

    try {
      // Act
      const result = await createWiki(targetDir, options);
      const codexInstructions = await readGeneratedFile(targetDir, "CODEX.md");
      const config = parse(await readGeneratedFile(targetDir, ".llm-wiki/config.yml")) as {
        agent: { default: string };
        agents?: Record<string, unknown>;
      };

      // Assert
      expect(result.ok).toBe(true);
      expect(await pathExists(resolve(targetDir, "AGENTS.md"))).toBe(true);
      expect(await pathExists(resolve(targetDir, "CODEX.md"))).toBe(true);
      expect(await pathExists(resolve(targetDir, "CLAUDE.md"))).toBe(false);
      expect(codexInstructions).toContain("# Codex Instructions");
      expect(codexInstructions).toContain("AGENTS.md is authoritative");
      expect(codexInstructions).not.toContain("## Ingest workflow");
      expect(config.agent.default).toBe("codex");
      expect(config.agents).toEqual({
        codex: {
          type: "local-exec",
          command: "codex",
          args: ["exec"],
          approval_policy: "never",
          sandbox_mode: "workspace-write",
          output_mode: "git-diff",
          timeout_seconds: 900,
        },
      });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("creates only the thin Claude variant when requested", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-optional-claude-"));
    const targetDir = resolve(parent, "wiki");
    const options: CreateWikiOptions = { ...defaultOptions, agent: "claude" };

    try {
      // Act
      const result = await createWiki(targetDir, options);
      const claudeInstructions = await readGeneratedFile(targetDir, "CLAUDE.md");
      const config = parse(await readGeneratedFile(targetDir, ".llm-wiki/config.yml")) as {
        agent: { default: string };
        agents?: Record<string, unknown>;
      };

      // Assert
      expect(result.ok).toBe(true);
      expect(await pathExists(resolve(targetDir, "AGENTS.md"))).toBe(true);
      expect(await pathExists(resolve(targetDir, "CLAUDE.md"))).toBe(true);
      expect(await pathExists(resolve(targetDir, "CODEX.md"))).toBe(false);
      expect(claudeInstructions).toContain("# Claude Instructions");
      expect(claudeInstructions).toContain("AGENTS.md is authoritative");
      expect(claudeInstructions).not.toContain("## Ingest workflow");
      expect(config.agent.default).toBe("claude");
      expect(config.agents).toBeUndefined();
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("creates Obsidian starter files only when requested", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-optional-obsidian-"));
    const defaultTargetDir = resolve(parent, "default-wiki");
    const obsidianTargetDir = resolve(parent, "obsidian-wiki");
    const options: CreateWikiOptions = { ...defaultOptions, obsidian: true };

    try {
      // Act
      const defaultResult = await createWiki(defaultTargetDir, defaultOptions);
      const obsidianResult = await createWiki(obsidianTargetDir, options);

      // Assert
      expect(defaultResult.ok).toBe(true);
      expect(obsidianResult.ok).toBe(true);
      expect(await pathExists(resolve(defaultTargetDir, ".obsidian"))).toBe(false);
      expect(await pathExists(resolve(obsidianTargetDir, ".obsidian/app.json"))).toBe(true);
      expect(await readGeneratedFile(obsidianTargetDir, ".obsidian/app.json")).toContain("alwaysUpdateLinks");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("creates Dataview dashboards only when requested", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-optional-dataview-"));
    const defaultTargetDir = resolve(parent, "default-wiki");
    const dataviewTargetDir = resolve(parent, "dataview-wiki");
    const options: CreateWikiOptions = { ...defaultOptions, dataview: true };

    try {
      // Act
      const defaultResult = await createWiki(defaultTargetDir, defaultOptions);
      const dataviewResult = await createWiki(dataviewTargetDir, options);
      const ingestionQueue = await readGeneratedFile(dataviewTargetDir, "curated/dashboards/ingestion-queue.md");
      const needsReview = await readGeneratedFile(dataviewTargetDir, "curated/dashboards/needs-review.md");

      // Assert
      expect(defaultResult.ok).toBe(true);
      expect(dataviewResult.ok).toBe(true);
      expect(await pathExists(resolve(defaultTargetDir, "curated/dashboards/.gitkeep"))).toBe(true);
      expect(await pathExists(resolve(defaultTargetDir, "curated/dashboards/ingestion-queue.md"))).toBe(false);
      expect(await pathExists(resolve(defaultTargetDir, "curated/dashboards/needs-review.md"))).toBe(false);
      expect(ingestionQueue).toContain("FROM \"raw/inputs\"");
      expect(ingestionQueue).toContain("WHERE type = \"raw_source\" AND status != \"ingested\"");
      expect(needsReview).toContain("FROM \"curated\"");
      expect(needsReview).toContain("WHERE review_status = \"needs-human-review\"");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("keeps quartz-ready byte-for-byte identical to default init output", async () => {
    // Arrange
    const parent = await mkdtemp(resolve(tmpdir(), "llm-wiki-optional-quartz-ready-"));
    const defaultTargetDir = resolve(parent, "default-wiki");
    const quartzReadyTargetDir = resolve(parent, "quartz-ready-wiki");
    const quartzReadyOptions: CreateWikiOptions = { ...defaultOptions, quartzReady: true };

    try {
      // Act
      const defaultResult = await createWiki(defaultTargetDir, defaultOptions);
      const quartzReadyResult = await createWiki(quartzReadyTargetDir, quartzReadyOptions);
      const defaultSnapshot = await readTreeSnapshot(defaultTargetDir);
      const quartzReadySnapshot = await readTreeSnapshot(quartzReadyTargetDir);

      // Assert
      expect(defaultResult.ok).toBe(true);
      expect(quartzReadyResult.ok).toBe(true);
      expect(quartzReadySnapshot).toEqual(defaultSnapshot);
      expect(quartzReadySnapshot.has("quartz/README.md")).toBe(false);
      expect([...quartzReadySnapshot.keys()].some((path) => path.startsWith("quartz/"))).toBe(false);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});
