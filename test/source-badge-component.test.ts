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

  it("renders normalized PDF status without passing extracted content through the badge", async () => {
    await withTempWorkspace("llm-wiki-source-badge-pdf-status-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const document = new ComponentTestDocument();
      appendSourceBadgeMarker(document);
      appendJsonCodeBlock(document, [
        {
          source_id: "src-pdf-status",
          title: "PDF Source",
          source_kind: "file",
          queue_status: "blocked",
          visibility: "private",
          source_card_path: "raw/inputs/pdf/_source.md",
          pdf_extraction: {
            extraction_status: "failed",
            artifact_health: "missing",
            extraction_id: "pdfext_ui_failure",
            artifact_path: "raw/inputs/private/extracted/pdf/pdfext_ui_failure/document.md",
            plugin_descriptor: "openai-pdf@1.2.3",
            model_descriptor: "explicit:gpt-5.2",
            reasoning_effort: "medium",
            pdf_detail: "high",
            diagnosis_code: "PDF_ARTIFACT_REQUIRED",
            diagnosis_message: "No validated artifact is selected.",
            retry_command: "llm-wiki extract pdf src-pdf-status",
            artifact_content: "PRIVATE EXTRACTED PDF BODY",
          },
        },
      ]);

      // Act
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiSourceBadge.tsx");
      const script = extractGeneratedClientScript(component, "sourceBadgeScript");
      executeGeneratedClientScript(script, document);
      const renderedBadge = document.article.querySelector("[data-llm-wiki-source-badge-list]");

      // Assert
      expect(renderedBadge?.textContent).toContain("PDF extractionfailed");
      expect(renderedBadge?.textContent).toContain("PDF artifact healthmissing");
      expect(renderedBadge?.textContent).toContain("PDF extraction IDpdfext_ui_failure");
      expect(renderedBadge?.textContent).toContain("PDF artifact pathraw/inputs/private/extracted/pdf/pdfext_ui_failure/document.md");
      expect(renderedBadge?.textContent).toContain("PDF provenanceopenai-pdf@1.2.3 · explicit:gpt-5.2");
      expect(renderedBadge?.textContent).toContain("PDF retryllm-wiki extract pdf src-pdf-status");
      expect(renderedBadge?.textContent).toContain("PDF diagnosisPDF_ARTIFACT_REQUIRED: No validated artifact is selected.");
      expect(renderedBadge?.textContent).not.toContain("PRIVATE EXTRACTED PDF BODY");
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
