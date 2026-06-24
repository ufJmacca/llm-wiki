import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { parseInitJson, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

type RenderNode = RenderElement | RenderNode[] | string | number | boolean | null | undefined;

type RenderElement = {
  tag: string;
  props: Record<string, unknown>;
  children: RenderNode[];
};

type ReviewPanelComponent = (props: {
  fileData: {
    slug: string;
    frontmatter: Record<string, unknown>;
  };
}) => RenderNode;

function h(
  tag: string | ((props: Record<string, unknown>) => RenderNode),
  props: Record<string, unknown> | null,
  ...children: RenderNode[]
): RenderNode {
  if (typeof tag === "function") {
    return tag({ ...(props ?? {}), children });
  }

  return { tag, props: props ?? {}, children };
}

function renderNode(node: RenderNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }

  if (Array.isArray(node)) {
    return node.map(renderNode).join("");
  }

  if (typeof node === "string" || typeof node === "number") {
    return escapeHtml(String(node));
  }

  const attributes = Object.entries(node.props)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([name, value]) => {
      if (value === true) {
        return name;
      }

      return `${name}="${escapeHtml(String(value))}"`;
    });
  const attributeText = attributes.length === 0 ? "" : ` ${attributes.join(" ")}`;

  return `<${node.tag}${attributeText}>${node.children.map(renderNode).join("")}</${node.tag}>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderReviewPanel(componentSource: string, frontmatter: Record<string, unknown>): string {
  const component = loadReviewPanelComponent(componentSource);
  const node = component({
    fileData: {
      slug: "_llm-wiki/review/overview",
      frontmatter,
    },
  });

  return renderNode(node);
}

function loadReviewPanelComponent(componentSource: string): ReviewPanelComponent {
  const executableSource = componentSource
    .replace(/^import \{ resolveRelative \} from "\.\.\/quartz\/util\/path"\n/m, "")
    .replace(/^import type .*\n/gm, "")
    .replace(/\nexport default \(\(\) => LlmWikiReviewPanel\) satisfies QuartzComponentConstructor\s*$/m, "\n");
  const compiled = ts.transpileModule(executableSource, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const resolveRelative = (currentSlug: string, targetSlug: string): string =>
    `resolved:${currentSlug}/${targetSlug}`;

  return new Function("h", "resolveRelative", `${compiled.outputText}\nreturn LlmWikiReviewPanel;`)(
    h,
    resolveRelative,
  ) as ReviewPanelComponent;
}

describe("LlmWikiReviewPanel component template", () => {
  it("renders review navigation metadata and count badges from page frontmatter", async () => {
    await withTempWorkspace("llm-wiki-review-panel-component-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const reviewLinks = [
        { label: "Overview", href: "_llm-wiki/review/overview" },
        { label: "Status", href: "_llm-wiki/review/status", count_key: "frontmatter_status" },
        { label: "Source queue", href: "_llm-wiki/review/source-queue", count_key: "frontmatter_source_queue" },
        { label: "Recent ingests", href: "_llm-wiki/review/recent-ingests", count_key: "frontmatter_recent_ingests" },
        { label: "Needs review", href: "_llm-wiki/review/needs-review", count_key: "frontmatter_needs_review" },
        { label: "Contradictions", href: "_llm-wiki/review/contradictions", count_key: "frontmatter_contradictions" },
        { label: "Orphans", href: "_llm-wiki/review/orphans", count_key: "frontmatter_orphans" },
        { label: "Stale pages", href: "_llm-wiki/review/stale-pages", count_key: "frontmatter_stale_pages" },
        {
          label: "Visibility warnings",
          href: "_llm-wiki/review/visibility-warnings",
          count_key: "frontmatter_visibility_warnings",
        },
        {
          label: "Profile summary",
          href: "_llm-wiki/review/profile-summary",
          count_key: "frontmatter_profile_summary",
        },
      ];
      const reviewCounts: Record<string, number> = {
        frontmatter_status: 41,
        frontmatter_source_queue: 42,
        frontmatter_recent_ingests: 43,
        frontmatter_needs_review: 44,
        frontmatter_contradictions: 45,
        frontmatter_orphans: 46,
        frontmatter_stale_pages: 47,
        frontmatter_visibility_warnings: 48,
        frontmatter_profile_summary: 49,
      };

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiReviewPanel.tsx");
      const rendered = renderReviewPanel(component, {
        llm_wiki_review_profile: "review",
        llm_wiki_review_generated_at: "2026-06-24T01:02:03.000Z",
        llm_wiki_review_links: reviewLinks,
        llm_wiki_review_counts: reviewCounts,
      });

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(rendered).toContain('data-llm-wiki-review-panel="true"');
      expect(rendered).toContain("<dt>Active profile</dt><dd>review</dd>");
      expect(rendered).toContain(
        '<dt>Generated</dt><dd><time dateTime="2026-06-24T01:02:03.000Z">2026-06-24T01:02:03.000Z</time></dd>',
      );
      for (const link of reviewLinks) {
        const href = `href="resolved:_llm-wiki/review/overview/${link.href}"`;
        const countKey = link.count_key;
        if (countKey !== undefined) {
          const count = reviewCounts[countKey];
          expect(rendered).toContain(
            `${href}>${link.label}<span class="llm-wiki-review-panel__count" data-llm-wiki-review-count="${countKey}">${count}</span></a>`,
          );
        } else {
          expect(rendered).toContain(`${href}>${link.label}</a>`);
        }
      }
    });
  });

  it("omits profile metadata when review frontmatter is absent", async () => {
    await withTempWorkspace("llm-wiki-review-panel-missing-metadata-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);

      // Act
      const result = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiReviewPanel.tsx");
      const rendered = renderReviewPanel(component, {});

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(rendered).toContain('data-llm-wiki-review-panel="true"');
      expect(rendered).toContain('href="resolved:_llm-wiki/review/overview/_llm-wiki/review/overview">Overview</a>');
      expect(rendered).toContain('href="resolved:_llm-wiki/review/overview/_llm-wiki/review/status">Status</a>');
      expect(rendered).not.toContain("<dt>Active profile</dt>");
      expect(rendered).not.toContain("<dd>unknown</dd>");
      expect(rendered).not.toContain("<dt>Generated</dt>");
      expect(rendered).not.toContain("<dl>");
    });
  });
});
