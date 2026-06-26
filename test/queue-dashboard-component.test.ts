import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { parseInitJson, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

type RenderedNode = string | number | boolean | null | undefined | RenderedElement | RenderedNode[];

type RenderedElement = {
  tag: string | ((props: Record<string, unknown>) => RenderedNode);
  props: Record<string, unknown>;
  children: RenderedNode[];
};

type QueueDashboardFrontmatter = {
  llm_wiki_upload_page_enabled?: boolean;
  llm_wiki_queue_total: number;
  llm_wiki_queue_queued: number;
  llm_wiki_queue_ingesting: number;
  llm_wiki_queue_blocked: number;
  llm_wiki_queue_completed: number;
  llm_wiki_queue_items: Array<Record<string, unknown>>;
};

async function initializeQuartzRuntime(wikiDir: string): Promise<void> {
  const init = await runCliBuffered(["init", wikiDir, "--no-git", "--json"]);
  expect(init.exitCode).toBe(0);
  parseInitJson(init.stdout);

  const quartz = await runCliBuffered(["explore", "init", "--repo", wikiDir, "--json"]);
  expect(quartz.exitCode).toBe(0);
}

function h(tag: RenderedElement["tag"], props: Record<string, unknown> | null, ...children: RenderedNode[]): RenderedElement {
  return { tag, props: props ?? {}, children };
}

function renderText(node: RenderedNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }

  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(renderText).join("");
  }

  if (typeof node.tag === "function") {
    return renderText(node.tag({ ...node.props, children: node.children }));
  }

  return node.children.map(renderText).join("");
}

function findAll(node: RenderedNode, predicate: (element: RenderedElement) => boolean): RenderedElement[] {
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((child) => findAll(child, predicate));
  }

  if (typeof node.tag === "function") {
    return findAll(node.tag({ ...node.props, children: node.children }), predicate);
  }

  const matches = predicate(node) ? [node] : [];
  return [...matches, ...node.children.flatMap((child) => findAll(child, predicate))];
}

function flattenClassNames(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return value.split(/\s+/u).filter(Boolean);
}

function isRenderedElement(node: RenderedNode): node is RenderedElement {
  return (
    node !== null &&
    node !== undefined &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    "tag" in node &&
    "props" in node &&
    "children" in node
  );
}

function directChildElements(element: RenderedElement, tag: string): RenderedElement[] {
  return element.children.flatMap((child) => directElementsFromChild(child, tag));
}

function directElementsFromChild(node: RenderedNode, tag: string): RenderedElement[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => directElementsFromChild(child, tag));
  }

  if (!isRenderedElement(node)) {
    return [];
  }

  return node.tag === tag ? [node] : [];
}

function tableBodyRows(node: RenderedNode): RenderedElement[] {
  const bodies = findAll(node, (element) => element.tag === "tbody");
  expect(bodies).toHaveLength(1);
  return directChildElements(bodies[0], "tr");
}

function tableRowCells(row: RenderedElement): string[] {
  return directChildElements(row, "td").map(renderText);
}

async function renderGeneratedDashboard(
  componentContent: string,
  frontmatter: Partial<QueueDashboardFrontmatter>,
): Promise<RenderedNode> {
  const moduleSource = componentContent
    .replace(/^import \{ resolveRelative \} from "[^"]+"\n/mu, "")
    .replace(/^import type .* from "[^"]+"\n/gmu, "")
    .replace(/^export default [\s\S]*$/mu, "")
    .replace(/\bsatisfies\s+[A-Za-z0-9_]+/gu, "");
  const transpiled = ts.transpileModule(moduleSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
    },
  }).outputText;
  const render = new Function(
    "h",
    "resolveRelative",
    "frontmatter",
    `${transpiled}
return LlmWikiQueueDashboard({
  fileData: {
    slug: "_llm-wiki/review/overview",
    frontmatter,
  },
});`,
  ) as (
    jsxFactory: typeof h,
    resolveRelative: (from: string, to: string) => string,
    frontmatter?: Partial<QueueDashboardFrontmatter>,
  ) => RenderedNode;

  return render(h, (_from: string, to: string) => `/resolved/${to}`, frontmatter);
}

