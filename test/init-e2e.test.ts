import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  expectPathInsideSystemTemp,
  parseInitJson,
  pathExists,
  readGeneratedFile,
  readGeneratedYaml,
  runCliBuffered,
  withTempWorkspace,
} from "./helpers/init.js";

type Config = {
  agent: { default: string };
  agents?: {
    codex?: {
      type: string;
      command: string;
      args: string[];
      approval_policy: string;
      sandbox_mode: string;
      output_mode: string;
      timeout_seconds: number;
    };
  };
  defaults: { visibility: string; source_status: string };
  features: { obsidian: boolean; dataview: boolean; git: boolean };
  privacy: {
    raw_public_by_default: boolean;
    public_requires_visibility: string;
  };
  raw: {
    default_visibility: string;
    immutable_original_glob: string;
  };
  curated: {
    default_visibility: string;
    require_source_ids: boolean;
  };
};

type LintRules = {
  rules: {
    raw_originals_are_immutable: { severity: string; glob: string };
    public_pages_require_visibility: { severity: string; required_value: string };
    public_pages_must_not_link_raw: { severity: string };
    public_pages_must_not_link_private: { severity: string };
  };
};

describe("init end-to-end scaffold contract", () => {
  it("creates the complete approved scaffold shape with optional Codex, Obsidian, and Dataview files", async () => {
    await withTempWorkspace("llm-wiki-init-e2e-shape-", async (workspaceDir) => {
      // Arrange
      const targetDir = resolve(workspaceDir, "wiki");
      const requiredPaths = [
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
        ".obsidian/app.json",
        "AGENTS.md",
        "CODEX.md",
        "README.md",
        "curated/comparisons/.gitkeep",
        "curated/concepts/.gitkeep",
        "curated/contradictions.md",
        "curated/dashboards/.gitkeep",
        "curated/dashboards/ingestion-queue.md",
        "curated/dashboards/needs-review.md",
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

      // Act
      const result = await runCliBuffered([
        "init",
        targetDir,
        "--agent",
        "codex",
        "--obsidian",
        "--dataview",
        "--no-git",
        "--quartz-ready",
        "--json",
      ]);
      const payload = parseInitJson(result.stdout);
      const config = await readGeneratedYaml<Config>(targetDir, ".llm-wiki/config.yml");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      await expectPathInsideSystemTemp(targetDir);
      expect(payload).toMatchObject({
        command: "init",
        status: "initialized",
        targetDir,
        optionalGroups: {
          agent: "codex",
          obsidian: true,
          dataview: true,
          git: false,
          quartzReady: true,
        },
        noOp: {
          git: true,
        },
        git: {
          enabled: false,
          attempted: false,
          ok: true,
          initialized: false,
          staged: false,
          committed: false,
          error: null,
        },
        warnings: [],
        errors: [],
      });
      expect(payload.createdPaths).toEqual([...payload.createdPaths].sort());
      expect(payload.createdPaths).toEqual(expect.arrayContaining(requiredPaths));
      expect(payload.overwrittenPaths).toEqual([]);
      expect(payload.skippedPaths).toEqual([]);

      for (const requiredPath of requiredPaths) {
        expect(await pathExists(resolve(targetDir, requiredPath)), requiredPath).toBe(true);
      }

      expect(await pathExists(resolve(targetDir, "CLAUDE.md"))).toBe(false);
      expect(await pathExists(resolve(targetDir, ".git"))).toBe(false);
      expect(await pathExists(resolve(targetDir, "quartz"))).toBe(false);
      expect(await readGeneratedFile(targetDir, "CODEX.md")).toContain("AGENTS.md is authoritative");
      expect(config).toMatchObject({
        agent: { default: "codex" },
        agents: {
          codex: {
            type: "local-exec",
            command: "codex",
            args: ["exec"],
            approval_policy: "never",
            sandbox_mode: "workspace-write",
            output_mode: "git-diff",
            timeout_seconds: 900,
          },
        },
        pdf_ingestion: {
          codex_agent: "codex",
          required_plugin: "pdf@openai-primary-runtime",
          reasoning_effort: "high",
          pdf_detail: "high",
          timeout_seconds: 900,
          require_artifact_before_ingest: true,
        },
      });
      expect(await readGeneratedFile(targetDir, "curated/dashboards/ingestion-queue.md")).toContain(
        'FROM "raw/inputs"',
      );
    });
  });

  it("writes private-by-default config and lint rules that preserve raw/curated separation", async () => {
    await withTempWorkspace("llm-wiki-init-e2e-privacy-", async (workspaceDir) => {
      // Arrange
      const targetDir = resolve(workspaceDir, "wiki");

      // Act
      const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);
      const config = await readGeneratedYaml<Config>(targetDir, ".llm-wiki/config.yml");
      const lintRules = await readGeneratedYaml<LintRules>(targetDir, ".llm-wiki/checks/lint-rules.yml");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(config).toMatchObject({
        agent: { default: "generic" },
        defaults: {
          visibility: "private",
          source_status: "queued",
        },
        features: {
          obsidian: false,
          dataview: false,
          git: false,
        },
        privacy: {
          raw_public_by_default: false,
          public_requires_visibility: "public",
        },
        raw: {
          default_visibility: "private",
          immutable_original_glob: "raw/inputs/**/original.*",
        },
        curated: {
          default_visibility: "private",
          require_source_ids: true,
        },
      });
      expect(lintRules.rules.raw_originals_are_immutable).toEqual({
        severity: "error",
        glob: "raw/inputs/**/original.*",
      });
      expect(lintRules.rules.public_pages_require_visibility).toEqual({
        severity: "error",
        required_value: "public",
      });
      expect(lintRules.rules.public_pages_must_not_link_raw.severity).toBe("error");
      expect(lintRules.rules.public_pages_must_not_link_private.severity).toBe("error");
    });
  });

  it("supports safe force reruns without overwriting unrelated user files", async () => {
    await withTempWorkspace("llm-wiki-init-e2e-force-", async (workspaceDir) => {
      // Arrange
      const targetDir = resolve(workspaceDir, "wiki");
      const agentsPath = resolve(targetDir, "AGENTS.md");
      const unrelatedPath = resolve(targetDir, "notes", "private.md");
      const initial = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);
      expect(initial.exitCode).toBe(0);
      await writeFile(agentsPath, "# Custom agent notes\n", "utf8");
      await mkdir(resolve(targetDir, "notes"));
      await writeFile(unrelatedPath, "human-authored note\n", "utf8");

      // Act
      const result = await runCliBuffered([
        "init",
        targetDir,
        "--agent",
        "claude",
        "--force",
        "--no-git",
        "--json",
      ]);
      const payload = parseInitJson(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.createdPaths).toContain("CLAUDE.md");
      expect(payload.overwrittenPaths).toEqual(expect.arrayContaining([".llm-wiki/config.yml", "AGENTS.md"]));
      expect(payload.skippedPaths).toContain("curated/index.md");
      expect(await readGeneratedFile(targetDir, "AGENTS.md")).toContain("# LLM Wiki Agent Instructions");
      expect(await readFile(unrelatedPath, "utf8")).toBe("human-authored note\n");
      expect(await pathExists(resolve(targetDir, "CODEX.md"))).toBe(false);
    });
  });

  it("rejects unsupported agents and unsafe target paths before creating output", async () => {
    await withTempWorkspace("llm-wiki-init-e2e-reject-", async (workspaceDir) => {
      // Arrange
      const unsupportedAgentTarget = resolve(workspaceDir, "unsupported-agent");
      const traversalTarget = `${workspaceDir}/safe/../traversal`;

      // Act
      const unsupportedAgent = await runCliBuffered([
        "init",
        unsupportedAgentTarget,
        "--agent",
        "gpt",
        "--json",
      ]);
      const traversal = await runCliBuffered(["init", traversalTarget, "--no-git", "--json"]);

      // Assert
      expect(unsupportedAgent.exitCode).toBe(1);
      expect(unsupportedAgent.stdout).toEqual([]);
      expect(unsupportedAgent.stderr.join("\n")).toContain("unsupported agent");
      expect(await pathExists(unsupportedAgentTarget)).toBe(false);
      expect(traversal.exitCode).toBe(1);
      expect(traversal.stdout).toEqual([]);
      expect(traversal.stderr.join("\n")).toContain("unsafe target path");
      expect(await pathExists(resolve(workspaceDir, "traversal"))).toBe(false);
    });
  });
});
