import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { planWikiScaffold } from "../src/scaffold/files.js";
import {
  defaultCreateWikiOptions,
  parseInitJson,
  readTreeSnapshot,
  runCliBuffered,
  withTempWorkspace,
} from "./helpers/init.js";

const approvedDefaultScaffoldPaths = [
  ".gitignore",
  ".llm-wiki/checks/lint-rules.yml",
  ".llm-wiki/config.yml",
  ".llm-wiki/profiles/local.yml",
  ".llm-wiki/profiles/public.yml",
  ".llm-wiki/profiles/review.yml",
  ".llm-wiki/schema.yml",
  ".llm-wiki/templates/comparison.md",
  ".llm-wiki/templates/concept.md",
  ".llm-wiki/templates/entity.md",
  ".llm-wiki/templates/log-entry.md",
  ".llm-wiki/templates/question.md",
  ".llm-wiki/templates/review-page.md",
  ".llm-wiki/templates/source-card.md",
  ".llm-wiki/templates/source-summary.md",
  ".llm-wiki/templates/topic.md",
  "AGENTS.md",
  "README.md",
  "curated/comparisons/.gitkeep",
  "curated/concepts/.gitkeep",
  "curated/contradictions.md",
  "curated/dashboards/.gitkeep",
  "curated/entities/.gitkeep",
  "curated/home.md",
  "curated/index.md",
  "curated/log.md",
  "curated/map.md",
  "curated/open-questions.md",
  "curated/questions/.gitkeep",
  "curated/sources/.gitkeep",
  "curated/topics/.gitkeep",
  "raw/README.md",
  "raw/assets/.gitkeep",
  "raw/inputs/.gitkeep",
  "raw/queue/.gitkeep",
];

describe("scaffold determinism contract", () => {
  it("plans the approved default scaffold path set in lexical order", () => {
    // Arrange
    const expectedPaths = approvedDefaultScaffoldPaths;

    // Act
    const plannedPaths = planWikiScaffold(defaultCreateWikiOptions).map((entry) => entry.path);

    // Assert
    expect(plannedPaths).toEqual(expectedPaths);
    expect(plannedPaths).toEqual([...plannedPaths].sort());
    expect(new Set(plannedPaths).size).toBe(plannedPaths.length);
    for (const plannedPath of plannedPaths) {
      expect(plannedPath).not.toContain("\\");
      expect(plannedPath).not.toContain("..");
    }
  });

  it("plans the Codex scaffold path set in lexical order with only the Codex variant added", () => {
    // Arrange
    const expectedPaths = [...approvedDefaultScaffoldPaths, "CODEX.md"].sort();

    // Act
    const plannedPaths = planWikiScaffold({ ...defaultCreateWikiOptions, agent: "codex" }).map((entry) => entry.path);

    // Assert
    expect(plannedPaths).toEqual(expectedPaths);
    expect(plannedPaths).toEqual([...plannedPaths].sort());
    expect(plannedPaths).toContain(".llm-wiki/config.yml");
    expect(plannedPaths).toContain("CODEX.md");
    expect(plannedPaths).not.toContain("CLAUDE.md");
  });

  it("keeps Codex scaffold content stable and free of literal secrets", () => {
    // Arrange
    const secretLikePattern = /api[_-]?key|secret|token|password|sk-/i;

    // Act
    const firstPlan = planWikiScaffold({ ...defaultCreateWikiOptions, agent: "codex" });
    const secondPlan = planWikiScaffold({ ...defaultCreateWikiOptions, agent: "codex" });
    const config = firstPlan.find((entry) => entry.path === ".llm-wiki/config.yml");

    // Assert
    expect(secondPlan).toEqual(firstPlan);
    expect(config?.content).toBeDefined();
    expect(config?.content).not.toMatch(secretLikePattern);
  });

  it("keeps scaffold content stable and free of generated timestamps", () => {
    // Arrange
    const generatedTimestampPattern = /\b\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+)?\b/;

    // Act
    const firstPlan = planWikiScaffold(defaultCreateWikiOptions);
    const secondPlan = planWikiScaffold(defaultCreateWikiOptions);

    // Assert
    expect(secondPlan).toEqual(firstPlan);
    for (const entry of firstPlan) {
      expect(entry.content, entry.path).not.toMatch(generatedTimestampPattern);
    }
  });

  it("creates byte-for-byte identical no-Git repos across different temp targets", async () => {
    await withTempWorkspace("llm-wiki-determinism-output-", async (workspaceDir) => {
      // Arrange
      const firstTarget = resolve(workspaceDir, "first-wiki");
      const secondTarget = resolve(workspaceDir, "second-wiki");

      // Act
      const first = await runCliBuffered(["init", firstTarget, "--agent", "claude", "--dataview", "--no-git", "--json"]);
      const second = await runCliBuffered(["init", secondTarget, "--agent", "claude", "--dataview", "--no-git", "--json"]);
      const firstPayload = parseInitJson(first.stdout);
      const secondPayload = parseInitJson(second.stdout);
      const firstSnapshot = await readTreeSnapshot(firstTarget);
      const secondSnapshot = await readTreeSnapshot(secondTarget);

      // Assert
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(firstPayload.createdPaths).toEqual(secondPayload.createdPaths);
      expect(firstPayload.overwrittenPaths).toEqual([]);
      expect(secondPayload.overwrittenPaths).toEqual([]);
      expect(firstSnapshot).toEqual(secondSnapshot);
    });
  });

  it("keeps quartz-ready as a declared no-op until explore init owns Quartz files", async () => {
    await withTempWorkspace("llm-wiki-determinism-quartz-ready-", async (workspaceDir) => {
      // Arrange
      const defaultTarget = resolve(workspaceDir, "default-wiki");
      const quartzReadyTarget = resolve(workspaceDir, "quartz-ready-wiki");

      // Act
      const defaultResult = await runCliBuffered(["init", defaultTarget, "--no-git", "--json"]);
      const quartzReadyResult = await runCliBuffered([
        "init",
        quartzReadyTarget,
        "--quartz-ready",
        "--no-git",
        "--json",
      ]);
      const defaultSnapshot = await readTreeSnapshot(defaultTarget);
      const quartzReadySnapshot = await readTreeSnapshot(quartzReadyTarget);

      // Assert
      expect(defaultResult.exitCode).toBe(0);
      expect(quartzReadyResult.exitCode).toBe(0);
      expect(parseInitJson(quartzReadyResult.stdout).optionalGroups.quartzReady).toBe(true);
      expect(quartzReadySnapshot).toEqual(defaultSnapshot);
      expect([...quartzReadySnapshot.keys()].some((path) => path.startsWith("quartz/"))).toBe(false);
    });
  });
});
