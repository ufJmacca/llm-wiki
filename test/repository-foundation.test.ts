import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

type GitHubWorkflow = {
  name?: string;
  on?: unknown;
  jobs?: Record<
    string,
    {
      "runs-on"?: string;
      steps?: Array<{
        name?: string;
        uses?: string;
        run?: string;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

describe("repository documentation and CI foundation", () => {
  it("documents the package layout and local verification commands", async () => {
    // Arrange
    const requiredCommands = ["npm ci", "npm run lint", "npm test", "npm run build"];
    const requiredPaths = [
      "src/cli.ts",
      "src/commands/init.ts",
      "src/scaffold/",
      "src/scaffold/templates/",
      "src/utils/",
      "test/",
      ".github/workflows/ci.yml",
    ];

    // Act
    const readme = await readRepoFile("README.md");

    // Assert
    for (const command of requiredCommands) {
      expect(readme, command).toContain(command);
    }
    for (const path of requiredPaths) {
      expect(readme, path).toContain(path);
    }
    expect(readme).toContain("Node 22");
    expect(readme).toContain("same commands run in CI");
  });

  it("documents the first supported init workflow and generated scaffold semantics", async () => {
    // Arrange
    const workflowCommand = "llm-wiki init my-wiki --agent codex --obsidian --dataview --git --quartz-ready";
    const generatedSemantics = [
      "raw/inputs/",
      "raw/queue/",
      "curated/",
      "curated/index.md",
      "curated/log.md",
      ".llm-wiki/config.yml",
      ".llm-wiki/schema.yml",
      ".llm-wiki/profiles/local.yml",
      ".llm-wiki/profiles/review.yml",
      ".llm-wiki/profiles/public.yml",
      "AGENTS.md",
      "CODEX.md",
      "CLAUDE.md",
    ];

    // Act
    const readme = await readRepoFile("README.md");

    // Assert
    expect(readme).toContain(workflowCommand);
    expect(readme).toContain("cd my-wiki");
    expect(readme).toContain("git status");
    for (const semantic of generatedSemantics) {
      expect(readme, semantic).toContain(semantic);
    }
    expect(readme).toContain("append-only operation ledger");
    expect(readme).toContain("content-oriented wiki map");
    expect(readme).toContain("raw originals are immutable source material");
    expect(readme).toContain("`--quartz-ready` is accepted but currently a no-op");
  });

  it("documents privacy defaults, agent-file behavior, and deferred features", async () => {
    // Arrange
    const deferredFeatures = [
      "ingest",
      "Quartz runtime",
      "upload",
      "GitHub Pages deploy",
    ];

    // Act
    const readme = await readRepoFile("README.md");

    // Assert
    expect(readme).toContain("private by default");
    expect(readme).toMatch(/public publishing is opt-in/i);
    expect(readme).toContain("public profile excludes `raw/**`");
    expect(readme).toContain("raw source originals are excluded from Explorer profiles by default");
    expect(readme).toContain("AGENTS.md is always generated");
    expect(readme).toContain("canonical, model-agnostic");
    expect(readme).toContain("CODEX.md is generated only with `--agent codex`");
    expect(readme).toContain("CLAUDE.md is generated only with `--agent claude`");
    expect(readme).toContain("`llm-wiki add <path> --title <title>`");
    expect(readme).toContain("`llm-wiki add-text --title <title> --text <text>`");
    expect(readme).toContain("Duplicate content returns the existing source metadata");
    expect(readme).toContain("`llm-wiki lint` reports stable issue records");
    expect(readme).toContain("`llm-wiki index rebuild` writes `.llm-wiki/cache/pages.json`");
    expect(readme).toContain("Public leak checks are represented in generated lint-rule configuration and enforced");
    for (const feature of deferredFeatures) {
      expect(readme, feature).toContain(feature);
    }
  });

  it("defines a Node 22 CI workflow that runs the local verification commands", async () => {
    // Arrange
    const expectedRuns = ["npm ci", "npm run lint", "npm test", "npm run build"];

    // Act
    const workflowContent = await readRepoFile(".github/workflows/ci.yml");
    const workflow = parse(workflowContent) as GitHubWorkflow;
    const verifyJob = workflow.jobs?.verify;
    const steps = verifyJob?.steps ?? [];
    const runCommands = steps.map((step) => step.run).filter((run): run is string => run !== undefined);
    const setupNodeStep = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));

    // Assert
    expect(workflow.name).toBe("CI");
    expect(workflow.on).toBeDefined();
    expect(verifyJob?.["runs-on"]).toBe("ubuntu-latest");
    expect(setupNodeStep?.with?.["node-version"]).toBe(22);
    expect(runCommands).toEqual(expectedRuns);
  });

  it("keeps CI independent from generated wiki repositories", async () => {
    // Arrange
    const generatedRepoAssumptions = [/llm-wiki init/, /git status --exit-code/, /git diff --exit-code/, /generated-wiki/];

    // Act
    const workflowContent = await readRepoFile(".github/workflows/ci.yml");

    // Assert
    for (const assumption of generatedRepoAssumptions) {
      expect(workflowContent).not.toMatch(assumption);
    }
  });
});
