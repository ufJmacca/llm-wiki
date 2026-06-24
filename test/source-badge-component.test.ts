import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendJsonCodeBlock,
  ComponentTestDocument,
  executeGeneratedClientScript,
  extractGeneratedClientScript,
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

function appendSourceBadgeMarker(document: ComponentTestDocument, currentSlug = "_llm-wiki/review/source-queue"): void {
  const marker = document.createElement("aside");
  marker.dataset.llmWikiSourceBadge = "true";
  marker.dataset.llmWikiCurrentSlug = currentSlug;
  document.article.append(marker);
}

describe("LlmWikiSourceBadge generated component", () => {
  it("renders source kind, queue status, visibility, and source/page links from review item data", async () => {
    await withTempWorkspace("llm-wiki-source-badge-component-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const document = new ComponentTestDocument();
      appendSourceBadgeMarker(document);
      appendJsonCodeBlock(document, [
        {
          source: {
            source_id: "src-private-url",
            title: "Private URL Capture",
            source_kind: "url",
            queue_status: "queued",
            visibility: "private",
            source_card_path: "raw/sources/src-private-url.md",
            page_path: "raw/sources/src-private-url.md",
          },
        },
        {
          source_id: "src-reviewed-page",
          title: "Reviewed Page",
          source_kind: "text",
          status: "ingested",
          visibility: "public",
          page_path: "curated/reviewed-page.md",
        },
      ]);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiSourceBadge.tsx");
      const script = extractGeneratedClientScript(component, "sourceBadgeScript");
      executeGeneratedClientScript(script, document);
      const layout = await readGeneratedFile(wikiDir, "quartz/quartz.layout.ts");
      const renderedBadges = document.article.querySelector("[data-llm-wiki-source-badge-list]");
      const links = document.article.querySelectorAll("a").map((link) => ({
        href: link.href,
        text: link.textContent,
      }));

      // Assert
      expect(renderedBadges?.textContent).toContain("Private URL Capture");
      expect(renderedBadges?.textContent).toContain("Source kindurl");
      expect(renderedBadges?.textContent).toContain("Queue statusqueued");
      expect(renderedBadges?.textContent).toContain("Visibilityprivate");
      expect(renderedBadges?.textContent).toContain("Source cardraw/sources/src-private-url.md");
      expect(renderedBadges?.textContent).toContain("Reviewed Page");
      expect(renderedBadges?.textContent).toContain("Queue statusingested");
      expect(renderedBadges?.textContent).toContain("Visibilitypublic");
      expect(renderedBadges?.textContent).toContain("Pagecurated/reviewed-page.md");
      expect(links).toEqual([
        { href: "../../raw/sources/src-private-url", text: "raw/sources/src-private-url.md" },
        { href: "../../curated/reviewed-page", text: "curated/reviewed-page.md" },
      ]);
      expect(layout).toContain("LlmWikiSourceBadge()");
      expect(layout).toContain("page.fileData.frontmatter?.llm_wiki_source_badge === true");
    });
  });

  it("renders source badges from generated review rows that provide a sources array", async () => {
    await withTempWorkspace("llm-wiki-source-badge-sources-array-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const document = new ComponentTestDocument();
      appendSourceBadgeMarker(document, "_llm-wiki/review/stale-pages");
      appendJsonCodeBlock(document, [
        {
          path: "curated/topics/stale-page.md",
          title: "Stale Page",
          review_status: "needs-human-review",
          sources: [
            {
              source_id: "src-stale-url",
              title: "Stale URL Source",
              source_kind: "url",
              queue_status: "queued",
              visibility: "private",
              source_card_path: "raw/sources/src-stale-url.md",
              page_path: "curated/topics/stale-page.md",
            },
          ],
        },
      ]);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiSourceBadge.tsx");
      const script = extractGeneratedClientScript(component, "sourceBadgeScript");
      executeGeneratedClientScript(script, document);
      const renderedBadges = document.article.querySelector("[data-llm-wiki-source-badge-list]");
      const links = document.article.querySelectorAll("a").map((link) => ({
        href: link.href,
        text: link.textContent,
      }));

      // Assert
      expect(renderedBadges?.textContent).toContain("Stale URL Source");
      expect(renderedBadges?.textContent).toContain("Source kindurl");
      expect(renderedBadges?.textContent).toContain("Queue statusqueued");
      expect(renderedBadges?.textContent).toContain("Visibilityprivate");
      expect(renderedBadges?.textContent).toContain("Source cardraw/sources/src-stale-url.md");
      expect(links).toEqual([{ href: "../../raw/sources/src-stale-url", text: "raw/sources/src-stale-url.md" }]);
    });
  });

  it("does not mutate pages without the source badge marker", async () => {
    await withTempWorkspace("llm-wiki-source-badge-unmarked-page-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const document = new ComponentTestDocument();
      appendJsonCodeBlock(document, [
        {
          source_id: "src-normal-article-json",
          title: "Normal Article JSON",
          source_kind: "url",
          status: "queued",
          source_card_path: "raw/sources/src-normal-article-json.md",
        },
      ]);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiSourceBadge.tsx");
      const script = extractGeneratedClientScript(component, "sourceBadgeScript");
      executeGeneratedClientScript(script, document);

      // Assert
      expect(document.article.querySelector("[data-llm-wiki-source-badge-list]")).toBeNull();
      expect(document.article.querySelectorAll("a")).toEqual([]);
    });
  });

  it("renders client-created links relative to the current Quartz slug", async () => {
    await withTempWorkspace("llm-wiki-source-badge-relative-links-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const document = new ComponentTestDocument();
      appendSourceBadgeMarker(document, "curated/review/deep-page");
      appendJsonCodeBlock(document, [
        {
          source_id: "src-nested-page",
          title: "Nested Page Source",
          source_kind: "text",
          queue_status: "ingested",
          visibility: "public",
          page_path: "curated/reviewed-page.md",
        },
      ]);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiSourceBadge.tsx");
      const script = extractGeneratedClientScript(component, "sourceBadgeScript");
      executeGeneratedClientScript(script, document);
      const links = document.article.querySelectorAll("a").map((link) => ({
        href: link.href,
        text: link.textContent,
      }));

      // Assert
      expect(links).toEqual([{ href: "../../curated/reviewed-page", text: "curated/reviewed-page.md" }]);
    });
  });
});
