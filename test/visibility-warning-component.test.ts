import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendJsonCodeBlock,
  ComponentTestDocument,
  executeGeneratedClientScript,
  extractGeneratedClientScript,
  linksFromVNode,
  renderGeneratedQuartzComponent,
  textFromVNode,
} from "./helpers/generatedComponentDom.js";
import { parseInitJson, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function initializeQuartzRuntime(wikiDir: string): Promise<void> {
  const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toEqual([]);
}

function appendVisibilityWarningMarker(
  document: ComponentTestDocument,
  currentSlug = "_llm-wiki/review/visibility-warnings",
): void {
  const marker = document.createElement("aside");
  marker.dataset.llmWikiVisibilityWarning = "true";
  marker.dataset.llmWikiCurrentSlug = currentSlug;
  document.article.append(marker);
}

describe("LlmWikiVisibilityWarning generated component", () => {
  it("renders page-level private frontmatter warnings with severity, reason, impact, action, path, and review links", async () => {
    await withTempWorkspace("llm-wiki-visibility-warning-component-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiVisibilityWarning.tsx");
      const rendered = renderGeneratedQuartzComponent(component, {
        fileData: {
          slug: "curated/private-note",
          frontmatter: {
            title: "Private Note",
            path: "curated/private-note.md",
            visibility: "private",
          },
        },
      });
      const renderedText = textFromVNode(rendered);
      const renderedLinks = linksFromVNode(rendered);
      const layout = await readGeneratedFile(wikiDir, "quartz/quartz.layout.ts");

      // Assert
      expect(renderedText).toContain("warning: private_visibility");
      expect(renderedText).toContain("Severitywarning");
      expect(renderedText).toContain("ReasonThis page is marked visibility: private.");
      expect(renderedText).toContain("Affected pathcurated/private-note.md");
      expect(renderedText).toContain(
        "Public impactPrivate page text, links, search snippets, or graph nodes could become visible if selected by a public profile.",
      );
      expect(renderedText).toContain(
        "Recommended actionExclude this page from public profiles or review it and set visibility: public.",
      );
      expect(renderedLinks).toEqual([
        { href: "/_llm-wiki/review/visibility-warnings", text: "Visibility warnings" },
        { href: "/_llm-wiki/review/profile-summary", text: "Profile summary" },
      ]);
      expect(layout).toContain("LlmWikiVisibilityWarning()");
      expect(layout).toContain('page.fileData.frontmatter?.visibility === "private"');
      expect(layout).toContain('page.fileData.frontmatter?.type === "raw_source"');
      expect(layout).toContain("page.fileData.frontmatter?.llm_wiki_public_unsafe === true");
    });
  });

  it("renders default-private raw source cards as private warnings instead of raw source errors", async () => {
    await withTempWorkspace("llm-wiki-visibility-warning-raw-source-private-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiVisibilityWarning.tsx");
      const rendered = renderGeneratedQuartzComponent(component, {
        fileData: {
          slug: "raw/inputs/2026/06/src-queued/_source",
          frontmatter: {
            type: "raw_source",
            title: "Queued URL Source",
            path: "raw/inputs/2026/06/src-queued/_source.md",
            visibility: "private",
          },
        },
      });
      const renderedText = textFromVNode(rendered);

      // Assert
      expect(renderedText).toContain("warning: private_visibility");
      expect(renderedText).toContain("Severitywarning");
      expect(renderedText).toContain("Affected pathraw/inputs/2026/06/src-queued/_source.md");
      expect(renderedText).not.toContain("error: raw_sources_default_private");
      expect(renderedText).not.toContain("Severityerror");
    });
  });

  it("keeps public raw source cards error-level", async () => {
    await withTempWorkspace("llm-wiki-visibility-warning-raw-source-public-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiVisibilityWarning.tsx");
      const rendered = renderGeneratedQuartzComponent(component, {
        fileData: {
          slug: "raw/inputs/2026/06/src-public/_source",
          frontmatter: {
            type: "raw_source",
            title: "Public Raw Source",
            path: "raw/inputs/2026/06/src-public/_source.md",
            visibility: "public",
          },
        },
      });
      const renderedText = textFromVNode(rendered);

      // Assert
      expect(renderedText).toContain("error: raw_sources_default_private");
      expect(renderedText).toContain("Severityerror");
      expect(renderedText).toContain("ReasonRaw source cards must remain private.");
      expect(renderedText).toContain("Affected pathraw/inputs/2026/06/src-public/_source.md");
    });
  });

  it("renders page-level public-unsafe frontmatter warnings with severity, reason, impact, action, path, and review links", async () => {
    await withTempWorkspace("llm-wiki-visibility-warning-public-unsafe-component-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiVisibilityWarning.tsx");
      const rendered = renderGeneratedQuartzComponent(component, {
        fileData: {
          slug: "curated/public-unsafe-note",
          frontmatter: {
            title: "Public Unsafe Note",
            path: "curated/public-unsafe-note.md",
            public_safe: false,
          },
        },
      });
      const renderedText = textFromVNode(rendered);
      const renderedLinks = linksFromVNode(rendered);
      const layout = await readGeneratedFile(wikiDir, "quartz/quartz.layout.ts");

      // Assert
      expect(renderedText).toContain("error: public_private_page_selected");
      expect(renderedText).toContain("Severityerror");
      expect(renderedText).toContain(
        "ReasonPage frontmatter marks this content as unsafe for public output.",
      );
      expect(renderedText).toContain("Affected pathcurated/public-unsafe-note.md");
      expect(renderedText).toContain(
        "Public impactPublic output could include content that has not been approved for publication.",
      );
      expect(renderedText).toContain(
        "Recommended actionReview the page and set visibility: public only after it is safe to publish.",
      );
      expect(renderedLinks).toEqual([
        { href: "/_llm-wiki/review/visibility-warnings", text: "Visibility warnings" },
        { href: "/_llm-wiki/review/profile-summary", text: "Profile summary" },
      ]);
      expect(layout).toContain("page.fileData.frontmatter?.public_safe === false");
      expect(layout).toContain("page.fileData.frontmatter?.llm_wiki_public_unsafe === true");
    });
  });

  it("renders generated warning-list data with multiple severities, reasons, actions, paths, and review links", async () => {
    await withTempWorkspace("llm-wiki-visibility-warning-list-component-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const document = new ComponentTestDocument();
      appendVisibilityWarningMarker(document, "curated/review/deep-page");
      appendJsonCodeBlock(document, [
        {
          severity: "error",
          rule_id: "public_private_page_selected",
          reason: "Page frontmatter marks unsafe public content.",
          path: "curated/unsafe.md",
          public_impact: "Unsafe private details could publish.",
          recommended_action: "Remove the page from public profile selection.",
        },
        {
          severity: "warning",
          rule_id: "private_visibility",
          message: "Private page selected for review.",
          path: "curated/private.md",
          fix_hint: "Keep the page private until reviewed.",
        },
      ]);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiVisibilityWarning.tsx");
      const script = extractGeneratedClientScript(component, "visibilityWarningScript");
      executeGeneratedClientScript(script, document);
      const renderedWarnings = document.article.querySelector("[data-llm-wiki-visibility-warning-list]");
      const links = document.article.querySelectorAll("a").map((link) => ({
        href: link.href,
        text: link.textContent,
      }));

      // Assert
      expect(renderedWarnings?.textContent).toContain("error: public_private_page_selected");
      expect(renderedWarnings?.textContent).toContain("Severityerror");
      expect(renderedWarnings?.textContent).toContain("ReasonPage frontmatter marks unsafe public content.");
      expect(renderedWarnings?.textContent).toContain("Affected pathcurated/unsafe.md");
      expect(renderedWarnings?.textContent).toContain("Public impactUnsafe private details could publish.");
      expect(renderedWarnings?.textContent).toContain(
        "Recommended actionRemove the page from public profile selection.",
      );
      expect(renderedWarnings?.textContent).toContain("warning: private_visibility");
      expect(renderedWarnings?.textContent).toContain("Severitywarning");
      expect(renderedWarnings?.textContent).toContain("ReasonPrivate page selected for review.");
      expect(renderedWarnings?.textContent).toContain("Affected pathcurated/private.md");
      expect(renderedWarnings?.textContent).toContain(
        "Public impactPublic output could include private or unsafe content.",
      );
      expect(renderedWarnings?.textContent).toContain("Recommended actionKeep the page private until reviewed.");
      expect(links).toEqual([
        { href: "../../_llm-wiki/review/visibility-warnings", text: "Visibility warnings" },
        { href: "../../_llm-wiki/review/profile-summary", text: "Profile summary" },
      ]);
    });
  });

  it("does not mutate pages without the visibility warning marker", async () => {
    await withTempWorkspace("llm-wiki-visibility-warning-unmarked-page-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const document = new ComponentTestDocument();
      appendJsonCodeBlock(document, [
        {
          severity: "warning",
          rule_id: "private_visibility",
          reason: "Normal article JSON mentioning a visibility rule.",
          path: "curated/ordinary.md",
        },
      ]);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiVisibilityWarning.tsx");
      const script = extractGeneratedClientScript(component, "visibilityWarningScript");
      executeGeneratedClientScript(script, document);

      // Assert
      expect(document.article.querySelector("[data-llm-wiki-visibility-warning-list]")).toBeNull();
      expect(document.article.querySelectorAll("a")).toEqual([]);
    });
  });
});
