import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { scanWikiRepository } from "../src/scanner/repo.js";
import { withTempWorkspace } from "./helpers/init.js";

describe("repository scanner", () => {
  it("can scan live Markdown and source cards without raw originals or queue metadata", async () => {
    await withTempWorkspace("llm-wiki-repo-scan-live-markdown-", async (workspaceDir) => {
      const sourceId = "src_2026_06_17_large_abcdef12";
      const rawDir = resolve(workspaceDir, "raw/inputs", sourceId);
      await mkdir(rawDir, { recursive: true });
      await mkdir(resolve(workspaceDir, "raw/queue"), { recursive: true });
      await mkdir(resolve(workspaceDir, "curated/topics"), { recursive: true });
      await mkdir(resolve(workspaceDir, ".llm-wiki/profiles"), { recursive: true });
      await mkdir(resolve(workspaceDir, "quartz/.quartz-cache"), { recursive: true });
      await mkdir(resolve(workspaceDir, "quartz/quartz"), { recursive: true });

      await writeFile(resolve(rawDir, "original.md"), "# Raw original\n\nThis must stay out of search/nav scans.\n", "utf8");
      await writeFile(resolve(workspaceDir, "quartz/.quartz-cache/generated.md"), "# Generated cache\n", "utf8");
      await writeFile(resolve(workspaceDir, "quartz/quartz/generated.md"), "# Copied runtime\n", "utf8");
      await writeFile(
        resolve(rawDir, "_source.md"),
        [
          "---",
          "type: raw_source",
          `source_id: ${sourceId}`,
          "title: Large Capture",
          "source_kind: file",
          "origin: local",
          "captured_at: 2026-06-17T11:28:42Z",
          "content_hash: sha256:abc",
          "status: queued",
          "visibility: private",
          "---",
          "",
          "# Large Capture",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        resolve(workspaceDir, "curated/topics/live-page.md"),
        "---\ntype: topic\ntitle: Live Page\nvisibility: private\nsource_ids: []\n---\n\n# Live Page\n",
        "utf8",
      );
      await writeFile(resolve(workspaceDir, "raw/queue", `${sourceId}.json`), `{"source_id":"${sourceId}"}`, "utf8");
      await writeFile(resolve(workspaceDir, ".llm-wiki/profiles/public.yml"), "include: []\n", "utf8");

      const scan = await scanWikiRepository(workspaceDir, { mode: "liveMarkdown" });

      expect(scan.files.map((file) => file.path)).toEqual([
        "curated/topics/live-page.md",
        `raw/inputs/${sourceId}/_source.md`,
      ]);
      expect(scan.markdown.map((file) => file.path)).toEqual([
        "curated/topics/live-page.md",
        `raw/inputs/${sourceId}/_source.md`,
      ]);
      expect(scan.sourceCards.map((card) => card.source_id)).toEqual([sourceId]);
      expect(scan.rawOriginals).toEqual([]);
      expect(scan.queueFiles).toEqual([]);
      expect(scan.profiles).toEqual([]);
    });
  });

  it("skips node_modules directories below generated scaffold paths", async () => {
    await withTempWorkspace("llm-wiki-repo-scan-nested-node-modules-", async (workspaceDir) => {
      await mkdir(resolve(workspaceDir, "curated/topics"), { recursive: true });
      await mkdir(resolve(workspaceDir, "upload/github/serverless/node_modules/example-package"), { recursive: true });
      await writeFile(
        resolve(workspaceDir, "curated/topics/live-page.md"),
        "---\ntype: topic\ntitle: Live Page\nvisibility: private\nsource_ids: []\n---\n\n# Live Page\n",
        "utf8",
      );
      await writeFile(
        resolve(workspaceDir, "upload/github/serverless/node_modules/example-package/README.md"),
        "# Dependency README\n\nThis dependency Markdown must not be scanned as wiki content.\n",
        "utf8",
      );

      const scan = await scanWikiRepository(workspaceDir);

      expect(scan.files.map((file) => file.path)).toEqual(["curated/topics/live-page.md"]);
      expect(scan.markdown.map((file) => file.path)).toEqual(["curated/topics/live-page.md"]);
    });
  });
});
