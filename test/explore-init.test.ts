import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseInitJson, pathExists, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

type ExploreInitEnvelope = {
  ok: true;
  command: "explore.init";
  repo: string;
  data: {
    created_paths: string[];
    install: {
      attempted: boolean;
      ok: boolean;
      command: string;
      cwd: string;
      stdout: string;
      stderr: string;
    };
  };
  warnings: string[];
};

type ExploreInitFailureEnvelope = {
  ok: false;
  command: "explore.init";
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

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

function parseExploreInit(stdout: string[]): ExploreInitEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreInitEnvelope;
}

function parseExploreInitFailure(stdout: string[]): ExploreInitFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as ExploreInitFailureEnvelope;
}

function installCallback(args: unknown[]): (error: Error | null, stdout?: string, stderr?: string) => void {
  const callback = args.at(-1);
  expect(callback).toEqual(expect.any(Function));

  return callback as (error: Error | null, stdout?: string, stderr?: string) => void;
}

describe("explore init command", () => {
  it("creates isolated Quartz runtime placeholders and prints exact install instructions without installing by default", async () => {
    await withTempWorkspace("llm-wiki-explore-init-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).not.toHaveBeenCalled();
      expect(payload).toMatchObject({
        ok: true,
        command: "explore.init",
        repo: wikiDir,
        data: {
          install: {
            attempted: false,
            ok: false,
            command: "cd quartz && npm install",
            cwd: resolve(wikiDir, "quartz"),
            stdout: "",
            stderr: "",
          },
        },
        warnings: ["Quartz dependencies were not installed. Run: cd quartz && npm install"],
      });
      expect(payload.data.created_paths).toEqual([
        "quartz/README.md",
        "quartz/components/LlmWikiQueueDashboard.tsx",
        "quartz/components/LlmWikiReviewPanel.tsx",
        "quartz/components/LlmWikiSourceBadge.tsx",
        "quartz/components/LlmWikiUploadForm.tsx",
        "quartz/components/LlmWikiVisibilityWarning.tsx",
        "quartz/package.json",
        "quartz/quartz.config.ts",
        "quartz/quartz.layout.ts",
        "quartz/scripts/llm-wiki-loopback-listen.cjs",
        "quartz/scripts/llm-wiki-sync-quartz-runtime.cjs",
      ]);
      const packageJson = JSON.parse(await readGeneratedFile(wikiDir, "quartz/package.json")) as {
        private: boolean;
        version: string;
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
      };
      expect(packageJson).toMatchObject({
        private: true,
        version: "4.5.2",
        scripts: {
          postinstall: "node scripts/llm-wiki-sync-quartz-runtime.cjs",
          build: "node ./quartz/bootstrap-cli.mjs build",
          serve: "node ./quartz/bootstrap-cli.mjs build --serve",
        },
        dependencies: {
          "@jackyzha0/quartz": "github:jackyzha0/quartz#v4.5.2",
        },
      });
      const quartzConfig = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");
      expect(quartzConfig).toContain("pageTitle: \"LLM Wiki\"");
      expect(quartzConfig).toContain("enableSiteMap: false");
      expect(quartzConfig).toContain("enableRSS: false");
      const layout = await readGeneratedFile(wikiDir, "quartz/quartz.layout.ts");
      const uploadComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiUploadForm.tsx");
      const queueDashboardComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiQueueDashboard.tsx");
      const reviewPanelComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiReviewPanel.tsx");
      const sourceBadgeComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiSourceBadge.tsx");
      const visibilityWarningComponent = await readGeneratedFile(
        wikiDir,
        "quartz/components/LlmWikiVisibilityWarning.tsx",
      );
      for (const gate of [
        { component: "LlmWikiUploadForm", field: "llm_wiki_upload" },
        { component: "LlmWikiQueueDashboard", field: "llm_wiki_queue_dashboard" },
        { component: "LlmWikiReviewPanel", field: "llm_wiki_review_panel" },
        { component: "LlmWikiSourceBadge", field: "llm_wiki_source_badge" },
        { component: "LlmWikiVisibilityWarning", field: "llm_wiki_visibility_warning" },
      ]) {
        expect(layout).toContain(`import ${gate.component} from "./components/${gate.component}"`);
        expect(layout).toContain(`${gate.component}()`);
        expect(layout).toContain(`page.fileData.frontmatter?.${gate.field} === true`);
        expect(layout).toContain(`page.fileData.frontmatter?.llm_wiki_component === "${gate.component}"`);
      }
      expect(layout).toContain('typeof page.fileData.frontmatter?.source_id === "string"');
      expect(layout).toContain('typeof page.fileData.frontmatter?.source_card_path === "string"');
      expect(uploadComponent).toContain("const LlmWikiUploadForm");
      expect(uploadComponent).toContain("/_llm-wiki/runtime/local-daemon.json");
      expect(uploadComponent).toContain('encType="multipart/form-data"');
      expect(uploadComponent).toContain("x-llm-wiki-upload-token");
      expect(uploadComponent).toContain("path: body.error.path || body?.issues?.[0]?.path");
      expect(uploadComponent).toContain("LlmWikiUploadForm.afterDOMLoaded = uploadFormScript");
      expect(uploadComponent).toContain("bindLlmWikiUploadForms");
      expect(uploadComponent).toContain('document.addEventListener(\\"nav\\", bindLlmWikiUploadForms)');
      expect(uploadComponent).not.toContain("dangerouslySetInnerHTML");
      for (const placeholder of [
        ["LlmWikiUploadForm", "llm-wiki-upload-form", uploadComponent],
        ["LlmWikiQueueDashboard", "llm-wiki-queue-dashboard", queueDashboardComponent],
        ["LlmWikiReviewPanel", "llm-wiki-review-panel", reviewPanelComponent],
        ["LlmWikiSourceBadge", "llm-wiki-source-badge", sourceBadgeComponent],
        ["LlmWikiVisibilityWarning", "llm-wiki-visibility-warning", visibilityWarningComponent],
      ]) {
        const [componentName, className, content] = placeholder;
        expect(content).not.toContain(
          `return <section class="${className}" data-llm-wiki-component="${componentName}" />`,
        );
        expect(content).not.toContain(`return <div className="${className}" />;`);
      }
      expect(queueDashboardComponent).toContain("data-llm-wiki-queue-dashboard");
      expect(queueDashboardComponent).toContain("Queued");
      expect(queueDashboardComponent).toContain("Blocked");
      expect(reviewPanelComponent).toContain("data-llm-wiki-review-panel");
      expect(reviewPanelComponent).toContain("_llm-wiki/review/source-queue");
      expect(reviewPanelComponent).toContain("_llm-wiki/review/visibility-warnings");
      expect(reviewPanelComponent).toContain("resolveRelative(currentSlug, link.href)");
      expect(reviewPanelComponent).toContain('class="internal"');
      expect(reviewPanelComponent).not.toContain('href="/_llm-wiki/review/');
      expect(sourceBadgeComponent).toContain("data-llm-wiki-source-badge");
      expect(sourceBadgeComponent).toContain("Visibility");
      expect(visibilityWarningComponent).toContain("data-llm-wiki-visibility-warning");
      expect(visibilityWarningComponent).toContain("public profiles");
      await expect(readGeneratedFile(wikiDir, "quartz/scripts/llm-wiki-loopback-listen.cjs")).resolves.toContain(
        "LLM_WIKI_EXPLORER_HOST",
      );
      await expect(readGeneratedFile(wikiDir, "quartz/scripts/llm-wiki-loopback-listen.cjs")).resolves.toContain(
        "requestedHost === undefined",
      );
      await expect(readGeneratedFile(wikiDir, "quartz/scripts/llm-wiki-sync-quartz-runtime.cjs")).resolves.toContain(
        "node_modules/@jackyzha0/quartz/quartz",
      );
    });
  });

  it("prints install instructions in human output when dependency install is not requested", async () => {
    await withTempWorkspace("llm-wiki-explore-init-human-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir]);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).not.toHaveBeenCalled();
      expect(result.stdout.join("\n")).toContain("Install dependencies: cd quartz && npm install");
    });
  });

  it("leaves existing Quartz runtime files unchanged when initializing missing placeholders", async () => {
    await withTempWorkspace("llm-wiki-explore-init-existing-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const customPackageJson = "{\"private\": true, \"name\": \"custom-quartz\"}\n";
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/package.json"), customPackageJson, "utf8");

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).not.toHaveBeenCalled();
      expect(payload.data.created_paths).toContain("quartz/quartz.config.ts");
      expect(payload.data.created_paths).not.toContain("quartz/package.json");
      expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("quartz/package.json")]));
      await expect(readGeneratedFile(wikiDir, "quartz/package.json")).resolves.toBe(customPackageJson);
    });
  });

  it("migrates old generated Quartz placeholders to the runnable runtime package", async () => {
    await withTempWorkspace("llm-wiki-explore-init-upgrade-placeholder-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      await writeFile(
        resolve(wikiDir, "quartz/README.md"),
        `# Quartz Runtime

This directory contains LLM Wiki generated Quartz placeholders.

Install dependencies:

\`\`\`bash
cd quartz && npm install
\`\`\`

Sync content with:

\`\`\`bash
llm-wiki explore sync --profile local
\`\`\`
`,
        "utf8",
      );
      await writeFile(
        resolve(wikiDir, "quartz/package.json"),
        `${JSON.stringify(
          {
            private: true,
            type: "module",
            scripts: {
              build: "quartz build",
              serve: "quartz build --serve",
            },
            dependencies: {},
            devDependencies: {},
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        resolve(wikiDir, "quartz/quartz.config.ts"),
        `// LLM Wiki Quartz placeholder.
// Replace this file with a full Quartz config when wiring the upstream Quartz runtime.
export default {
  configuration: {
    pageTitle: "LLM Wiki",
  },
  plugins: {},
};
`,
        "utf8",
      );
      await writeFile(
        resolve(wikiDir, "quartz/quartz.layout.ts"),
        `// LLM Wiki Quartz layout placeholder.
export const defaultContentPageLayout = {
  beforeBody: [],
  left: [],
  right: [],
};
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);
      const packageJson = JSON.parse(await readGeneratedFile(wikiDir, "quartz/package.json")) as {
        version: string;
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
      };

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).not.toHaveBeenCalled();
      expect(payload.data.created_paths).toContain("quartz/scripts/llm-wiki-sync-quartz-runtime.cjs");
      expect(payload.data.created_paths).not.toContain("quartz/README.md");
      expect(payload.data.created_paths).not.toContain("quartz/package.json");
      const updatedWarning = payload.warnings.find((warning) =>
        warning.startsWith("Updated generated Quartz runtime files:"),
      );
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/README.md"));
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/package.json"));
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/quartz.config.ts"));
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/quartz.layout.ts"));
      expect(payload.warnings).toEqual(
        expect.arrayContaining([
          "Quartz dependencies were not installed. Run: cd quartz && npm install",
        ]),
      );
      expect(packageJson).toMatchObject({
        version: "4.5.2",
        scripts: {
          postinstall: "node scripts/llm-wiki-sync-quartz-runtime.cjs",
          build: "node ./quartz/bootstrap-cli.mjs build",
          serve: "node ./quartz/bootstrap-cli.mjs build --serve",
        },
        dependencies: {
          "@jackyzha0/quartz": "github:jackyzha0/quartz#v4.5.2",
        },
      });
      await expect(readGeneratedFile(wikiDir, "quartz/quartz.config.ts")).resolves.toContain(
        "import { QuartzConfig } from \"./quartz/cfg\"",
      );
    });
  });

  it("migrates exact generated Quartz configs that enabled feeds without a base URL", async () => {
    await withTempWorkspace("llm-wiki-explore-init-upgrade-feed-config-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstInit = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      expect(firstInit.exitCode).toBe(0);
      const generatedConfig = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");
      const oldGeneratedConfig = generatedConfig
        .replace("enableSiteMap: false", "enableSiteMap: true")
        .replace("enableRSS: false", "enableRSS: true");
      await writeFile(resolve(wikiDir, "quartz/quartz.config.ts"), oldGeneratedConfig, "utf8");

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);
      const migratedConfig = await readGeneratedFile(wikiDir, "quartz/quartz.config.ts");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      const updatedWarning = payload.warnings.find((warning) =>
        warning.startsWith("Updated generated Quartz runtime files:"),
      );
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/quartz.config.ts"));
      expect(migratedConfig).toContain("enableSiteMap: false");
      expect(migratedConfig).toContain("enableRSS: false");
      expect(migratedConfig).not.toContain("enableSiteMap: true");
      expect(migratedConfig).not.toContain("enableRSS: true");
    });
  });

  it("migrates the prior generated layout and exact component placeholders to frontmatter gates", async () => {
    await withTempWorkspace("llm-wiki-explore-init-upgrade-upload-layout-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstInit = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      expect(firstInit.exitCode).toBe(0);
      const generatedLayout = await readGeneratedFile(wikiDir, "quartz/quartz.layout.ts");
      const gatedComponentSnippet = (component: string, field: string) => `    Component.ConditionalRender({
      component: ${component}(),
      condition: (page) =>
        page.fileData.frontmatter?.${field} === true ||
        page.fileData.frontmatter?.llm_wiki_component === "${component}",
    }),
`;
      const priorGeneratedLayout = generatedLayout
        .replace('import LlmWikiQueueDashboard from "./components/LlmWikiQueueDashboard"\n', "")
        .replace('import LlmWikiReviewPanel from "./components/LlmWikiReviewPanel"\n', "")
        .replace('import LlmWikiSourceBadge from "./components/LlmWikiSourceBadge"\n', "")
        .replace('import LlmWikiVisibilityWarning from "./components/LlmWikiVisibilityWarning"\n', "")
        .replace('import LlmWikiUploadForm from "./components/LlmWikiUploadForm"\n', "")
        .replace(gatedComponentSnippet("LlmWikiVisibilityWarning", "llm_wiki_visibility_warning"), "")
        .replace(`    Component.ConditionalRender({
      component: LlmWikiSourceBadge(),
      condition: (page) =>
        page.fileData.frontmatter?.llm_wiki_source_badge === true ||
        page.fileData.frontmatter?.llm_wiki_component === "LlmWikiSourceBadge" ||
        typeof page.fileData.frontmatter?.source_id === "string" ||
        typeof page.fileData.frontmatter?.source_card_path === "string",
    }),
`, "")
        .replace(gatedComponentSnippet("LlmWikiUploadForm", "llm_wiki_upload"), "")
        .replace(gatedComponentSnippet("LlmWikiQueueDashboard", "llm_wiki_queue_dashboard"), "")
        .replace(gatedComponentSnippet("LlmWikiReviewPanel", "llm_wiki_review_panel"), "");
      await writeFile(resolve(wikiDir, "quartz/quartz.layout.ts"), priorGeneratedLayout, "utf8");
      for (const placeholder of [
        ["LlmWikiQueueDashboard", "llm-wiki-queue-dashboard"],
        ["LlmWikiReviewPanel", "llm-wiki-review-panel"],
        ["LlmWikiSourceBadge", "llm-wiki-source-badge"],
        ["LlmWikiUploadForm", "llm-wiki-upload-form"],
        ["LlmWikiVisibilityWarning", "llm-wiki-visibility-warning"],
      ]) {
        const [componentName, className] = placeholder;
        await writeFile(
          resolve(wikiDir, `quartz/components/${componentName}.tsx`),
          `import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"

const ${componentName}: QuartzComponent = () => {
  return <section class="${className}" data-llm-wiki-component="${componentName}" />
}

export default (() => ${componentName}) satisfies QuartzComponentConstructor
`,
          "utf8",
        );
      }

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);
      const migratedLayout = await readGeneratedFile(wikiDir, "quartz/quartz.layout.ts");
      const migratedUploadComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiUploadForm.tsx");
      const migratedQueueDashboardComponent = await readGeneratedFile(
        wikiDir,
        "quartz/components/LlmWikiQueueDashboard.tsx",
      );
      const migratedReviewPanelComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiReviewPanel.tsx");
      const migratedSourceBadgeComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiSourceBadge.tsx");
      const migratedVisibilityWarningComponent = await readGeneratedFile(
        wikiDir,
        "quartz/components/LlmWikiVisibilityWarning.tsx",
      );

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      const updatedWarning = payload.warnings.find((warning) =>
        warning.startsWith("Updated generated Quartz runtime files:"),
      );
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/components/LlmWikiQueueDashboard.tsx"));
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/components/LlmWikiReviewPanel.tsx"));
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/components/LlmWikiSourceBadge.tsx"));
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/components/LlmWikiUploadForm.tsx"));
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/components/LlmWikiVisibilityWarning.tsx"));
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/quartz.layout.ts"));
      for (const gate of [
        { component: "LlmWikiUploadForm", field: "llm_wiki_upload" },
        { component: "LlmWikiQueueDashboard", field: "llm_wiki_queue_dashboard" },
        { component: "LlmWikiReviewPanel", field: "llm_wiki_review_panel" },
        { component: "LlmWikiSourceBadge", field: "llm_wiki_source_badge" },
        { component: "LlmWikiVisibilityWarning", field: "llm_wiki_visibility_warning" },
      ]) {
        expect(migratedLayout).toContain(`import ${gate.component} from "./components/${gate.component}"`);
        expect(migratedLayout).toContain(`${gate.component}()`);
        expect(migratedLayout).toContain(`page.fileData.frontmatter?.${gate.field} === true`);
      }
      expect(migratedLayout).toContain('typeof page.fileData.frontmatter?.source_id === "string"');
      expect(migratedLayout).toContain('typeof page.fileData.frontmatter?.source_card_path === "string"');
      expect(migratedUploadComponent).toContain("LlmWikiUploadForm.afterDOMLoaded = uploadFormScript");
      expect(migratedUploadComponent).toContain("/_llm-wiki/runtime/local-daemon.json");
      expect(migratedQueueDashboardComponent).toContain("data-llm-wiki-queue-dashboard");
      expect(migratedQueueDashboardComponent).not.toContain(
        'return <section class="llm-wiki-queue-dashboard" data-llm-wiki-component="LlmWikiQueueDashboard" />',
      );
      expect(migratedReviewPanelComponent).toContain("_llm-wiki/review/source-queue");
      expect(migratedReviewPanelComponent).toContain("resolveRelative(currentSlug, link.href)");
      expect(migratedReviewPanelComponent).not.toContain('href="/_llm-wiki/review/');
      expect(migratedSourceBadgeComponent).toContain("data-llm-wiki-source-badge");
      expect(migratedSourceBadgeComponent).not.toContain(
        'return <section class="llm-wiki-source-badge" data-llm-wiki-component="LlmWikiSourceBadge" />',
      );
      expect(migratedVisibilityWarningComponent).toContain("public profiles");
    });
  });

  it("migrates the exact prior generated review panel to baseUrl-aware links", async () => {
    await withTempWorkspace("llm-wiki-explore-init-upgrade-review-links-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstInit = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      expect(firstInit.exitCode).toBe(0);
      await writeFile(
        resolve(wikiDir, "quartz/components/LlmWikiReviewPanel.tsx"),
        `import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"

const LlmWikiReviewPanel: QuartzComponent = () => {
  return (
    <nav class="llm-wiki-review-panel" data-llm-wiki-review-panel="true" aria-label="LLM Wiki review">
      <h2>Review panel</h2>
      <ul>
        <li><a href="/_llm-wiki/review/overview">Overview</a></li>
        <li><a href="/_llm-wiki/review/source-queue">Source queue</a></li>
        <li><a href="/_llm-wiki/review/recent-ingests">Recent ingests</a></li>
        <li><a href="/_llm-wiki/review/needs-review">Needs review</a></li>
        <li><a href="/_llm-wiki/review/contradictions">Contradictions</a></li>
        <li><a href="/_llm-wiki/review/orphans">Orphans</a></li>
        <li><a href="/_llm-wiki/review/stale-pages">Stale pages</a></li>
        <li><a href="/_llm-wiki/review/visibility-warnings">Visibility warnings</a></li>
        <li><a href="/_llm-wiki/review/profile-summary">Profile summary</a></li>
      </ul>
    </nav>
  )
}

export default (() => LlmWikiReviewPanel) satisfies QuartzComponentConstructor
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);
      const migratedReviewPanelComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiReviewPanel.tsx");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      const updatedWarning = payload.warnings.find((warning) =>
        warning.startsWith("Updated generated Quartz runtime files:"),
      );
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/components/LlmWikiReviewPanel.tsx"));
      expect(migratedReviewPanelComponent).toContain("resolveRelative(currentSlug, link.href)");
      expect(migratedReviewPanelComponent).toContain('class="internal"');
      expect(migratedReviewPanelComponent).not.toContain('href="/_llm-wiki/review/');
    });
  });

  it("migrates the old upload form Component placeholder to the default export expected by the layout", async () => {
    await withTempWorkspace("llm-wiki-explore-init-upgrade-old-upload-placeholder-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstInit = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      expect(firstInit.exitCode).toBe(0);
      await writeFile(
        resolve(wikiDir, "quartz/components/LlmWikiUploadForm.tsx"),
        `export function Component() {
  return <div className="llm-wiki-upload-form" />;
}
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);
      const migratedLayout = await readGeneratedFile(wikiDir, "quartz/quartz.layout.ts");
      const migratedUploadComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiUploadForm.tsx");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      const updatedWarning = payload.warnings.find((warning) =>
        warning.startsWith("Updated generated Quartz runtime files:"),
      );
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/components/LlmWikiUploadForm.tsx"));
      expect(migratedLayout).toContain('import LlmWikiUploadForm from "./components/LlmWikiUploadForm"');
      expect(migratedLayout).toContain("LlmWikiUploadForm()");
      expect(migratedUploadComponent).toContain("const LlmWikiUploadForm");
      expect(migratedUploadComponent).toContain("export default (() => LlmWikiUploadForm)");
      expect(migratedUploadComponent).not.toContain("export function Component()");
    });
  });

  it("does not migrate the layout when a customized upload component lacks a default export", async () => {
    await withTempWorkspace("llm-wiki-explore-init-custom-upload-named-export-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstInit = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      expect(firstInit.exitCode).toBe(0);
      const generatedLayout = await readGeneratedFile(wikiDir, "quartz/quartz.layout.ts");
      const priorGeneratedLayout = generatedLayout
        .replace('import LlmWikiUploadForm from "./components/LlmWikiUploadForm"\n', "")
        .replace(
          `    Component.ConditionalRender({
      component: LlmWikiUploadForm(),
      condition: (page) =>
        page.fileData.frontmatter?.llm_wiki_upload === true ||
        page.fileData.frontmatter?.llm_wiki_component === "LlmWikiUploadForm",
    }),
`,
          "",
        );
      const customizedUploadComponent = `export function Component() {
  return <div className="llm-wiki-upload-form">Custom local uploader</div>;
}
`;
      await writeFile(resolve(wikiDir, "quartz/quartz.layout.ts"), priorGeneratedLayout, "utf8");
      await writeFile(
        resolve(wikiDir, "quartz/components/LlmWikiUploadForm.tsx"),
        customizedUploadComponent,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);
      const layout = await readGeneratedFile(wikiDir, "quartz/quartz.layout.ts");
      const uploadComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiUploadForm.tsx");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      const updatedWarning = payload.warnings.find((warning) =>
        warning.startsWith("Updated generated Quartz runtime files:"),
      );
      expect(updatedWarning).not.toEqual(expect.stringContaining("quartz/quartz.layout.ts"));
      expect(updatedWarning).not.toEqual(expect.stringContaining("quartz/components/LlmWikiUploadForm.tsx"));
      expect(layout).toBe(priorGeneratedLayout);
      expect(layout).not.toContain('import LlmWikiUploadForm from "./components/LlmWikiUploadForm"');
      expect(layout).not.toContain("LlmWikiUploadForm()");
      expect(uploadComponent).toBe(customizedUploadComponent);
    });
  });

  it("migrates the old placeholder layout without importing a customized upload component", async () => {
    await withTempWorkspace("llm-wiki-explore-init-old-layout-custom-upload-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const firstInit = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      expect(firstInit.exitCode).toBe(0);
      const oldPlaceholderLayout = `// LLM Wiki Quartz layout placeholder.
export const defaultContentPageLayout = {
  beforeBody: [],
  left: [],
  right: [],
};
`;
      const customizedUploadComponent = `export function Component() {
  return <div className="llm-wiki-upload-form">Custom local uploader</div>;
}
`;
      await writeFile(resolve(wikiDir, "quartz/quartz.layout.ts"), oldPlaceholderLayout, "utf8");
      await writeFile(
        resolve(wikiDir, "quartz/components/LlmWikiUploadForm.tsx"),
        customizedUploadComponent,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);
      const layout = await readGeneratedFile(wikiDir, "quartz/quartz.layout.ts");
      const uploadComponent = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiUploadForm.tsx");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      const updatedWarning = payload.warnings.find((warning) =>
        warning.startsWith("Updated generated Quartz runtime files:"),
      );
      expect(updatedWarning).toEqual(expect.stringContaining("quartz/quartz.layout.ts"));
      expect(updatedWarning).not.toEqual(expect.stringContaining("quartz/components/LlmWikiUploadForm.tsx"));
      expect(layout).not.toBe(oldPlaceholderLayout);
      expect(layout).toContain("export const sharedPageComponents");
      expect(layout).toContain("export const defaultListPageLayout");
      expect(layout).not.toContain('import LlmWikiUploadForm from "./components/LlmWikiUploadForm"');
      expect(layout).not.toContain("LlmWikiUploadForm()");
      expect(uploadComponent).toBe(customizedUploadComponent);
    });
  });

  it("preserves customized Quartz runtime files that retain old placeholder text", async () => {
    await withTempWorkspace("llm-wiki-explore-init-customized-placeholder-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz"), { recursive: true });
      const customizedPackageJson = `${JSON.stringify(
        {
          private: true,
          type: "module",
          scripts: {
            build: "quartz build",
            serve: "quartz build --serve",
          },
          dependencies: {},
          devDependencies: {},
          customRuntime: true,
        },
        null,
        2,
      )}\n`;
      const customizedReadme = `# Quartz Runtime

This directory contains LLM Wiki generated Quartz placeholders.

Custom operator notes that must not be overwritten.
`;
      const customizedConfig = `// LLM Wiki Quartz placeholder.
// User-customized config that must not be overwritten.
export default {
  configuration: {
    pageTitle: "Custom Wiki",
  },
  plugins: {},
};
`;
      const customizedLayout = `// LLM Wiki Quartz layout placeholder.
export const defaultContentPageLayout = {
  beforeBody: ["custom"],
  left: [],
  right: [],
};
`;
      const customizedQueueDashboard = `import type { QuartzComponent, QuartzComponentConstructor } from "../quartz/components/types"

const LlmWikiQueueDashboard: QuartzComponent = () => {
  return (
    <section class="llm-wiki-queue-dashboard" data-customized="true">
      Custom queue dashboard operator notes.
    </section>
  )
}

export default (() => LlmWikiQueueDashboard) satisfies QuartzComponentConstructor
`;
      await writeFile(resolve(wikiDir, "quartz/package.json"), customizedPackageJson, "utf8");
      await writeFile(resolve(wikiDir, "quartz/README.md"), customizedReadme, "utf8");
      await writeFile(resolve(wikiDir, "quartz/quartz.config.ts"), customizedConfig, "utf8");
      await writeFile(resolve(wikiDir, "quartz/quartz.layout.ts"), customizedLayout, "utf8");
      await mkdir(resolve(wikiDir, "quartz/components"), { recursive: true });
      await writeFile(
        resolve(wikiDir, "quartz/components/LlmWikiQueueDashboard.tsx"),
        customizedQueueDashboard,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).not.toHaveBeenCalled();
      expect(payload.warnings).not.toEqual(expect.arrayContaining([expect.stringContaining("Updated generated Quartz runtime files")]));
      expect(payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("quartz/package.json")]));
      await expect(readGeneratedFile(wikiDir, "quartz/package.json")).resolves.toBe(customizedPackageJson);
      await expect(readGeneratedFile(wikiDir, "quartz/README.md")).resolves.toBe(customizedReadme);
      await expect(readGeneratedFile(wikiDir, "quartz/quartz.config.ts")).resolves.toBe(customizedConfig);
      await expect(readGeneratedFile(wikiDir, "quartz/quartz.layout.ts")).resolves.toBe(customizedLayout);
      await expect(readGeneratedFile(wikiDir, "quartz/components/LlmWikiQueueDashboard.tsx")).resolves.toBe(
        customizedQueueDashboard,
      );
    });
  });

  it("runs npm install only when --install is supplied", async () => {
    await withTempWorkspace("llm-wiki-explore-init-install-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      execFileMock.mockImplementation((...args: unknown[]) => {
        installCallback(args)(null, "installed\n", "");
      });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--install", "--json"]);
      const payload = parseExploreInit(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile).toHaveBeenCalledWith(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["install"],
        { cwd: resolve(wikiDir, "quartz") },
        expect.any(Function),
      );
      expect(payload.data.install).toEqual({
        attempted: true,
        ok: true,
        command: "cd quartz && npm install",
        cwd: resolve(wikiDir, "quartz"),
        stdout: "installed\n",
        stderr: "",
      });
      expect(payload.warnings).toEqual([]);
    });
  });

  it("returns a JSON failure envelope when explicit dependency install fails", async () => {
    await withTempWorkspace("llm-wiki-explore-init-install-failure-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      execFileMock.mockImplementation((...args: unknown[]) => {
        installCallback(args)(new Error("install failed"), "", "registry unavailable\n");
      });
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--install", "--json"]);
      const payload = parseExploreInitFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload).toMatchObject({
        ok: false,
        command: "explore.init",
        repo: wikiDir,
        error: {
          code: "QUARTZ_INSTALL_FAILED",
          message: "Quartz dependency install failed.",
          hint: "Run cd quartz && npm install after fixing the package manager error.",
        },
        issues: [
          {
            severity: "error",
            code: "QUARTZ_INSTALL_FAILED",
            path: "quartz/package.json",
          },
        ],
      });
      expect(await pathExists(resolve(wikiDir, "quartz/package.json"))).toBe(true);
    });
  });

  it("keeps generated wiki ignore rules aligned with generated Quartz content and build output", async () => {
    await withTempWorkspace("llm-wiki-explore-init-gitignore-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");

      // Assert
      expect(gitignore).toContain("quartz/content/");
      expect(gitignore).toContain("quartz/public/");
      expect(gitignore).toContain("quartz/.quartz-cache/");
      expect(gitignore).toContain("quartz/quartz/");
    });
  });

  it("patches upgraded wiki ignore rules before install can copy the Quartz runtime tree", async () => {
    await withTempWorkspace("llm-wiki-explore-init-upgraded-gitignore-", async (workspaceDir) => {
      // Arrange
      execFileMock.mockReset();
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(
        resolve(wikiDir, ".gitignore"),
        ".DS_Store\n.llm-wiki/cache/\nnode_modules/\nquartz/.quartz-cache/\nquartz/content/\nquartz/public/\n",
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const payload = parseExploreInit(result.stdout);
      const gitignore = await readFile(resolve(wikiDir, ".gitignore"), "utf8");

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(execFile).not.toHaveBeenCalled();
      expect(payload.warnings).toEqual(
        expect.arrayContaining([
          "Added missing generated Quartz ignore rule: quartz/quartz/",
          "Quartz dependencies were not installed. Run: cd quartz && npm install",
        ]),
      );
      expect(gitignore).toContain("quartz/quartz/\n");
    });
  });
});