describe("LlmWikiQueueDashboard generated component", () => {
  it("renders count metrics and newest queue rows from generated frontmatter", async () => {
    await withTempWorkspace("llm-wiki-queue-dashboard-component-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await mkdir(wikiDir, { recursive: true });
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiQueueDashboard.tsx");
      const frontmatter: QueueDashboardFrontmatter = {
        llm_wiki_queue_total: 4,
        llm_wiki_queue_queued: 1,
        llm_wiki_queue_ingesting: 1,
        llm_wiki_queue_blocked: 1,
        llm_wiki_queue_completed: 1,
        llm_wiki_queue_items: [
          {
            title: "Newest Completed Source",
            source_id: "src_2026_06_23_completed",
            source_kind: "file",
            queue_status: "ingested",
            visibility: "public",
            source_card_path: "raw/inputs/2026/06/src_2026_06_23_completed/_source.md",
            source_card_materialized: true,
            queue_path: "raw/queue/src_2026_06_23_completed.json",
          },
          {
            title: "Second Queued Source",
            source_id: "src_2026_06_23_queued",
            source_kind: "text",
            queue_status: "queued",
            visibility: "private",
            source_card_path: "raw/inputs/2026/06/src_2026_06_23_queued/_source.md",
            source_card_materialized: true,
            queue_path: "raw/queue/src_2026_06_23_queued.json",
          },
          {
            title: "Third Blocked Source",
            source_id: "src_2026_06_23_blocked",
            source_kind: "url",
            queue_status: "blocked",
            visibility: "public",
            source_card_path: "raw/inputs/2026/06/src_2026_06_23_blocked/_source.md",
            source_card_materialized: true,
            queue_path: "raw/queue/src_2026_06_23_blocked.json",
          },
          {
            title: "Fourth Ingesting Source",
            source_id: "src_2026_06_23_ingesting",
            source_kind: "file",
            queue_status: "ingesting",
            visibility: "private",
            source_card_path: "raw/inputs/2026/06/src_2026_06_23_ingesting/_source.md",
            source_card_materialized: true,
            queue_path: "raw/queue/src_2026_06_23_ingesting.json",
          },
        ],
      };

      // Act
      const dashboard = await renderGeneratedDashboard(component, frontmatter);
      const text = renderText(dashboard);
      const anchors = findAll(dashboard, (element) => element.tag === "a");
      const rows = tableBodyRows(dashboard);
      const rowLinks = rows.map((row) => findAll(row, (element) => element.tag === "a").map((link) => link.props.href));

      // Assert
      expect(findAll(dashboard, (element) => element.props["data-llm-wiki-queue-dashboard"] === "true")).toHaveLength(1);
      expect(text).toContain("Total4");
      expect(text).toContain("Queued1");
      expect(text).toContain("Ingesting1");
      expect(text).toContain("Blocked1");
      expect(text).toContain("Completed1");
      expect(rows.map(tableRowCells)).toEqual([
        [
          "Newest Completed Source",
          "src_2026_06_23_completed",
          "file",
          "ingested",
          "public",
          "raw/inputs/2026/06/src_2026_06_23_completed/_source.md",
          "raw/queue/src_2026_06_23_completed.json",
        ],
        [
          "Second Queued Source",
          "src_2026_06_23_queued",
          "text",
          "queued",
          "private",
          "raw/inputs/2026/06/src_2026_06_23_queued/_source.md",
          "raw/queue/src_2026_06_23_queued.json",
        ],
        [
          "Third Blocked Source",
          "src_2026_06_23_blocked",
          "url",
          "blocked",
          "public",
          "raw/inputs/2026/06/src_2026_06_23_blocked/_source.md",
          "raw/queue/src_2026_06_23_blocked.json",
        ],
        [
          "Fourth Ingesting Source",
          "src_2026_06_23_ingesting",
          "file",
          "ingesting",
          "private",
          "raw/inputs/2026/06/src_2026_06_23_ingesting/_source.md",
          "raw/queue/src_2026_06_23_ingesting.json",
        ],
      ]);
      expect(rowLinks).toEqual([
        ["/resolved/raw/inputs/2026/06/src_2026_06_23_completed/_source"],
        ["/resolved/raw/inputs/2026/06/src_2026_06_23_queued/_source"],
        ["/resolved/raw/inputs/2026/06/src_2026_06_23_blocked/_source"],
        ["/resolved/raw/inputs/2026/06/src_2026_06_23_ingesting/_source"],
      ]);
      expect(anchors).toHaveLength(4);
    });
  });

  it("renders unavailable source card paths without internal links", async () => {
    await withTempWorkspace("llm-wiki-queue-dashboard-unavailable-source-card-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await mkdir(wikiDir, { recursive: true });
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiQueueDashboard.tsx");

      // Act
      const dashboard = await renderGeneratedDashboard(component, {
        llm_wiki_queue_total: 1,
        llm_wiki_queue_queued: 1,
        llm_wiki_queue_ingesting: 0,
        llm_wiki_queue_blocked: 0,
        llm_wiki_queue_completed: 0,
        llm_wiki_queue_items: [
          {
            title: "Excluded Source",
            source_id: "src_2026_06_23_excluded",
            source_kind: "text",
            queue_status: "queued",
            visibility: "private",
            source_card_path: "raw/inputs/2026/06/src_2026_06_23_excluded/_source.md",
            source_card_materialized: false,
            queue_path: "raw/queue/src_2026_06_23_excluded.json",
          },
        ],
      });
      const text = renderText(dashboard);
      const anchors = findAll(dashboard, (element) => element.tag === "a");

      // Assert
      expect(text).toContain("raw/inputs/2026/06/src_2026_06_23_excluded/_source.md (Not generated)");
      expect(anchors).toHaveLength(0);
    });
  });

  it("renders a complete zero state with upload and source queue links when upload page is enabled", async () => {
    await withTempWorkspace("llm-wiki-queue-dashboard-zero-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await mkdir(wikiDir, { recursive: true });
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiQueueDashboard.tsx");

      // Act
      const dashboard = await renderGeneratedDashboard(component, {
        llm_wiki_upload_page_enabled: true,
        llm_wiki_queue_total: 0,
        llm_wiki_queue_queued: 0,
        llm_wiki_queue_ingesting: 0,
        llm_wiki_queue_blocked: 0,
        llm_wiki_queue_completed: 0,
        llm_wiki_queue_items: [],
      });
      const text = renderText(dashboard);
      const links = findAll(dashboard, (element) => element.tag === "a").map((link) => ({
        href: link.props.href,
        text: renderText(link),
        classNames: flattenClassNames(link.props.class),
      }));

      // Assert
      expect(text).toContain("No sources are currently queued.");
      expect(text).toContain("Total0");
      expect(text).toContain("Queued0");
      expect(links).toEqual(
        expect.arrayContaining([
          {
            href: "/resolved/_llm-wiki/upload",
            text: "Upload sources",
            classNames: ["internal"],
          },
          {
            href: "/resolved/_llm-wiki/review/source-queue",
            text: "Open source queue",
            classNames: ["internal"],
          },
        ]),
      );
    });
  });

  it("omits the zero-state upload link when upload page is disabled", async () => {
    await withTempWorkspace("llm-wiki-queue-dashboard-zero-disabled-upload-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await mkdir(wikiDir, { recursive: true });
      await initializeQuartzRuntime(wikiDir);
      const component = await readGeneratedFile(wikiDir, "quartz/components/LlmWikiQueueDashboard.tsx");

      // Act
      const dashboard = await renderGeneratedDashboard(component, {
        llm_wiki_upload_page_enabled: false,
        llm_wiki_queue_total: 0,
        llm_wiki_queue_queued: 0,
        llm_wiki_queue_ingesting: 0,
        llm_wiki_queue_blocked: 0,
        llm_wiki_queue_completed: 0,
        llm_wiki_queue_items: [],
      });
      const links = findAll(dashboard, (element) => element.tag === "a").map((link) => ({
        href: link.props.href,
        text: renderText(link),
        classNames: flattenClassNames(link.props.class),
      }));

      // Assert
      expect(links).toEqual([
        {
          href: "/resolved/_llm-wiki/review/source-queue",
          text: "Open source queue",
          classNames: ["internal"],
        },
      ]);
    });
  });
});
